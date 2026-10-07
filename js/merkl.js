/*
 * Merkl incentive campaigns.
 *
 * The emissions panel next door reads DefiLlama, which splits a pool's APY into earned
 * (apyBase) and paid (apyReward). What it cannot tell you is when the paying stops. Merkl runs
 * a large share of DeFi's incentive campaigns and publishes the one fact that matters most about
 * an incentive: its end date.
 *
 * That turns out to change the picture. Across 366 live campaigns sampled while building this,
 * the median had 21 days left, 73% ended within 30 days, 24% within a week, and exactly 2 ran
 * beyond 180 days. An "82% APR" on a campaign with 19 days to run is not an annual rate anyone
 * will receive -- it is about 4% of capital, and then it is gone. So this panel leads with the
 * end date and shows what the campaign actually pays over its remaining life, with the
 * annualised figure as the secondary number rather than the headline.
 *
 * It also makes dilution exact rather than hand-waved. For 92% of those campaigns the published
 * apr reconstructs to within 10% of dailyRewards * 365 / tvl (median ratio 1.000), which means
 * the reward pot is fixed and shared pro rata. Where that identity holds, the APR you would get
 * at your own size is apr * tvl / (tvl + yours) exactly. Where it does not -- restricted
 * campaigns with eligibility conditions -- this says so instead of modelling it anyway.
 *
 * It goes through /api/merkl rather than calling Merkl directly, for a reason that took a
 * browser to find. Requested without an Origin header, Merkl answers with
 * Access-Control-Allow-Origin: *; requested with one, that header alone is missing and the fetch
 * fails. A curl check said no proxy was needed and was wrong, because curl sends no Origin.
 *
 * One request per pool, filtered server-side to a single address and trimmed by the proxy to a
 * few hundred bytes -- cheap enough to load automatically rather than behind a button.
 */
window.LP = window.LP || {};

LP.merkl = (function () {
  const U = () => LP.util;
  const esc = (s) => LP.util.escapeHtml(s);

  // Our own proxy, not api.merkl.xyz: see the note above on Merkl's Origin-dependent CORS.
  const API = '/api/merkl';

  /*
   * GeckoTerminal network name -> numeric chain id, restricted to chains Merkl actually runs
   * on (its own /v4/chains listing, 70 of them). A name missing here means "Merkl does not
   * operate there", which is a different answer from "no campaign", and the UI keeps them apart.
   */
  const CHAIN_IDS = {
    eth: 1, optimism: 10, flare: 14, bsc: 56, xdai: 100, unichain: 130,
    polygon_pos: 137, monad: 143, sonic: 146, ftm: 250, fraxtal: 252,
    zksync: 324, 'world-chain': 480, hyperevm: 999, 'polygon-zkevm': 1101,
    glmr: 1284, 'sei-v2': 1329, soneium: 1868, ronin: 2020, mantle: 5000,
    base: 8453, plasma: 9745, mode: 34443, arbitrum: 42161, celo: 42220,
    avax: 43114, ink: 57073, linea: 59144, berachain: 80094, blast: 81457,
    taiko: 167000, scroll: 534352, katana: 747474
  };

  const cache = new Map();      // "chainId:address" -> raw opportunity array
  const inflight = new Map();

  const local = { state: 'idle', data: null, error: null, result: null };
  // state: idle | loading | done | absent | unsupported | error

  /* ------------------------------------------------------------------- fetch */

  /**
   * Campaigns for one pool address. Merkl matches `identifier` case-insensitively, and returns
   * an empty array -- not an error -- when a pool has no campaign, which is the common case.
   */
  async function lookup(network, address) {
    const chainId = CHAIN_IDS[network];
    if (!chainId) {
      return { ok: false, unsupported: true,
        reason: 'Merkl does not run campaigns on ' + (network || 'this chain') + '.' };
    }
    const addr = String(address || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) {
      return { ok: false, reason: 'Merkl is matched by pool address, and this is not one.' };
    }

    const key = chainId + ':' + addr;
    if (cache.has(key)) return { ok: true, chainId, raw: cache.get(key) };
    if (inflight.has(key)) return inflight.get(key);

    const p = (async () => {
      let res;
      try {
        res = await fetch(API + '?identifier=' + addr + '&chainId=' + chainId, {
          headers: { accept: 'application/json' }
        });
      } catch (e) {
        throw new Error('Could not reach /api/merkl. ' + (e.message || String(e)));
      }
      if (res.status === 404) {
        throw new Error('/api/merkl is not deployed here. Merkl’s API withholds its CORS ' +
          'header from browser requests, so the campaign check needs that function. Every other ' +
          'panel on this page works without it.');
      }
      if (!res.ok) throw new Error('/api/merkl returned HTTP ' + res.status + '.');
      const json = await res.json();
      const raw = Array.isArray(json) ? json : [];
      cache.set(key, raw);
      return { ok: true, chainId, raw };
    })();

    inflight.set(key, p);
    try { return await p; } finally { inflight.delete(key); }
  }

  /* ---------------------------------------------------------------- analysis */

  const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;

  /**
   * Shape one raw opportunity into the fields this panel reasons about.
   *
   * `proRata` records whether the published APR reconstructs from the reward pot over the TVL it
   * is shared across. It is the licence to model dilution, so it is computed rather than assumed.
   */
  function shape(o, nowSec) {
    const apr = num(o.apr);
    const tvl = num(o.tvl);
    const daily = num(o.dailyRewards);
    const endsAt = num(Number(o.latestCampaignEnd)) || null;
    const startedAt = num(Number(o.earliestCampaignStart)) || null;
    const daysLeft = endsAt ? (endsAt - nowSec) / 86400 : null;

    const impliedApr = (daily !== null && tvl !== null && tvl > 0) ? (daily * 365 / tvl) * 100 : null;
    const proRata = (impliedApr !== null && apr !== null && apr > 0)
      ? Math.abs(impliedApr / apr - 1) <= 0.1 : false;

    const tokens = ((o.rewardsRecord && o.rewardsRecord.breakdowns) || [])
      .map((b) => (b.token || {}).symbol).filter(Boolean);

    return {
      name: o.name || '(unnamed campaign)',
      type: o.type || null,
      action: o.action || null,
      status: o.status || null,
      identifier: o.identifier || null,
      apr: apr, tvl: tvl, daily: daily, endsAt: endsAt, startedAt: startedAt,
      daysLeft: daysLeft, impliedApr: impliedApr, proRata: proRata,
      liveCampaigns: num(o.liveCampaigns),
      depositUrl: typeof o.depositUrl === 'string' && /^https:\/\//.test(o.depositUrl)
        ? o.depositUrl : null,
      rewardTokens: Array.from(new Set(tokens)),
      // What the remaining life of the campaign is actually worth, as a share of capital.
      remainingPct: (apr !== null && daysLeft !== null && daysLeft > 0)
        ? apr * (daysLeft / 365) : null
    };
  }

  /**
   * The APR you would see at your own size, once your deposit joins the pot's denominator.
   *
   * Your share of the daily pot is P/(T+P), so your annual reward is daily*365*P/(T+P) and your
   * APR is that over P -- the P cancels, leaving apr * T/(T+P). Exact whenever the pot is fixed
   * and shared pro rata, which `proRata` is there to establish.
   */
  function dilutedApr(c, positionUsd) {
    if (!c.proRata || c.apr === null || c.tvl === null || c.tvl <= 0) return null;
    const p = num(positionUsd);
    if (p === null || p <= 0) return null;
    return c.apr * (c.tvl / (c.tvl + p));
  }

  function analyse(raw, opts) {
    opts = opts || {};
    const nowSec = (opts.nowSec !== undefined) ? opts.nowSec : Date.now() / 1000;
    const all = (raw || []).map((o) => shape(o, nowSec));

    // Expired campaigns are kept out of the totals but remembered, because a pool whose
    // incentives just ended looks identical to one that never had any unless you say so.
    const live = all.filter((c) => c.daysLeft === null || c.daysLeft > 0);
    const ended = all.filter((c) => c.daysLeft !== null && c.daysLeft <= 0);

    const aprs = live.map((c) => c.apr).filter((v) => v !== null);
    const totalApr = aprs.length ? aprs.reduce((a, b) => a + b, 0) : null;

    const lefts = live.map((c) => c.daysLeft).filter((v) => v !== null);
    const soonestDays = lefts.length ? Math.min.apply(null, lefts) : null;
    const latestDays = lefts.length ? Math.max.apply(null, lefts) : null;

    const remaining = live.map((c) => c.remainingPct).filter((v) => v !== null);
    const totalRemainingPct = remaining.length ? remaining.reduce((a, b) => a + b, 0) : null;

    // Merkl's TVL for the campaign against the pool's own. A wide gap usually means the campaign
    // is scoped to something other than the whole pool, so its APR is not ours to annualise.
    const poolUsd = num(opts.poolUsd);
    const merklTvl = live.length ? num(live[0].tvl) : null;
    const tvlRatio = (poolUsd !== null && poolUsd > 0 && merklTvl !== null && merklTvl > 0)
      ? merklTvl / poolUsd : null;
    const tvlSuspect = tvlRatio !== null && (tvlRatio > 5 || tvlRatio < 0.2);

    const diluted = live.map((c) => dilutedApr(c, opts.positionUsd))
      .filter((v) => v !== null);
    const totalDilutedApr = diluted.length ? diluted.reduce((a, b) => a + b, 0) : null;

    return {
      live: live, ended: ended, totalApr: totalApr,
      soonestDays: soonestDays, latestDays: latestDays,
      totalRemainingPct: totalRemainingPct,
      merklTvl: merklTvl, poolUsd: poolUsd, tvlRatio: tvlRatio, tvlSuspect: tvlSuspect,
      totalDilutedApr: totalDilutedApr,
      positionUsd: num(opts.positionUsd),
      anyRestricted: live.some((c) => !c.proRata),
      rewardTokens: Array.from(new Set([].concat.apply([], live.map((c) => c.rewardTokens)))),
      flags: flagsFor(live, soonestDays, tvlSuspect, tvlRatio)
    };
  }

  /*
   * Flags in the shape the main risk list expects: { level, title, detail } with level one of
   * critical | warn | info. Anything else renders as "undefined" there.
   */
  function flagsFor(live, soonestDays, tvlSuspect, tvlRatio) {
    const f = [];
    if (!live.length) return f;

    /*
     * Compared on the rounded value, because that is what the panel displays. At 7.39 days the
     * panel said "7 days" while a `< 7` test stayed silent, which read as a missing warning.
     */
    const shown = soonestDays === null ? null : Math.round(soonestDays);

    if (soonestDays !== null && soonestDays < 1) {
      f.push({ level: 'critical', title: 'An incentive campaign ends within 24 hours',
        detail: 'Any APR quoted from it is about to stop being paid. If you are entering for the ' +
          'incentive, there is nothing left to enter for.' });
    } else if (shown !== null && shown <= 7) {
      f.push({ level: 'warn', title: 'An incentive campaign ends in ' + shown + ' days',
        detail: 'Weigh the round-trip gas cost against what is actually left to earn, not ' +
          'against the annualised rate.' });
    }

    if (live.some((c) => !c.proRata)) {
      f.push({ level: 'info', title: 'A campaign has eligibility conditions',
        detail: 'Its APR does not reconstruct from the reward pot over the TVL it is shared ' +
          'across, which usually means conditions attached — a minimum size, a health factor, ' +
          'a particular token pairing. Read the campaign rules before sizing.' });
    }

    if (tvlSuspect) {
      f.push({ level: 'warn', title: 'The campaign is measured against different TVL',
        detail: 'Merkl sees ' + U().ratio(tvlRatio > 1 ? tvlRatio : 1 / tvlRatio, 1) + '× ' +
          (tvlRatio > 1 ? 'more' : 'less') + ' participating TVL than this pool holds, so it is ' +
          'probably scoped to something other than the whole pool. Treat its APR as indicative.' });
    }

    return f;
  }

  /* ------------------------------------------------------------------ render */

  function dayLabel(d) {
    if (d === null) return '—';
    if (d <= 0) return 'ended';
    if (d < 1) return Math.round(d * 24) + 'h';
    if (d < 45) return Math.round(d) + ' days';
    return (d / 30.44).toFixed(1) + ' months';
  }

  function reset() { local.state = 'idle'; local.data = null; local.error = null; }

  function render(r) {
    local.result = r;
    if (local.state === 'idle' || local.state === 'loading') return '';
    if (local.state === 'unsupported') return '';

    if (local.state === 'error') {
      return card('<div class="callout warn"><strong>Could not check Merkl campaigns.</strong> ' +
        esc(local.error || '') + ' The swap-fee figures elsewhere are unaffected.</div>');
    }

    if (local.state === 'absent' || !local.data || !local.data.live.length) {
      const n = (local.data && local.data.ended.length) || 0;
      const endedNote = n
        ? ' Merkl did run ' + n + ' campaign' + (n === 1 ? '' : 's') + ' here that has since ' +
          'ended, so an APY quoted from an older screenshot may include incentives that are no ' +
          'longer being paid.'
        : '';
      return card('<p class="muted"><strong>No live Merkl campaign on this pool.</strong>' +
        esc(endedNote) + ' Incentives can also be paid outside Merkl, so this is not proof of ' +
        'none — it rules out the largest single source.</p>');
    }

    const a = local.data;
    const u = U();
    const ending = a.soonestDays !== null && a.soonestDays < 7;

    return card(`
      <div class="metrics">
        ${metric('Incentive APR', a.totalApr === null ? '—' : u.pct(a.totalApr, 2),
          a.live.length > 1 ? a.live.length + ' campaigns, added' : 'annualised by Merkl')}
        ${metric('Ends in', dayLabel(a.soonestDays),
          a.live.length > 1 && a.latestDays !== null && a.latestDays !== a.soonestDays
            ? 'soonest of ' + a.live.length + '; the last ends ' + dayLabel(a.latestDays)
            : 'then this APR stops', ending ? 'weak' : '')}
        ${metric('Worth, if you stay to the end',
          a.totalRemainingPct === null ? '—' : u.pct(a.totalRemainingPct, 2),
          'of capital — the APR over what remains, not over a year', 'good')}
        ${metric('Paid in', a.rewardTokens.length ? esc(a.rewardTokens.join(', ')) : '—',
          a.rewardTokens.length ? 'you hold this token’s price risk after claiming'
            : 'reward token')}
      </div>

      <div class="callout ${ending ? 'warn' : ''}">
        <strong>An incentive APR is a rate, not a promise of a year.</strong>
        ${a.totalApr === null ? '' : `It annualises to ${u.pct(a.totalApr, 2)}, but the campaign
        has ${dayLabel(a.soonestDays)} to run — so staying to the end pays about
        <strong>${a.totalRemainingPct === null ? '—' : u.pct(a.totalRemainingPct, 2)}</strong>
        of your capital, not ${u.pct(a.totalApr, 2)}.`}
        Of 366 live campaigns sampled while building this, the median had 21 days left and only
        two ran beyond 180 days, so a horizon measured in days rather than months is the normal
        shape of an incentive — this campaign is not unusually short.
      </div>

      ${renderDilution(a)}
      ${renderCampaigns(a)}

      <p class="fineprint">From Merkl’s own campaign API, matched on this pool’s address${
        a.merklTvl === null ? '' : ' — they measure ' + u.usd(a.merklTvl) +
        ' of participating TVL against this pool’s ' + u.usd(a.poolUsd)}.
        These rewards are separate from swap fees: add them to the fee APR elsewhere on this page
        rather than treating either one as the total.</p>`);
  }

  function renderDilution(a) {
    const u = U();
    if (a.totalDilutedApr === null || a.positionUsd === null) return '';

    const drop = (a.totalApr !== null && a.totalApr > 0)
      ? (1 - a.totalDilutedApr / a.totalApr) * 100 : null;
    const myRemaining = (a.soonestDays !== null && a.soonestDays > 0)
      ? a.totalDilutedApr * (a.soonestDays / 365) : null;

    return `
      <h4>At your size</h4>
      <div class="metrics">
        ${metric('Your incentive APR', u.pct(a.totalDilutedApr, 2),
          u.usd(a.positionUsd) + ' joining ' + u.usd(a.merklTvl),
          drop !== null && drop > 25 ? 'weak' : '')}
        ${metric('Diluted by', drop === null ? '—' : u.pct(drop, 1),
          'by your own deposit, against the headline rate')}
        ${metric('You would collect', myRemaining === null ? '—' : u.pct(myRemaining, 2),
          'of your capital, over the campaign’s remaining life')}
      </div>
      <p class="fineprint">The reward pot is fixed, so your share of it is
        <code>P / (T + P)</code> and your rate is <code>APR × T / (T + P)</code>. Checked
        rather than assumed: this is shown only for campaigns whose published APR reconstructs
        from <code>dailyRewards × 365 / TVL</code>, which held for 92% of those sampled.</p>`;
  }

  function renderCampaigns(a) {
    const u = U();
    if (!a.live.length) return '';
    return `
      <h4>${a.live.length === 1 ? 'The campaign' : 'The ' + a.live.length + ' campaigns'}</h4>
      <div class="table-scroll"><table>
        <thead><tr>
          <th>Campaign</th><th class="num">APR</th><th class="num">Ends in</th>
          <th class="num">Remaining value</th><th class="num">Daily pot</th>
        </tr></thead>
        <tbody>
          ${a.live.map((c) => `<tr>
            <td>${c.depositUrl
                ? '<a href="' + esc(c.depositUrl) + '" target="_blank" rel="noopener noreferrer">' +
                  esc(c.name) + '</a>'
                : esc(c.name)}${c.proRata ? '' : ' <span class="tag">restricted</span>'}</td>
            <td class="num">${c.apr === null ? '—' : u.pct(c.apr, 2)}</td>
            <td class="num ${c.daysLeft !== null && c.daysLeft < 7 ? 'down' : ''}">${
              dayLabel(c.daysLeft)}</td>
            <td class="num">${c.remainingPct === null ? '—' : u.pct(c.remainingPct, 2)}</td>
            <td class="num">${c.daily === null ? '—' : u.usd(c.daily)}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;
  }

  function metric(label, value, sub, cls) {
    return `<div class="metric ${cls || ''}">
      <span class="m-label">${label}</span>
      <span class="m-value">${value}</span>
      ${sub ? '<span class="m-sub">' + sub + '</span>' : ''}
    </div>`;
  }

  function card(inner) {
    return `<section class="card merkl">
      <h3>Incentive campaigns, and when they stop</h3>
      ${inner}
    </section>`;
  }

  /* ------------------------------------------------------------------ wiring */

  /**
   * Fetched automatically: one filtered request of about 10 KB, unlike the 2.4 MB DefiLlama
   * dataset next door that has to be asked for with a button.
   */
  async function autoLoad(r, onChange) {
    reset();
    if (!r || !r.pool) return;
    local.state = 'loading';
    try {
      const hit = await lookup(r.pool.network, r.pool.address);
      if (!hit.ok) {
        local.state = hit.unsupported ? 'unsupported' : 'absent';
        local.data = null;
      } else {
        local.data = analyse(hit.raw, {
          poolUsd: r.pool.tvlUsd,
          positionUsd: r.assumptions && r.assumptions.positionUsd
        });
        local.state = (local.data.live.length || local.data.ended.length) ? 'done' : 'absent';
      }
    } catch (e) {
      local.error = e.message || String(e);
      local.state = 'error';
    }
    if (onChange) onChange();
  }

  /** Flags for the main risk list, so a campaign ending tomorrow is not only in this panel. */
  function flags() {
    return (local.state === 'done' && local.data) ? local.data.flags : [];
  }

  return {
    CHAIN_IDS: CHAIN_IDS,
    lookup: lookup, analyse: analyse, shape: shape, dilutedApr: dilutedApr,
    render: render, reset: reset, autoLoad: autoLoad, flags: flags,
    _state: () => local.state
  };
})();
