/*
 * The analysis engine.
 *
 * Structured around the three goals of an LP, taken from the OTS "Liquidity Providing
 * in DeFi" notes:
 *   1. If concentrated, estimate how long the pair price spends inside a range.
 *   2. Pick the most performant pools -- the V/R (volume / reserves) ratio.
 *   3. Outperform simply holding: fees > impermanent loss.
 *
 * Every number here is derived from public pool data. Nothing accounts for token
 * emissions or incentives, which is stated loudly in the UI because on many pools
 * (see the Yield Radar notes) incentives are most of the advertised APY.
 */
window.LP = window.LP || {};

LP.analyze = (function () {
  const DAY = 86400000;

  /* --------------------------------------------------------------- IL maths */

  /**
   * Constant-product (Uniswap v2 / 50-50) impermanent loss.
   * @param r price ratio P1/P0 of base measured in quote
   * @returns negative fraction, e.g. -0.0572 for a 2x move
   */
  function ilV2(r) {
    if (!(r > 0)) return null;
    return (2 * Math.sqrt(r)) / (1 + r) - 1;
  }

  /**
   * Value of a concentrated-liquidity position, normalised so entry value = 1.
   * Standard Uniswap v3 maths: x = L(1/vP - 1/vpb), y = L(vP - vpa).
   */
  function clValue(P, P0, pa, pb) {
    if (!(P > 0 && P0 > 0 && pa > 0 && pb > pa)) return null;
    const v = (p) => {
      if (p <= pa) return (1 / Math.sqrt(pa) - 1 / Math.sqrt(pb)) * p;  // all base sold into quote
      if (p >= pb) return Math.sqrt(pb) - Math.sqrt(pa);                 // all quote bought into base
      return 2 * Math.sqrt(p) - p / Math.sqrt(pb) - Math.sqrt(pa);
    };
    const entry = v(P0);
    if (!(entry > 0)) return null;
    return v(P) / entry;
  }

  /** CL impermanent loss vs holding the entry basket. */
  function ilCl(P, P0, pa, pb) {
    const posRel = clValue(P, P0, pa, pb);
    if (posRel === null) return null;
    // HODL value of the entry basket, normalised the same way.
    const inRange0 = P0 > pa && P0 < pb;
    if (!inRange0) return null;
    const L = 1;
    const x0 = L * (1 / Math.sqrt(P0) - 1 / Math.sqrt(pb));   // base units
    const y0 = L * (Math.sqrt(P0) - Math.sqrt(pa));           // quote units
    const entryVal = x0 * P0 + y0;
    const hodl = (x0 * P + y0) / entryVal;
    return posRel / hodl - 1;
  }

  /**
   * Capital efficiency of a range vs full-range, for the same fee-earning depth.
   *   E = 1 / (1 - (sqrt(P/pb) + sqrt(pa/P)) / 2)
   * For a geometric range [P/m, P*m] this reduces to 1/(1 - 1/sqrt(m)).
   */
  function capitalEfficiency(P, pa, pb) {
    if (!(P > 0 && pa > 0 && pb > pa)) return null;
    const denom = 1 - (Math.sqrt(P / pb) + Math.sqrt(pa / P)) / 2;
    if (!(denom > 1e-9)) return null;
    return 1 / denom;
  }

  /**
   * Price divergence that a given accumulated fee yield can absorb.
   * Solves 1 - 2*sqrt(r)/(1+r) = F in closed form.
   * @param feeYield accumulated fees as a fraction of position value (0.02 = 2%)
   * @returns {up, down} fractional moves, or null if fees cover any move
   */
  function breakevenDivergence(feeYield) {
    if (!(feeYield > 0)) return { up: 0, down: 0 };
    const g = 1 - feeYield;
    if (g <= 0) return null; // fees exceed the worst case; any divergence is covered
    const disc = 1 - g * g;
    if (disc < 0) return null;
    const s = (1 + Math.sqrt(disc)) / g;
    const r = s * s;
    return { up: r - 1, down: 1 / r - 1 };
  }

  /* ------------------------------------------------------- price history stats */

  /** Realised volatility and path shape from daily bars (base priced in quote). */
  function historyStats(bars) {
    if (!bars || bars.length < 3) return null;
    const closes = bars.map((b) => b.c);
    const rets = [];
    for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));

    const sd = LP.util.stdev(rets);
    const netLog = Math.log(closes[closes.length - 1] / closes[0]);
    const totalAbs = rets.reduce((a, b) => a + Math.abs(b), 0);

    // Path efficiency: 1 = straight line (trend), 0 = pure chop.
    const efficiency = totalAbs > 0 ? Math.abs(netLog) / totalAbs : 0;

    const window = (bars[bars.length - 1].t - bars[0].t) / DAY;

    function changeOverDays(d) {
      const cutoff = bars[bars.length - 1].t - d * DAY;
      let start = bars[0];
      for (const b of bars) { if (b.t <= cutoff) start = b; else break; }
      return closes[closes.length - 1] / start.c;
    }

    return {
      bars,
      days: window,
      sdDaily: sd,
      volAnnual: sd === null ? null : sd * Math.sqrt(365),
      netRatio: closes[closes.length - 1] / closes[0],
      efficiency,
      chop: 1 - efficiency,
      maxClose: Math.max.apply(null, closes),
      minClose: Math.min.apply(null, closes),
      ratio7d: changeOverDays(7),
      ratio30d: changeOverDays(30),
      ratio90d: changeOverDays(90),
      volumeSum: bars.reduce((a, b) => a + (b.v || 0), 0),
      volumeSumLast: (n) => bars.slice(-n).reduce((a, b) => a + (b.v || 0), 0)
    };
  }

  /** Pair regime from the volatility of the base/quote ratio itself. */
  function regime(volAnnual) {
    if (volAnnual === null || volAnnual === undefined) return { key: 'unknown', label: 'Unknown' };
    const v = volAnnual * 100;
    if (v < 3) return { key: 'pegged', label: 'Pegged pair', note: 'The two tokens barely move against each other — IL is structurally tiny, and the risk is a depeg rather than divergence.' };
    if (v < 20) return { key: 'correlated', label: 'Correlated pair', note: 'The tokens move together (an LST/LRT or similar). This is the profile the OTS notes call easiest to LP — high volume, low divergence.' };
    if (v < 80) return { key: 'volatile', label: 'Volatile pair', note: 'A normal volatile pair. Fees have to work hard to cover divergence.' };
    return { key: 'wild', label: 'Highly volatile pair', note: 'Very high realised volatility. Expect large IL; a concentrated range will go out of range quickly.' };
  }

  /* ----------------------------------------------------------------- grading */

  function grade(score) {
    if (score >= 80) return { key: 'good', label: 'Strong' };
    if (score >= 60) return { key: 'ok', label: 'Decent' };
    if (score >= 35) return { key: 'weak', label: 'Marginal' };
    return { key: 'bad', label: 'Poor' };
  }

  /* ------------------------------------------------------------ main analysis */

  /**
   * @param ctx {pool, cross, hist, feeInfo, assumptions:{positionUsd, rangePct, holdDays}}
   */
  function run(ctx) {
    const pool = ctx.pool;
    const feeInfo = ctx.feeInfo;
    const a = ctx.assumptions;
    const stats = ctx.hist && ctx.hist.length ? historyStats(ctx.hist) : null;

    const tvl = pool.tvlUsd;
    const vol24 = pool.volume.h24;
    const feeFrac = feeInfo.fee / 100;
    const lpFeeFrac = feeFrac * feeInfo.lpShare;

    /* --- Goal 2: V/R ratio ------------------------------------------------ */
    const vr24 = tvl > 0 && vol24 !== null ? vol24 / tvl : null;
    const vr6x4 = tvl > 0 && pool.volume.h6 !== null ? (pool.volume.h6 * 4) / tvl : null;
    // A 3-day average smooths out a single busy day, which is what the notes suggest.
    const vr3d = stats && tvl > 0 ? stats.volumeSumLast(3) / 3 / tvl : null;

    const vrBenchmark = 0.25; // "A good starting point is a V/R ratio of 0.25 over 1-3 days."
    const vrForScore = vr3d !== null ? vr3d : vr24;
    let vrScore = null;
    if (vrForScore !== null) {
      vrScore = LP.util.clamp((vrForScore / vrBenchmark) * 55, 0, 100);
      if (vrForScore > 5) vrScore = Math.min(vrScore, 70); // implausibly high, likely wash volume
    }

    /* --- Fee APR --------------------------------------------------------- */
    const feeAprFullRange = vr24 !== null ? vr24 * lpFeeFrac * 365 * 100 : null;
    const feeApr3d = vr3d !== null ? vr3d * lpFeeFrac * 365 * 100 : null;
    const dailyFeeYield = vr24 !== null ? vr24 * lpFeeFrac : null;
    const feesPerDayOnPosition = dailyFeeYield !== null && a.positionUsd ? dailyFeeYield * a.positionUsd : null;
    const poolFeesPerDay = vol24 !== null ? vol24 * feeFrac : null;

    /* --- Goal 3: fees vs impermanent loss -------------------------------- */
    const holdDays = a.holdDays || 30;
    const feeYieldOverHold = dailyFeeYield !== null ? dailyFeeYield * holdDays : null;
    const breakeven = feeYieldOverHold !== null ? breakevenDivergence(feeYieldOverHold) : null;

    // Scenario table: IL at fixed divergences, against fees earned over the hold.
    const scenarios = [-50, -25, -10, 10, 25, 50, 100].map((movePct) => {
      const r = 1 + movePct / 100;
      const il = ilV2(r) * 100;
      const net = feeYieldOverHold !== null ? il + feeYieldOverHold * 100 : null;
      return { movePct, ilPct: il, netPct: net };
    });

    // What actually happened: realised IL over the hold window vs fees over the same window.
    let realised = null;
    if (stats) {
      const slice = stats.bars.slice(-holdDays);
      const n = slice.length;
      const r = slice[n - 1].c / slice[0].c;
      const ilPct = ilV2(r) * 100;
      // Fees over the same window, using actual historical volume but current TVL.
      const volWindow = stats.volumeSumLast(n);
      const feePct = tvl > 0 ? (volWindow * lpFeeFrac / tvl) * 100 : null;
      realised = {
        windowDays: n,
        priceRatio: r,
        movePct: (r - 1) * 100,
        ilPct,
        feePct,
        netPct: feePct === null ? null : feePct + ilPct,
        approximate: true
      };
    }

    let ilScore = null;
    if (realised && realised.feePct !== null) {
      const cover = Math.abs(realised.ilPct) < 1e-9 ? 3 : realised.feePct / Math.abs(realised.ilPct);
      ilScore = LP.util.clamp(cover * 50, 0, 100);
      // Beating a zero divergence with a rounding error still isn't a good pool. A pegged pair
      // clears this goal trivially, so cap the score when there is barely any fee income to win.
      if (feeAprFullRange !== null) {
        if (feeAprFullRange < 1) ilScore = Math.min(ilScore, 40);
        else if (feeAprFullRange < 3) ilScore = Math.min(ilScore, 60);
      }
    }

    /* --- Goal 1: concentrated range ------------------------------------- */
    const isCl = feeInfo.type === 'cl';
    let range = null;
    if (isCl && pool.basePriceInQuote > 0) {
      const P0 = pool.basePriceInQuote;
      const w = (a.rangePct || 20) / 100;
      const pa = P0 * (1 - w);
      const pb = P0 * (1 + w);
      const eff = capitalEfficiency(P0, pa, pb);
      // Backtest the same window as the hold period, so every panel talks about the same horizon.
      const btBars = stats ? stats.bars.slice(-holdDays) : null;
      range = {
        P0, pa, pb, widthPct: a.rangePct || 20,
        efficiency: eff,
        feeAprInRange: feeAprFullRange !== null && eff !== null ? feeAprFullRange * eff : null,
        bars: btBars,
        backtest: btBars ? LP.backtest.run(btBars, { pa, pb, P0, lpFeeFrac, tvl, efficiency: eff }) : null
      };
    }

    let rangeScore = null;
    if (range && range.backtest) rangeScore = LP.util.clamp(range.backtest.pctTimeInRange, 0, 100);

    /* --- Risk flags ------------------------------------------------------ */
    const flags = buildFlags({ pool, cross: ctx.cross, feeInfo, stats, vr24, vr3d, tvl });

    /* --- Overall verdict ------------------------------------------------- */
    const parts = [];
    if (vrScore !== null) parts.push({ w: 1.0, s: vrScore });
    if (ilScore !== null) parts.push({ w: 1.0, s: ilScore });
    if (rangeScore !== null) parts.push({ w: 0.6, s: rangeScore });
    const wSum = parts.reduce((x, p) => x + p.w, 0);
    let overall = wSum ? parts.reduce((x, p) => x + p.w * p.s, 0) / wSum : null;

    /*
     * A headline grade off one goal is worse than no grade. Volume/reserves alone would happily
     * call a hard-trending pool "Strong", so withhold the verdict unless we could also test
     * fees against divergence.
     */
    let incomplete = null;
    if (ilScore === null) {
      incomplete = 'Without price history we can only measure volume against reserves, which says ' +
        'nothing about whether fees would have beaten simply holding the two tokens. That is half ' +
        'the question, so no overall grade is shown.';
      overall = null;
    }

    // Hard risks cap the verdict regardless of the yield maths.
    const criticals = flags.filter((f) => f.level === 'critical').length;
    if (overall !== null && criticals) overall = Math.min(overall, 30);

    return {
      pool, cross: ctx.cross, feeInfo, assumptions: a, stats,
      regime: regime(stats ? stats.volAnnual : null),
      poolType: feeInfo.type,
      isCl,
      vr: { h24: vr24, h6x4: vr6x4, d3: vr3d, benchmark: vrBenchmark, score: vrScore },
      fees: {
        feePct: feeInfo.fee,
        lpShare: feeInfo.lpShare,
        confidence: feeInfo.confidence,
        aprFullRange: feeAprFullRange,
        apr3d: feeApr3d,
        dailyYield: dailyFeeYield,
        onPositionPerDay: feesPerDayOnPosition,
        poolPerDay: poolFeesPerDay
      },
      il: { scenarios, breakeven, feeYieldOverHold, holdDays, realised, score: ilScore },
      range, rangeScore,
      flags,
      incomplete,
      overall: overall === null ? null : { score: overall, grade: grade(overall) }
    };
  }

  function buildFlags(o) {
    const { pool, cross, feeInfo, stats, vr24, vr3d, tvl } = o;
    const flags = [];
    const add = (level, title, detail) => flags.push({ level, title, detail });

    const ageDays = LP.util.age(pool.createdAt);

    if (tvl === null) {
      add('warn', 'Pool size unknown', 'The data source did not report reserves, so every ratio below is unreliable.');
    } else if (tvl < 25000) {
      add('critical', 'Very thin liquidity',
        'Only ' + LP.util.usd(tvl) + ' in the pool. Your own deposit would move the pool materially, ' +
        'and exiting will cost slippage. Treat any APR here as noise.');
    } else if (tvl < 250000) {
      add('warn', 'Small pool',
        LP.util.usd(tvl) + ' of liquidity. A single large trade can reprice this pool, and the ' +
        'volume figures are easy to manipulate at this size.');
    }

    if (vr24 !== null && vr24 > 5) {
      add('warn', 'Implausible volume/reserves ratio',
        'V/R of ' + LP.util.ratio(vr24) + ' means the pool turns over ' + LP.util.ratio(vr24) +
        'x its own size every day. That can be real for a tight stable pool, but it is also the ' +
        'signature of wash trading. Check the trade history before believing the fee APR.');
    }

    const t24 = pool.txns && pool.txns.h24;
    if (t24) {
      const trades = (t24.buys || 0) + (t24.sells || 0);
      const traders = (t24.buyers || 0) + (t24.sellers || 0);
      if (traders > 0 && trades / traders > 6 && trades > 100) {
        add('warn', 'Trading looks bot-dominated',
          LP.util.int(trades) + ' trades from only ' + LP.util.int(traders) + ' unique addresses ' +
          '(' + LP.util.ratio(trades / traders, 1) + ' trades each). Arbitrage bots are the usual ' +
          'explanation; that volume is real but it is also the volume that causes your IL.');
      }
      if (trades < 20) {
        add('warn', 'Barely traded',
          'Only ' + LP.util.int(trades) + ' trades in 24h. Fee income will be lumpy and the ' +
          'annualised numbers below are extrapolated from almost nothing.');
      }
    }

    if (ageDays !== null && ageDays < 3) {
      add('critical', 'Brand new pool',
        'Created ' + LP.util.ageLabel(ageDays) + ' ago. There is no history to judge it by, and ' +
        'early volume is often incentive- or launch-driven rather than organic.');
    } else if (ageDays !== null && ageDays < 30) {
      add('warn', 'Young pool',
        'Created ' + LP.util.ageLabel(ageDays) + ' ago, so the history below is short.');
    }

    const fdv = pool.fdvUsd !== null ? pool.fdvUsd : (cross ? cross.fdv : null);
    if (fdv && tvl > 0) {
      const mult = fdv / tvl;
      if (mult > 250) {
        add('warn', 'Valuation dwarfs the liquidity',
          'Fully diluted value is ' + LP.util.ratio(mult, 0) + 'x the pool size (' +
          LP.util.usd(fdv) + ' vs ' + LP.util.usd(tvl) + '). If holders decide to exit, this pool ' +
          'is the exit — expect violent price moves and heavy IL.');
      }
    }

    if (stats) {
      if (stats.volAnnual !== null && stats.volAnnual > 1.5) {
        add('warn', 'Extreme realised volatility',
          LP.util.pct(stats.volAnnual * 100, 0) + ' annualised over the last ' +
          Math.round(stats.days) + ' days. LPs are short volatility; this much of it is expensive.');
      }
      if (stats.efficiency > 0.5 && Math.abs(Math.log(stats.netRatio)) > 0.3) {
        add('warn', 'Trending, not chopping',
          'The pair has moved ' + LP.util.signedPct((stats.netRatio - 1) * 100, 0) + ' over ' +
          Math.round(stats.days) + ' days in a fairly straight line. The OTS notes are blunt about ' +
          'this: in sustained one-way moves you are better off just holding (or shorting) the token ' +
          'than LPing it.');
      }
    }

    if (feeInfo.confidence === 'assumed') {
      add('warn', 'Swap fee was assumed, not read',
        'The fee tier could not be read from the data source, so 0.30% is assumed. Fee APR scales ' +
        'linearly with this — correct it in the assumptions panel if the pool page says otherwise.');
    }

    if (feeInfo.isVeModel) {
      add('warn', 'Swap fees do not go to LPs on this DEX',
        feeInfo.notes[0] || 'Fees are routed to veToken voters; LP yield comes from emissions.');
    }

    if (feeInfo.type === 'pendle') {
      add('warn', 'Pendle pool — different maths',
        'This pool trades principal tokens against their yield-bearing asset. The impermanent-loss ' +
        'model below assumes a constant-product spot pool and does not describe Pendle. Its LP ' +
        'exposure is closer to holding PT (which converges to par at expiry) plus swap fees.');
    }

    if (feeInfo.type === 'stable') {
      add('info', 'Stableswap curve',
        'This pool uses a stableswap invariant, so real IL is much smaller than the constant-product ' +
        'numbers below while the pair holds its peg — and much larger than they suggest if it breaks.');
    }

    if (feeInfo.type === 'weighted') {
      add('info', 'Weighted pool',
        'Non-50/50 pools have a flatter IL curve than the maths below. The OTS notes flag skewed ' +
        'pools (80/20, 90/10) as a way to keep lopsided exposure while still earning fees.');
    }

    if (pool.lockedLiquidityPct !== null && pool.lockedLiquidityPct === 0 && tvl !== null && tvl < 250000 &&
        ageDays !== null && ageDays < 60) {
      add('warn', 'No locked liquidity',
        'None of this small, young pool\'s liquidity is locked, so whoever seeded it can withdraw at will.');
    }

    add('info', 'Emissions and incentives are not counted',
      'Every yield number here is swap-fee only. Most advertised DEX APYs are mostly token ' +
      'emissions or campaign rewards (Merkl and similar). Add those separately — and remember ' +
      'they dilute as more liquidity arrives.');

    return flags;
  }

  return { run, ilV2, ilCl, clValue, capitalEfficiency, breakevenDivergence, historyStats, regime, grade };
})();
