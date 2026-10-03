/* Edge-case tests for the maths modules. These are the numbers that cost money if wrong. */
import { loadLP, suite, check, near, throwsOrNull, report } from './harness.mjs';

const LP = loadLP();
const A = LP.analyze, S = LP.swap, M = LP.model, B = LP.backtest;

/* ------------------------------------------------- impermanent loss */
suite('analyze.ilV2');
near('no move is no loss', A.ilV2(1), 0);
near('2x matches the textbook value', A.ilV2(2), -0.05719095841793653, 1e-12);
near('symmetric in r and 1/r', A.ilV2(0.5), A.ilV2(2), 1e-12);
near('4x', A.ilV2(4), -0.2, 1e-12);
check('always a loss for any move', [0.01, 0.3, 0.9, 1.1, 3, 100]
  .every((r) => A.ilV2(r) < 0));
check('monotone away from 1', A.ilV2(3) < A.ilV2(2) && A.ilV2(2) < A.ilV2(1.5));
throwsOrNull('zero price ratio', () => A.ilV2(0));
throwsOrNull('negative price ratio', () => A.ilV2(-1));

suite('analyze.capitalEfficiency');
near('4x geometric range is exactly 2x', A.capitalEfficiency(100, 25, 400), 2, 1e-12);
check('full-ish range tends to 1', A.capitalEfficiency(100, 1e-9, 1e9) < 1.001);
check('tighter range is more efficient',
  A.capitalEfficiency(100, 95, 105) > A.capitalEfficiency(100, 80, 120));
throwsOrNull('inverted bounds', () => A.capitalEfficiency(100, 120, 80));
throwsOrNull('zero lower bound', () => A.capitalEfficiency(100, 0, 200));

suite('analyze.ilCl');
near('at entry there is no loss', A.ilCl(1, 1, 0.8, 1.2), 0, 1e-12);
check('concentrated loses more than full range',
  A.ilCl(1.3, 1, 0.8, 1.2) < A.ilV2(1.3));
check('out of range both directions is still a loss',
  A.ilCl(5, 1, 0.8, 1.2) < 0 && A.ilCl(0.2, 1, 0.8, 1.2) < 0);
throwsOrNull('entry outside the range is undefined', () => A.ilCl(1.5, 2, 0.8, 1.2));

suite('analyze.breakevenDivergence');
for (const f of [0.001, 0.01, 0.05, 0.2]) {
  const be = A.breakevenDivergence(f);
  near('IL at the +' + (f * 100).toFixed(1) + '% breakeven equals the fees',
    A.ilV2(1 + be.up), -f, 1e-9);
  near('IL at the -' + (f * 100).toFixed(1) + '% breakeven equals the fees',
    A.ilV2(1 + be.down), -f, 1e-9);
}
check('zero fees cover nothing', A.breakevenDivergence(0).up === 0);
check('fees above 100% cover any move', A.breakevenDivergence(1.5) === null);

/* ------------------------------------------------------------ swap */
suite('swap.amountIn / amountOut');
near('notebook worked case: 0.1 BTC from 100k/2 at 0.30%',
  S.amountIn(0.1, 1e5, 2, 0.003), 5278.994879, 1e-5);
for (const [X, Y, f] of [[1e5, 2, 0.003], [1e6, 500, 0], [50, 50, 0.01], [1e9, 1e9, 0.002]]) {
  const inAmt = Math.min(X, Y) * 0.01;
  const out = S.amountOut(inAmt, X, Y, f);
  near('round trip X=' + X + ' Y=' + Y + ' f=' + f,
    S.amountIn(out, X, Y, f), inAmt, inAmt * 1e-9);
}
check('cannot drain the pool', S.amountIn(100, 1e5, 100, 0.003) === null);
check('cannot take more than the reserve', S.amountIn(101, 1e5, 100, 0) === null);
check('zero input gives zero output', S.amountOut(0, 100, 100, 0.003) === 0);
check('negative input gives zero output', S.amountOut(-5, 100, 100, 0.003) === 0);
check('output always below the reserve',
  [1, 1e3, 1e9, 1e15].every((i) => S.amountOut(i, 100, 100, 0.003) < 100));

suite('swap.curveIsValid');
check('reserve ratio equal to spot is a valid curve', S.curveIsValid(100, 300000, 3000).ok);
check('tolerates small drift', S.curveIsValid(100, 300000, 3000 * 1.01).ok);
check('rejects a concentrated pool', !S.curveIsValid(9086.5, 74901849, 2673.6).ok);
check('rejects missing reserves', !S.curveIsValid(0, 100, 1).ok);

suite('swap.costOfUsd');
const pool = { base: 1000, quote: 3e6, baseUsd: 3000, quoteUsd: 1 };
for (const f of [0, 0.0005, 0.003, 0.01]) {
  const tiny = S.costOfUsd(pool, 0.01, 'buyBase', f);
  near('a dust trade costs only the ' + (f * 100).toFixed(2) + '% fee', tiny.lostPct, f * 100, 1e-4);
}
const buy = S.costOfUsd(pool, 10000, 'buyBase', 0.003);
const sell = S.costOfUsd(pool, 10000, 'sellBase', 0.003);
near('buy and sell cost the same at the same size', buy.lostPct, sell.lostPct, 1e-9);
check('cost grows with size', [1e3, 1e4, 1e5, 1e6]
  .map((u) => S.costOfUsd(pool, u, 'buyBase', 0.003).lostPct)
  .every((v, i, a) => i === 0 || v > a[i - 1]));

suite('swap.baseValueFraction');
near('full range is 50/50', S.baseValueFraction(false, null), 0.5, 1e-12);
check('a range skews the split', S.baseValueFraction(true, 0.5) < 0.5);
check('a tight range approaches 50/50',
  Math.abs(S.baseValueFraction(true, 0.01) - 0.5) < 0.01);

suite('swap.roundTrip');
const rt = S.roundTrip(pool, 10000, 0.003, { arriveWith: 'quote', baseFraction: 0.5 });
check('entry and exit both priced', !!(rt.entry && rt.exit));
check('cost is positive', rt.totalLostPct > 0);
check('balanced arrival needs no swap',
  S.roundTrip(pool, 10000, 0.003, { arriveWith: 'balanced', baseFraction: 0.5 }).totalLostPct === 0);
const tooBig = S.roundTrip(pool, 1e9, 0.003, { arriveWith: 'quote', baseFraction: 0.5 });
check('position larger than the pool is flagged', tooBig.exitImpossible === true);
check('and reports no total rather than a wrong one', tooBig.totalLostPct === null);

suite('swap.arbSize');
const mid = 3000;
check('inside the fee band there is nothing to do',
  S.arbSize(pool, mid, 0.003).dir === 'none');
check('pool cheap means buy from it', S.arbSize(pool, mid * 1.2, 0.003).dir === 'buyBase');
check('pool rich means sell into it', S.arbSize(pool, mid * 0.8, 0.003).dir === 'sellBase');
const arb = S.arbSize(pool, mid * 1.2, 0.003);
check('arbitrage is profitable outside the band', arb.grossUsd > 0);
check('band widens with the fee',
  S.arbSize(pool, mid * 1.004, 0.01).dir === 'none' &&
  S.arbSize(pool, mid * 1.004, 0.0005).dir !== 'none');

/* ----------------------------------------------------------- model */
suite('model.evaluate');
const p = { V: 1e8, R: 1e8, f: 0.003, s: 1, T: 30, Q: 1e4, w: null, r: 1.2, isCl: false, bars: null };
near('fee yield matches the closed form',
  M.evaluate(p).feeYieldPct,
  1e8 * 0.003 * 30 * (1e4 / (1e8 + 1e4)) / 1e4 * 100, 1e-9);
near('IL matches analyze', M.evaluate(p).ilPct, A.ilV2(1.2) * 100, 1e-12);
check('net is fees plus IL',
  Math.abs(M.evaluate(p).netPct - (M.evaluate(p).feeYieldPct + M.evaluate(p).ilPct)) < 1e-12);
check('zero position earns zero', M.evaluate(Object.assign({}, p, { Q: 0 })).feeYieldPct === 0);
check('empty pool does not divide by zero',
  Number.isFinite(M.evaluate(Object.assign({}, p, { R: 0 })).feeYieldPct));

suite('model.elasticity');
for (const pair of [['V', 1], ['f', 1], ['s', 1], ['T', 1], ['R', -1]]) {
  near(pair[0] + ' has elasticity ' + pair[1], M.elasticity(p, pair[0], 'feeYieldPct'), pair[1], 1e-6);
}
near('LP share is still 1 at the boundary',
  M.elasticity(Object.assign({}, p, { s: 1 }), 's', 'feeYieldPct'), 1, 1e-6);
near('and at an interior point',
  M.elasticity(Object.assign({}, p, { s: 0.5 }), 's', 'feeYieldPct'), 1, 1e-6);

suite('model dilution');
const share = (R) => M.evaluate(Object.assign({}, p, { R })).share;
near('owning half of a pool your own size', share(1e4), 0.5, 1e-12);
check('share rises as the pool shrinks', share(1e9) < share(1e6) && share(1e6) < share(1e4));

suite('model.solve');
const roots = M.solve(p, 'r', 'netPct', 0, 0.2, 5);
check('finds both break-even prices', roots.length === 2);
check('they straddle no-move', roots[0] < 1 && roots[1] > 1);
roots.forEach((rr, i) =>
  near('root ' + i + ' really is break-even',
    M.evaluate(Object.assign({}, p, { r: rr })).netPct, 0, 1e-6));

/* -------------------------------------------------------- backtest */
suite('backtest path independence');
const splitCost = (tot, n, f) => {
  let X = 100, Y = 100, s = 0;
  for (let i = 0; i < n; i++) { const c = S.amountIn(tot / n, X, Y, f); X += c; Y -= tot / n; s += c; }
  return s;
};
near('no fee: one trade equals ninety-nine', splitCost(60, 1, 0), splitCost(60, 99, 0), 1e-9);
check('with a fee, splitting costs more', splitCost(60, 99, 0.003) > splitCost(60, 1, 0.003));

suite('backtest.run');
const bars = Array.from({ length: 40 }, (_, i) => ({
  t: Date.UTC(2026, 0, 1 + i), c: 100 * (1 + 0.02 * Math.sin(i / 3)), v: 1e6
}));
const bt = B.run(bars, { P0: bars[0].c, pa: bars[0].c * 0.9, pb: bars[0].c * 1.1,
                         lpFeeFrac: 0.003, tvl: 1e7 });
check('a range that always holds reports 100% in range', bt.pctTimeInRange === 100);
check('fees accrue', bt.feesPct > 0);
check('too few bars returns null', B.run(bars.slice(0, 2), { P0: 100, pa: 90, pb: 110,
  lpFeeFrac: 0.003, tvl: 1e7 }) === null);
const sweep = B.sweep(bars, { lpFeeFrac: 0.003, tvl: 1e7 });
check('sweep covers every width without dropping any', sweep.length === 7);
check('efficiency falls as the range widens',
  sweep.every((s, i) => i === 0 || s.efficiency < sweep[i - 1].efficiency));

report();
