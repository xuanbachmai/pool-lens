/*
 * Strategies and alerts for a position you actually hold.
 *
 * Two rules keep this honest:
 *
 *  1. Every strategy carries its own arithmetic. "Rebalance" is only advice if it comes with
 *     what the rebalance costs, what it earns back, and how long the payback takes -- otherwise
 *     it is a horoscope. Anything whose economics cannot be computed is not offered.
 *  2. Every alert is a NUMBER, not a mood. "Watch for volatility" is useless; "your range breaks
 *     at 2,412.50, which is 9.4% below here" is something you can put into a price alert.
 *
 * Nothing here can push a notification -- this is a static page with no backend. It computes
 * exact trigger levels, remembers them, and tells you which have already fired when you come
 * back. That limit is stated in the UI rather than papered over.
 */
window.LP = window.LP || {};

LP.strategy = (function () {
  const U = () => LP.util;
  const esc = (s) => LP.util.escapeHtml(s);

  /* ---------------------------------------------------------------- helpers */

  /**
   * Daily fee yield the position earns RIGHT NOW.
   *
   * The model's range statistics are measured against the start of its own window, which is not
   * where the user's range sits. A position whose price has left its range earns nothing at all,
   * and treating it as if it were freshly centred was enough to rank "hold" first for a position
   * that was out of range and 11% behind holding.
   */
  function dailyYield(r, pos, perf) {
    const p = LP.model.paramsFrom(r, {
      Q: pos ? pos.sizeUsd : r.assumptions.positionUsd,
      w: r.isCl && pos && pos.rangePct ? pos.rangePct / 100 : undefined
    });
    const m = LP.model.evaluate(p);
    const earning = !(perf && perf.bounds && !perf.inRangeNow);
    // While in range the position earns at the full concentrated rate; outside it, zero.
    const perDay = earning && p.T > 0 ? (m.feeYieldPct / 100) / p.T * (m.tauVol > 0 ? 1 / m.tauVol : 1) : 0;
    return {
      yieldPerDay: Number.isFinite(perDay) ? perDay : 0,
      earning, model: m, params: p
    };
  }

  /** Round-trip execution cost as a fraction of the position, when the curve is priceable. */
  function roundTripCost(r, sizeUsd) {
    const c = LP.execution.ctx(r);
    if (!c.ok || !c.valid.ok) return null;
    const rt = LP.swap.roundTrip(c.pool, sizeUsd, c.fee,
      { arriveWith: 'quote', baseFraction: c.baseFrac });
    if (!rt || rt.exitImpossible) return null;
    return { pct: rt.totalLostPct, usd: rt.totalLostUsd, ctx: c };
  }

  /* -------------------------------------------------------------- strategies */

  /**
   * @returns ranked list of {key, title, verdict, body, numbers[], score}
   *          verdict: 'do' | 'consider' | 'avoid' | 'info'
   */
  function build(r, pos, perf) {
    const out = [];
    const u = U();
    const dy = dailyYield(r, pos, perf);
    const clamp = (v) => U().clamp(v, 0, 100);
    const outOfRangeNow = !!(perf && perf.bounds && !perf.inRangeNow);
    const sizeUsd = pos ? pos.sizeUsd : r.assumptions.positionUsd;
    const rt = roundTripCost(r, sizeUsd);
    const stats = r.stats;
    const sigmaDaily = stats && stats.sdDaily ? stats.sdDaily : null;

    /* --- 1. hold ------------------------------------------------------- */
    {
      const horizon = 30;
      const feeGain = dy.yieldPerDay * horizon * 100;
      // Expected IL at a one-sigma move over the horizon: the honest middle case.
      let ilAt1Sig = null;
      if (sigmaDaily) {
        const move = Math.exp(sigmaDaily * Math.sqrt(horizon));
        ilAt1Sig = r.isCl && pos && pos.rangePct
          ? (LP.analyze.ilCl(move, 1, 1 - pos.rangePct / 100, 1 + pos.rangePct / 100) || 0) * 100
          : LP.analyze.ilV2(move) * 100;
      }
      const net = ilAt1Sig === null ? null : feeGain + ilAt1Sig;
      out.push({
        key: 'hold',
        title: outOfRangeNow ? 'Hold as you are — but you are earning nothing' : 'Hold as you are',
        verdict: outOfRangeNow ? 'avoid' : net === null ? 'info' : net > 0 ? 'do' : 'avoid',
        // Relevance, not profit: a good outlook ranks high, a bad one sinks. Same 0-100 scale
        // as every other strategy so the ordering means something.
        score: outOfRangeNow ? 5 : net === null ? 20 : clamp(50 + net * 3),
        body: outOfRangeNow
          ? 'Price is outside your range, so this position collects no fees at all while you ' +
            'wait. Holding only pays if you expect the price to come back inside ' +
            (perf.bounds ? u.price(perf.bounds.lo) + ' – ' + u.price(perf.bounds.hi) : 'your range') +
            '; otherwise you are holding a converted position for free.'
          : net === null
          ? 'Not enough price history to project a 30-day outcome.'
          : 'Over the next 30 days this position earns about ' + u.pct(feeGain, 2) +
            ' in fees. A one-sigma price move of ' +
            u.pct((Math.exp(sigmaDaily * Math.sqrt(horizon)) - 1) * 100, 0) +
            ' would cost ' + u.pct(Math.abs(ilAt1Sig), 2) + ' in impermanent loss, leaving ' +
            u.signedPct(net, 2) + '.',
        numbers: net === null ? [] : [
          ['Fees, 30 days', u.pct(feeGain, 2)],
          ['IL at one sigma', u.pct(ilAt1Sig, 2)],
          ['Net', u.signedPct(net, 2)]
        ]
      });
    }

    /* --- 2. re-centre the range --------------------------------------- */
    if (r.isCl && pos && pos.rangePct > 0 && perf && perf.bounds) {
      const outOfRange = !perf.inRangeNow;
      const w = pos.rangePct / 100;
      const effNow = LP.analyze.capitalEfficiency(1, 1 - w, 1 + w) || 1;
      // Re-centring means swapping back to the pool's ratio: one round trip's worth of friction.
      const cost = rt ? rt.pct : null;
      const yieldAfter = dy.yieldPerDay;            // a re-centred range earns the full rate again
      const payback = cost !== null && yieldAfter > 0 ? cost / 100 / yieldAfter : null;

      out.push({
        key: 'recentre',
        title: outOfRange ? 'Re-centre the range — you are earning nothing' : 'Re-centre the range',
        verdict: outOfRange ? (payback !== null && payback < 45 ? 'do' : 'consider') : 'consider',
        score: outOfRange ? 90 : 12,
        body: outOfRange
          ? 'Price is outside ' + u.price(perf.bounds.lo) + ' – ' + u.price(perf.bounds.hi) +
            ', so your liquidity is fully converted to one token and collecting no fees at all. ' +
            'Re-centring restarts the fee clock but crystallises the divergence loss.' +
            (payback !== null ? ' At the current fee rate the re-centring cost pays back in ' +
              u.ratio(payback, payback > 10 ? 0 : 1) + ' days.' : '')
          : 'Your range still brackets the price, so there is nothing to fix yet. Re-centring ' +
            'now would pay the round-trip cost for no gain.',
        numbers: [
          ['Range', u.price(perf.bounds.lo) + ' – ' + u.price(perf.bounds.hi)],
          ['Price now', u.price(perf.priceNow)],
          ['Concentration', u.ratio(effNow, 1) + '×'],
          cost === null ? null : ['Cost to re-centre', u.pct(cost, 2)],
          payback === null ? null : ['Pays back in', u.ratio(payback, 1) + ' days']
        ].filter(Boolean)
      });
    }

    /* --- 3. the width the data actually favours ------------------------ */
    if (r.isCl && r.range && r.range.bars && r.range.bars.length > 5) {
      const sweep = LP.backtest.sweep(r.range.bars, {
        lpFeeFrac: (r.fees.feePct / 100) * r.fees.lpShare,
        tvl: r.pool.tvlUsd
      });
      if (sweep.length) {
        const best = sweep.reduce((a, b) => (b.netVsHodlPct > a.netVsHodlPct ? b : a));
        const currentW = pos && pos.rangePct ? pos.rangePct : r.assumptions.rangePct;
        const better = Math.abs(best.widthPct - currentW) > currentW * 0.25;
        out.push({
          key: 'width',
          title: better ? 'Your range width is not the one the data favours' : 'Range width looks right',
          verdict: better ? 'consider' : 'info',
          score: better ? 55 : 8,
          body: 'Replaying the last ' + r.range.bars.length + ' days across a range of widths, ' +
            '±' + best.widthPct + '% produced the best net result (' +
            u.signedPct(best.netVsHodlPct, 1) + ', in range ' + u.pct(best.pctTimeInRange, 0) +
            ' of the time). You are at ±' + u.ratio(currentW, 0) + '%.' +
            (better ? '' : ' That is close enough that switching would cost more than it gains.'),
          numbers: [
            ['Best width', '±' + best.widthPct + '%'],
            ['Its net vs holding', u.signedPct(best.netVsHodlPct, 1)],
            ['Your width', '±' + u.ratio(currentW, 0) + '%']
          ]
        });
      }
    }

    /* --- 4. hedge the directional exposure ----------------------------- */
    {
      const hedge = hedgeSize(r, pos);
      if (hedge) {
        out.push({
          key: 'hedge',
          title: 'Hedge the price exposure, keep the fees',
          verdict: 'consider',
          score: stats && stats.chop < 0.5 ? 60 : 25,
          body: 'An LP position is long the pair and short volatility. Shorting ' +
            u.ratio(hedge.baseUnits, 4) + ' ' + esc(r.pool.baseSymbol || 'base') + ' (about ' +
            u.usd(hedge.usd) + ', ' + u.pct(hedge.fracOfPosition * 100, 0) +
            ' of the position) neutralises the price exposure at today\'s price, leaving the ' +
            'fee income. The hedge has to be rebalanced as the price moves, and funding on a ' +
            'perp is a real cost the fee income has to clear.',
          numbers: [
            ['Short', u.ratio(hedge.baseUnits, 4) + ' ' + (r.pool.baseSymbol || 'base')],
            ['Notional', u.usd(hedge.usd)],
            ['Delta now', u.ratio(hedge.fracOfPosition, 3) + ' of position']
          ]
        });
      }
    }

    /* --- 5. move to a better pool for the same pair --------------------- */
    out.push({
      key: 'switch',
      title: 'Check the other fee tiers for this pair',
      verdict: 'info',
      score: 20,
      body: 'The same pair often runs several pools side by side. A smaller pool at a higher fee ' +
        'tier can earn far more per dollar — the V/R ratio is what to compare, since it is the ' +
        'part that is measured rather than assumed. Use the pool comparison above; switching ' +
        'costs a full round trip' + (rt ? ' (' + u.pct(rt.pct, 2) + ' here)' : '') + ', so the ' +
        'new pool has to beat the current one by more than that before it is worth moving.',
      numbers: rt ? [['Cost to switch', u.pct(rt.pct, 2) + ' · ' + u.usd(rt.usd)]] : []
    });

    /* --- 6. exit --------------------------------------------------------*/
    {
      const trending = stats && stats.chop < 0.45 && Math.abs(Math.log(stats.netRatio)) > 0.25;
      const losing = perf && perf.netPct < 0;
      out.push({
        key: 'exit',
        title: trending ? 'Consider closing — this pair is trending, not chopping' : 'Close the position',
        verdict: trending || (losing && outOfRangeNow) ? 'consider' : 'info',
        score: trending ? 75 : losing && outOfRangeNow ? 70 : 15,
        body: trending
          ? 'The pair has moved ' + u.signedPct((stats.netRatio - 1) * 100, 0) + ' over ' +
            Math.round(stats.days) + ' days in a fairly straight line, with only ' +
            u.pct(stats.chop * 100, 0) + ' chop. Sustained one-way moves are the condition LPs ' +
            'lose in: you are sold the winner and left holding the loser on every leg. ' +
            (losing ? 'This position is already behind holding.' : '')
          : 'Closing costs the exit half of the round trip' +
            (rt ? ' (about ' + u.pct(rt.pct / 2, 2) + ')' : '') +
            ' and stops both the fees and the divergence. Worth it when the pool stops trading ' +
            'or the pair starts trending.',
        numbers: [
          stats ? ['Chop', u.pct(stats.chop * 100, 0)] : null,
          stats ? ['Move over window', u.signedPct((stats.netRatio - 1) * 100, 0)] : null,
          perf ? ['Position vs holding', u.signedPct(perf.netPct, 2)] : null
        ].filter(Boolean)
      });
    }

    return out.sort((a, b) => b.score - a.score);
  }

  /**
   * Delta of the position in base-token units.
   *
   * Full range: V = Q·sqrt(r), so dV/dP at entry is Q/(2P) -- half the position's value sits in
   * base exposure. Concentrated: no clean closed form worth hard-coding, so differentiate the
   * position value numerically. Both give the size to short to be neutral at today's price.
   */
  function hedgeSize(r, pos) {
    const price = r.pool.basePriceInQuote;
    const sizeUsd = pos ? pos.sizeUsd : r.assumptions.positionUsd;
    if (!(price > 0) || !(sizeUsd > 0)) return null;

    let fracOfPosition;
    if (r.isCl && pos && pos.rangePct > 0) {
      const w = pos.rangePct / 100;
      const h = 0.001;
      const v0 = LP.analyze.clValue(1 - h, 1, 1 - w, 1 + w);
      const v1 = LP.analyze.clValue(1 + h, 1, 1 - w, 1 + w);
      if (v0 === null || v1 === null) return null;
      // d(value)/d(relative price), normalised: value is 1 at entry, so this is the delta.
      fracOfPosition = (v1 - v0) / (2 * h);
    } else {
      fracOfPosition = 0.5;   // exact for constant product at entry
    }
    if (!Number.isFinite(fracOfPosition) || fracOfPosition <= 0) return null;

    const usd = sizeUsd * fracOfPosition;
    const quoteUsd = r.pool.quotePriceUsd || 1;
    return { fracOfPosition, usd, baseUnits: usd / (price * quoteUsd) };
  }

  /* ------------------------------------------------------------------ alerts */

  /**
   * Exact levels worth watching. Each is a threshold you can paste into any price-alert tool.
   */
  function alerts(r, pos, perf) {
    const u = U();
    const list = [];
    const price = r.pool.basePriceInQuote;
    const dy = dailyYield(r, pos, perf);
    const sizeUsd = pos ? pos.sizeUsd : r.assumptions.positionUsd;

    const add = (o) => list.push(o);

    /* --- range boundaries -------------------------------------------- */
    if (perf && perf.bounds) {
      const { lo, hi } = perf.bounds;
      const dLo = (lo / price - 1) * 100;
      const dHi = (hi / price - 1) * 100;
      add({
        key: 'range-lo', kind: 'price', level: lo, fired: price <= lo,
        title: 'Range floor — fees stop below here',
        detail: u.price(lo) + ', which is ' + u.signedPct(dLo, 1) + ' from here. Below it your ' +
          'position is entirely ' + esc(r.pool.baseSymbol || 'base') + ' and earns nothing.'
      });
      add({
        key: 'range-hi', kind: 'price', level: hi, fired: price >= hi,
        title: 'Range ceiling — fees stop above here',
        detail: u.price(hi) + ', which is ' + u.signedPct(dHi, 1) + ' from here. Above it your ' +
          'position is entirely ' + esc(r.pool.quoteSymbol || 'quote') + ' and earns nothing.'
      });
      // Early warning at 80% of the way to each edge.
      const warnLo = price - (price - lo) * 0.8;
      const warnHi = price + (hi - price) * 0.8;
      if (!perf.inRangeNow) { /* already out; the edge alerts above say so */ }
      else {
        add({
          key: 'range-warn', kind: 'price', level: null, fired: false,
          title: 'Early warning before the edge',
          detail: 'Set a pair of alerts at ' + u.price(warnLo) + ' and ' + u.price(warnHi) +
            ' to get a chance to act before the range breaks rather than after.'
        });
      }
    }

    /* --- break-even against holding ----------------------------------- */
    {
      const params = LP.model.paramsFrom(r, {
        Q: sizeUsd,
        w: r.isCl && pos && pos.rangePct ? pos.rangePct / 100 : undefined
      });
      const roots = LP.model.solve(params, 'r', 'netPct', 0, 0.2, 5);
      if (roots.length) {
        const levels = roots.map((rr) => price * rr).sort((a, b) => a - b);
        add({
          key: 'breakeven', kind: 'price', level: levels[0], fired: false,
          title: 'Where fees stop covering the divergence',
          detail: 'Over a ' + Math.round(params.T) + '-day hold this position breaks even against ' +
            'simply holding at ' + levels.map((l) => u.price(l)).join(' and ') +
            '. Outside those levels you would have been better off not providing liquidity.'
        });
      }
    }

    /* --- execution cost repaid ---------------------------------------- */
    {
      const rt = roundTripCost(r, sizeUsd);
      if (rt && dy.yieldPerDay > 0) {
        const days = (rt.pct / 100) / dy.yieldPerDay;
        const heldDays = perf ? perf.daysHeld : 0;
        const remaining = Math.max(0, days - heldDays);
        add({
          key: 'payback', kind: 'time', level: days, fired: heldDays >= days,
          title: heldDays >= days ? 'Entry and exit costs are now covered' : 'Entry cost not yet earned back',
          detail: heldDays >= days
            ? 'You have held ' + heldDays + ' days against a ' + u.ratio(days, 0) +
              '-day payback, so the round trip is paid for. Closing now no longer forfeits it.'
            : 'The round trip costs ' + u.pct(rt.pct, 2) + ' and the pool pays ' +
              u.pct(dy.yieldPerDay * 100, 3) + ' a day, so it is covered after about ' +
              u.ratio(days, 0) + ' days — roughly ' + u.ratio(remaining, 0) + ' more from today. ' +
              'Closing before then locks in a loss on execution alone.'
        });
      }
    }

    /* --- pool health -------------------------------------------------- */
    {
      const vr = r.vr.h24;
      if (vr !== null) {
        const volNeeded = r.vr.benchmark * r.pool.tvlUsd;
        add({
          key: 'vr', kind: 'pool', level: volNeeded, fired: vr < r.vr.benchmark,
          title: vr < r.vr.benchmark ? 'Pool is below the volume benchmark' : 'Watch for volume drying up',
          detail: 'V/R is ' + u.ratio(vr, 2) + ' against the 0.25 benchmark. That needs ' +
            u.usd(volNeeded) + ' of daily volume at the current ' + u.usd(r.pool.tvlUsd) +
            ' of liquidity; today it did ' + u.usd(r.pool.volume.h24) + '. ' +
            (vr < r.vr.benchmark
              ? 'Below the benchmark the fees rarely justify the divergence risk.'
              : 'If volume falls under that, the case for staying weakens.')
        });
      }
    }

    /* --- dilution ------------------------------------------------------ */
    {
      const tvl = r.pool.tvlUsd;
      if (tvl > 0) {
        add({
          key: 'tvl', kind: 'pool', level: tvl * 2, fired: false,
          title: 'Your yield halves if the pool doubles',
          detail: 'Fee APR scales with 1/TVL at constant volume. If liquidity grows from ' +
            u.usd(tvl) + ' to ' + u.usd(tvl * 2) + ' without volume following it, your share ' +
            'of the same fees halves. Incentive campaigns are the usual cause of a sudden doubling.'
        });
      }
    }

    return list;
  }

  /* ------------------------------------------------------------------ render */

  function render(r) {
    const pos = LP.position.current(r);
    const perf = pos ? LP.position.performance(r, pos) : null;
    const strategies = build(r, pos, perf);
    const alertList = alerts(r, pos, perf);
    const u = U();

    const verdictLabel = { do: 'Do this', consider: 'Consider', avoid: 'Not now', info: 'Context' };

    const cards = strategies.map((s) => `
      <div class="strat ${esc(s.verdict)}">
        <div class="strat-top">
          <strong>${esc(s.title)}</strong>
          <span class="strat-tag ${esc(s.verdict)}">${esc(verdictLabel[s.verdict] || '')}</span>
        </div>
        <p>${s.body}</p>
        ${s.numbers.length ? '<dl class="strat-nums">' + s.numbers.map(([k, v]) =>
          '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>').join('') + '</dl>' : ''}
      </div>`).join('');

    const alertRows = alertList.map((a) => `
      <li class="alert ${a.fired ? 'fired' : ''}">
        <div class="alert-top">
          <strong>${esc(a.title)}</strong>
          ${a.fired ? '<span class="alert-flag">triggered now</span>' : ''}
        </div>
        <p>${a.detail}</p>
      </li>`).join('');

    return `
    <section class="card strategies">
      <h3>What to do about it</h3>
      <p class="muted">Ranked by what the numbers for ${pos ? 'your position' : 'a ' +
        u.usd(r.assumptions.positionUsd) + ' position'} actually support. Each one carries its own
      arithmetic — cost, gain and payback — because advice without those is just a guess with
      confidence.</p>
      ${pos ? '' : '<p class="fineprint">Add your position above and these become specific to what ' +
        'you hold, including where your range breaks and whether your entry cost is earned back.</p>'}
      <div class="strat-list">${cards}</div>
    </section>

    <section class="card alerts-card">
      <h3>Levels worth watching</h3>
      <div class="callout">
        This page has no backend, so it cannot send you anything. What it can do is work out the
        exact numbers to watch and tell you which have already fired when you come back. Put the
        price levels into whatever alerting you already use.
      </div>
      <ul class="alert-list">${alertRows}</ul>
    </section>`;
  }

  return { render, build, alerts, hedgeSize, dailyYield, roundTripCost };
})();
