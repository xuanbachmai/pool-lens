/* Rendering and event wiring. */
window.LP = window.LP || {};

LP.ui = (function () {
  const U = LP.util;
  const esc = U.escapeHtml;

  const state = {
    input: '',
    target: null,
    pool: null,
    cross: null,
    hist: [],
    histError: null,
    candidates: [],
    matchedBy: null,
    baseFeeInfo: null,
    overrides: { fee: null, lpShare: null },
    assumptions: { positionUsd: 10000, holdDays: 30, rangePct: 20 },
    result: null,
    siblings: null
  };

  const $ = (sel) => document.querySelector(sel);

  /* ----------------------------------------------------------------- helpers */

  function statusEl() { return $('#status'); }

  function setStatus(kind, html) {
    const el = statusEl();
    if (!html) { el.className = 'status hidden'; el.innerHTML = ''; return; }
    el.className = 'status status-' + kind;
    el.innerHTML = html;
  }

  /** Forget the current pool so a failed lookup can never leave stale numbers on screen. */
  function clearResults() {
    $('#results').classList.add('hidden');
    $('#results').innerHTML = '';
    state.pool = null; state.result = null; state.cross = null; state.hist = [];
    state.histError = null; state.candidates = []; state.siblings = null; state.baseFeeInfo = null;
  }

  function setBusy(busy, label) {
    const btn = $('#analyzeBtn');
    btn.disabled = busy;
    btn.textContent = busy ? (label || 'Analysing…') : 'Analyse pool';
  }

  const EXPLORERS = {
    eth: 'ethereum', arbitrum: 'arbitrum', optimism: 'optimism', base: 'base',
    polygon_pos: 'polygon', bsc: 'bsc', avax: 'avalanche', solana: 'solana'
  };

  function gtLink(pool) {
    return 'https://www.geckoterminal.com/' + encodeURIComponent(pool.network) +
      '/pools/' + encodeURIComponent(pool.address);
  }

  /* --------------------------------------------------------------- main flow */

  async function analyze(rawInput) {
    const input = (rawInput === undefined ? $('#poolUrl').value : rawInput).trim();
    state.input = input;
    $('#poolUrl').value = input;

    const target = LP.parse.parseInput(input);
    state.target = target;

    if (target.kind === 'none') {
      clearResults();
      setStatus('error', '<strong>Could not read that link.</strong> ' + esc(target.reason));
      return;
    }

    setBusy(true, 'Looking up pool…');
    setStatus('info', 'Resolving ' + esc(target.address || (target.addresses || []).join(', ')) +
      (target.chain ? ' on <code>' + esc(target.chain) + '</code>' : ' (chain not named in the URL)') + '…');

    try {
      const resolved = await LP.api.resolvePool(target);
      if (!resolved.pool) {
        clearResults();
        setStatus('error',
          '<strong>No pool found for that address.</strong> The data sources index most DEXes but ' +
          'not all of them, and very new pools can take a while to appear. Double-check that the ' +
          'address is the pool/pair contract rather than a token or a router.');
        return;
      }

      state.pool = resolved.pool;
      state.candidates = resolved.candidates;
      state.matchedBy = resolved.matchedBy;
      state.siblings = null;

      setBusy(true, 'Fetching history…');
      state.histError = null;
      const [cross, hist] = await Promise.all([
        LP.api.crossCheck(state.pool),
        // A failed history fetch degrades the analysis rather than killing it, but the reason
        // has to reach the user — otherwise the range panels just say "no history" and lie by
        // omission about why.
        LP.api.history(state.pool, 180).catch((e) => {
          state.histError = e.message || String(e);
          return [];
        })
      ]);
      state.cross = cross;
      state.hist = hist || [];
      if (!state.hist.length && !state.histError) {
        state.histError = 'The data source has no daily price history for this pool yet. That is ' +
          'normal for pools created in the last day or two.';
      }

      state.baseFeeInfo = LP.fees.resolve(state.pool);
      state.overrides.fee = null;
      state.overrides.lpShare = null;
      LP.whatif.reset();

      // Start with a range width that reflects how this pair actually moves over the hold period.
      const suggestion = LP.backtest.suggestRange(
        state.hist.slice(-state.assumptions.holdDays), 0.9);
      if (suggestion) state.assumptions.rangePct = U.clamp(suggestion.widthPct, 2, 95);

      const notes = [];
      if (state.matchedBy === 'token') {
        notes.push('<strong>That looked like a token address, not a pool.</strong> Showing the ' +
          'deepest pool that trades it — use the pool picker below to switch.');
      }
      if (state.histError) {
        notes.push('<strong>No price history loaded.</strong> ' + esc(state.histError) +
          ' The impermanent-loss and range panels are limited without it.');
      }
      setStatus(notes.length ? 'warn' : null, notes.join('<br>'));

      recompute();
      $('#results').classList.remove('hidden');
    } catch (err) {
      clearResults();
      const isRate = err instanceof LP.api.RateLimitError;
      setStatus(isRate ? 'warn' : 'error',
        '<strong>' + (isRate ? 'Rate limited.' : 'Lookup failed.') + '</strong> ' + esc(err.message || String(err)));
    } finally {
      setBusy(false);
    }
  }

  function currentFeeInfo() {
    const base = state.baseFeeInfo;
    if (!base) return null;
    const info = Object.assign({}, base);
    if (state.overrides.fee !== null) { info.fee = state.overrides.fee; info.confidence = 'manual'; }
    if (state.overrides.lpShare !== null) { info.lpShare = state.overrides.lpShare; }
    return info;
  }

  function recompute() {
    if (!state.pool) return;
    state.result = LP.analyze.run({
      pool: state.pool,
      cross: state.cross,
      hist: state.hist,
      feeInfo: currentFeeInfo(),
      assumptions: state.assumptions
    });
    render(state.result);
  }

  /* ---------------------------------------------------------------- rendering */

  function render(r) {
    $('#results').innerHTML = [
      renderHeader(r),
      renderVerdict(r),
      renderMetrics(r),
      renderAssumptions(r),
      renderGoalVR(r),
      renderGoalFeesVsIl(r),
      r.isCl ? renderGoalRange(r) : renderNonClNote(r),
      LP.whatif.render(r),
      LP.whatif.renderFormulas(r),
      renderFlags(r),
      renderCandidates(),
      renderSiblings(),
      renderProvenance(r)
    ].join('\n');
    wrapWideTables();
    wireResultEvents();
    LP.whatif.wire();
  }

  /*
   * The comparison tables have too many columns for a phone. Wrapping every table in its own
   * scroll box here keeps the templates clean and guarantees the page body never scrolls
   * sideways, whichever table a future panel adds.
   */
  function wrapWideTables() {
    document.querySelectorAll('#results table').forEach((t) => {
      if (t.parentElement && t.parentElement.classList.contains('table-scroll')) return;
      const box = document.createElement('div');
      box.className = 'table-scroll';
      t.parentNode.insertBefore(box, t);
      box.appendChild(t);
    });
  }

  function renderHeader(r) {
    const p = r.pool;
    const ageDays = U.age(p.createdAt);
    const feeBadge = {
      api: 'read from pool', name: 'read from pool name', known: 'DEX default',
      assumed: 'assumed', manual: 'your override'
    }[r.fees.confidence] || 'unknown';

    const links = [
      '<a href="' + esc(gtLink(p)) + '" target="_blank" rel="noopener">GeckoTerminal</a>',
      r.cross && r.cross.url ? '<a href="' + esc(r.cross.url) + '" target="_blank" rel="noopener">DexScreener</a>' : ''
    ].filter(Boolean).join('<span class="sep">·</span>');

    return `
    <section class="card head">
      <div class="head-main">
        <h2>${esc(p.poolName || p.name || 'Pool')}</h2>
        <div class="head-meta">
          <span class="tag">${esc(r.feeInfo.profile.label)}</span>
          <span class="tag">${esc(p.network)}</span>
          <span class="tag">${esc(r.poolType === 'cl' ? 'concentrated liquidity' : r.poolType === 'cpmm' ? 'constant product (50/50)' : r.poolType)}</span>
          <span class="tag">fee ${U.pct(r.fees.feePct, 2)} <em>(${esc(feeBadge)})</em></span>
          ${ageDays !== null ? '<span class="tag">age ' + esc(U.ageLabel(ageDays)) + '</span>' : ''}
        </div>
        <div class="head-links">${links}</div>
      </div>
      <div class="head-price">
        <div class="kv"><span>1 ${esc(p.baseSymbol || 'base')}</span><strong>${U.price(p.basePriceInQuote)} ${esc(p.quoteSymbol || 'quote')}</strong></div>
        <div class="kv"><span>24h</span><strong class="${(p.priceChange.h24 || 0) >= 0 ? 'up' : 'down'}">${U.signedPct(p.priceChange.h24)}</strong></div>
      </div>
    </section>`;
  }

  function renderVerdict(r) {
    const o = r.overall;
    const goals = [
      {
        n: 1, title: 'Time in range',
        score: r.rangeScore,
        text: r.isCl
          ? (r.range && r.range.backtest
              ? 'A &plusmn;' + U.ratio(r.range.widthPct, 0) + '% range would have held the price ' +
                U.pct(r.range.backtest.pctTimeInRange, 0) + ' of the last ' + r.range.backtest.windowDays + ' days.'
              : 'Not enough price history to backtest a range.')
          : 'Not applicable — this is a full-range pool, so there is no range to fall out of.'
      },
      {
        n: 2, title: 'V/R ratio',
        score: r.vr.score,
        text: r.vr.d3 !== null || r.vr.h24 !== null
          ? 'Turning over ' + U.ratio(r.vr.d3 !== null ? r.vr.d3 : r.vr.h24) + 'x its reserves per day ' +
            'against a 0.25 benchmark.'
          : 'No volume data.'
      },
      {
        n: 3, title: 'Fees beat holding',
        score: r.il.score,
        text: r.il.realised && r.il.realised.feePct !== null
          ? 'Over the last ' + r.il.realised.windowDays + ' days: ' + U.pct(r.il.realised.feePct) +
            ' in fees against ' + U.pct(r.il.realised.ilPct) + ' impermanent loss.'
          : 'Not enough history to compare fees against divergence.'
      }
    ];

    const rows = goals.map((g) => `
      <div class="goal">
        <div class="goal-n">${g.n}</div>
        <div class="goal-body">
          <div class="goal-top">
            <strong>${esc(g.title)}</strong>
            ${g.score === null ? '<span class="score na">n/a</span>'
              : '<span class="score ' + esc(LP.analyze.grade(g.score).key) + '">' + Math.round(g.score) + '</span>'}
          </div>
          <p>${g.text}</p>
          ${g.score === null ? '' : '<div class="bar"><i class="' + esc(LP.analyze.grade(g.score).key) + '" style="width:' + U.clamp(g.score, 0, 100) + '%"></i></div>'}
        </div>
      </div>`).join('');

    const crit = r.flags.filter((f) => f.level === 'critical');

    return `
    <section class="card verdict">
      <div class="verdict-head">
        <div>
          <h3>Verdict</h3>
          <p class="muted">Scored against the three goals of an LP: hold your range, earn a high
          volume-to-reserves ratio, and out-earn simply holding the two tokens.</p>
        </div>
        ${o
          ? '<div class="overall ' + esc(o.grade.key) + '"><span>' + Math.round(o.score) + '</span><em>' + esc(o.grade.label) + '</em></div>'
          : '<div class="overall na"><span>?</span><em>Incomplete</em></div>'}
      </div>
      ${r.incomplete ? '<div class="verdict-cap neutral">' + esc(r.incomplete) + '</div>' : ''}
      ${crit.length ? '<div class="verdict-cap">Capped by a critical risk flag: ' + esc(crit.map((c) => c.title).join('; ')) + '.</div>' : ''}
      <div class="goals">${rows}</div>
    </section>`;
  }

  function metric(label, value, sub, cls) {
    return `<div class="metric ${cls || ''}">
      <span class="m-label">${label}</span>
      <span class="m-value">${value}</span>
      ${sub ? '<span class="m-sub">' + sub + '</span>' : ''}
    </div>`;
  }

  function renderMetrics(r) {
    const p = r.pool;
    const s = r.stats;
    const vrCls = r.vr.h24 === null ? '' : r.vr.h24 >= r.vr.benchmark ? 'good' : 'weak';

    return `
    <section class="card">
      <h3>Pool at a glance</h3>
      <div class="metrics">
        ${metric('Liquidity (TVL)', U.usd(p.tvlUsd), r.cross && r.cross.tvlUsd !== null
            ? 'DexScreener: ' + U.usd(r.cross.tvlUsd) : 'single source')}
        ${metric('Volume 24h', U.usd(p.volume.h24), '6h &times;4: ' + U.usd((p.volume.h6 || 0) * 4))}
        ${metric('V/R ratio 24h', U.ratio(r.vr.h24), 'benchmark 0.25 · 3-day: ' + U.ratio(r.vr.d3), vrCls)}
        ${metric('Fee APR (swap fees only)', r.fees.aprFullRange === null ? '—' : U.pct(r.fees.aprFullRange, 1),
            'at ' + U.pct(r.fees.feePct, 2) + ' fee, LP keeps ' + U.pct(r.fees.lpShare * 100, 0))}
        ${metric('Realised volatility', s && s.volAnnual !== null ? U.pct(s.volAnnual * 100, 0) + ' ann.' : '—',
            s ? 'over ' + Math.round(s.days) + ' days of daily bars' : 'no history')}
        ${metric('Chop vs trend', s ? U.pct(s.chop * 100, 0) + ' chop' : '—',
            s ? (s.chop > 0.7 ? 'choppy — good for LPs' : s.chop > 0.45 ? 'mixed' : 'trending — bad for LPs') : '')}
        ${metric('Pair regime', esc(r.regime.label), esc(r.regime.note || ''))}
        ${metric('Fees paid by traders / day', U.usd(r.fees.poolPerDay),
            'your share on ' + U.usd(r.assumptions.positionUsd) + ': ' + U.usd(r.fees.onPositionPerDay) + '/day')}
      </div>
    </section>`;
  }

  function renderAssumptions(r) {
    return `
    <section class="card assumptions">
      <h3>Assumptions <span class="muted">— change these and every number updates</span></h3>
      <div class="fields">
        <label>Position size (USD)
          <input type="number" id="aPosition" min="1" step="100" value="${r.assumptions.positionUsd}">
        </label>
        <label>Swap fee (%)
          <input type="number" id="aFee" min="0" max="10" step="0.01" value="${r.fees.feePct}">
          <em>${esc({ api: 'read from the pool', name: 'parsed from the pool name', known: 'this DEX\'s default', assumed: 'assumed — please verify', manual: 'your value' }[r.fees.confidence] || '')}</em>
        </label>
        <label>LP share of the fee (%)
          <input type="number" id="aLpShare" min="0" max="100" step="1" value="${Math.round(r.fees.lpShare * 100)}">
          <em>the rest goes to treasury, voters or buybacks</em>
        </label>
        <label>Hold period (days)
          <input type="number" id="aHold" min="1" max="365" step="1" value="${r.assumptions.holdDays}">
        </label>
        ${r.isCl ? `<label>Range width (&plusmn;%)
          <input type="number" id="aRange" min="0.5" max="95" step="0.5" value="${r.assumptions.rangePct}">
          <em>percent of the entry price, each side</em>
        </label>` : ''}
      </div>
    </section>`;
  }

  function renderGoalVR(r) {
    const rows = [
      ['Last 24 hours', r.vr.h24],
      ['Last 6 hours, annualised to a day', r.vr.h6x4],
      ['3-day average', r.vr.d3]
    ].map(([label, v]) => `
      <tr>
        <td>${esc(label)}</td>
        <td class="num">${U.ratio(v)}</td>
        <td class="num">${v === null ? '—' : U.pct(v * (r.fees.feePct / 100) * r.fees.lpShare * 365 * 100, 1)}</td>
        <td>${v === null ? '' : (v >= r.vr.benchmark ? '<span class="pill good">above benchmark</span>' : '<span class="pill weak">below benchmark</span>')}</td>
      </tr>`).join('');

    return `
    <section class="card">
      <h3>Goal 2 — Volume / Reserves</h3>
      <p class="muted">The single most useful screening metric: how much volume the pool does relative
      to its own size. High volume with little price divergence is the whole game. The 0.25-over-1-to-3-days
      benchmark comes straight from the OTS notes.</p>
      <table>
        <thead><tr><th>Window</th><th class="num">V/R</th><th class="num">Implied fee APR</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
  }

  function renderGoalFeesVsIl(r) {
    const be = r.il.breakeven;
    const rows = r.il.scenarios.map((s) => `
      <tr>
        <td class="num">${U.signedPct(s.movePct, 0)}</td>
        <td class="num down">${U.pct(s.ilPct)}</td>
        <td class="num">${s.netPct === null ? '—' : '<span class="' + (s.netPct >= 0 ? 'up' : 'down') + '">' + U.signedPct(s.netPct) + '</span>'}</td>
      </tr>`).join('');

    const realised = r.il.realised;

    return `
    <section class="card">
      <h3>Goal 3 — Do fees beat just holding?</h3>
      <p class="muted">Impermanent loss is measured against holding the two tokens, using the
      constant-product formula 2&radic;r/(1+r)&minus;1. Fees are swap fees only.</p>

      <div class="callout">
        Over ${r.il.holdDays} days this pool's fee rate accrues
        <strong>${r.il.feeYieldOverHold === null ? '—' : U.pct(r.il.feeYieldOverHold * 100)}</strong>,
        which covers a price divergence of about
        <strong>${be === null ? 'any move' : U.signedPct(be.up * 100, 1) + ' / ' + U.signedPct(be.down * 100, 1)}</strong>
        before you would have been better off holding.
      </div>

      <div class="split">
        <div>
          <h4>Scenario table (${r.il.holdDays}-day hold)</h4>
          <table>
            <thead><tr><th class="num">Price move</th><th class="num">IL</th><th class="num">Net with fees</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div>
          <h4>What actually happened</h4>
          ${realised && realised.feePct !== null ? `
          <table>
            <tbody>
              <tr><td>Window</td><td class="num">${realised.windowDays} days</td></tr>
              <tr><td>Price move (base vs quote)</td><td class="num">${U.signedPct(realised.movePct)}</td></tr>
              <tr><td>Impermanent loss</td><td class="num down">${U.pct(realised.ilPct)}</td></tr>
              <tr><td>Fees earned</td><td class="num up">${U.pct(realised.feePct)}</td></tr>
              <tr class="total"><td>Net vs holding</td><td class="num ${realised.netPct >= 0 ? 'up' : 'down'}">${U.signedPct(realised.netPct)}</td></tr>
            </tbody>
          </table>
          <p class="fineprint">Uses each day's real volume against today's TVL, because historical
          reserves aren't available from the free endpoints. If the pool has grown, this overstates
          past fees; if it has shrunk, it understates them.</p>
          ` : '<p class="muted">' + esc(state.histError || 'Not enough price history for this pool.') + '</p>'}
        </div>
      </div>
    </section>`;
  }

  function renderGoalRange(r) {
    const range = r.range;
    if (!range) return '';
    const bt = range.backtest;
    const bars = range.bars || [];
    const suggestion = LP.backtest.suggestRange(bars, 0.9);
    const sweep = bars.length
      ? LP.backtest.sweep(bars, {
          lpFeeFrac: (r.fees.feePct / 100) * r.fees.lpShare,
          tvl: r.pool.tvlUsd
        })
      : [];

    const sweepRows = sweep.map((s) => `
      <tr class="${Math.abs(s.widthPct - range.widthPct) < 0.51 ? 'here' : ''}">
        <td class="num">&plusmn;${s.widthPct}%</td>
        <td class="num">${U.ratio(s.efficiency, 1)}&times;</td>
        <td class="num">${U.pct(s.pctTimeInRange, 0)}</td>
        <td class="num up">${U.pct(s.feesPct, 1)}</td>
        <td class="num down">${U.pct(s.ilPct, 1)}</td>
        <td class="num"><span class="${s.netVsHodlPct >= 0 ? 'up' : 'down'}">${U.signedPct(s.netVsHodlPct, 1)}</span></td>
      </tr>`).join('');

    return `
    <section class="card">
      <h3>Goal 1 — Would your range have held?</h3>
      <p class="muted">This is the hard part. A tighter range multiplies your fees while the price
      stays inside it and earns nothing when it doesn't. Below is a replay of the last
      ${bt ? bt.windowDays : r.assumptions.holdDays} days of real daily bars — the same window as your
      hold period — with the range centred on the price at the <em>start</em> of that window rather
      than today's price, so the result doesn't flatter itself.</p>

      <div class="metrics">
        ${metric('Capital efficiency', range.efficiency === null ? '—' : U.ratio(range.efficiency, 1) + '&times;',
            'vs a full-range position of the same size')}
        ${metric('Fee APR while in range', range.feeAprInRange === null ? '—' : U.pct(range.feeAprInRange, 1),
            'accrues only while in range — full range would be ' + U.pct(r.fees.aprFullRange, 1) + ' all the time')}
        ${bt ? metric('Time in range', U.pct(bt.pctTimeInRange, 0),
            bt.daysInRange + ' of ' + bt.windowDays + ' days closed inside', bt.pctTimeInRange >= 70 ? 'good' : 'weak') : ''}
        ${bt ? metric('First touch outside', bt.daysUntilFirstExit === null ? 'never' : 'day ' + bt.daysUntilFirstExit,
            bt.daysTouchedOut + ' days traded outside the range intraday') : ''}
      </div>

      ${bt ? `
      <div class="split">
        <div>
          <h4>Backtest result (&plusmn;${U.ratio(bt.widthPct, 1)}% over ${bt.windowDays} days)</h4>
          <table>
            <tbody>
              <tr><td>Entry price</td><td class="num">${U.price(bt.entryPrice)}</td></tr>
              <tr><td>Range</td><td class="num">${U.price(bt.pa)} – ${U.price(bt.pb)}</td></tr>
              <tr><td>Final price</td><td class="num">${U.price(bt.finalPrice)} (${U.signedPct(bt.priceMovePct)})</td></tr>
              <tr><td>Fees earned</td><td class="num up">${U.pct(bt.feesPct, 1)}</td></tr>
              <tr><td>Impermanent loss</td><td class="num down">${U.pct(bt.ilPct, 1)}</td></tr>
              <tr class="total"><td>Net vs holding</td><td class="num ${bt.netVsHodlPct >= 0 ? 'up' : 'down'}">${U.signedPct(bt.netVsHodlPct, 1)}</td></tr>
            </tbody>
          </table>
          ${suggestion ? '<p class="fineprint">The narrowest symmetric range that would have held ' +
            'the price 90% of this window is <strong>&plusmn;' + suggestion.widthPct + '%</strong>.</p>'
            : '<p class="fineprint">No symmetric range up to &plusmn;95% would have held the price 90% of this window — this pair moves too far to make a static range work.</p>'}
        </div>
        <div>
          <h4>Price path vs range</h4>
          ${sparkline(bt)}
        </div>
      </div>

      <h4>Width trade-off</h4>
      <table>
        <thead><tr><th class="num">Width</th><th class="num">Efficiency</th><th class="num">In range</th>
          <th class="num">Fees</th><th class="num">IL</th><th class="num">Net vs holding</th></tr></thead>
        <tbody>${sweepRows}</tbody>
      </table>
      <p class="fineprint">Assumes the rest of the pool's liquidity distribution stays as it is today,
      and that you never rebalance. Real managed positions rebalance, which converts some IL into
      realised loss but keeps fees flowing.</p>
      ` : '<p class="muted">' + esc(state.histError || 'Not enough daily history to backtest this range.') + '</p>'}
    </section>`;
  }

  function renderNonClNote(r) {
    return `
    <section class="card">
      <h3>Goal 1 — Time in range</h3>
      <p class="muted">Not applicable: ${esc(r.feeInfo.profile.label)} is a full-range pool, so your
      liquidity is always active and you never fall out of range. The trade-off is capital efficiency
      — a concentrated pool earns the same fees on far less capital, at the cost of having to manage
      the range.</p>
    </section>`;
  }

  /** Small inline SVG of the backtested path with the range band drawn on. */
  function sparkline(bt) {
    const pts = bt.series;
    if (!pts || pts.length < 2) return '';
    const W = 420, H = 160, pad = 6;
    const prices = pts.map((p) => p.price);
    const lo = Math.min(Math.min.apply(null, prices), bt.pa);
    const hi = Math.max(Math.max.apply(null, prices), bt.pb);
    const span = hi - lo || 1;
    const x = (i) => pad + (i / (pts.length - 1)) * (W - 2 * pad);
    const y = (p) => pad + (1 - (p - lo) / span) * (H - 2 * pad);

    const path = pts.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.price).toFixed(1)).join(' ');
    const bandY = y(bt.pb), bandH = Math.max(1, y(bt.pa) - y(bt.pb));

    return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="Price path with the backtested range band">
      <rect x="${pad}" y="${bandY.toFixed(1)}" width="${W - 2 * pad}" height="${bandH.toFixed(1)}"
        class="band"></rect>
      <path d="${path}" class="line"></path>
    </svg>
    <div class="spark-legend"><span class="sw band"></span>range
      <span class="sw line"></span>price (${esc(bt.windowDays)} days, oldest left)</div>`;
  }

  function renderFlags(r) {
    const order = { critical: 0, warn: 1, info: 2 };
    const flags = r.flags.slice().sort((a, b) => order[a.level] - order[b.level]);
    const items = flags.map((f) => `
      <li class="flag ${esc(f.level)}">
        <strong>${esc(f.title)}</strong>
        <p>${esc(f.detail)}</p>
      </li>`).join('');
    return `
    <section class="card">
      <h3>Risk flags</h3>
      <ul class="flags">${items}</ul>
    </section>`;
  }

  function renderCandidates() {
    const list = state.candidates || [];
    if (list.length < 2) return '';
    const rows = list.slice(0, 8).map((c, i) => `
      <tr class="${c.address === state.pool.address && c.network === state.pool.network ? 'here' : ''}">
        <td>${esc(c.poolName || c.name || '')}</td>
        <td>${esc(c.network)}</td>
        <td>${esc(c.dexId || '')}</td>
        <td class="num">${U.usd(c.tvlUsd)}</td>
        <td class="num">${U.usd(c.volume.h24)}</td>
        <td><button class="link" data-pick="${i}">use this</button></td>
      </tr>`).join('');
    return `
    <section class="card">
      <h3>Other matches for that address</h3>
      <p class="muted">The same address exists on chain forks, and a token address matches many
      pools. We picked the deepest one that matched the chain in your URL.</p>
      <table>
        <thead><tr><th>Pool</th><th>Chain</th><th>DEX</th><th class="num">TVL</th><th class="num">Vol 24h</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
  }

  function renderSiblings() {
    if (state.siblings === null) {
      return `
      <section class="card">
        <h3>Is this the best pool for this pair?</h3>
        <p class="muted">The same pair often runs several pools side by side at different fee tiers.
        The deepest one is not always the best one to LP in — a smaller pool at a higher fee tier can
        have a much better V/R ratio.</p>
        <button class="btn secondary" id="siblingsBtn">Compare pools for this pair</button>
      </section>`;
    }
    if (!state.siblings.length) {
      return `<section class="card"><h3>Pools for this pair</h3>
        <p class="muted">No sibling pools found for this pair on ${esc(state.pool.network)}.</p></section>`;
    }
    /*
     * The token-pools endpoint doesn't carry pool_fee_percentage, but CL pool names do
     * ("WETH / USDC 0.05%"), so resolve() recovers most of them. Where the fee had to be
     * assumed, say so instead of quietly comparing pools on a made-up number.
     */
    let anyAssumed = false;
    const rows = state.siblings.map((p) => {
      const f = LP.fees.resolve(p);
      const assumed = f.confidence === 'assumed';
      if (assumed) anyAssumed = true;
      const vr = p.tvlUsd > 0 && p.volume.h24 !== null ? p.volume.h24 / p.tvlUsd : null;
      const apr = vr === null ? null : vr * (f.fee / 100) * f.lpShare * 365 * 100;
      const isHere = p.address === state.pool.address;
      return `<tr class="${isHere ? 'here' : ''}">
        <td>${esc(p.name || p.poolName || '')}${isHere ? ' <em>(this one)</em>' : ''}</td>
        <td>${esc(p.dexId || '')}</td>
        <td class="num">${U.pct(f.fee, 2)}${assumed ? '<em title="fee not published for this pool">*</em>' : ''}</td>
        <td class="num">${U.usd(p.tvlUsd)}</td>
        <td class="num">${U.usd(p.volume.h24)}</td>
        <td class="num">${U.ratio(vr)}</td>
        <td class="num">${apr === null ? '—' : U.pct(apr, 1) + (assumed ? '<em>*</em>' : '')}</td>
        <td>${isHere ? '' : '<button class="link" data-sibling="' + esc(p.network + '|' + p.address) + '">analyse</button>'}</td>
      </tr>`;
    }).join('');
    return `
    <section class="card">
      <h3>Pools for this pair</h3>
      <table>
        <thead><tr><th>Pool</th><th>DEX</th><th class="num">Fee</th><th class="num">TVL</th>
          <th class="num">Vol 24h</th><th class="num">V/R</th><th class="num">Fee APR</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="fineprint">Fee APR uses each pool's own fee tier and this tool's LP-share assumption for
      that DEX${anyAssumed ? ', except where marked <em>*</em> — those pools don\'t publish a fee, so a ' +
      'DEX default was assumed and the APR could be off by several times' : ''}. Compare on V/R first:
      it is the part that isn't assumed.</p>
    </section>`;
  }

  function renderProvenance(r) {
    const notes = (r.feeInfo.notes || []).map((n) => '<li>' + esc(n) + '</li>').join('');
    return `
    <section class="card provenance">
      <h3>Where these numbers came from</h3>
      <ul>
        <li>Pool state, fee tier and daily price history: GeckoTerminal (CoinGecko on-chain), pool
          <code>${esc(r.pool.address)}</code> on <code>${esc(r.pool.network)}</code>.</li>
        <li>Cross-check of liquidity and volume: ${r.cross ? 'DexScreener (TVL ' + U.usd(r.cross.tvlUsd) +
          ', 24h volume ' + U.usd(r.cross.volume24h) + ')' : 'not available for this pool'}.</li>
        <li>Price history: ${state.hist.length} daily bars, base priced in the quote token.</li>
        ${notes}
      </ul>
      <p class="fineprint">This is a screening tool, not advice. Fee APR is an extrapolation of recent
      volume and will not repeat. Nothing here accounts for token emissions, gas, MEV, rebalancing
      costs, smart-contract risk or the tokens themselves going to zero.</p>
    </section>`;
  }

  /* ------------------------------------------------------------ event wiring */

  function wireResultEvents() {
    const bind = (id, key, transform) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => {
        const v = parseFloat(el.value);
        if (!Number.isFinite(v)) return;
        transform(v);
        recompute();
      });
    };

    bind('aPosition', null, (v) => { state.assumptions.positionUsd = Math.max(1, v); });
    bind('aHold', null, (v) => { state.assumptions.holdDays = U.clamp(Math.round(v), 1, 365); });
    bind('aRange', null, (v) => { state.assumptions.rangePct = U.clamp(v, 0.5, 95); });
    bind('aFee', null, (v) => { state.overrides.fee = U.clamp(v, 0, 10); });
    bind('aLpShare', null, (v) => { state.overrides.lpShare = U.clamp(v, 0, 100) / 100; });

    document.querySelectorAll('[data-pick]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idx = +btn.getAttribute('data-pick');
        const pick = state.candidates[idx];
        if (!pick) return;
        await analyze(gtLink(pick));
      });
    });

    document.querySelectorAll('[data-sibling]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const [net, addr] = btn.getAttribute('data-sibling').split('|');
        await analyze('https://www.geckoterminal.com/' + net + '/pools/' + addr);
      });
    });

    const sb = document.getElementById('siblingsBtn');
    if (sb) {
      sb.addEventListener('click', async () => {
        sb.disabled = true;
        sb.textContent = 'Loading…';
        try {
          state.siblings = await LP.api.siblingPools(state.pool);
        } catch (e) {
          state.siblings = [];
          setStatus('warn', '<strong>Could not load sibling pools.</strong> ' + esc(e.message || String(e)));
        }
        render(state.result);
      });
    }
  }

  function init() {
    $('#analyzeBtn').addEventListener('click', () => analyze());
    $('#poolUrl').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); analyze(); }
    });
    document.querySelectorAll('[data-example]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        analyze(el.getAttribute('data-example'));
      });
    });

    // Deep link support: index.html?url=<pool url>
    const q = new URLSearchParams(location.search).get('url');
    if (q) analyze(q);
  }

  return { init, analyze, state };
})();

document.addEventListener('DOMContentLoaded', LP.ui.init);
