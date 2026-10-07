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

/*
 * Both of these are called directly rather than through api/merkl.js and api/pendle.js. Those
 * proxies exist only to add a CORS header for the browser; this runs in Node, where there is no
 * origin and no preflight, so the upstreams are reachable as they are.
 */
const MERKL = 'https://api.merkl.xyz/v4/opportunities';
const PENDLE = 'https://api-v2.pendle.finance/core/v1';

// Enough of the chain map for the networks a watched position is plausibly on.
const CHAIN_IDS = {
  eth: 1, optimism: 10, bsc: 56, unichain: 130, polygon_pos: 137, sonic: 146,
  zksync: 324, hyperevm: 999, mantle: 5000, base: 8453, mode: 34443,
  arbitrum: 42161, avax: 43114, linea: 59144, berachain: 80094, blast: 81457,
  scroll: 534352, katana: 747474
};

/** Live incentive campaigns on a pool. An empty list is the normal answer, not a failure. */
async function fetchCampaigns(network, address) {
  const chainId = CHAIN_IDS[network];
  if (!chainId) return [];
  const url = `${MERKL}?identifier=${encodeURIComponent(address.toLowerCase())}&chainId=${chainId}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Merkl HTTP ${res.status}`);
  const json = await res.json();
  return Array.isArray(json) ? json : [];
}

/**
 * A Pendle market, if this address is one.
 *
 * GeckoTerminal indexes no Pendle markets, so a Pendle position fails the pool fetch outright.
 * That failure is the signal to look here instead.
 */
async function fetchPendleMarket(network, address) {
  const chainId = CHAIN_IDS[network];
  if (!chainId) return null;
  const want = String(address).toLowerCase();
  // The upstream caps limit at 100 and rejects anything larger.
  for (let skip = 0; skip < 300; skip += 100) {
    const res = await fetch(`${PENDLE}/${chainId}/markets?limit=100&skip=${skip}&is_active=true`,
      { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`Pendle HTTP ${res.status}`);
    const page = await res.json();
    const batch = page.results || [];
    const hit = batch.find((m) => String(m.address).toLowerCase() === want);
    if (hit) return hit;
    if (batch.length < 100) break;
  }
  return null;
}

/* ----------------------------------------------------------------- evaluate */

/**
 * Which countdown threshold a date has crossed, or null while it is still far off.
 *
 * The key carries the bucket, so each threshold fires exactly once as it is passed: a campaign
 * 40 days out is silent, then reports at 30, 14, 7, 3 and 1. Without the bucket in the key the
 * edge-triggered state would fire once at 30 days and never mention it again.
 */
function dayBucket(days) {
  if (!Number.isFinite(days) || days <= 0) return null;
  /*
   * Bucketed on the rounded figure the message displays, not the raw one. At 14.4 days the raw
   * value falls in the 30 bucket while the text reads "14 days"; a day later it crosses into the
   * 14 bucket and fires a second time with identical wording. Rounding first keeps one message
   * per distinct thing said. Anything still short of a day stays in the 1 bucket rather than
   * rounding to zero and going quiet in the final hours.
   */
  const shown = Math.max(1, Math.round(days));
  for (const t of [1, 3, 7, 14, 30]) if (shown <= t) return t;
  return null;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const dayText = (d) => (d < 1
  ? plural(Math.max(1, Math.round(d * 24)), 'hour')
  : plural(Math.max(1, Math.round(d)), 'day'));

/**
 * Incentive campaigns ending.
 *
 * An APR that stops next week is not the APR you are being paid, and it is the one fact about a
 * campaign you cannot read off the pool itself.
 */
function evaluateCampaigns(position, campaigns, nowSec) {
  const fired = [];
  for (const c of campaigns) {
    const endsAt = Number(c.latestCampaignEnd);
    if (!Number.isFinite(endsAt)) continue;
    const days = (endsAt - nowSec) / 86400;
    const bucket = dayBucket(days);
    if (bucket === null) continue;

    const apr = Number(c.apr);
    const worth = Number.isFinite(apr) && days > 0 ? apr * (days / 365) : null;
    fired.push({
      key: `campaign-ends-${bucket}`,
      title: `Incentive campaign ends in ${dayText(days)}`,
      text: `${position.label || position.address}: "${c.name || 'campaign'}" stops paying in ` +
            `${dayText(days)}.` +
            (Number.isFinite(apr) ? ` It quotes ${apr.toFixed(2)}% APR, which over what is left ` +
              `is worth about ${worth.toFixed(2)}% of capital — not ${apr.toFixed(2)}%.` : '') +
            ` After that the pool pays swap fees only.`
    });
  }
  return fired;
}

/**
 * A Pendle market approaching expiry.
 *
 * Unlike every other alert here this one is certain in advance: the date is fixed at launch. At
 * expiry the PT is redeemable at par and the market stops being a yield trade, so the position
 * has to be rolled or redeemed rather than left alone.
 */
function evaluatePendle(position, market, nowSec) {
  const fired = [];
  const expiry = Date.parse(market.expiry) / 1000;
  if (!Number.isFinite(expiry)) return fired;

  const days = (expiry - nowSec) / 86400;
  const name = market.simpleName || market.name || position.label || position.address;

  if (days <= 0) {
    fired.push({
      key: 'pendle-expired',
      title: 'Pendle market has expired',
      text: `${name}: expired. The PT is redeemable at par and the LP has stopped earning — ` +
            `capital sitting here is idle until you redeem or roll into a later maturity.`
    });
    return fired;
  }

  const bucket = dayBucket(days);
  if (bucket !== null) {
    const implied = Number(market.impliedApy);
    fired.push({
      key: `pendle-expiry-${bucket}`,
      title: `Pendle market expires in ${dayText(days)}`,
      text: `${name}: ${dayText(days)} to expiry.` +
            (Number.isFinite(implied)
              ? ` Implied yield is ${(implied * 100).toFixed(2)}%, and the remaining term is ` +
                `short enough that fees and slippage now matter more than the rate.` : '') +
            ` Decide whether to redeem at par or roll into a later maturity.`
    });
  }
  return fired;
}

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

  const nowSec = Date.now() / 1000;

  for (const pos of positions) {
    const id = `${pos.network}:${pos.address}`;
    let pool;
    try {
      pool = await fetchPool(pos.network, pos.address);
    } catch (e) {
      /*
       * A pool that cannot be found may be a Pendle market rather than a missing pool --
       * GeckoTerminal indexes none of them. Check before reporting a problem, so a Pendle
       * position gets its expiry countdown instead of a weekly "pool not found".
       */
      let market = null;
      try {
        market = await fetchPendleMarket(pos.network, pos.address);
      } catch { /* leave it to the original failure below */ }

      if (market) {
        const fired = evaluatePendle(pos, market, nowSec);
        now[id] = fired.map((f) => f.key).sort();
        const before = new Set(previous[id] || []);
        for (const f of fired.filter((x) => !before.has(x.key))) {
          messages.push(`[${f.title}]\n${f.text}`);
        }
        console.log(`${pos.label || id}: Pendle market, ${fired.length} condition(s) active`);
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }

      problems.push(`${pos.label || id}: ${e.message}`);
      // Carry the previous state forward so a transient fetch failure does not re-fire
      // everything on the next successful run.
      if (previous[id]) now[id] = previous[id];
      continue;
    }

    const fired = evaluate(pos, pool);

    // Campaign end dates are not visible in pool state, so they are fetched separately. A
    // failure here must not lose the pool checks that already succeeded.
    try {
      fired.push(...evaluateCampaigns(pos, await fetchCampaigns(pos.network, pos.address), nowSec));
    } catch (e) {
      problems.push(`${pos.label || id}: campaigns — ${e.message}`);
    }

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
