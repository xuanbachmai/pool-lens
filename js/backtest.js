/*
 * Range backtest.
 *
 * "If concentrated, estimate how long the pair price is spent within a specific range
 *  (hardest part!) -- Backtesting"  -- OTS notes, The Goals of an LP
 *
 * We replay the real daily bars GeckoTerminal gives us. The range is centred on the price
 * at the *start* of the window, not today's price, otherwise the recent bars would sit
 * inside the range by construction and the result would flatter itself.
 *
 * Two approximations worth knowing about, both surfaced in the UI:
 *   - fee accrual uses today's TVL against each day's real volume, because historical
 *     reserves aren't available from the free endpoints;
 *   - the concentration multiplier assumes the rest of the pool's liquidity distribution
 *     stays as it is now.
 */
window.LP = window.LP || {};

LP.backtest = (function () {
  const DAY = 86400000;

  /**
   * @param bars  oldest-first [{t,o,h,l,c,v}] with prices in quote-token terms
   * @param opts  {pa, pb, P0, lpFeeFrac, tvl, efficiency}
   */
  function run(bars, opts) {
    if (!bars || bars.length < 5) return null;
    const widthPct = ((opts.pb - opts.P0) / opts.P0) * 100;

    // Re-centre the same relative width on the price at the start of the window.
    const entry = bars[0].c;
    const w = widthPct / 100;
    const pa = entry * (1 - w);
    const pb = entry * (1 + w);
    if (!(pa > 0 && pb > pa)) return null;

    const eff = LP.analyze.capitalEfficiency(entry, pa, pb) || 1;
    const lpFeeFrac = opts.lpFeeFrac;
    const tvl = opts.tvl;

    let inRangeDays = 0;
    let touchedOut = 0;
    let firstExitDay = null;
    let feesPct = 0;
    const series = [];

    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const closeIn = b.c >= pa && b.c <= pb;
      const spanOut = b.l < pa || b.h > pb;

      if (closeIn) inRangeDays++;
      if (spanOut) {
        touchedOut++;
        if (firstExitDay === null) firstExitDay = i;
      }

      // Fees accrue only while the price is inside the range.
      if (closeIn && tvl > 0 && b.v > 0) {
        feesPct += (b.v * lpFeeFrac / tvl) * eff * 100;
      }

      const posRel = LP.analyze.clValue(b.c, entry, pa, pb);
      series.push({
        t: b.t,
        price: b.c,
        inRange: closeIn,
        cumFeesPct: feesPct,
        positionRel: posRel
      });
    }

    const last = bars[bars.length - 1].c;
    const ilPct = (LP.analyze.ilCl(last, entry, pa, pb) || 0) * 100;
    const days = bars.length;

    return {
      windowDays: days,
      entryPrice: entry,
      finalPrice: last,
      pa, pb,
      widthPct,
      efficiency: eff,
      daysInRange: inRangeDays,
      pctTimeInRange: (inRangeDays / days) * 100,
      daysTouchedOut: touchedOut,
      daysUntilFirstExit: firstExitDay,
      feesPct,
      ilPct,
      netVsHodlPct: feesPct + ilPct,
      priceMovePct: (last / entry - 1) * 100,
      series,
      approximate: true
    };
  }

  /**
   * Narrowest symmetric range that would have kept the price inside for `target`
   * of the window. Answers the practical question directly: how wide does this pair
   * actually need?
   */
  function suggestRange(bars, target) {
    if (!bars || bars.length < 5) return null;
    const goal = target === undefined ? 0.9 : target;
    const entry = bars[0].c;

    for (let w = 1; w <= 95; w++) {
      const pa = entry * (1 - w / 100);
      const pb = entry * (1 + w / 100);
      let inside = 0;
      for (const b of bars) if (b.c >= pa && b.c <= pb) inside++;
      if (inside / bars.length >= goal) {
        return { widthPct: w, pctTimeInRange: (inside / bars.length) * 100, target: goal * 100 };
      }
    }
    return null;
  }

  /**
   * Sweep a set of widths so the UI can show the fee-vs-IL trade-off directly.
   * Widths are literal percentages of the entry price, so they stop below 100%
   * (a -100% lower bound would put the range floor at zero).
   */
  function sweep(bars, opts, widths) {
    const list = widths || [5, 10, 20, 35, 50, 75, 90];
    return list.map((w) => {
      const P0 = bars[0].c;
      const res = run(bars, Object.assign({}, opts, { P0, pa: P0 * (1 - w / 100), pb: P0 * (1 + w / 100) }));
      return res ? {
        widthPct: w,
        efficiency: res.efficiency,
        pctTimeInRange: res.pctTimeInRange,
        feesPct: res.feesPct,
        ilPct: res.ilPct,
        netVsHodlPct: res.netVsHodlPct
      } : null;
    }).filter(Boolean);
  }

  return { run, suggestRange, sweep };
})();
