/*
 * A single closed-form model of an LP position, written so every input can be perturbed
 * and the effect measured exactly. Everything in the "what if" panel calls evaluate().
 *
 * Prices are unit-free: entry price is 1, so `r` is the price ratio at the end of the hold
 * and a range of half-width w is simply [1-w, 1+w].
 *
 * The one thing here that the main analysis does not model is YOUR OWN DILUTION. When you
 * add Q to a pool holding R you do not earn the pool's fee rate -- you earn a share of it,
 * and your own deposit sits in the denominator. On a small pool that dominates everything else.
 */
window.LP = window.LP || {};

LP.model = (function () {
  const A = () => LP.analyze;

  /**
   * Concentration multiplier and time-in-range for a symmetric range, measured on real bars.
   *
   * Two different "time in range" numbers come out of this, and using the wrong one is a real
   * error rather than a rounding detail:
   *   tau     - the fraction of DAYS the price closed inside. This is what a human means by
   *             "in range 30% of the time", so it is what gets displayed.
   *   tauVol  - the fraction of VOLUME that traded on those days. This is what fees actually
   *             accrue on. The two diverge whenever the quiet days and the in-range days are
   *             not the same days, which is common: on this pool a tight range was in-range for
   *             30% of the days but only ~21% of the volume, so day-count tau overstated fee
   *             income by about 45%.
   */
  function rangeStats(bars, w) {
    const E = A().capitalEfficiency(1, 1 - w, 1 + w) || 1;
    if (!bars || !bars.length) return { E, tau: 1, tauVol: 1, fromBars: false };
    const entry = bars[0].c;
    const lo = entry * (1 - w);
    const hi = entry * (1 + w);
    let inside = 0;
    let volIn = 0;
    let volAll = 0;
    for (const b of bars) {
      const v = b.v > 0 ? b.v : 0;
      volAll += v;
      if (b.c >= lo && b.c <= hi) { inside++; volIn += v; }
    }
    const tau = inside / bars.length;
    // Fall back to the day count when the source gave us no per-bar volume.
    const tauVol = volAll > 0 ? volIn / volAll : tau;
    return { E, tau, tauVol, fromBars: true };
  }

  /**
   * @param p {V,R,f,s,T,Q,w,r,isCl,bars}
   *   V daily volume USD, R pool reserves USD, f fee fraction, s LP share of the fee,
   *   T hold days, Q position USD, w range half-width (null = full range),
   *   r price ratio at the end of the hold.
   */
  function evaluate(p) {
    const isCl = !!(p.isCl && p.w > 0 && p.w < 1);
    const rs = isCl ? rangeStats(p.bars, p.w) : { E: 1, tau: 1, tauVol: 1, fromBars: false };
    const E = rs.E;
    const tau = rs.tau;
    const tauVol = rs.tauVol;

    /*
     * Your effective depth at the current price is E*Q of full-range-equivalent liquidity,
     * competing against the pool's R. Share = E*Q / (R + E*Q), which correctly collapses to
     * Q/R for a full-range position in a pool much larger than you.
     */
    const effQ = E * p.Q;
    const share = p.R + effQ > 0 ? effQ / (p.R + effQ) : 0;

    // Fees accrue only on the volume that traded while the price was inside the range.
    const feesUsd = p.V * p.f * p.s * p.T * tauVol * share;
    const feeYieldPct = p.Q > 0 ? (feesUsd / p.Q) * 100 : 0;
    const feeAprPct = p.T > 0 ? (feeYieldPct / p.T) * 365 : 0;

    const ilPct = isCl
      ? (A().ilCl(p.r, 1, 1 - p.w, 1 + p.w) || 0) * 100
      : (A().ilV2(p.r) || 0) * 100;

    const netPct = feeYieldPct + ilPct;

    return {
      E, tau, tauVol, share, feesUsd,
      feeYieldPct, feeAprPct, ilPct, netPct,
      netUsd: (netPct / 100) * p.Q,
      ilUsd: (ilPct / 100) * p.Q,
      isCl, fromBars: rs.fromBars
    };
  }

  /* The inputs the what-if panel can move. */
  const DRIVERS = [
    { key: 'V', label: 'Daily volume', unit: 'usd', hint: 'How much the pool trades per day.' },
    { key: 'R', label: 'Pool reserves (TVL)', unit: 'usd', hint: 'Everyone else’s liquidity, which you split the fees with.' },
    { key: 'f', label: 'Swap fee', unit: 'feepct', hint: 'The fee tier the pool charges traders.' },
    { key: 's', label: 'LP share of the fee', unit: 'sharepct', hint: 'How much of that fee reaches you rather than a treasury or veToken voters.' },
    { key: 'T', label: 'Hold period', unit: 'days', hint: 'Fees accumulate with time. Impermanent loss does not.' },
    { key: 'Q', label: 'Your position size', unit: 'usd', hint: 'Only matters through dilution — your own deposit sits in the denominator.' },
    { key: 'r', label: 'Price ratio at exit', unit: 'ratio', hint: 'Base token measured in the quote token, relative to entry.' },
    { key: 'w', label: 'Range half-width', unit: 'widthpct', hint: 'Tighter multiplies fees but falls out of range sooner.', clOnly: true }
  ];

  function driversFor(p) {
    return DRIVERS.filter((d) => !d.clOnly || (p.isCl && p.w));
  }

  function withDriver(p, key, value) {
    const q = Object.assign({}, p);
    q[key] = value;
    return q;
  }

  function clampDriver(key, v) {
    if (key === 'w') return Math.max(0.005, Math.min(0.95, v));
    if (key === 'T') return Math.max(0.5, v);
    if (key === 's') return Math.max(0, Math.min(1, v));
    if (key === 'r') return Math.max(1e-6, v);
    return Math.max(0, v);
  }

  /**
   * Elasticity: percent change in the output per one percent change in the input.
   * Central difference at +/-1%. For the pure power-law terms this returns exactly what
   * the algebra says -- volume, fee and LP share are all +1, reserves is -1 before dilution.
   */
  function elasticity(p, key, outKey) {
    const base = p[key];
    if (!(Math.abs(base) > 0)) return null;
    const h = Math.abs(base) * 0.01;
    /*
     * Divide by the separation of the points actually evaluated, not by 2h. When base sits on a
     * bound (an LP fee share of exactly 100%, say) the upper bump gets clamped away, and assuming
     * a full 2h step there would silently report half the true elasticity.
     */
    const hiV = clampDriver(key, base + h);
    const loV = clampDriver(key, base - h);
    const span = hiV - loV;
    if (!(span > 0)) return null;
    const up = evaluate(withDriver(p, key, hiV))[outKey];
    const dn = evaluate(withDriver(p, key, loV))[outKey];
    const mid = evaluate(p)[outKey];
    if (!Number.isFinite(up) || !Number.isFinite(dn) || Math.abs(mid) < 1e-12) return null;
    return ((up - dn) / span) * (base / mid);
  }

  /** One-at-a-time perturbation of every driver by +/-pct, for a tornado chart. */
  function tornado(p, pct, outKey) {
    const base = evaluate(p)[outKey];
    const k = pct / 100;
    return driversFor(p).map((d) => {
      const v = p[d.key];
      const lo = clampDriver(d.key, v * (1 - k));
      const hi = clampDriver(d.key, v * (1 + k));
      const down = evaluate(withDriver(p, d.key, lo))[outKey];
      const up = evaluate(withDriver(p, d.key, hi))[outKey];
      return {
        key: d.key, label: d.label, unit: d.unit, hint: d.hint,
        base, low: Math.min(down, up), high: Math.max(down, up),
        atLow: down, atHigh: up, loVal: lo, hiVal: hi,
        swing: Math.abs(up - down)
      };
    }).sort((a, b) => b.swing - a.swing);
  }

  /** Sweep one driver across a set of values. */
  function sweep(p, key, values, outKeys) {
    const keys = outKeys || ['netPct', 'feeYieldPct', 'ilPct'];
    return values.map((v) => {
      const res = evaluate(withDriver(p, key, v));
      const row = { value: v, E: res.E, tau: res.tau, share: res.share };
      keys.forEach((k) => { row[k] = res[k]; });
      return row;
    });
  }

  /**
   * Values of a driver where an output crosses `target`. Scans first, then bisects each sign
   * change, so it also finds both roots of a non-monotonic driver like range width or price
   * ratio rather than silently reporting one.
   */
  function solve(p, key, outKey, target, lo, hi, steps) {
    const tgt = target || 0;
    const n = steps || 400;
    const f = (v) => evaluate(withDriver(p, key, v))[outKey] - tgt;
    const roots = [];
    let prevV = lo;
    let prevF = f(lo);
    for (let i = 1; i <= n; i++) {
      const v = lo + ((hi - lo) * i) / n;
      const cur = f(v);
      if (Number.isFinite(prevF) && Number.isFinite(cur) && prevF * cur < 0) {
        let a = prevV, b = v, fa = prevF;
        for (let j = 0; j < 60; j++) {
          const m = (a + b) / 2;
          const fm = f(m);
          if (fa * fm <= 0) b = m; else { a = m; fa = fm; }
        }
        roots.push((a + b) / 2);
      }
      prevV = v; prevF = cur;
    }
    return roots;
  }

  /** Two-driver grid, for a heat table of net return. */
  function grid(p, xKey, xs, yKey, ys, outKey) {
    return ys.map((y) => ({
      y,
      cells: xs.map((x) => {
        const q = withDriver(withDriver(p, xKey, x), yKey, y);
        return { x, value: evaluate(q)[outKey] };
      })
    }));
  }

  /** Build the model's base-case parameters from a completed analysis. */
  function paramsFrom(result, opts) {
    const o = opts || {};
    const pool = result.pool;
    const bars = (result.range && result.range.bars) ||
      (result.stats ? result.stats.bars.slice(-result.assumptions.holdDays) : null);

    /*
     * Default to the trailing average daily volume over the hold window rather than the last
     * 24 hours, so the base case reconciles with the historical replay instead of resting on
     * one busy day. Today's figure stays available as a scenario.
     */
    let V = pool.volume.h24 || 0;
    let vSource = 'last 24h';
    if (bars && bars.length) {
      const avg = bars.reduce((a, b) => a + (b.v || 0), 0) / bars.length;
      if (avg > 0) { V = avg; vSource = bars.length + '-day average'; }
    }

    const r = bars && bars.length ? bars[bars.length - 1].c / bars[0].c : 1;

    return {
      V: o.V !== undefined ? o.V : V,
      R: o.R !== undefined ? o.R : (pool.tvlUsd || 0),
      f: o.f !== undefined ? o.f : result.fees.feePct / 100,
      s: o.s !== undefined ? o.s : result.fees.lpShare,
      T: o.T !== undefined ? o.T : result.assumptions.holdDays,
      Q: o.Q !== undefined ? o.Q : result.assumptions.positionUsd,
      w: result.isCl ? (o.w !== undefined ? o.w : result.assumptions.rangePct / 100) : null,
      r: o.r !== undefined ? o.r : r,
      isCl: result.isCl,
      bars,
      vSource,
      todayV: pool.volume.h24
    };
  }

  return {
    evaluate, elasticity, tornado, sweep, solve, grid, paramsFrom,
    rangeStats, driversFor, clampDriver, DRIVERS, withDriver
  };
})();
