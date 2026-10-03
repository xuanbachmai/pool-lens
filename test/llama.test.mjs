/*
 * Tests for the DefiLlama client against a real captured dataset.
 *
 * Covers the memoisation added after shape() was found to run on every keystroke, including
 * the hazard memoisation introduces: a shared array that a sort could reorder in place.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLP, suite, check, near, report } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'llama-pools.json');

if (!existsSync(FIXTURE)) {
  console.log('\nskipped: no fixture at test/fixtures/llama-pools.json');
  console.log('  create it with: npm run test:fixture');
  process.exit(0);
}

const data = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const LP = loadLP(['util', 'llama'], {
  fetch: async () => ({ ok: true, status: 200, json: async () => data })
});
const L = LP.llama;
await L.load();

suite('llama.load');
check('dataset loaded', L.isLoaded());
check('has a realistic number of pools', L.count() > 2000, 'got ' + L.count());

suite('llama memoisation');
const t0 = performance.now();
L.rows();
const first = performance.now() - t0;
const t1 = performance.now();
for (let i = 0; i < 20; i++) L.rows();
const laterEach = (performance.now() - t1) / 20;
check('first call shapes the dataset', first >= 0);
check('later calls are far cheaper than re-shaping',
  laterEach < Math.max(first / 5, 1),
  'first ' + first.toFixed(1) + 'ms, later ' + laterEach.toFixed(3) + 'ms each');
check('rows() returns the same array each time', L.rows() === L.rows());

suite('llama sort does not corrupt the shared view');
const before = L.rows().slice(0, 50).map((p) => p.id);
L.screen({ sort: 'apy' });
L.screen({ sort: 'tvl' });
L.screen({ sort: 'base' });
const after = L.rows().slice(0, 50).map((p) => p.id);
check('repeated sorts leave the memoised order untouched',
  before.join() === after.join());

suite('llama.screen filters');
const all = L.screen({});
check('no filter returns everything', all.length === L.count());
const single = L.screen({ exposure: 'single' });
check('exposure=single is honoured', single.every((p) => p.exposure === 'single'));
check('and is a real subset', single.length > 0 && single.length < all.length);
const stables = L.screen({ stablecoin: true, noIlRisk: true });
check('stablecoin + no-IL filters compose',
  stables.every((p) => p.stablecoin && p.ilRisk === 'no'));
const deep = L.screen({ minTvl: 1e7 });
check('minTvl floor is honoured', deep.every((p) => p.tvlUsd >= 1e7));
const real = L.screen({ maxRewardShare: 0.25 });
check('emissions ceiling is honoured',
  real.every((p) => { const s = L.rewardShare(p); return s !== null && s <= 0.25; }));
check('and it excludes rows with no reward data rather than guessing',
  real.every((p) => L.rewardShare(p) !== null));
const searched = L.screen({ search: 'usdc' });
check('search matches symbol, project or meta',
  searched.every((p) => (
    String(p.symbol || '') + String(p.project || '') + String(p.meta || '')
  ).toLowerCase().includes('usdc')));

suite('llama.screen sorting');
const byApy = L.screen({ sort: 'apy', limit: 200 });
check('apy sort is descending', byApy.every((p, i) => i === 0 || p.apy <= byApy[i - 1].apy));
const byTvl = L.screen({ sort: 'tvl', limit: 200 });
check('tvl sort is descending', byTvl.every((p, i) => i === 0 || p.tvlUsd <= byTvl[i - 1].tvlUsd));
const byBase = L.screen({ sort: 'base', limit: 200 });
check('base sort is descending',
  byBase.every((p, i) => i === 0 || (p.apyBase ?? -1) <= (byBase[i - 1].apyBase ?? -1)));
check('limit is respected', L.screen({ limit: 7 }).length === 7);

suite('llama emissions, as the data actually behaves');
/*
 * This started as an assertion that sorting by headline APY surfaces emission-dependent pools.
 * It failed: only 6 of the top 25 by APY were majority emissions, and the median emissions
 * share across the whole set is 0%. The claim was wrong and the UI copy that repeated it has
 * been corrected. What the data does support is narrower and more useful -- emission-heavy
 * pools are a minority, but when a pool is one, almost none of its yield is earned.
 */
const liquid = L.screen({ minTvl: 1e6, excludeOutliers: true });
const withData = liquid.filter((p) => L.rewardShare(p) !== null);
const heavy = withData.filter((p) => L.rewardShare(p) > 0.5);
const heavyPct = (heavy.length / withData.length) * 100;

check('emission-heavy pools are a minority, not the norm',
  heavyPct > 2 && heavyPct < 40,
  heavyPct.toFixed(0) + '% of ' + withData.length + ' pools are >50% emissions');
check('most pools carry no emissions at all',
  withData.filter((p) => L.rewardShare(p) === 0).length > withData.length / 2);

const meanApy = heavy.reduce((a, p) => a + p.apy, 0) / heavy.length;
const meanBase = heavy.reduce((a, p) => a + (p.apyBase || 0), 0) / heavy.length;
check('when a pool is emission-heavy, almost none of its yield is earned',
  meanBase < meanApy * 0.35,
  'mean headline ' + meanApy.toFixed(1) + '% vs earned ' + meanBase.toFixed(1) + '%');
check('dual-sided carries more emission risk than single-sided',
  (() => {
    const f = (exp) => {
      const r = L.screen({ exposure: exp, minTvl: 1e6, excludeOutliers: true })
        .filter((p) => L.rewardShare(p) !== null);
      return r.filter((p) => L.rewardShare(p) > 0.5).length / r.length;
    };
    return f('multi') > f('single');
  })());

suite('llama.chains');
const chains = L.chains();
check('chains are listed', chains.length > 5);
check('sorted by pool count descending',
  chains.every((c, i) => i === 0 || c.n <= chains[i - 1].n));
check('counts sum to the dataset size',
  chains.reduce((a, c) => a + c.n, 0) === L.count());

report();
