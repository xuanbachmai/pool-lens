/*
 * Strategy backtest.
 *
 * The question is not "what returned most" but "did any rule beat holding the same assets,
 * after costs". Only the second is worth acting on: an LP earning 40% in fees while the pair
 * diverges 50% has lost money against doing nothing. So every figure here is EXCESS RETURN
 * VERSUS HOLDING, with IL computed from real token prices via 2*sqrt(r)/(1+r) - 1 -- the same
 * closed form the app uses, path-independent, so endpoints suffice.
 *
 * Three corrections, each forced by something the data did when this was first run:
 *
 * 1. CONCENTRATED POOLS ARE EXCLUDED BY DEFAULT. DefiLlama's apyBase divides fees by the
 *    liquidity actually deployed, so for a v3-style pool it is the return on in-range,
 *    actively-managed capital. Taken at face value it said a $156M WETH/USDC v3 pool paid 105%
 *    in fees over a year with a 666% peak. A passive full-range LP earns nothing like that. The
 *    v2-style pools in the same window read 6-9%, which is believable. Mixing the two produces
 *    a number that describes neither, so --type selects one. (The app's own answer to this is
 *    tau_v, volume-weighted time in range; there is no historical tau to apply here.)
 *
 * 2. APY IS WINSORISED. One pool showed 16,247% cumulative over 365 days -- the signature of
 *    TVL collapsing toward zero while the fee numerator stands still, not of money earned. The
 *    cap is reported, along with how many points it touched, so its effect is visible.
 *
 * 3. YIELD IS DILUTED TO A REAL POSITION SIZE. A quoted APY belongs to the capital already
 *    there. Adding yours makes it apy * T/(T+S), the same own-dilution formula the analyser
 *    uses. Without this, strategies get credit for yields that exist only while nobody takes
 *    them.
 *
 *   node backtest/run.mjs
 *   node backtest/run.mjs --type cl --cap 500 --size 100000
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLP } from '../test/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const WINDOW_DAYS = parseInt(arg('--days', '365'), 10);
const COST_BPS = parseFloat(arg('--cost', '25'));
const HOLD = parseInt(arg('--hold', '30'), 10);
const TOP_N = parseInt(arg('--top', '10'), 10);
const APY_CAP = parseFloat(arg('--cap', '300'));      // %, winsorisation
const SIZE = parseFloat(arg('--size', '100000'));     // position size for dilution
const TYPE = arg('--type', 'cpmm');                   // cpmm | cl | all

const day = (t) => new Date(t).toISOString().slice(0, 10);

const universe = JSON.parse(await readFile(join(DATA, 'universe.json'), 'utf8'));
const charts = JSON.parse(await readFile(join(DATA, 'charts.json'), 'utf8'));
const prices = JSON.parse(await readFile(join(DATA, 'prices.json'), 'utf8'));

// Classify with the app's own profile table rather than a second opinion that could drift.
const LP = loadLP(['util', 'fees'], { fetch: async () => { throw new Error('offline'); } });
const poolType = (p) => LP.fees.profileFor(p.project).type;

const CHAIN = { Ethereum: 'ethereum', Arbitrum: 'arbitrum', Base: 'base', 'OP Mainnet': 'optimism',
  Polygon: 'polygon', BSC: 'bsc', Avalanche: 'avax', Solana: 'solana', Linea: 'linea',
  Blast: 'blast', Scroll: 'scroll', Mantle: 'mantle', Sonic: 'sonic', Unichain: 'unichain',
  Berachain: 'berachain', Gnosis: 'xdai', Fantom: 'fantom', Celo: 'celo', Mode: 'mode',
  Fraxtal: 'fraxtal', Ink: 'ink', 'ZKsync Era': 'era', Taiko: 'taiko', Sui: 'sui', Aptos: 'aptos' };

function priceMap(chain, token) {
  const c = CHAIN[chain];
  if (!c) return null;
  const s = prices[`${c}:${token}`];
  if (!s || !s.length) return null;
  return new Map(s.map((p) => [day(p.timestamp * 1000), p.price]));
}

/* ------------------------------------------------------------------- build */

const series = new Map();
let noPrices = 0, clipped = 0, points = 0, excludedType = 0;

for (const p of universe) {
  const t = poolType(p);
  const isCl = t === 'cl';
  if (TYPE === 'cpmm' && isCl) { excludedType++; continue; }
  if (TYPE === 'cl' && !isCl) { excludedType++; continue; }

  const hist = charts[p.pool];
  if (!hist || hist.length < 90) continue;

  let pm0 = null, pm1 = null;
  if (p.sleeve === 'volatile') {
    pm0 = priceMap(p.chain, p.underlyingTokens[0]);
    pm1 = priceMap(p.chain, p.underlyingTokens[1]);
    if (!pm0 || !pm1) { noPrices++; continue; }
  }

  const rows = [];
  for (const h of hist) {
    const d = day(h.timestamp);
    const base = h.apyBase ?? ((h.apyReward === null || h.apyReward === undefined) ? h.apy : null);
    const reward = h.apyReward ?? 0;
    let total = (base ?? 0) + reward;
    if (!Number.isFinite(total) || total < 0) continue;

    points++;
    if (total > APY_CAP) { total = APY_CAP; clipped++; }

    // Dilute to a real position size: the quoted yield belongs to the capital already there.
    const tvl = h.tvlUsd ?? null;
    const dilution = (tvl && tvl > 0) ? tvl / (tvl + SIZE) : 1;

    let ratio = 1;
    if (p.sleeve === 'volatile') {
      const a = pm0.get(d), b = pm1.get(d);
      if (!a || !b) continue;
      ratio = a / b;
    }
    rows.push({
      d,
      yield: (total * dilution) / 365 / 100,
      apy: total * dilution,
      apyBase: Math.min(base ?? 0, APY_CAP) * dilution,
      apyReward: Math.min(reward, APY_CAP) * dilution,
      tvl, ratio
    });
  }
  if (rows.length < 90) continue;
  rows.sort((a, b) => (a.d < b.d ? -1 : 1));
  series.set(p.pool, { meta: { ...p, type: t }, rows, byDate: new Map(rows.map((r) => [r.d, r])) });
}

const il = (r) => (2 * Math.sqrt(r)) / (1 + r) - 1;

function excessMultiple(entry, from, to) {
  const rows = entry.rows.filter((r) => r.d >= from && r.d <= to);
  if (rows.length < 2) return null;
  let acc = 1;
  for (const r of rows) acc *= 1 + r.yield;
  const r0 = rows[0].ratio, r1 = rows[rows.length - 1].ratio;
  const loss = entry.meta.sleeve === 'volatile' ? il(r1 / r0) : 0;
  return { multiple: acc * (1 + loss), yieldOnly: acc, il: loss };
}

function trailing(entry, asOf, lookback = 30) {
  const idx = entry.rows.findIndex((r) => r.d >= asOf);
  if (idx < lookback) return null;
  const w = entry.rows.slice(Math.max(0, idx - lookback), idx);
  if (!w.length) return null;
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const apys = w.map((r) => r.apy);
  const m = mean(apys);
  const sd = Math.sqrt(mean(apys.map((x) => (x - m) ** 2)));
  const tvls = w.map((r) => r.tvl).filter((v) => v !== null);
  return {
    apy: m, apyBase: mean(w.map((r) => r.apyBase)),
    sigma: m > 0 ? sd / m : Infinity,
    rewardShare: m > 0 ? mean(w.map((r) => r.apyReward)) / m : 0,
    tvlTrend: tvls.length > 10 ? tvls[tvls.length - 1] / tvls[0] : 1,
    churn: Math.abs(Math.log(w[w.length - 1].ratio / w[0].ratio))
  };
}

const rank = (cands, st, score) => cands
  .map((c) => ({ pool: c.pool, s: st.get(c.pool) })).filter((x) => x.s)
  .sort((a, b) => score(b.s) - score(a.s)).map((x) => x.pool);

const STRATEGIES = {
  'hold everything': { note: 'equal weight the sleeve, never rotate — the benchmark',
    pick: (c) => c.map((x) => x.pool) },
  'chase top APY': { note: 'highest trailing APY — what every dashboard sorts by',
    pick: (c, st) => rank(c, st, (s) => s.apy).slice(0, TOP_N) },
  'chase fee APR': { note: 'highest trailing apyBase, ignoring emissions',
    pick: (c, st) => rank(c, st, (s) => s.apyBase).slice(0, TOP_N) },
  'stable yield': { note: 'apyBase among pools whose APY is not wildly unstable (sigma<1)',
    pick: (c, st) => rank(c.filter((x) => (st.get(x.pool)?.sigma ?? 9) < 1), st, (s) => s.apyBase).slice(0, TOP_N) },
  'calm pairs': { note: 'apyBase among pairs that have not been diverging — fees without the IL',
    pick: (c, st) => rank(c.filter((x) => (st.get(x.pool)?.churn ?? 9) < 0.15), st, (s) => s.apyBase).slice(0, TOP_N) },
  'avoid emissions': { note: 'APY where emissions are under a third of the yield',
    pick: (c, st) => rank(c.filter((x) => (st.get(x.pool)?.rewardShare ?? 1) < 0.33), st, (s) => s.apy).slice(0, TOP_N) },
  'avoid draining': { note: 'apyBase among pools whose TVL has not halved',
    pick: (c, st) => rank(c.filter((x) => (st.get(x.pool)?.tvlTrend ?? 1) > 0.5), st, (s) => s.apyBase).slice(0, TOP_N) }
};

function runStrategy(sleeve, strat) {
  const pools = [...series.values()].filter((e) => e.meta.sleeve === sleeve);
  if (pools.length < 3) return null;
  const allDates = [...new Set(pools.flatMap((e) => e.rows.map((r) => r.d)))].sort();
  const dates = allDates.slice(-WINDOW_DAYS);
  if (dates.length < HOLD * 2) return null;

  let equity = 1, prev = new Set(), totalCost = 0;
  const legs = [];

  for (let i = 0; i + HOLD < dates.length; i += HOLD) {
    const from = dates[i], to = dates[i + HOLD];
    const cands = pools.filter((e) => e.byDate.has(from) && e.byDate.has(to));
    if (!cands.length) continue;
    const st = new Map();
    for (const c of cands) { const t = trailing(c, from); if (t) st.set(c.meta.pool, t); }
    const chosen = strat.pick(cands.map((c) => c.meta), st).slice(0, Math.max(1, TOP_N));
    if (!chosen.length) continue;

    const next = new Set(chosen);
    const kept = [...next].filter((p) => prev.has(p)).length;
    const turnover = prev.size === 0 ? 1 : 1 - kept / next.size;
    const cost = turnover * (COST_BPS / 10000);
    totalCost += cost;

    let sum = 0, n = 0, ilSum = 0;
    for (const pid of chosen) {
      const r = series.get(pid) && excessMultiple(series.get(pid), from, to);
      if (!r) continue;
      sum += r.multiple; ilSum += r.il; n++;
    }
    if (!n) continue;
    const legMult = (sum / n) * (1 - cost);
    equity *= legMult;
    legs.push({ mult: legMult, il: ilSum / n });
    prev = next;
  }
  if (!legs.length) return null;
  const mults = legs.map((l) => l.mult);
  return {
    total: (equity - 1) * 100,
    ann: (Math.pow(equity, 365 / dates.length) - 1) * 100,
    win: legs.filter((l) => l.mult > 1).length / legs.length * 100,
    worst: (Math.min(...mults) - 1) * 100,
    best: (Math.max(...mults) - 1) * 100,
    avgIl: legs.reduce((a, b) => a + b.il, 0) / legs.length * 100,
    cost: totalCost * 100,
    legs: legs.length, days: dates.length, note: strat.note
  };
}

/* ------------------------------------------------------------------ report */

const vol = [...series.values()].filter((e) => e.meta.sleeve === 'volatile');
const stb = [...series.values()].filter((e) => e.meta.sleeve === 'stable');

console.log('='.repeat(80));
console.log('BACKTEST — excess return versus holding the same tokens');
console.log('='.repeat(80));
console.log(`pool type   ${TYPE}${TYPE === 'cpmm' ? '  (concentrated pools excluded — see the note in this file)' : ''}`);
console.log(`universe    ${vol.length} volatile (IL-bearing) + ${stb.length} no-IL`);
console.log(`excluded    ${excludedType} by pool type, ${noPrices} with no token prices (IL not computable)`);
console.log(`window      last ${WINDOW_DAYS}d, rebalance ${HOLD}d, top ${TOP_N}, ${COST_BPS}bps turnover cost`);
console.log(`APY cap     ${APY_CAP}%  — clipped ${clipped}/${points} points (${(clipped / points * 100).toFixed(2)}%)`);
console.log(`position    $${SIZE.toLocaleString()} (yield diluted by TVL/(TVL+size))`);
console.log('');

for (const [sleeve, label] of [
  ['volatile', 'DUAL-SIDED, IL-BEARING   excess = yield net of real IL, vs holding'],
  ['stable', 'NO-IL / SINGLE-SIDED     excess = yield; holding these earns nothing']
]) {
  console.log('-'.repeat(80));
  console.log(label);
  console.log('-'.repeat(80));
  const rows = [];
  for (const [name, s] of Object.entries(STRATEGIES)) {
    const r = runStrategy(sleeve, s);
    if (r) rows.push({ name, ...r });
  }
  if (!rows.length) { console.log('  not enough pools in this sleeve\n'); continue; }
  console.log('  strategy             total%    ann%   win%   worst%    best%   avgIL%  cost%');
  rows.sort((a, b) => b.total - a.total);
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(18)} ${f(r.total, 7)} ${f(r.ann, 7)} ${r.win.toFixed(0).padStart(5)} ` +
      `${f(r.worst, 8)} ${f(r.best, 8)} ${f(r.avgIl, 8)} ${r.cost.toFixed(2).padStart(6)}`);
  }
  const bench = rows.find((r) => r.name === 'hold everything');
  if (bench) {
    const beat = rows.filter((r) => r.name !== 'hold everything' && r.total > bench.total);
    console.log(`\n  benchmark "hold everything": ${f(bench.total, 0)}%  —  ` +
      `${beat.length}/${rows.length - 1} strategies beat it`);
  }
  console.log('');
}
console.log('notes');
for (const [n, s] of Object.entries(STRATEGIES)) console.log(`  ${n.padEnd(18)} ${s.note}`);

function f(v, w) {
  if (v === null || !Number.isFinite(v)) return '—'.padStart(w);
  return ((v >= 0 ? '+' : '') + v.toFixed(2)).padStart(w);
}
