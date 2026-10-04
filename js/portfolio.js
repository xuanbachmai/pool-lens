/*
 * Every position at once.
 *
 * The rest of the app is built around one pool. Real LPs hold several, and the questions that
 * matter across a book are different ones: which position needs attention first, how much of
 * my capital is sitting out of range earning nothing, am I unknowingly concentrated in one
 * token or one chain.
 *
 * Positions come from the same localStorage the analyser writes, so nothing new has to be
 * entered. Live pool state is re-fetched per position -- one GeckoTerminal call each, spaced by
 * the api module's own queue, so a book of ten stays inside the free tier's limit.
 */
window.LP = window.LP || {};

LP.portfolio = (function () {
  const U = () => LP.util;
  const esc = (s) => LP.util.escapeHtml(s);
  const $ = (id) => document.getElementById(id);

  const state = { rows: [], loading: false, errors: [], throttled: 0 };

  /* -------------------------------------------------------------------- load */

  async function load() {
    const saved = LP.position.listAll();
    if (!saved.length) return render();

    state.loading = true;
    state.errors = [];
    state.throttled = 0;
    state.rows = [];
    render();

    for (const entry of saved) {
      const [network, address] = String(entry.key || '').split(':');
      if (!network || !address) continue;
      try {
        const res = await LP.api.gtPool(network, address);
        const pool = res && res.data ? LP.api.shapeGtPool(res.data) : null;
        if (!pool) throw new Error('pool not found');

        /*
          * Each position costs two calls to a free tier that allows about 30 a minute, so a
          * large book runs out partway through. History is the expendable half -- without it
          * the position still shows, but with no fee figures -- so the failure is counted and
          * reported rather than leaving blank numbers that look like zero.
          */
        let hist = [];
        try {
          hist = await LP.api.history(pool, 180);
        } catch (e) {
          if (e instanceof LP.api.RateLimitError) state.throttled++;
          hist = [];
        }
        const feeInfo = LP.fees.resolve(pool);
        const cross = await LP.api.crossCheck(pool).catch(() => null);

        // Reuse the real analysis so a position is judged exactly as it is on its own page.
        const result = LP.analyze.run({
          pool, cross, hist, feeInfo,
          assumptions: {
            positionUsd: entry.sizeUsd,
            holdDays: 30,
            rangePct: entry.rangePct || 20
          }
        });
        const perf = LP.position.performance(result, entry);
        const strategies = LP.strategy.build(result, entry, perf);
        const alerts = LP.strategy.alerts(result, entry, perf);

        // An entry price in the wrong units produces a confident -100%, which would drag the
        // book's totals somewhere meaningless. Keep the row, exclude it from the maths.
        state.rows.push({ key: entry.key, pos: entry, pool, result, perf, strategies, alerts,
                          suspect: !perf.plausible });
      } catch (e) {
        state.errors.push((entry.label || entry.key) + ': ' + (e.message || String(e)));
      }
      render();
    }
    state.loading = false;
    render();
  }

  /* ------------------------------------------------------------------ totals */

  function totals() {
    const rows = state.rows.filter((r) => !r.suspect);
    const excluded = state.rows.length - rows.length;
    if (!rows.length) return excluded ? { excluded, n: 0 } : null;

    const capital = rows.reduce((a, r) => a + r.pos.sizeUsd, 0);
    const netUsd = rows.reduce((a, r) => a + (r.perf.netUsd || 0), 0);
    const feesUsd = rows.reduce((a, r) => a + (r.perf.feesUsd || 0), 0);
    const ilUsd = rows.reduce((a, r) => a + (r.perf.ilUsd || 0), 0);

    // Capital earning nothing because its range broke. The number nobody tracks.
    const idle = rows.filter((r) => r.perf.bounds && !r.perf.inRangeNow);
    const idleUsd = idle.reduce((a, r) => a + r.pos.sizeUsd, 0);

    const behind = rows.filter((r) => r.perf.netPct < 0);

    // Concentration: a book of five positions that are all the same token is one position.
    const byToken = new Map();
    const byChain = new Map();
    rows.forEach((r) => {
      [r.pool.baseSymbol, r.pool.quoteSymbol].filter(Boolean).forEach((sym) => {
        // Each side is roughly half a 50/50 position's value.
        byToken.set(sym, (byToken.get(sym) || 0) + r.pos.sizeUsd / 2);
      });
      byChain.set(r.pool.network, (byChain.get(r.pool.network) || 0) + r.pos.sizeUsd);
    });
    const topToken = [...byToken.entries()].sort((a, b) => b[1] - a[1])[0];
    const topChain = [...byChain.entries()].sort((a, b) => b[1] - a[1])[0];

    return {
      excluded,
      n: rows.length, capital, netUsd, feesUsd, ilUsd,
      netPct: capital > 0 ? (netUsd / capital) * 100 : 0,
      idleCount: idle.length, idleUsd,
      idlePct: capital > 0 ? (idleUsd / capital) * 100 : 0,
      behindCount: behind.length,
      topToken, topChain,
      topTokenPct: topToken && capital > 0 ? (topToken[1] / capital) * 100 : 0,
      topChainPct: topChain && capital > 0 ? (topChain[1] / capital) * 100 : 0
    };
  }

  /** Rank by what needs attention, not by size. */
  function urgency(r) {
    let score = 0;
    // A bad entry price needs fixing, but it is a data problem, not a position problem --
    // ranking it above a genuinely broken range would bury the thing that costs money.
    if (r.suspect) return 5;
    if (r.perf.bounds && !r.perf.inRangeNow) score += 60;      // earning nothing
    if (r.perf.netPct < 0) score += 25;                        // behind holding
    const firedNow = r.alerts.filter((a) => a.fired).length;
    score += firedNow * 8;
    const top = r.strategies[0];
    if (top && (top.key === 'recentre' || top.key === 'exit')) score += 10;
    return score;
  }

  /* ------------------------------------------------------------------ render */

  function render() {
    const host = $('pfBody');
    if (!host) return;
    const u = U();
    const saved = LP.position.listAll();

    if (!saved.length) {
      host.innerHTML = `<section class="card">
        <h3>No positions saved yet</h3>
        <p class="muted">Analyse a pool, add your position on that page, and it will appear here.
        Positions live in this browser only — nothing is uploaded.</p>
        <p><a class="btn" href="index.html" style="display:inline-block;text-decoration:none">Analyse a pool →</a></p>
      </section>`;
      return;
    }

    const t = totals();
    const ranked = state.rows.slice().sort((a, b) => urgency(b) - urgency(a));
    const usable = t && t.n > 0;

    host.innerHTML = `
      ${state.loading ? '<div class="status status-info">Loading ' +
        (state.rows.length + 1) + ' of ' + saved.length + '…</div>' : ''}

      ${usable ? `<section class="card">
        <h3>The book</h3>
        <div class="metrics">
          ${metric('Capital deployed', u.usd(t.capital), t.n + ' position' + (t.n === 1 ? '' : 's'))}
          ${metric('Net vs holding', u.signedPct(t.netPct, 2),
            u.usd(t.netUsd) + ' · ' + u.usd(t.feesUsd) + ' fees, ' + u.usd(t.ilUsd) + ' IL',
            t.netUsd >= 0 ? 'good' : 'weak')}
          ${metric('Capital earning nothing', u.pct(t.idlePct, 0),
            t.idleCount + ' position' + (t.idleCount === 1 ? '' : 's') + ' out of range · ' +
            u.usd(t.idleUsd), t.idlePct > 0 ? 'weak' : 'good')}
          ${metric('Behind holding', t.behindCount + ' of ' + t.n,
            'positions where fees have not covered divergence',
            t.behindCount > t.n / 2 ? 'weak' : '')}
          ${t.topToken ? metric('Largest token exposure', esc(t.topToken[0]),
            u.pct(t.topTokenPct, 0) + ' of the book · ' + u.usd(t.topToken[1]),
            t.topTokenPct > 50 ? 'weak' : '') : ''}
          ${t.topChain ? metric('Largest chain exposure', esc(t.topChain[0]),
            u.pct(t.topChainPct, 0) + ' of the book', t.topChainPct > 70 ? 'weak' : '') : ''}
        </div>
        ${t.idlePct >= 15 ? '<div class="callout warn"><strong>' + u.pct(t.idlePct, 0) +
          ' of your capital is sitting outside its range.</strong> That portion is fully ' +
          'converted to one token and collecting no fees at all while it waits.</div>' : ''}
        ${t.topTokenPct >= 40 ? '<div class="callout warn"><strong>' +
          u.pct(t.topTokenPct, 0) + ' of the book is exposed to ' + esc(t.topToken[0]) +
          '.</strong> Positions in different pools are not diversification if they share a ' +
          'token — one price move moves all of them together.</div>' : ''}
        ${t.excluded ? '<div class="callout warn"><strong>' + t.excluded + ' position' +
          (t.excluded === 1 ? '' : 's') + ' excluded from these totals.</strong> Their entry ' +
          'price is orders of magnitude from the pool\'s current price, which usually means it ' +
          'was entered the other way round. They are listed below and flagged.</div>' : ''}
      </section>` : ''}

      ${state.throttled ? '<div class="status status-warn"><strong>' + state.throttled +
        ' position' + (state.throttled === 1 ? '' : 's') + ' loaded without price history.</strong> ' +
        'The data source allows about 30 requests a minute and this book needs two per position, ' +
        'so a long one runs out partway through. Those rows show no fee income \u2014 that is a ' +
        'missing number, not a zero. Wait a minute and reload.</div>' : ''}

      ${state.errors.length ? '<section class="card"><h3>Could not load</h3><ul class="flags">' +
        state.errors.map((e) => '<li class="flag warn"><strong>' + esc(e) + '</strong></li>').join('') +
        '</ul></section>' : ''}

      <section class="card">
        <h3>Positions, most urgent first</h3>
        <p class="muted">Ranked by what needs attention — a broken range outranks a large
        position, because capital earning nothing is the costliest state to leave alone.</p>
        <div class="pf-list">${ranked.map((r) => renderRow(r)).join('')}</div>
      </section>`;
  }

  function renderRow(r) {
    const u = U();
    const top = r.strategies[0];
    const fired = r.alerts.filter((a) => a.fired);
    const outOfRange = r.perf.bounds && !r.perf.inRangeNow;
    const good = r.perf.netPct >= 0;

    return `
      <div class="pf-row ${outOfRange ? 'urgent' : ''}">
        <div class="pf-main">
          <div class="pf-name">
            <strong>${esc(r.pool.poolName || r.pool.name || '')}</strong>
            <span class="pf-tags">
              <span class="tag">${esc(r.pool.network)}</span>
              <span class="tag">${esc(r.result.feeInfo.profile.label)}</span>
              ${outOfRange ? '<span class="pill weak">out of range</span>' : ''}
              ${r.suspect ? '<span class="pill weak">entry price looks wrong</span>' : ''}
            </span>
          </div>
          <div class="pf-numbers">
            <span><em>size</em> ${u.usd(r.pos.sizeUsd)}</span>
            <span><em>held</em> ${r.perf.daysHeld}d</span>
            <span><em>fees</em> <b class="up">${u.pct(r.perf.feesPct, 2)}</b></span>
            <span><em>IL</em> <b class="down">${u.pct(r.perf.ilPct, 2)}</b></span>
            ${r.perf.inRangePct === null ? '' :
              '<span><em>in range</em> ' + u.pct(r.perf.inRangePct, 0) + '</span>'}
          </div>
          ${top ? '<div class="pf-action"><span class="strat-tag ' + esc(top.verdict) + '">' +
            esc({ do: 'Do this', consider: 'Consider', avoid: 'Not now', info: 'Context' }[top.verdict] || '') +
            '</span> ' + esc(top.title) + '</div>' : ''}
          ${fired.length ? '<div class="pf-alerts">' + fired.map((a) =>
            '<span class="alert-flag">' + esc(a.title) + '</span>').join('') + '</div>' : ''}
        </div>
        <div class="pf-net ${good ? 'good' : 'bad'}">
          <span>${u.signedPct(r.perf.netPct, 1)}</span>
          <em>${u.usd(r.perf.netUsd)}</em>
          <a href="index.html?url=${encodeURIComponent(
            'https://www.geckoterminal.com/' + r.pool.network + '/pools/' + r.pool.address)}">open →</a>
        </div>
      </div>`;
  }

  function metric(label, value, sub, cls) {
    return `<div class="metric ${cls || ''}">
      <span class="m-label">${label}</span>
      <span class="m-value">${value}</span>
      ${sub ? '<span class="m-sub">' + sub + '</span>' : ''}
    </div>`;
  }

  function init() { load(); }

  return { init, load, render, totals, urgency, state };
})();

document.addEventListener('DOMContentLoaded', LP.portfolio.init);
