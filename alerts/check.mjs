/*
 * Scheduled alert check.
 *
 * Runs on a cron in GitHub Actions, where there is no browser and no localStorage. It reads the
 * positions committed in alerts/positions.json, re-fetches live pool state, evaluates the same
 * thresholds the web app computes, and posts anything that has fired to a webhook.
 *
 * Deliberately dependency-free: Node 18+ has fetch built in, so there is nothing to install and
 * nothing to keep up to date.
 *
 * State lives in alerts/state.json so an alert fires on the EDGE rather than every run -- a job
 * that tells you the range is broken every thirty minutes for a week is one you will mute, and a
 * muted alert is the same as no alert.
 *
 *   node alerts/check.mjs            evaluate and notify
 *   node alerts/check.mjs --dry-run  evaluate and print, touch nothing
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const POSITIONS = join(HERE, 'positions.json');
const STATE = join(HERE, 'state.json');
const DRY = process.argv.includes('--dry-run');

const GT = 'https://api.geckoterminal.com/api/v2';

/* ------------------------------------------------------------------ helpers */

const pct = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) + '%' : '—');
const usd = (v) => {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + v.toFixed(2);
};
const price = (v) => (Number.isFinite(v)
  ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/* -------------------------------------------------------------------- fetch */

async function fetchPool(network, address) {
  const url = `${GT}/networks/${encodeURIComponent(network)}/pools/${encodeURIComponent(address)}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (res.status === 429) throw new Error('rate limited by GeckoTerminal');
  if (!res.ok) throw new Error(`GeckoTerminal HTTP ${res.status}`);
  const json = await res.json();
  const a = json?.data?.attributes;
  if (!a) throw new Error('pool not found');
  return {
    name: a.pool_name || a.name,
    price: Number(a.base_token_price_quote_token),
    tvl: Number(a.reserve_in_usd),
    volume24h: Number(a.volume_usd?.h24),
    feePct: a.pool_fee_percentage === null ? null : Number(a.pool_fee_percentage)
  };
}

/* ----------------------------------------------------------------- evaluate */

/**
 * The same checks the browser runs, reduced to the ones that can be evaluated from pool state
 * alone. Each returns a stable key so state.json can tell a new event from a continuing one.
 */
function evaluate(position, pool) {
  const fired = [];
  const p = pool.price;

  if (position.rangePct > 0 && position.entryPrice > 0) {
    const w = position.rangePct / 100;
    const lo = position.entryPrice * (1 - w);
    const hi = position.entryPrice * (1 + w);

    if (p < lo) {
      fired.push({
        key: 'range-below',
        title: 'Range broken (below)',
        text: `${pool.name}: price ${price(p)} is under your floor of ${price(lo)}. ` +
              `The position is fully converted and earning no fees.`
      });
    } else if (p > hi) {
      fired.push({
        key: 'range-above',
        title: 'Range broken (above)',
        text: `${pool.name}: price ${price(p)} is over your ceiling of ${price(hi)}. ` +
              `The position is fully converted and earning no fees.`
      });
    } else {
      // Warn once the price is inside the last 20% of either side.
      const nearLo = p <= lo + (hi - lo) * 0.1;
      const nearHi = p >= hi - (hi - lo) * 0.1;
      if (nearLo || nearHi) {
        fired.push({
          key: 'range-near',
          title: 'Approaching the edge of your range',
          text: `${pool.name}: price ${price(p)} is close to the ${nearLo ? 'floor' : 'ceiling'} ` +
                `(${price(nearLo ? lo : hi)}). Range is ${price(lo)} – ${price(hi)}.`
        });
      }
    }
  }

  // Volume against the 0.25 V/R benchmark from the OTS notes.
  if (pool.tvl > 0 && Number.isFinite(pool.volume24h)) {
    const vr = pool.volume24h / pool.tvl;
    if (vr < 0.25) {
      fired.push({
        key: 'vr-low',
        title: 'Volume below the benchmark',
        text: `${pool.name}: V/R is ${vr.toFixed(3)} against the 0.25 benchmark ` +
              `(${usd(pool.volume24h)} on ${usd(pool.tvl)}). Fee income is thin here.`
      });
    }
  }

  // Dilution: your share falls as liquidity arrives.
  if (position.tvlAtEntry > 0 && pool.tvl > position.tvlAtEntry * 1.75) {
    const mult = pool.tvl / position.tvlAtEntry;
    fired.push({
      key: 'tvl-grown',
      title: 'Pool has grown — your yield is diluted',
      text: `${pool.name}: liquidity is ${mult.toFixed(1)}× what it was when you entered ` +
            `(${usd(position.tvlAtEntry)} → ${usd(pool.tvl)}). At unchanged volume your share ` +
            `of the fees has fallen by about ${((1 - 1 / mult) * 100).toFixed(0)}%.`
    });
  }

  return fired;
}

/* ------------------------------------------------------------------- notify */

async function notify(messages) {
  const webhook = process.env.ALERT_WEBHOOK_URL;
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  const body = messages.join('\n\n');

  if (!webhook && !(tgToken && tgChat)) {
    console.log('No notification channel configured; printing instead.\n');
    console.log(body);
    return 'stdout';
  }

  if (tgToken && tgChat) {
    const res = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: tgChat, text: body, disable_web_page_preview: true })
    });
    if (!res.ok) throw new Error(`Telegram HTTP ${res.status}: ${await res.text()}`);
    return 'telegram';
  }

  // Discord and Slack both accept a JSON body with a text field under different names.
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: body, text: body })
  });
  if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
  return 'webhook';
}

/* --------------------------------------------------------------------- main */

async function main() {
  const positions = await readJson(POSITIONS, []);
  if (!Array.isArray(positions) || !positions.length) {
    console.log('No positions in alerts/positions.json — nothing to check.');
    return;
  }

  const previous = await readJson(STATE, {});
  const now = {};
  const messages = [];
  const problems = [];

  for (const pos of positions) {
    const id = `${pos.network}:${pos.address}`;
    let pool;
    try {
      pool = await fetchPool(pos.network, pos.address);
    } catch (e) {
      problems.push(`${pos.label || id}: ${e.message}`);
      // Carry the previous state forward so a transient fetch failure does not re-fire
      // everything on the next successful run.
      if (previous[id]) now[id] = previous[id];
      continue;
    }

    const fired = evaluate(pos, pool);
    now[id] = fired.map((f) => f.key).sort();

    const before = new Set(previous[id] || []);
    const fresh = fired.filter((f) => !before.has(f.key));

    for (const f of fresh) {
      messages.push(`[${f.title}]\n${f.text}`);
    }
    console.log(`${pos.label || id}: ${fired.length} condition(s) active, ${fresh.length} new`);

    // Space the calls out; the free tier allows roughly 30 a minute.
    await new Promise((r) => setTimeout(r, 1200));
  }

  if (problems.length) console.log('\nProblems:\n  ' + problems.join('\n  '));

  if (!messages.length) {
    console.log('\nNothing new to report.');
  } else if (DRY) {
    console.log('\n--- would send ---\n' + messages.join('\n\n'));
  } else {
    const via = await notify(messages);
    console.log(`\nSent ${messages.length} alert(s) via ${via}.`);
  }

  if (!DRY) await writeFile(STATE, JSON.stringify(now, null, 2) + '\n');
}

main().catch((e) => {
  console.error('Alert check failed:', e.message);
  process.exit(1);
});
