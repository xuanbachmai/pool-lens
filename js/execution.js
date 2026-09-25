/*
 * "Getting in and out" -- what the round trip costs before any yield exists.
 *
 * This is the piece the rest of the app was missing. Every other panel reasons from
 * aggregate TVL and volume and quietly assumes you can enter and leave a position at mid
 * price. On a deep pool that assumption is nearly free. On a thin one the entry and exit
 * swaps can cost more than the fees earn back in months, which flips the verdict entirely.
 */
window.LP = window.LP || {};

LP.execution = (function () {
  const U = () => LP.util;
  const esc = (s) => LP.util.escapeHtml(s);

  const local = { arriveWith: 'quote', result: null };

  function ctx(r) {
    const built = LP.swap.poolFrom(r);
    if (!built.ok) return { ok: false, reason: built.reason };
    const fee = (r.fees.feePct / 100);
    const baseFrac = LP.swap.baseValueFraction(r.isCl, r.isCl ? r.assumptions.rangePct / 100 : null);
    return {
      ok: true,
      ...built,
      fee,
      baseFrac,
      positionUsd: r.assumptions.positionUsd,
      dailyFeeYield: r.fees.dailyYield   // fraction per day, full-range basis
    };
  }

  /* ------------------------------------------------------------------- render */

  function render(r) {
    local.result = r;
    const c = ctx(r);

    if (!c.ok) {
      return card(`<p class="muted">${esc(c.reason)} Execution cost needs the pool's token-level
        reserves, which this pool's data source did not provide.</p>`);
    }

    const split = renderSplit(r, c);

    if (!c.valid.ok) {
      return card(`
        ${split}
        <div class="callout warn">
          <strong>Slippage can't be quoted for this pool.</strong>
          ${esc(c.valid.reason)}
          Pricing a trade against these totals would produce a confident-looking number that is
          simply wrong, so this panel stops here rather than guessing. Tick-level liquidity — which
          the free APIs don't expose — is what would be needed.
        </div>
        <p class="fineprint">The deposit split above is still exact: it comes from the position
        formulas, not from the reserves. And the size-vs-pool figure below is the honest proxy for
        how much your own trade would move things.</p>
        ${renderSizeVsPool(c)}`);
    }

    return card(`
      ${split}
      ${renderRoundTrip(r, c)}
      <h4>What a trade costs in this pool</h4>
      ${renderDepth(c)}
      <h4>Price impact by trade size</h4>
      ${renderImpactChart(c)}
      ${renderArbBand(c)}`);
  }

  function card(inner) {
    return `<section class="card execution">
      <h3>Getting in and out</h3>
      <p class="muted">Every other panel assumes you can enter and leave at mid price. You can't.
      Opening a position usually means swapping into the pair, and closing it means swapping back —
      and both trades pay the fee and move the price against you.</p>
      ${inner}
    </section>`;
  }

  function renderSplit(r, c) {
    const u = U();
    const bf = c.baseFrac;
    return `
      <div class="metrics">
        ${metric('Deposit split', u.pct(bf * 100, 1) + ' ' + esc(c.baseSymbol || 'base'),
          u.pct((1 - bf) * 100, 1) + ' ' + esc(c.quoteSymbol || 'quote') +
          (r.isCl ? ' · set by your ±' + u.ratio(r.assumptions.rangePct, 0) + '% range' : ' · full range is always 50/50'))}
        ${metric('Your position vs the pool', u.pct((c.positionUsd / c.poolUsd) * 100, 3),
          u.usd(c.positionUsd) + ' into ' + u.usd(c.poolUsd),
          c.positionUsd / c.poolUsd > 0.05 ? 'weak' : '')}
      </div>`;
  }

  function renderSizeVsPool(c) {
    const u = U();
    const ratio = c.positionUsd / c.poolUsd;
    return `<p class="fineprint">A ${u.usd(c.positionUsd)} position is
      <strong>${u.pct(ratio * 100, 3)}</strong> of this ${u.usd(c.poolUsd)} pool.
      ${ratio > 0.05
        ? 'That is large enough that your own entry and exit will move the price noticeably.'
        : 'Small enough that execution cost is unlikely to dominate.'}</p>`;
  }

  function renderRoundTrip(r, c) {
    const u = U();
    const rt = LP.swap.roundTrip(c.pool, c.positionUsd, c.fee,
      { arriveWith: local.arriveWith, baseFraction: c.baseFrac });
    if (!rt || rt.exitImpossible) {
      return `<div class="callout warn"><strong>Your position is bigger than the pool.</strong>
        ${u.usd(c.positionUsd)} into a ${u.usd(c.poolUsd)} pool. Once you withdraw there is nothing
        left to sell your side into, so there is no exit price to quote — and on the way in you
        would be trading against yourself. That is the answer on its own.</div>`;
    }

    // The number that ties this panel to the rest of the app.
    const daysToRepay = c.dailyFeeYield > 0 ? (rt.totalLostPct / 100) / c.dailyFeeYield : null;

    /*
     * Two different denominators here, and mixing them up makes a round trip look half its
     * real size: lostPct is the cost of that swap as a share of THE SWAP, while the last
     * column is its cost as a share of THE POSITION. They differ because you only ever swap
     * the part that has to change hands.
     */
    const leg = (l, label) => l ? `
      <tr>
        <td>${label}</td>
        <td class="num">${u.usd(l.usdIn)}</td>
        <td class="num">${u.pct(l.exFee * 100, 3)}</td>
        <td class="num">${u.pct(c.fee * 100, 3)}</td>
        <td class="num down">${u.pct(l.lostPct, 3)}</td>
        <td class="num down">${u.usd(l.lostUsd)}</td>
        <td class="num down">${u.pct((l.lostUsd / c.positionUsd) * 100, 3)}</td>
      </tr>` : `<tr><td>${label}</td><td colspan="6" class="muted">no swap needed</td></tr>`;

    return `
      <div class="exec-ctl">
        <label>You arrive holding
          <select id="execArrive">
            <option value="quote"${local.arriveWith === 'quote' ? ' selected' : ''}>all ${esc(c.quoteSymbol || 'quote')}</option>
            <option value="base"${local.arriveWith === 'base' ? ' selected' : ''}>all ${esc(c.baseSymbol || 'base')}</option>
            <option value="balanced"${local.arriveWith === 'balanced' ? ' selected' : ''}>already balanced</option>
          </select>
        </label>
      </div>

      <div class="table-scroll"><table>
        <thead><tr><th>Leg</th><th class="num">Swap size</th><th class="num">Slippage</th>
          <th class="num">Fee</th><th class="num">of swap</th><th class="num">Cost</th>
          <th class="num">of position</th></tr></thead>
        <tbody>
          ${leg(rt.entry, 'Entry swap')}
          ${leg(rt.exit, 'Exit swap')}
          <tr class="total"><td>Round trip</td><td class="num"></td><td class="num"></td>
            <td class="num"></td><td class="num"></td>
            <td class="num down">${u.usd(rt.totalLostUsd)}</td>
            <td class="num down">${u.pct(rt.totalLostPct, 3)}</td></tr>
        </tbody>
      </table></div>

      <div class="callout ${daysToRepay !== null && daysToRepay > 30 ? 'warn' : ''}">
        ${daysToRepay === null
          ? 'This pool earns no measurable swap fees, so there is nothing to repay the round trip with.'
          : 'At this pool\'s current fee rate, you need <strong>' +
            (daysToRepay < 1 ? 'less than a day' : u.ratio(daysToRepay, daysToRepay > 10 ? 0 : 1) + ' days') +
            '</strong> in the position just to earn back what getting in and out costs.'}
      </div>

      <p class="fineprint">The exit is priced against the pool <em>after</em> your own liquidity is
      withdrawn (${u.usd(rt.exitPricedAgainst)} rather than ${u.usd(rt.poolUsd)}) — pulling your
      position out makes the pool thinner, and on a small pool that is most of the exit cost.
      Assumes you route both swaps through this pool; for a well-traded pair an aggregator would
      usually find a cheaper path.</p>`;
  }

  function renderDepth(c) {
    const u = U();
    const rows = LP.swap.depthTable(c.pool, c.fee);
    if (!rows.length) return '<p class="muted">Pool too small to tabulate.</p>';
    const body = rows.map((d) => `
      <tr class="${Math.abs(d.usd - c.positionUsd) / c.positionUsd < 0.5 ? 'here' : ''}">
        <td class="num">${u.usd(d.usd)}</td>
        <td class="num">${u.pct(d.pctOfPool, 2)}</td>
        <td class="num">${u.price(d.fill)}</td>
        <td class="num down">${u.pct(d.impactPct, 3)}</td>
        <td class="num">${u.pct(d.exFeePct, 3)}</td>
        <td class="num down">${u.usd(d.lostUsd)}</td>
      </tr>`).join('');
    return `
      <div class="table-scroll"><table>
        <thead><tr><th class="num">Buy size</th><th class="num">of pool</th>
          <th class="num">Fill price</th><th class="num">vs mid</th>
          <th class="num">ex-fee</th><th class="num">Cost</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>
      <p class="fineprint">Mid is ${u.price(c.pool.quote / c.pool.base)}
      ${esc(c.quoteSymbol || '')} per ${esc(c.baseSymbol || '')}. "ex-fee" strips the
      ${u.pct(c.fee * 100, 2)} fee out to leave pure curve slippage — the part that gets worse
      as the trade grows relative to the pool.</p>`;
  }

  function renderImpactChart(c) {
    const u = U();
    const poolUsd = c.poolUsd;
    const W = 560, H = 220, padL = 56, padR = 14, padT = 14, padB = 40;
    const pts = [];
    for (let i = 0; i <= 120; i++) {
      const frac = 0.0005 * Math.pow(0.30 / 0.0005, i / 120);   // 0.05% .. 30% of the pool, log
      const usd = poolUsd * frac;
      const q = LP.swap.costOfUsd(c.pool, usd, 'buyBase', c.fee);
      if (q) pts.push({ frac, usd, lostPct: q.lostPct });
    }
    if (pts.length < 2) return '';
    const maxLoss = Math.max.apply(null, pts.map((p) => p.lostPct));
    const lx = (v) => Math.log10(v);
    const sx = (f) => padL + ((lx(f) - lx(pts[0].frac)) / (lx(pts[pts.length - 1].frac) - lx(pts[0].frac))) * (W - padL - padR);
    const sy = (v) => padT + (1 - v / maxLoss) * (H - padT - padB);

    const path = pts.map((p, i) => (i ? 'L' : 'M') + sx(p.frac).toFixed(1) + ' ' + sy(p.lostPct).toFixed(1)).join('');
    let grid = '';
    [0.001, 0.01, 0.1].forEach((f) => {
      if (f < pts[0].frac || f > pts[pts.length - 1].frac) return;
      grid += `<line class="eg" x1="${sx(f).toFixed(1)}" x2="${sx(f).toFixed(1)}" y1="${padT}" y2="${H - padB}"/>
        <text x="${sx(f).toFixed(1)}" y="${H - padB + 15}" text-anchor="middle">${(f * 100).toFixed(f < 0.01 ? 1 : 0)}%</text>`;
    });
    for (let i = 0; i <= 4; i++) {
      const v = (maxLoss * i) / 4;
      grid += `<line class="eg" x1="${padL}" x2="${W - padR}" y1="${sy(v).toFixed(1)}" y2="${sy(v).toFixed(1)}"/>
        <text x="${padL - 7}" y="${(sy(v) + 4).toFixed(1)}" text-anchor="end">${v.toFixed(1)}%</text>`;
    }

    // Mark the user's own position size.
    const myFrac = c.positionUsd / poolUsd;
    let marker = '';
    if (myFrac >= pts[0].frac && myFrac <= pts[pts.length - 1].frac) {
      const q = LP.swap.costOfUsd(c.pool, c.positionUsd, 'buyBase', c.fee);
      if (q) {
        marker = `<line class="emark" x1="${sx(myFrac).toFixed(1)}" x2="${sx(myFrac).toFixed(1)}"
          y1="${padT}" y2="${H - padB}"/>
          <circle cx="${sx(myFrac).toFixed(1)}" cy="${sy(q.lostPct).toFixed(1)}" r="5" class="edot"/>`;
      }
    }

    return `
      <svg class="impact" viewBox="0 0 ${W} ${H}" role="img"
        aria-label="Cost of a trade as a percentage, against trade size as a share of the pool">
        ${grid}
        <path class="eline" d="${path}"/>
        ${marker}
        <text x="${(padL + W - padR) / 2}" y="${H - 6}" text-anchor="middle">trade size as a share of the pool (log)</text>
      </svg>
      <p class="fineprint">Total cost (fee + slippage) of buying ${esc(c.baseSymbol || 'base')}.
      ${marker ? 'The marker is a trade the size of your ' + u.usd(c.positionUsd) + ' position.' : ''}
      Cost is roughly flat at the fee until the trade approaches a few percent of the pool, then
      slippage takes over and grows without bound.</p>`;
  }

  function renderArbBand(c) {
    const u = U();
    const mid = c.pool.quote / c.pool.base;
    const lower = mid * (1 - c.fee);
    const upper = mid / (1 - c.fee);
    return `
      <h4>The no-arbitrage band</h4>
      <p class="muted">The pool only learns the real price when somebody trades it back into line,
      and whoever does that is paid out of your liquidity. Nothing is profitable while the true
      price sits inside this band.</p>
      <div class="metrics">
        ${metric('Band', u.price(lower) + ' – ' + u.price(upper),
          '±' + u.pct((c.fee / (1 - c.fee)) * 100, 3) + ' around ' + u.price(mid))}
        ${metric('Width', u.pct(((upper - lower) / mid) * 100, 3),
          'set by the ' + u.pct(c.fee * 100, 2) + ' fee')}
      </div>
      <p class="fineprint">This is the LP's structural bleed, usually called LVR: every time the
      real price moves further than the band, an arbitrageur rebalances you at a stale price and
      keeps the difference. A higher fee tier widens the band and bleeds less — but it also wins
      less volume, which is the trade-off the V/R panel is really measuring.</p>`;
  }

  function metric(label, value, sub, cls) {
    return `<div class="metric ${cls || ''}">
      <span class="m-label">${label}</span>
      <span class="m-value">${value}</span>
      ${sub ? '<span class="m-sub">' + sub + '</span>' : ''}
    </div>`;
  }

  function wire() {
    const sel = document.getElementById('execArrive');
    if (!sel) return;
    sel.addEventListener('change', () => {
      local.arriveWith = sel.value;
      const sec = document.querySelector('.card.execution');
      if (sec && local.result) {
        sec.outerHTML = render(local.result);
        wire();
      }
    });
  }

  function reset() { local.arriveWith = 'quote'; }

  return { render, wire, reset, ctx };
})();
