/*
 * Constant-product swap maths, and what it costs to open and close an LP position.
 *
 * The analysis elsewhere in this app reasons from aggregate TVL and volume. This module
 * reasons from the curve itself: given the pool's actual token reserves, what does a trade
 * of a given size actually fill at?
 *
 * Fee is taken on the input, Uniswap-v2 style. Exact quote for a desired output, which is
 * the form the lecture notebook uses:
 *
 *     dx = ( X·Y / (Y − dy) − X ) / (1 − f)
 *
 * and its inverse, the output for a given input:
 *
 *     dy = dx·(1 − f)·Y / ( X + dx·(1 − f) )
 *
 * IMPORTANT -- when this is valid. For a constant-product pool the reserves define the
 * whole curve, and everything here is exact. For a concentrated-liquidity pool the total
 * reserves say what inventory the pool holds but NOT how deep it is at the current price,
 * so the same arithmetic would be badly wrong. We detect which case we are in from the data
 * rather than trusting the DEX label: on a real CPMM pool the reserve ratio equals the spot
 * price to within rounding, and on a concentrated pool it does not (a live Uniswap v3
 * WETH/USDC pool showed a reserve ratio of 8243 against a spot price of 2674).
 */
window.LP = window.LP || {};

LP.swap = (function () {
  /** Output received for a given input. Fee on the way in. */
  function amountOut(amountIn, reserveIn, reserveOut, fee) {
    if (!(amountIn > 0 && reserveIn > 0 && reserveOut > 0)) return 0;
    const inAfterFee = amountIn * (1 - fee);
    return (inAfterFee * reserveOut) / (reserveIn + inAfterFee);
  }

  /** Input required for a desired output. Returns null if the pool cannot fill it. */
  function amountIn(amountOut, reserveIn, reserveOut, fee) {
    if (!(amountOut > 0 && reserveIn > 0 && reserveOut > 0)) return null;
    if (amountOut >= reserveOut) return null; // would drain the pool
    return ((reserveIn * reserveOut) / (reserveOut - amountOut) - reserveIn) / (1 - fee);
  }

  /**
   * Does this pool's reserve pair actually describe a constant-product curve?
   * On a CPMM pool reserveQuote / reserveBase is the spot price by construction.
   */
  function curveIsValid(reserveBase, reserveQuote, spotBaseInQuote) {
    if (!(reserveBase > 0 && reserveQuote > 0 && spotBaseInQuote > 0)) return { ok: false, reason: 'missing reserves' };
    const implied = reserveQuote / reserveBase;
    const err = Math.abs(implied / spotBaseInQuote - 1);
    return {
      ok: err < 0.02,
      impliedPrice: implied,
      spotPrice: spotBaseInQuote,
      error: err,
      reason: err < 0.02 ? null
        : 'The reserve ratio (' + implied.toPrecision(6) + ') does not match the spot price (' +
          spotBaseInQuote.toPrecision(6) + '), so these reserves do not describe a constant-product ' +
          'curve. That is expected for a concentrated-liquidity pool: the totals are inventory ' +
          'spread across many price ranges, not depth at the current price.'
    };
  }

  /**
   * Quote a trade against the pool.
   * @param dir 'buyBase'  - spend quote, receive base
   *            'sellBase' - spend base, receive quote
   * @returns fill price in quote-per-base, plus impact split into fee and curve slippage
   */
  function quote(pool, sizeIn, dir, fee) {
    const { base: X, quote: Y } = pool;
    const mid = Y / X;
    if (!(sizeIn > 0)) return null;

    let out, fill;
    if (dir === 'buyBase') {
      out = amountOut(sizeIn, Y, X, fee);          // in quote, out base
      if (!(out > 0)) return null;
      fill = sizeIn / out;                          // quote per base
    } else {
      out = amountOut(sizeIn, X, Y, fee);          // in base, out quote
      if (!(out > 0)) return null;
      fill = out / sizeIn;                          // quote per base
    }

    // Worse fill means paying more per base when buying, receiving less when selling.
    const impact = dir === 'buyBase' ? fill / mid - 1 : 1 - fill / mid;
    // Strip the fee out to isolate pure curve slippage, as the lecture notebook does.
    const midWithFee = dir === 'buyBase' ? mid / (1 - fee) : mid * (1 - fee);
    const exFee = dir === 'buyBase' ? fill / midWithFee - 1 : 1 - fill / midWithFee;

    return { sizeIn, out, mid, fill, impact, exFee, feePaid: sizeIn * fee, dir };
  }

  /**
   * Cost of moving `usd` of value through the pool: the value lost to fee plus slippage.
   *
   * Everything is marked at the POOL'S OWN mid price and measured in quote units, then
   * converted to USD once at the end. Valuing the output at an external USD price instead
   * would fold the disagreement between two independently-sampled data sources into the
   * answer -- on a live WETH/USDC pool the reserve-implied mid and the quoted USD price
   * differed by 0.25%, which is comparable to the fee itself and made a symmetric round
   * trip look wildly asymmetric (0.64% in, 0.06% out).
   */
  function costOfUsd(pool, usd, dir, fee) {
    const { base: X, quote: Y, baseUsd, quoteUsd } = pool;
    if (!(usd > 0 && quoteUsd > 0)) return null;
    const mid = Y / X;

    // Convert the USD amount into the token going in, via the pool's own pricing.
    const sizeIn = dir === 'buyBase' ? usd / quoteUsd : usd / (mid * quoteUsd);
    const q = quote(pool, sizeIn, dir, fee);
    if (!q) return null;

    // Value in and out, both in quote units at mid. A frictionless swap would break even.
    const valueInQuote = dir === 'buyBase' ? sizeIn : sizeIn * mid;
    const valueOutQuote = dir === 'buyBase' ? q.out * mid : q.out;
    const lostUsd = (valueInQuote - valueOutQuote) * quoteUsd;

    return Object.assign({}, q, {
      usdIn: valueInQuote * quoteUsd,
      usdOut: valueOutQuote * quoteUsd,
      lostUsd,
      lostPct: (lostUsd / (valueInQuote * quoteUsd)) * 100,
      // How much of the pool this trade represents -- the thing that actually drives slippage.
      sizeVsPool: valueInQuote / (Y + X * mid)
    });
  }

  /**
   * The token split a position must hold.
   *   Full range  -> 50/50 by value.
   *   Range [pa,pb] at price P -> exact from the v3 position formulas, no tick data needed.
   * @returns fraction of the position's value that must sit in the BASE token
   */
  function baseValueFraction(isCl, w) {
    if (!isCl || !(w > 0 && w < 1)) return 0.5;
    const P = 1, pa = 1 - w, pb = 1 + w;
    const x = 1 / Math.sqrt(P) - 1 / Math.sqrt(pb);   // base units, L = 1
    const y = Math.sqrt(P) - Math.sqrt(pa);           // quote units
    const vb = x * P;
    return vb / (vb + y);
  }

  /**
   * What it costs to open a position and later close it, assuming you arrive holding a
   * single token and want to leave holding that same token.
   *
   * Two details that matter and are easy to get wrong:
   *  - You only swap the part that has to change hands, not the whole position.
   *  - On exit, your own liquidity is no longer in the pool, so the sell is priced against
   *    the pool MINUS your position. On a thin pool that is a large correction.
   */
  function roundTrip(pool, positionUsd, fee, opts) {
    const o = opts || {};
    const arriveWith = o.arriveWith || 'quote';       // 'quote' | 'base' | 'balanced'
    const targetBaseFrac = o.baseFraction === undefined ? 0.5 : o.baseFraction;

    const poolUsd = poolValueUsd(pool);
    if (!(poolUsd > 0)) return null;

    // --- entry -------------------------------------------------------------
    let entrySwapUsd, entryDir;
    if (arriveWith === 'quote') { entrySwapUsd = positionUsd * targetBaseFrac; entryDir = 'buyBase'; }
    else if (arriveWith === 'base') { entrySwapUsd = positionUsd * (1 - targetBaseFrac); entryDir = 'sellBase'; }
    else { entrySwapUsd = 0; entryDir = null; }

    const entry = entrySwapUsd > 0 ? costOfUsd(pool, entrySwapUsd, entryDir, fee) : null;

    // --- exit --------------------------------------------------------------
    // Price the exit against the pool after your own liquidity has been pulled out.
    const shrunk = shrinkPool(pool, positionUsd);
    let exitSwapUsd, exitDir;
    if (arriveWith === 'quote') { exitSwapUsd = positionUsd * targetBaseFrac; exitDir = 'sellBase'; }
    else if (arriveWith === 'base') { exitSwapUsd = positionUsd * (1 - targetBaseFrac); exitDir = 'buyBase'; }
    else { exitSwapUsd = 0; exitDir = null; }

    /*
     * If the position is the whole pool there is nothing left to sell into once you withdraw.
     * Say so explicitly -- returning a result with a silently-missing exit leg would render as
     * "no swap needed", which is the opposite of the truth.
     */
    const exitImpossible = exitSwapUsd > 0 && !shrunk;
    const exit = exitSwapUsd > 0 && shrunk ? costOfUsd(shrunk, exitSwapUsd, exitDir, fee) : null;

    const totalLost = (entry ? entry.lostUsd : 0) + (exit ? exit.lostUsd : 0);
    return {
      arriveWith,
      targetBaseFrac,
      poolUsd,
      positionVsPool: positionUsd / poolUsd,
      entry, exit, exitImpossible,
      totalLostUsd: exitImpossible ? null : totalLost,
      totalLostPct: exitImpossible ? null : (totalLost / positionUsd) * 100,
      exitPricedAgainst: shrunk ? poolValueUsd(shrunk) : null
    };
  }

  /** Total pool value in USD, priced off the pool's own reserve ratio. */
  function poolValueUsd(pool) {
    return (pool.quote + pool.base * (pool.quote / pool.base)) * pool.quoteUsd;
  }

  /** The same pool with `usd` of liquidity removed proportionally. */
  function shrinkPool(pool, usd) {
    const poolUsd = poolValueUsd(pool);
    if (!(poolUsd > usd)) return null;                 // you are the whole pool; no exit to price
    const k = 1 - usd / poolUsd;
    return Object.assign({}, pool, { base: pool.base * k, quote: pool.quote * k });
  }

  /** Cost of a ladder of trade sizes, for a depth table. */
  function depthTable(pool, fee, sizes) {
    const poolUsd = poolValueUsd(pool);
    const list = sizes || [1e3, 1e4, 1e5, 1e6, 1e7].filter((s) => s < poolUsd * 3);
    return list.map((usd) => {
      const buy = costOfUsd(pool, usd, 'buyBase', fee);
      return buy ? {
        usd,
        pctOfPool: (usd / poolUsd) * 100,
        fill: buy.fill,
        mid: buy.mid,
        impactPct: buy.impact * 100,
        exFeePct: buy.exFee * 100,
        lostUsd: buy.lostUsd,
        lostPct: buy.lostPct
      } : null;
    }).filter(Boolean);
  }

  /**
   * Trade size that moves the pool's post-fee marginal price exactly to an external price.
   * This is the arbitrage that LPs pay for on every price move (the LVR drag).
   */
  function arbSize(pool, externalPrice, fee) {
    const { base: X, quote: Y } = pool;
    const K = X * Y;
    const mid = Y / X;
    const upper = mid / (1 - fee);
    const lower = mid * (1 - fee);

    if (externalPrice > upper) {
      // Pool is cheap: buy base from the pool, sell outside.
      const x1 = Math.sqrt(K / (externalPrice * (1 - fee)));
      const dxBase = X - x1;
      const costQuote = (K / x1 - Y) / (1 - fee);
      return {
        dir: 'buyBase', sizeBase: dxBase, costQuote,
        grossUsd: (dxBase * externalPrice - costQuote) * (pool.quoteUsd || 1),
        priceAfter: K / (x1 * x1)
      };
    }
    if (externalPrice < lower) {
      const x1 = Math.sqrt((K * (1 - fee)) / externalPrice);
      const dxBase = (x1 - X) / (1 - fee);
      const recvQuote = Y - K / x1;
      return {
        dir: 'sellBase', sizeBase: dxBase, costQuote: -recvQuote,
        grossUsd: (recvQuote - dxBase * externalPrice) * (pool.quoteUsd || 1),
        priceAfter: K / (x1 * x1)
      };
    }
    return { dir: 'none', sizeBase: 0, grossUsd: 0, priceAfter: mid, band: [lower, upper] };
  }

  /** Build the reserve view this module needs from an analysis result. */
  function poolFrom(result) {
    const cross = result.cross;
    const p = result.pool;
    const res = cross && cross.reserves;
    if (!res || !(res.base > 0) || !(res.quote > 0)) {
      return { ok: false, reason: 'The data source did not report token-level reserves for this pool.' };
    }
    const baseUsd = p.basePriceUsd;
    const quoteUsd = p.quotePriceUsd;
    if (!(baseUsd > 0) || !(quoteUsd > 0)) {
      return { ok: false, reason: 'No USD price for one side of the pair.' };
    }
    const valid = curveIsValid(res.base, res.quote, p.basePriceInQuote);
    return {
      ok: true,
      pool: { base: res.base, quote: res.quote, baseUsd, quoteUsd },
      valid,
      poolUsd: poolValueUsd({ base: res.base, quote: res.quote, quoteUsd }),
      baseSymbol: p.baseSymbol, quoteSymbol: p.quoteSymbol
    };
  }

  return {
    amountOut, amountIn, quote, costOfUsd, roundTrip, depthTable,
    arbSize, baseValueFraction, curveIsValid, shrinkPool, poolValueUsd, poolFrom
  };
})();
