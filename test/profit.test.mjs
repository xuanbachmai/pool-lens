/*
 * Tests for the realised-profit replay.
 *
 * The figures are checked against hand arithmetic rather than against the implementation's own
 * output, so a sign flip or a misplaced /365 cannot pass. The headline number is net of
 * impermanent loss and gas and stated against holding, which is the only framing that can tell
 * you a pool lost you money while paying 40% in fees.
 */
import { loadLP, suite, check, near, report } from './harness.mjs';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

const LP = loadLP(['util', 'swap', 'profit'], { fetch: async () => { throw new Error('offline'); } });
const P = LP.profit;

/** n days of history at a constant APY split, with a constant TVL. */
function history(n, { base = 0, reward = null, tvl = 1e6, from = T0 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = from + i * DAY;
    out.push({ t, day: new Date(t).toISOString().slice(0, 10),
      apy: base + (reward || 0), apyBase: base, apyReward: reward, tvlUsd: tvl });
  }
  return out;
}

/** Two price bars spanning the window, so IL has something to read. */
const bars = (p0, p1, n = 100, from = T0) =>
  [{ t: from, c: p0 }, { t: from + (n - 1) * DAY, c: p1 }];

/* ----------------------------------------------------------- the IL formula */

suite('profit.il');
near('no divergence, no loss', P.il(1), 0, 1e-12);
near('a 2x move costs 5.719%', P.il(2) * 100, -5.719095841793664, 1e-9);
near('IL(r) equals IL(1/r)', P.il(4), P.il(0.25), 1e-12);
near('a 4x move costs 20%', P.il(4) * 100, -20, 1e-9);
check('IL is never positive', [0.1, 0.5, 1, 2, 10].every((r) => P.il(r) <= 1e-15));
check('a nonsense ratio gives null rather than NaN', P.il(0) === null && P.il(-1) === null);

/* ------------------------------------------------------------- compounding */

suite('profit.simulate — yield');
{
  // 36.5% a year is exactly 0.1% a day; over 100 days that compounds to 1.001^100.
  const s = P.simulate(history(100, { base: 36.5 }), null, { days: 100, sizeUsd: 0, gasUsd: 0 });
  check('runs', s.ok === true);
  near('fees compound daily, not annualised once',
    s.feePct, (Math.pow(1.001, 100) - 1) * 100, 1e-9);
  check('which is more than the simple 10%', s.feePct > 10);
  near('no emissions reported when none were paid', s.rewardPct, 0, 1e-12);
  check('no IL without price bars', s.ilPct === null);
  near('net equals the fees when nothing else applies', s.netPct, s.feePct, 1e-9);
}
{
  // Fees and emissions must stay separable: the panel reports them in different rows.
  const s = P.simulate(history(100, { base: 36.5, reward: 36.5 }), null,
    { days: 100, sizeUsd: 0, gasUsd: 0 });
  near('fees alone', s.feePct, (Math.pow(1.001, 100) - 1) * 100, 1e-9);
  near('emissions alone', s.rewardPct, (Math.pow(1.001, 100) - 1) * 100, 1e-9);
  near('combined yield multiplies rather than adds',
    s.yieldPct, (Math.pow(1.001, 100) * Math.pow(1.001, 100) - 1) * 100, 1e-9);
  check('combined exceeds the sum of the parts', s.yieldPct > s.feePct + s.rewardPct - 1e-9);
}
{
  // apyBase null but apy populated must not silently become a zero yield.
  const h = history(50, { base: 36.5 }).map((d) => ({ ...d, apyBase: null, apyReward: null }));
  const s = P.simulate(h, null, { days: 50, sizeUsd: 0, gasUsd: 0 });
  check('a null split falls back to total apy instead of reporting nothing', s.feePct > 4);
}

/* --------------------------------------------------------------- dilution */

suite('profit.simulate — dilution');
{
  const h = history(100, { base: 36.5, tvl: 1e6 });
  const small = P.simulate(h, null, { days: 100, sizeUsd: 1, gasUsd: 0 });
  const half = P.simulate(h, null, { days: 100, sizeUsd: 1e6, gasUsd: 0 });

  near('a position equal to the pool halves the yield',
    half.feePct, (Math.pow(1.0005, 100) - 1) * 100, 1e-9);
  check('a negligible position barely dilutes', Math.abs(small.feePct - 10.512) < 0.01);
  check('bigger positions earn a lower rate', half.feePct < small.feePct);

  const none = P.simulate(h, null, { days: 100, sizeUsd: 0, gasUsd: 0 });
  check('size 0 means no dilution applied', none.feePct > half.feePct);
}

/* --------------------------------------------------------------------- IL */

suite('profit.simulate — impermanent loss');
{
  const h = history(100, { base: 0 });
  const s = P.simulate(h, bars(2000, 4000), { days: 100, sizeUsd: 10000, gasUsd: 0 });
  near('a doubling reads as -5.719%', s.ilPct, -5.719095841793664, 1e-9);
  near('divergence is reported', s.divergence, 2, 1e-12);
  check('with no fees, the position loses to holding', s.netPct < 0);
  near('the loss is the IL', s.netPct, -5.719095841793664, 1e-9);
}
{
  /*
   * A 2x move costs 5.72% and 100 days at 36.5% pays 10.5%, so the fees DO cover it and the
   * position beats holding by about 4.1%. Worth pinning down, because it is the case people
   * assume goes the other way.
   */
  const s = P.simulate(history(100, { base: 36.5 }), bars(2000, 4000),
    { days: 100, sizeUsd: 10000, gasUsd: 0 });
  check('fees were genuinely earned', s.feePct > 10);
  check('10.5% of fees outruns a 2x divergence', s.netPct > 0 && s.netPct < 5,
    'net ' + s.netPct.toFixed(3) + '%');
  check('so the panel reports the fees as covering the IL', s.feesCoveredIl === true);
  check('beatHolding agrees with the sign of net', s.beatHolding === (s.netPct > 0));
}
{
  // The case the panel exists for: real fees, bigger divergence, net loss against holding.
  // A 4x move costs exactly 20%, which 10.5% of fees cannot cover.
  const s = P.simulate(history(100, { base: 36.5 }), bars(2000, 8000),
    { days: 100, sizeUsd: 10000, gasUsd: 0 });
  near('a 4x move costs 20%', s.ilPct, -20, 1e-9);
  check('fees were still genuinely earned', s.feePct > 10);
  check('and holding still won', s.netPct < 0, 'net ' + s.netPct.toFixed(3) + '%');
  check('the panel says the fees did not cover the IL', s.feesCoveredIl === false);
  check('beatHolding agrees with the sign of net', s.beatHolding === (s.netPct > 0));
}
{
  const s = P.simulate(history(100, { base: 36.5 }), bars(2000, 2050),
    { days: 100, sizeUsd: 10000, gasUsd: 0 });
  check('a small move leaves fees ahead', s.netPct > 0 && s.feesCoveredIl === true);
}

/* -------------------------------------------------------------------- gas */

suite('profit.simulate — costs');
{
  const h = history(100, { base: 0 });
  const s = P.simulate(h, null, { days: 100, sizeUsd: 1000, gasUsd: 30 });
  near('gas is charged both ways', s.costUsd, 60, 1e-12);
  near('as a share of the position', s.costPct, 6, 1e-12);
  near('and comes straight off the net', s.netPct, -6, 1e-9);

  const big = P.simulate(h, null, { days: 100, sizeUsd: 100000, gasUsd: 30 });
  check('the same gas barely dents a large position', Math.abs(big.netPct) < 0.07);
  check('fixed costs hurt small positions far more', Math.abs(s.netPct) > Math.abs(big.netPct) * 10);
}

/* ------------------------------------------------------------ honesty guards */

suite('profit.simulate — guards');
{
  const s = P.simulate(history(100, { base: 50000 }), null,
    { days: 100, sizeUsd: 0, gasUsd: 0 });
  check('an absurd APY is capped', s.clipped === 100);
  near('at the documented cap', s.feePct,
    (Math.pow(1 + P.APY_CAP / 365 / 100, 100) - 1) * 100, 1e-9);
}
{
  const ok = P.simulate(history(100, { base: 10 }), null, { days: 100, sizeUsd: 0, gasUsd: 0 });
  const short = P.simulate(history(40, { base: 10 }), null, { days: 40, sizeUsd: 0, gasUsd: 0 });
  check('a long enough window is annualised', ok.annualisedPct !== null);
  check('a short one is not, rather than extrapolating 40 days to a year',
    short.annualisedPct === null);
}
{
  check('no history is refused', P.simulate([], null, { days: 90 }).ok === false);
  check('a single point is refused', P.simulate(history(1), null, { days: 90 }).ok === false);
  const tiny = P.simulate(history(3), null, { days: 90 });
  check('under a week is refused with a reason',
    tiny.ok === false && /week/i.test(tiny.reason), tiny.reason);
}
{
  // Asking for more history than exists must use what there is, not silently pad it.
  const s = P.simulate(history(60, { base: 36.5 }), null, { days: 365, sizeUsd: 0, gasUsd: 0 });
  check('a short history is used as-is', s.ok === true && s.days === 60);
  check('and the requested window is remembered separately', s.requestedDays === 365);
  near('yield reflects 60 days, not 365', s.feePct, (Math.pow(1.001, 60) - 1) * 100, 1e-9);
}
{
  // The window must actually cut the history, or every holding period reads the same.
  const h = history(200, { base: 36.5 });
  const a = P.simulate(h, null, { days: 30, sizeUsd: 0, gasUsd: 0 });
  const b = P.simulate(h, null, { days: 90, sizeUsd: 0, gasUsd: 0 });
  check('30 days reads fewer days than 90', a.days < b.days);
  check('and earns less', a.feePct < b.feePct);
  near('30 days of 0.1%/day', a.feePct, (Math.pow(1.001, a.days) - 1) * 100, 1e-9);
}

report();
