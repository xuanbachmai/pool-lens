/*
 * What this pool would actually have paid you.
 *
 * Every other yield figure in this app is forward-looking: an APR extrapolated from recent
 * volume, which will not repeat. This panel asks the backward-looking question instead -- if you
 * had put money in on a given day and left it there, what would you have now, and would you have
 * been better off simply holding the two tokens?
 *
 * That last clause is the whole point. A pool paying 40% in fees while the pair diverges 50% has
 * lost you money, and a panel reporting the 40% would be lying by omission. So the headline here
 * is always net of impermanent loss and net of the gas to get in and out, stated against holding.
 *
 * Method, carried over from backtest/ where it was validated across 27 configurations:
 *
 *   fees + emissions   DefiLlama's daily apyBase and apyReward for this exact pool, compounded
 *                      day by day rather than annualised from a single reading
 *   impermanent loss   2*sqrt(r)/(1+r) - 1 from the pool's own price bars -- path-independent,
 *                      so entry and exit prices are all it needs
 *   dilution           every day's yield is scaled by TVL/(TVL + your size), because a quoted
 *                      APY belongs to the capital already there, not to capital you add
 *   costs              gas in and out, from the per-chain table the execution panel uses
 *
 * Two honesty guards that exist because the data misbehaved during the backtest work:
 *
 *   - APY is winsorised. One pool in the backtest showed 16,247% cumulative over a year, which
 *     is the signature of TVL collapsing toward zero while the fee numerator stands still.
 *   - Concentrated pools are flagged, not silently reported. DefiLlama divides fees by the
 *     liquidity actually deployed, so for a v3-style pool apyBase is the return on in-range,
 *     actively-managed capital. It said a $156M WETH/USDC pool paid 105% in fees over a year
 *     while v2 pools read 6-9%. A passive full-range position earns nothing like that.
 */
window.LP = window.LP || {};

LP.profit = (function () {
  const U = () => LP.util;
  const esc = (s) => LP.util.escapeHtml(s);

  const DAY = 86400000;
  const APY_CAP = 300;          // %, matching backtest/run.mjs

  const local = { state: 'idle', data: null, error: null, result: null,
                  days: 90, sizeUsd: null };
  // state: idle | loading | done | absent | error

  /* ---------------------------------------------------------------- the maths */

  /** Impermanent loss against holding, for a price-ratio change r. Path-independent. */
  const il = (r) => (Number.isFinite(r) && r > 0) ? (2 * Math.sqrt(r)) / (1 + r) - 1 : null;

  /**
   * Replay one pool's history for a position opened `days` ago.
   *
   * @param history DefiLlama daily rows: { t, day, apy, apyBase, apyReward, tvlUsd }
   * @param bars    the pool's own price bars: { t, c }, used only for the price ratio
   * @param opts    { days, sizeUsd, gasUsd, poolTvlUsd }
   */
  function simulate(history, bars, opts) {
    opts = opts || {};
    const sizeUsd = num(opts.sizeUsd) || 0;
    const gasUsd = num(opts.gasUsd) || 0;
    const days = Math.max(1, opts.days || 90);

    if (!history || history.length < 2) {
      return { ok: false, reason: 'No usable history for this pool.' };
    }

    const now = history[history.length - 1].t;
    const from = now - days * DAY;
    const rows = history.filter((h) => h.t >= from);
    if (rows.length < 7) {
      return { ok: false, reason: 'Fewer than a week of history in that window.' };
    }

    // Compound each day separately so fees and emissions stay distinguishable at the end.
    let feeMult = 1, rewardMult = 1, clipped = 0;
    for (const h of rows) {
      const tvl = num(h.tvlUsd);
      const dilution = (tvl && tvl > 0 && sizeUsd > 0) ? tvl / (tvl + sizeUsd) : 1;

      let base = num(h.apyBase);
      let reward = num(h.apyReward);
      // apyBase can be null while apy is populated; attribute the remainder rather than lose it.
      if (base === null && reward === null) base = num(h.apy);
      if (base === null) base = 0;
      if (reward === null) reward = 0;

      if (base > APY_CAP) { base = APY_CAP; clipped++; }
      if (reward > APY_CAP) { reward = APY_CAP; clipped++; }

      feeMult *= 1 + (base * dilution) / 365 / 100;
      rewardMult *= 1 + (reward * dilution) / 365 / 100;
    }

    const feePct = (feeMult - 1) * 100;
    const rewardPct = (rewardMult - 1) * 100;
    const yieldMult = feeMult * rewardMult;

    // Impermanent loss from the pool's own bars, aligned to the same window.
    let ilPct = null, divergence = null, priceFrom = null, priceTo = null;
    if (bars && bars.length >= 2) {
      const inWindow = bars.filter((b) => b.t >= from);
      const use = inWindow.length >= 2 ? inWindow : bars.slice(-2);
      priceFrom = use[0].c;
      priceTo = use[use.length - 1].c;
      if (priceFrom > 0 && priceTo > 0) {
        divergence = priceTo / priceFrom;
        const v = il(divergence);
        if (v !== null) ilPct = v * 100;
      }
    }

    const ilMult = ilPct === null ? 1 : 1 + ilPct / 100;
    const grossMult = yieldMult * ilMult;

    // Gas both ways. It is a fixed cost, so it bites hardest on small positions -- which is
    // exactly what the minimum-viable-size panel is about.
    const costUsd = gasUsd * 2;
    const costPct = sizeUsd > 0 ? (costUsd / sizeUsd) * 100 : 0;

    const netPct = (grossMult - 1) * 100 - costPct;
    const netUsd = sizeUsd > 0 ? sizeUsd * (netPct / 100) : null;

    return {
      ok: true,
      days: rows.length,
      requestedDays: days,
      from: rows[0].day, to: rows[rows.length - 1].day,
      sizeUsd,
      feePct, rewardPct,
      yieldPct: (yieldMult - 1) * 100,
      ilPct, divergence, priceFrom, priceTo,
      costUsd, costPct,
      netPct, netUsd,
      // Annualising a short window is misleading, so it is offered only for 90 days or more.
      annualisedPct: rows.length >= 90
        ? (Math.pow(1 + netPct / 100, 365 / rows.length) - 1) * 100 : null,
      feesCoveredIl: ilPct === null ? null : ((feeMult - 1) * 100) + ilPct >= 0,
      beatHolding: netPct > 0,
      clipped,
      tvlAtEntry: num(rows[0].tvlUsd),
      tvlNow: num(rows[rows.length - 1].tvlUsd)
    };
  }

  const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;

  /* ------------------------------------------------------------------ render */

  function reset() { local.state = 'idle'; local.data = null; local.error = null; }

  function render(r) {
    local.result = r;

    if (local.state === 'idle') {
      return card(`
        <p class="muted">Every other yield figure on this page looks forward: an APR extrapolated
        from recent volume, which will not repeat. This one looks back — if you had put money in
        and left it, what would you have now, and would holding the two tokens have beaten it?</p>
        <button class="btn" id="pfLoad">Replay this pool’s history</button>
        <p class="fineprint">Fetches this pool’s daily history from DefiLlama. Needs the
        emissions panel’s dataset first, so that it knows which pool is which.</p>`);
    }
    if (local.state === 'loading') return card('<p class="muted">Replaying history…</p>');
    if (local.state === 'error') {
      return card('<div class="callout warn"><strong>Could not replay this pool.</strong> ' +
        esc(local.error || '') + '</div>');
    }
    if (local.state === 'absent' || !local.data) {
      return card(`<div class="callout"><strong>No history for this pool.</strong>
        ${esc(local.error || '')} DefiLlama has to be tracking the pool for this to work, and very
        new pools have nothing to replay.</div>`);
    }

    const s = local.data;
    if (!s.ok) {
      return card('<div class="callout"><strong>Not enough history.</strong> ' +
        esc(s.reason) + '</div>');
    }
    return card(body(r, s));
  }

  function body(r, s) {
    const u = U();
    const win = s.days;
    const isCl = r && r.isCl;

    const verdict = s.beatHolding
      ? `<div class="callout good"><strong>Providing liquidity beat holding, by
         ${u.pct(s.netPct, 2)} over ${win} days.</strong> On ${u.usd(s.sizeUsd)} that is
         ${u.usd(s.netUsd)} more than you would have had by keeping the two tokens in a wallet,
         after impermanent loss and after the gas to get in and out.</div>`
      : `<div class="callout warn"><strong>Holding would have beaten this pool by
         ${u.pct(Math.abs(s.netPct), 2)} over ${win} days.</strong> On ${u.usd(s.sizeUsd)} that is
         ${u.usd(Math.abs(s.netUsd))} worse than doing nothing. The fees were real; they did not
         cover what the price divergence and the gas took out.</div>`;

    return `
      ${verdict}

      <div class="metrics">
        ${metric('Swap fees', u.pct(s.feePct, 2),
          'earned over ' + win + ' days, diluted to your size', 'good')}
        ${metric('Emissions', s.rewardPct === 0 ? '—' : u.pct(s.rewardPct, 2),
          s.rewardPct === 0 ? 'none paid in this window' : 'token rewards, if you sold as paid')}
        ${metric('Impermanent loss', s.ilPct === null ? '—' : u.pct(s.ilPct, 2),
          s.divergence === null ? 'no price history'
            : 'the pair moved ' + u.ratio(s.divergence, 2) + '×',
          s.ilPct !== null && s.ilPct < -1 ? 'weak' : '')}
        ${metric('Gas, in and out', u.usd(s.costUsd),
          u.pct(s.costPct, 2) + ' of your position', s.costPct > 1 ? 'weak' : '')}
      </div>

      <h4>The arithmetic</h4>
      <div class="table-scroll"><table>
        <thead><tr><th>Component</th><th class="num">%</th><th class="num">On ${u.usd(s.sizeUsd)}</th><th>What it is</th></tr></thead>
        <tbody>
          <tr><td>Swap fees</td><td class="num up">${u.signedPct(s.feePct, 2)}</td>
            <td class="num">${u.usd(s.sizeUsd * s.feePct / 100)}</td>
            <td class="muted">your share of trading fees, compounded daily</td></tr>
          <tr><td>Emissions</td><td class="num ${s.rewardPct > 0 ? 'up' : ''}">${u.signedPct(s.rewardPct, 2)}</td>
            <td class="num">${u.usd(s.sizeUsd * s.rewardPct / 100)}</td>
            <td class="muted">incentive tokens — assumes you sold them as they were paid</td></tr>
          <tr><td>Impermanent loss</td>
            <td class="num ${s.ilPct !== null && s.ilPct < 0 ? 'down' : ''}">${s.ilPct === null ? '—' : u.signedPct(s.ilPct, 2)}</td>
            <td class="num">${s.ilPct === null ? '—' : u.usd(s.sizeUsd * s.ilPct / 100)}</td>
            <td class="muted">against holding the pair — from this pool's own price history</td></tr>
          <tr><td>Gas</td><td class="num down">${u.signedPct(-s.costPct, 2)}</td>
            <td class="num">${u.usd(-s.costUsd)}</td>
            <td class="muted">one entry and one exit</td></tr>
          <tr class="here"><td><strong>Net against holding</strong></td>
            <td class="num ${s.netPct >= 0 ? 'up' : 'down'}"><strong>${u.signedPct(s.netPct, 2)}</strong></td>
            <td class="num"><strong>${u.usd(s.netUsd)}</strong></td>
            <td class="muted">${s.annualisedPct === null
              ? 'too short a window to annualise honestly'
              : u.signedPct(s.annualisedPct, 1) + ' a year at this rate'}</td></tr>
        </tbody>
      </table></div>

      ${s.feesCoveredIl === null ? '' : `<p class="fineprint">
        Swap fees alone ${s.feesCoveredIl ? '<strong>covered</strong>' : 'did <strong>not</strong> cover'}
        the impermanent loss over this window${s.rewardPct > 0
          ? ', before counting emissions' : ''}.
        ${s.feesCoveredIl ? '' : 'That is the test that matters for a two-sided position: ' +
          'emissions end, and fees are what is left.'}</p>`}

      ${isCl ? `<div class="callout warn"><strong>This is a concentrated pool, so read the fee
        figure as an upper bound.</strong> DefiLlama divides fees by the liquidity actually
        deployed, which makes its apyBase the return on in-range, actively-managed capital. A
        passive position that drifts out of range earns a fraction of it. Comparing like for like
        during the backtest work, concentrated pools read 105% a year where constant-product pools
        in the same window read 6–9%.</div>` : ''}

      ${s.clipped > 0 ? `<p class="fineprint">${s.clipped} daily reading${s.clipped === 1 ? ' was' : 's were'}
        above ${APY_CAP}% a year and ${s.clipped === 1 ? 'was' : 'were'} capped there. An APY that
        high is usually TVL collapsing toward zero while the fee numerator stands still, not money
        being earned.</p>` : ''}

      ${renderControls(s)}

      <p class="fineprint">Window ${esc(s.from)} to ${esc(s.to)}, ${s.days} days of history.
        Pool TVL went ${u.usd(s.tvlAtEntry)} → ${u.usd(s.tvlNow)}. Each day's yield is scaled by
        TVL/(TVL+your size), because a quoted APY belongs to the capital already in the pool.
        This is what happened, not a forecast — and it says nothing about what the next
        ${s.days} days will do.</p>`;
  }

  function renderControls(s) {
    const opt = (d, label) => `<option value="${d}"${local.days === d ? ' selected' : ''}>${label}</option>`;
    return `
      <div class="assumptions">
        <label>Held for
          <select id="pfDays">
            ${opt(30, '30 days')}${opt(90, '90 days')}${opt(180, '180 days')}${opt(365, 'a year')}
          </select>
        </label>
        <label>Position size
          <input id="pfSize" type="number" min="100" step="100" value="${Math.round(s.sizeUsd)}">
        </label>
      </div>`;
  }

  function metric(label, value, sub, cls) {
    return `<div class="metric ${cls || ''}">
      <span class="m-label">${label}</span>
      <span class="m-value">${value}</span>
      ${sub ? '<span class="m-sub">' + sub + '</span>' : ''}
    </div>`;
  }

  function card(inner) {
    return `<section class="card profit">
      <h3>What it would actually have paid you</h3>
      ${inner}
    </section>`;
  }

  /* ------------------------------------------------------------------ wiring */

  /** Re-run the simulation from whatever is currently in `local`, without refetching. */
  function recompute(r) {
    if (!local.history) return;
    const gas = (LP.swap && LP.swap.gasFor) ? LP.swap.gasFor(r.pool.network) : 5;
    local.data = simulate(local.history, (r.stats && r.stats.bars) || null, {
      days: local.days,
      sizeUsd: local.sizeUsd || (r.assumptions && r.assumptions.positionUsd) || 10000,
      gasUsd: gas
    });
  }

  function wire(onChange) {
    const load = document.getElementById('pfLoad');
    if (load) {
      load.addEventListener('click', async () => {
        const r = local.result;
        local.state = 'loading';
        onChange();
        try {
          if (!LP.llama.isLoaded()) await LP.llama.load();
          const m = LP.llama.matchPool(r);
          if (!m.ok) {
            local.state = 'absent';
            local.error = m.reason || '';
          } else {
            local.history = await LP.llama.chart(m.row.id);
            local.sizeUsd = (r.assumptions && r.assumptions.positionUsd) || 10000;
            recompute(r);
            local.state = 'done';
          }
        } catch (e) {
          local.error = e.message || String(e);
          local.state = 'error';
        }
        onChange();
      });
    }

    const days = document.getElementById('pfDays');
    if (days) days.addEventListener('change', () => {
      local.days = parseInt(days.value, 10) || 90;
      recompute(local.result);
      onChange();
    });

    const size = document.getElementById('pfSize');
    if (size) size.addEventListener('change', () => {
      const v = parseFloat(size.value);
      if (Number.isFinite(v) && v > 0) {
        local.sizeUsd = v;
        recompute(local.result);
        onChange();
      }
    });
  }

  return { simulate, il, render, wire, reset, APY_CAP, _local: () => local };
})();
