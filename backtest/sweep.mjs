/*
 * Robustness sweep.
 *
 * A single backtest configuration is an anecdote. The first run of this suite reported that
 * passively holding a basket of volatile pools LOST 0.85% against holding the tokens -- a
 * striking result that turned out to appear at exactly one setting of the rebalance period and
 * basket size, because the leg boundaries move with it. It is not a finding, it is leg
 * alignment.
 *
 * So this re-runs every strategy across a grid and reports how often each one beats the passive
 * benchmark, not what it returned once. A rule that only works at one setting is noise.
 *
 *   node backtest/sweep.mjs
 *   node backtest/sweep.mjs --type cl
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = join(HERE, 'run.mjs');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const TYPE = arg('--type', 'cpmm');

const HOLDS = [14, 30, 60];
const TOPS = [5, 10, 20];
const COSTS = [10, 25, 50];

/** Parse the table run.mjs prints, per sleeve. */
function parse(out) {
  const res = { volatile: {}, stable: {} };
  let sleeve = null;
  for (const line of out.split('\n')) {
    if (/DUAL-SIDED/.test(line)) { sleeve = 'volatile'; continue; }
    if (/NO-IL/.test(line)) { sleeve = 'stable'; continue; }
    if (!sleeve) continue;
    const m = line.match(/^ {2}([a-z][a-z .A-Z]+?) {2,}([+-][\d.]+)\s+([+-][\d.]+)\s+(\d+)/);
    if (m) res[sleeve][m[1].trim()] = { total: parseFloat(m[2]), win: parseFloat(m[4]) };
  }
  return res;
}

const results = [];
for (const hold of HOLDS) {
  for (const top of TOPS) {
    for (const cost of COSTS) {
      const out = execFileSync(process.execPath,
        [RUN, '--hold', String(hold), '--top', String(top), '--cost', String(cost), '--type', TYPE],
        { encoding: 'utf8' });
      results.push({ hold, top, cost, ...parse(out) });
    }
  }
}

console.log('='.repeat(74));
console.log(`ROBUSTNESS SWEEP — ${results.length} configurations, type=${TYPE}`);
console.log(`  rebalance ${HOLDS.join('/')}d  x  top ${TOPS.join('/')}  x  cost ${COSTS.join('/')}bps`);
console.log('='.repeat(74));

for (const sleeve of ['volatile', 'stable']) {
  const names = [...new Set(results.flatMap((r) => Object.keys(r[sleeve])))];
  if (!names.length) continue;
  console.log(`\n${sleeve === 'volatile' ? 'DUAL-SIDED (IL-bearing)' : 'NO-IL / SINGLE-SIDED'}`);
  console.log('  strategy             median%   worst%    best%   beats benchmark');
  const rows = [];
  for (const n of names) {
    const vals = results.map((r) => r[sleeve][n]?.total).filter((v) => v !== undefined);
    if (!vals.length) continue;
    const beats = results.filter((r) => {
      const a = r[sleeve][n]?.total, b = r[sleeve]['hold everything']?.total;
      return a !== undefined && b !== undefined && a > b;
    }).length;
    const s = [...vals].sort((a, b) => a - b);
    rows.push({ n, med: s[Math.floor(s.length / 2)], min: s[0], max: s[s.length - 1],
      beats, of: vals.length });
  }
  rows.sort((a, b) => b.med - a.med);
  for (const r of rows) {
    const bench = r.n === 'hold everything';
    console.log(`  ${r.n.padEnd(18)} ${fmt(r.med)} ${fmt(r.min)} ${fmt(r.max)}   ` +
      (bench ? '(benchmark)' : `${r.beats}/${r.of}`));
  }
}

console.log('\nA strategy worth believing beats the benchmark in most configurations,');
console.log('not in one. The median column matters more than the best column.');

function fmt(v) { return ((v >= 0 ? '+' : '') + v.toFixed(2)).padStart(8); }
