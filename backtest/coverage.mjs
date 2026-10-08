/* Precise coverage audit: genuine AMM pools only (two-sided, IL-bearing). */
import { readFileSync } from 'node:fs';
import { loadLP } from '../test/harness.mjs';

const raw = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const pools = raw.data || raw;
const LP = loadLP(['util', 'fees'], { fetch: async () => { throw new Error('offline'); } });
const F = LP.fees;

const isAmm = (p) => p.exposure === 'multi' && p.ilRisk === 'yes';
const amm = pools.filter(isAmm);

const agg = new Map();
for (const p of amm) {
  const k = p.project;
  if (!agg.has(k)) agg.set(k, { project: k, tvl: 0, pools: 0, chains: new Set(), sample: p.symbol });
  const e = agg.get(k);
  e.tvl += p.tvlUsd || 0; e.pools++; e.chains.add(p.chain);
}

let ok = { tvl: 0, pools: 0, n: 0 }, miss = { tvl: 0, pools: 0, n: 0 };
const gaps = [];
for (const e of agg.values()) {
  if (F.profileFor(e.project).type !== 'unknown') { ok.tvl += e.tvl; ok.pools += e.pools; ok.n++; }
  else { miss.tvl += e.tvl; miss.pools += e.pools; miss.n++; gaps.push(e); }
}
const tot = ok.tvl + miss.tvl;

console.log('=== Genuine AMM pools (exposure=multi, ilRisk=yes) ===');
console.log(`  total: ${amm.length} pools, $${(tot / 1e9).toFixed(2)}B across ${agg.size} projects`);
console.log(`  with a fee profile : ${ok.n} projects, ${ok.pools} pools, $${(ok.tvl / 1e9).toFixed(2)}B  (${(ok.tvl / tot * 100).toFixed(1)}% of AMM TVL)`);
console.log(`  no profile         : ${miss.n} projects, ${miss.pools} pools, $${(miss.tvl / 1e9).toFixed(2)}B  (${(miss.tvl / tot * 100).toFixed(1)}%)`);

gaps.sort((a, b) => b.tvl - a.tvl);
console.log('\n=== real DEX gaps, by TVL ===');
for (const g of gaps.slice(0, 25)) {
  console.log(`  ${String(g.project).padEnd(30)} $${(g.tvl / 1e6).toFixed(1).padStart(7)}M ${String(g.pools).padStart(4)}p  ${[...g.chains].slice(0, 2).join(',').padEnd(18)} eg ${String(g.sample).slice(0, 18)}`);
}

// How much of the gap would a handful of profiles close?
let cum = 0;
console.log('\n=== cumulative share of the gap closed by the top N ===');
gaps.forEach((g, i) => {
  cum += g.tvl;
  if ([2, 5, 10, 20, 40].includes(i + 1)) {
    console.log(`  top ${String(i + 1).padStart(2)}: ${(cum / miss.tvl * 100).toFixed(0)}% of missing AMM TVL`);
  }
});
