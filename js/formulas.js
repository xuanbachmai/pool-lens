/*
 * The formula catalogue.
 *
 * Every formula the app uses, shown three ways: symbolically, with the current pool's numbers
 * substituted in, and the result. The substitution line is the point — it is what lets you
 * check the arithmetic by hand and see exactly which input is driving an answer.
 */
window.LP = window.LP || {};

LP.formulas = (function () {
  const U = () => LP.util;

  /* ------------------------------------------------------------------ formatting */

  function sig(v, d) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const n = d === undefined ? 4 : d;
    if (v === 0) return '0';
    const abs = Math.abs(v);
    if (abs >= 1e9) return (v / 1e9).toFixed(2) + 'e9';
    if (abs >= 1e6) return (v / 1e6).toFixed(3) + 'e6';
    if (abs >= 1000) return v.toFixed(0);
    if (abs >= 1) return v.toFixed(Math.min(n, 4));
    return v.toPrecision(n);
  }

  const money = (v) => (Number.isFinite(v) ? '$' + Math.round(v).toLocaleString('en-US') : '—');
  const pct = (v, d) => (Number.isFinite(v) ? v.toFixed(d === undefined ? 2 : d) + '%' : '—');

  /** A fraction, rendered without a maths library. */
  const frac = (num, den) => '<span class="frac"><i>' + num + '</i><i>' + den + '</i></span>';
  const sq = (x) => '<span class="sqrt">' + x + '</span>';

  /* -------------------------------------------------------------------- catalogue */

  /**
   * @param r the analysis result
   * @param p the model parameters (LP.model.paramsFrom)
   * @param m evaluate(p)
   */
  function build(r, p, m) {
    const groups = [];
    const isCl = m.isCl;
    const stats = r.stats;

    /* --- symbols legend ------------------------------------------------ */
    const symbols = [
      ['V', 'Daily volume traded through the pool', money(p.V) + ' / day', p.vSource],
      ['R', 'Pool reserves (TVL) — everyone else’s liquidity', money(p.R), 'from the pool'],
      ['f', 'Swap fee, as a fraction', sig(p.f, 4) + '  (' + pct(p.f * 100, 3) + ')', r.fees.confidence],
      ['s', 'Share of the swap fee that reaches LPs', sig(p.s, 3) + '  (' + pct(p.s * 100, 0) + ')', 'per-DEX assumption'],
      ['T', 'Hold period, in days', sig(p.T, 0), 'your assumption'],
      ['Q', 'Your position size', money(p.Q), 'your assumption'],
      ['r', 'Price ratio at exit — base priced in quote, relative to entry', sig(p.r, 4),
        p.bars && p.bars.length ? 'realised over ' + p.bars.length + ' days' : 'assumed flat'],
      isCl ? ['w', 'Range half-width', sig(p.w, 3) + '  (±' + pct(p.w * 100, 1) + ')', 'your assumption'] : null,
      isCl ? ['E', 'Capital efficiency of that range vs full range', sig(m.E, 3) + '×', 'derived'] : null,
      isCl ? ['τ', 'Fraction of DAYS the price stayed in range', sig(m.tau, 3) + '  (' + pct(m.tau * 100, 1) + ')',
        m.fromBars ? 'measured on real bars' : 'assumed 1'] : null,
      isCl ? ['τ<sub>v</sub>', 'Fraction of VOLUME that traded while in range — what fees accrue on',
        sig(m.tauVol, 3) + '  (' + pct(m.tauVol * 100, 1) + ')',
        m.fromBars ? 'measured on real bars' : 'assumed 1'] : null
    ].filter(Boolean);

    /* --- 1. Fee income -------------------------------------------------- */
    const effQ = m.E * p.Q;
    const fees = [];

    fees.push({
      name: 'Your share of the pool',
      sym: 'share = ' + frac('E · Q', 'R + E · Q'),
      sub: 'share = ' + frac(sig(m.E, 3) + ' · ' + money(p.Q),
        money(p.R) + ' + ' + money(effQ)),
      val: sig(m.share, 4) + '  (' + pct(m.share * 100, 4) + ' of the pool)',
      note: 'Your own deposit is in the denominator. Adding ' + money(p.Q) + ' to a ' + money(p.R) +
        ' pool dilutes the rate you were quoted — and on a small pool that term dominates ' +
        'everything else in this page.'
    });

    fees.push({
      name: 'Fees earned over the hold',
      sym: 'Fees = V · f · s · T · τ<sub>v</sub> · share',
      sub: 'Fees = ' + money(p.V) + ' · ' + sig(p.f, 4) + ' · ' + sig(p.s, 2) + ' · ' + sig(p.T, 0) +
        ' · ' + sig(m.tauVol, 3) + ' · ' + sig(m.share, 4),
      val: money(m.feesUsd) + ' on a ' + money(p.Q) + ' position',
      note: 'τ_v is the share of VOLUME that traded while the price was inside the range, not the ' +
        'share of days. Both are 1 for a full-range position. They only differ for a concentrated ' +
        'range, and they can differ a lot — using the day count here would overstate fees whenever ' +
        'the busy days are the ones that broke the range.'
    });

    fees.push({
      name: 'Fee yield over the hold',
      sym: 'y = ' + frac('Fees', 'Q'),
      sub: 'y = ' + frac(money(m.feesUsd), money(p.Q)),
      val: pct(m.feeYieldPct, 3),
      note: null
    });

    fees.push({
      name: 'Fee APR',
      sym: 'APR = y · ' + frac('365', 'T'),
      sub: 'APR = ' + pct(m.feeYieldPct, 3) + ' · ' + frac('365', sig(p.T, 0)),
      val: pct(m.feeAprPct, 1),
      note: 'An extrapolation, not a forecast: it annualises whatever volume the pool happened ' +
        'to do over this window.'
    });

    fees.push({
      name: 'Fee APR, simplified',
      sym: 'APR ≈ ' + frac('V', 'R') + ' · f · s · 365',
      sub: 'APR ≈ ' + sig(p.R > 0 ? p.V / p.R : 0, 4) + ' · ' + sig(p.f, 4) + ' · ' + sig(p.s, 2) + ' · 365',
      val: pct(p.R > 0 ? (p.V / p.R) * p.f * p.s * 365 * 100 : 0, 1) +
        (isCl ? '  (full range, before the ' + sig(m.E, 2) + '× concentration)' : ''),
      note: 'Drop the dilution and range terms and the whole thing collapses to this. Volume, ' +
        'fee and LP share are all elasticity +1; reserves is −1. Double the volume, double the ' +
        'APR. Double the TVL, halve it.'
    });

    fees.push({
      name: 'Volume / reserves ratio',
      sym: 'V/R = ' + frac('V', 'R'),
      sub: 'V/R = ' + frac(money(p.V), money(p.R)),
      val: sig(p.R > 0 ? p.V / p.R : 0, 3) + '   (benchmark 0.25)',
      note: 'The screening metric from the OTS notes. It is fee APR with the fee tier divided ' +
        'out, which is why it compares pools across different fee tiers fairly.'
    });

    groups.push({ group: 'Fee income', items: fees });

    /* --- 2. Impermanent loss -------------------------------------------- */
    const il = [];

    il.push({
      name: 'Constant-product impermanent loss',
      sym: 'IL(r) = ' + frac('2' + sq('r'), '1 + r') + ' − 1',
      sub: 'IL(' + sig(p.r, 4) + ') = ' + frac('2 · ' + sig(Math.sqrt(p.r), 4), '1 + ' + sig(p.r, 4)) + ' − 1',
      val: pct(LP.analyze.ilV2(p.r) * 100, 3),
      note: 'Measured against holding the two tokens, not against your entry value. IL(r) = IL(1/r), ' +
        'so a halving hurts exactly as much as a doubling.',
      derivation:
        'From x·y = k: at price P the reserves are x = √(k/P) and y = √(kP), so the pool is worth ' +
        '2√(kP). Holding the entry basket at the new price is worth x₀P + y₀. Dividing one by the ' +
        'other and writing r = P₁/P₀ leaves 2√r/(1+r).'
    });

    if (isCl) {
      const pa = 1 - p.w, pb = 1 + p.w;
      il.push({
        name: 'Concentrated position value',
        sym: 'V(P) = L · (2' + sq('P') + ' − P/' + sq('p<sub>b</sub>') + ' − ' + sq('p<sub>a</sub>') + ')',
        sub: 'V(' + sig(p.r, 4) + ') with p<sub>a</sub> = ' + sig(pa, 4) + ', p<sub>b</sub> = ' + sig(pb, 4) +
          ' (entry price normalised to 1)',
        val: sig(LP.analyze.clValue(p.r, 1, pa, pb), 4) + ' × entry value',
        note: 'Valid while the price is inside the range. Above p_b the position is entirely quote ' +
          'token and worth L(√p_b − √p_a); below p_a it is entirely base token and worth ' +
          'L(1/√p_a − 1/√p_b)·P — which is why an out-of-range position stops tracking the price.'
      });

      il.push({
        name: 'Concentrated impermanent loss',
        sym: 'IL = ' + frac('V<sub>position</sub>(P)', 'V<sub>hodl</sub>(P)') + ' − 1',
        sub: 'against the same entry basket at r = ' + sig(p.r, 4),
        val: pct(m.ilPct, 3) + '   (full range would be ' + pct(LP.analyze.ilV2(p.r) * 100, 3) + ')',
        note: 'Concentration amplifies IL by roughly the same factor it amplifies fees. That is the ' +
          'whole trade: E× the fees while in range, and something close to E× the divergence loss.'
      });
    }

    const be = LP.analyze.breakevenDivergence(m.feeYieldPct / 100);
    il.push({
      name: 'Break-even divergence',
      sym: 'solve  1 − ' + frac('2' + sq('r'), '1 + r') + ' = F   ⟹   ' +
        sq('r') + ' = ' + frac('1 + ' + sq('1 − (1 − F)²'), '1 − F'),
      sub: 'F = ' + pct(m.feeYieldPct, 3) + ' of fees accumulated over ' + sig(p.T, 0) + ' days',
      val: be === null ? 'fees cover any divergence'
        : '+' + pct(be.up * 100, 1) + ' up  /  ' + pct(be.down * 100, 1) + ' down',
      note: 'How far the price can diverge before you would have been better off just holding. ' +
        'Closed form, not a search — set IL equal to the fees and solve the quadratic in √r.'
    });

    il.push({
      name: 'Net result versus holding',
      sym: 'Net = y + IL(r)',
      sub: 'Net = ' + pct(m.feeYieldPct, 3) + ' + (' + pct(m.ilPct, 3) + ')',
      val: (m.netPct >= 0 ? '+' : '') + pct(m.netPct, 3) + '   (' + money(m.netUsd) + ' on ' + money(p.Q) + ')',
      note: 'IL is already negative, so this is a sum rather than a difference. Positive means the ' +
        'position beat holding the two tokens over this window.'
    });

    groups.push({ group: 'Impermanent loss', items: il });

    /* --- 3. Range mechanics --------------------------------------------- */
    if (isCl) {
      const rng = [];
      const pa = 1 - p.w, pb = 1 + p.w;

      rng.push({
        name: 'Capital efficiency',
        sym: 'E = ' + frac('1', '1 − ( ' + sq('P / p<sub>b</sub>') + ' + ' + sq('p<sub>a</sub> / P') + ' ) / 2'),
        sub: 'E = ' + frac('1', '1 − ( ' + sig(Math.sqrt(1 / pb), 4) + ' + ' + sig(Math.sqrt(pa), 4) + ' ) / 2'),
        val: sig(m.E, 3) + '×',
        note: 'How many times more fees the same capital earns while the price is inside the range. ' +
          'For a geometric range [P/m, P·m] this collapses to E = 1/(1 − 1/√m), so a 4×-wide range ' +
          'gives exactly 2×.'
      });

      rng.push({
        name: 'Time in range (by days)',
        sym: 'τ = ' + frac('days with p<sub>a</sub> ≤ P ≤ p<sub>b</sub>', 'days in the window'),
        sub: p.bars && p.bars.length
          ? 'τ = ' + frac(Math.round(m.tau * p.bars.length), p.bars.length) + ' daily closes'
          : 'no price history — assumed 1',
        val: pct(m.tau * 100, 1),
        note: 'Measured, not modelled: this is the real price path replayed. It is what people mean ' +
          'by "in range", and it is the term that punishes a tight range.'
      });

      rng.push({
        name: 'Active volume share',
        sym: 'τ<sub>v</sub> = ' + frac('volume traded while in range', 'total volume in the window'),
        sub: 'τ<sub>v</sub> = ' + pct(m.tauVol * 100, 1) + '  against τ = ' + pct(m.tau * 100, 1) + ' of days',
        val: pct(m.tauVol * 100, 1),
        note: Math.abs(m.tauVol - m.tau) < 0.005
          ? 'Here the two agree, so in-range days were ordinary-volume days.'
          : 'These differ by ' + pct(Math.abs(m.tauVol - m.tau) * 100, 1) + ' on this pool, which is ' +
            'the whole reason fees are computed on τ_v. ' +
            (m.tauVol < m.tau
              ? 'The in-range days were the quiet ones, so day-count time-in-range flatters the fee estimate.'
              : 'The in-range days were the busy ones, so this range captured more fees than its day count suggests.')
      });

      rng.push({
        name: 'Effective fee multiplier',
        sym: 'boost = E · τ<sub>v</sub>',
        sub: 'boost = ' + sig(m.E, 3) + ' · ' + sig(m.tauVol, 3),
        val: sig(m.E * m.tauVol, 3) + '×',
        note: 'The number that actually matters. Narrowing the range raises E and lowers τ_v, so this ' +
          'product peaks somewhere in the middle — which is what the width sweep finds.'
      });

      groups.push({ group: 'Range mechanics', items: rng });
    }

    /* --- 4. Price behaviour --------------------------------------------- */
    if (stats) {
      const px = [];
      px.push({
        name: 'Realised volatility',
        sym: 'σ<sub>daily</sub> = stdev( ln( P<sub>t</sub> / P<sub>t−1</sub> ) ),   σ<sub>ann</sub> = σ<sub>daily</sub> · ' + sq('365'),
        sub: 'σ<sub>daily</sub> = ' + sig(stats.sdDaily, 4) + ',  ' + sq('365') + ' = 19.105',
        val: pct(stats.volAnnual * 100, 1) + ' annualised, over ' + Math.round(stats.days) + ' days',
        note: 'LPs are structurally short volatility. This is the single number that sets how much ' +
          'IL you should expect and how quickly a range breaks.'
      });

      px.push({
        name: 'Chop versus trend',
        sym: 'chop = 1 − ' + frac('| Σ ln returns |', 'Σ | ln returns |'),
        sub: 'chop = 1 − ' + frac(sig(Math.abs(Math.log(stats.netRatio)), 4),
          sig(Math.abs(Math.log(stats.netRatio)) / Math.max(1e-9, stats.efficiency), 4)),
        val: pct(stats.chop * 100, 1) + (stats.chop > 0.7 ? '  (choppy — good for LPs)'
          : stats.chop > 0.45 ? '  (mixed)' : '  (trending — bad for LPs)'),
        note: 'Path efficiency inverted. A pair that ends where it started after moving a great ' +
          'deal pays fees the whole way and costs nothing in IL. A pair that walks in a straight ' +
          'line does the opposite.'
      });

      groups.push({ group: 'Price behaviour', items: px });
    }

    /* --- 5. How the scores are built ------------------------------------ */
    const sc = [];
    sc.push({
      name: 'Goal 2 — V/R score',
      sym: 'score = clamp( ' + frac('V/R', '0.25') + ' · 55,  0,  100 )',
      sub: r.vr.d3 !== null || r.vr.h24 !== null
        ? 'score = clamp( ' + frac(sig(r.vr.d3 !== null ? r.vr.d3 : r.vr.h24, 3), '0.25') + ' · 55 )'
        : 'no volume data',
      val: r.vr.score === null ? '—' : Math.round(r.vr.score) + ' / 100',
      note: 'Calibrated so the 0.25 benchmark from the OTS notes lands at 55 — a pass, not a top mark. ' +
        'Capped at 70 when V/R exceeds 5, because that is usually wash volume rather than a good pool.'
    });
    sc.push({
      name: 'Goal 3 — fees vs IL score',
      sym: 'score = clamp( ' + frac('fees', '| IL |') + ' · 50,  0,  100 )',
      sub: r.il.realised && r.il.realised.feePct !== null
        ? 'score = clamp( ' + frac(pct(r.il.realised.feePct, 3), pct(Math.abs(r.il.realised.ilPct), 3)) + ' · 50 )'
        : 'no history',
      val: r.il.score === null ? '—' : Math.round(r.il.score) + ' / 100',
      note: 'Fees exactly covering IL scores 50. Capped at 40 when fee APR is under 1%, so a pegged ' +
        'pair cannot ace this goal by having no divergence to beat.'
    });
    if (r.isCl) {
      sc.push({
        name: 'Goal 1 — range score',
        sym: 'score = τ · 100',
        sub: 'score = ' + sig(r.range && r.range.backtest ? r.range.backtest.pctTimeInRange / 100 : m.tau, 3) + ' · 100',
        val: r.rangeScore === null ? '—' : Math.round(r.rangeScore) + ' / 100',
        note: 'Simply the fraction of the window the backtested range held.'
      });
    }
    sc.push({
      name: 'Overall',
      sym: 'overall = ' + frac('Σ wᵢ · scoreᵢ', 'Σ wᵢ') + ',   w = 1.0 / 1.0 / 0.6',
      sub: r.overall ? 'weighted across the goals that could be measured' : 'withheld — see the verdict panel',
      val: r.overall ? Math.round(r.overall.score) + ' / 100  (' + r.overall.grade.label + ')' : 'incomplete',
      note: 'Range gets less weight because it is conditional on a width you chose. Capped at 30 if ' +
        'any critical risk flag fires, and withheld entirely when there is no price history.'
    });
    groups.push({ group: 'How the scores are built', items: sc });

    return { symbols, groups };
  }

  return { build, frac, sq, sig, money, pct };
})();
