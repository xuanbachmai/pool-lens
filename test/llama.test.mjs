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

/*
 * Chain-name mappings are the most fragile thing in this client: they are a third party's
 * display strings, and a wrong one fails SILENTLY -- the pool reports "not tracked" and the
 * emissions panel stays empty, indistinguishable from a chain that genuinely has no pools.
 *
 * Four were wrong before this test existed. The worst was Optimism, which DefiLlama lists as
 * "OP Mainnet": emissions never resolved for any Optimism pool, and the 435 of them in the
 * dataset were simply invisible.
 *
 * The check that catches this class without failing on chains that legitimately have no pools
 * right now: a mapped name must not differ from a real chain name by case or punctuation
 * alone. "zkSync Era" against "ZKsync Era" is a typo; "Blast" against nothing is just a quiet
 * month.
 */
suite('llama chain mappings match the live data');
const realNames = new Set(L.chains().map((c) => c.chain));
const normalise = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
const realByNorm = new Map();
realNames.forEach((n) => realByNorm.set(normalise(n), n));

const nearMisses = [];
const exact = [];
/*
 * Flattened through llamaNames, because a mapping may hold more than one name. Iterating the
 * raw values compares an array against a string: no match, and no near miss either, so the
 * aliased chains fall out of both counts and the test goes on passing while covering less. A
 * coverage check that silently stops covering is the worst thing in this file.
 */
for (const gt of Object.keys(L.CHAINS)) {
  for (const name of L.llamaNames(gt)) {
    if (realNames.has(name)) { exact.push(gt + ' -> ' + name); continue; }
    const hit = realByNorm.get(normalise(name));
    if (hit) nearMisses.push(gt + ': we send "' + name + '", data has "' + hit + '"');
  }
}
check('no mapping differs from a real chain name by case or punctuation only',
  nearMisses.length === 0, nearMisses.join('; '));
check('a healthy share of mappings resolve against the data',
  exact.length >= 20, exact.length + ' of ' + Object.keys(L.CHAINS).length + ' resolve');

check('Optimism maps to the name DefiLlama actually uses',
  realNames.has(L.CHAINS.optimism), 'sends "' + L.CHAINS.optimism + '"');
check('the chains with the most pools are all mapped',
  (() => {
    const mapped = new Set(L.llamaNamesAll());
    const top = L.chains().slice(0, 8).filter((c) => !mapped.has(c.chain));
    return top.length === 0 || (nearMisses.length === 0 && top.every((c) => c.n < 200));
  })(),
  'unmapped in the top 8: ' + L.chains().slice(0, 8)
    .filter((c) => !new Set(L.llamaNamesAll()).has(c.chain))
    .map((c) => c.chain + ' (' + c.n + ')').join(', '));

/*
 * Snapshot freshness. The dataset is held for the whole session so filtering stays instant,
 * which means the page can be showing hour-old yields with nothing saying so. These cover the
 * age being reported and the snapshot being genuinely replaceable.
 */
suite('llama freshness');
{
  check('a loaded snapshot records when it was taken', typeof L.loadedAt() === 'number');
  const age = L.ageSeconds();
  check('and reports an age in seconds', age !== null && age >= 0 && age < 120, 'age=' + age);
}
{
  // A fresh module, so the counters start clean.
  let calls = 0;
  const data = { data: [{ pool: 'a', project: 'uniswap-v3', chain: 'Ethereum', symbol: 'A-B',
    tvlUsd: 1e6, apy: 1, apyBase: 1, apyReward: null, underlyingTokens: [] }] };
  const LP2 = loadLP(['util', 'llama'], {
    fetch: async () => { calls++; return { ok: true, status: 200, json: async () => data }; }
  });
  const M = LP2.llama;

  check('nothing is loaded before the first call', M.loadedAt() === null && M.ageSeconds() === null);
  await M.load();
  check('one fetch after loading', calls === 1);
  const first = M.loadedAt();

  await M.load();
  check('a second load is served from the snapshot', calls === 1, 'calls=' + calls);
  check('and does not move the timestamp', M.loadedAt() === first);

  await M.refresh();
  check('refresh really re-fetches', calls === 2, 'calls=' + calls);
  check('and moves the timestamp forward', M.loadedAt() >= first);
  check('the data is still usable afterwards', M.count() === 1 && M.rows().length === 1);
}

/*
 * Chain keys that were silently dead.
 *
 * The CHAINS keys are GeckoTerminal network ids, and a wrong one does not error -- it 404s on
 * the pool lookup and the chain simply never resolves, which is how "OP Mainnet" hid for a
 * while and how these two did. Verified live against GeckoTerminal when corrected: starknet
 * 404s and starknet-alpha returns 200; sei-v2 404s and sei-network returns 200.
 *
 * Offline this can only pin the known-good spellings. tools/refresh.mjs does the live check on
 * a schedule and reports anything that drifts.
 */
suite('llama chain keys verified against GeckoTerminal');
check('Starknet uses the id GeckoTerminal actually serves',
  L.CHAINS['starknet-alpha'] === 'Starknet' && L.CHAINS.starknet === undefined,
  'has starknet-alpha: ' + !!L.CHAINS['starknet-alpha'] + ', stale starknet: ' + !!L.CHAINS.starknet);
check('Sei uses the id GeckoTerminal actually serves',
  L.CHAINS['sei-network'] === 'Sei' && L.CHAINS['sei-v2'] === undefined,
  'has sei-network: ' + !!L.CHAINS['sei-network'] + ', stale sei-v2: ' + !!L.CHAINS['sei-v2']);
check('Sonic and Sonic SVM are not confused for each other',
  L.CHAINS.sonic === 'Sonic' && L.CHAINS['sonic-svm'] === undefined);
check('no chain key is empty or whitespace',
  Object.keys(L.CHAINS).every((k) => k.trim().length > 1));

/*
 * Aliases, and the spellings they exist to protect.
 *
 * Two traps are pinned here. The first is that DefiLlama's chain LIST and its yields data
 * disagree: /v2/chains says "X Layer", every pool on the chain says "Xlayer". Only the second
 * is ever compared against, so the tidier-looking spelling is the broken one and someone will
 * eventually be tempted to "fix" it.
 *
 * The second is that one chain can be filed under several names at once -- Rootstock appears as
 * both 'Rootstock' and 'RSK' -- so a single string reaches part of the chain and reports
 * nothing wrong about the rest.
 */
suite('llama chain aliases');
check('a plain mapping gives one name', L.llamaNames('base').length === 1);
check('an aliased mapping gives all of them',
  L.llamaNames('rootstock').includes('Rootstock') && L.llamaNames('rootstock').includes('RSK'),
  L.llamaNames('rootstock').join(', '));
check('an unmapped network gives an empty list rather than undefined',
  Array.isArray(L.llamaNames('not-a-chain')) && L.llamaNames('not-a-chain').length === 0);
check('X Layer keeps the spelling the pool data uses, not the one the chain list shows',
  L.CHAINS['x-layer'] === 'Xlayer', JSON.stringify(L.CHAINS['x-layer']));
check('every flattened name is a non-empty string',
  L.llamaNamesAll().every((n) => typeof n === 'string' && n.length > 0));
check('flattening yields at least one name per mapping',
  L.llamaNamesAll().length >= Object.keys(L.CHAINS).length);
{
  // Each newly added chain should actually find pools in the captured dataset.
  const counts = new Map();
  L.chains().forEach((c) => counts.set(c.chain, c.n));
  const added = ['x-layer', 'rootstock', 'tempo', 'mezo', 'pharos',
                 'xrpl', 'stellar', 'near', 'stacks', 'cardano'];
  const dead = added.filter((k) =>
    L.llamaNames(k).reduce((n, name) => n + (counts.get(name) || 0), 0) === 0);
  check('every chain added in this pass has pools behind it', dead.length === 0,
    'nothing found for: ' + dead.join(', '));
}
{
  /*
   * The alias list earning its keep: a pool filed under the SECOND name still has to match.
   * With a single string this returned "DefiLlama does not track a pool for this pair".
   */
  const LP3 = loadLP(['util', 'llama'], {
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [{
      pool: 'rsk-1', project: 'sushiswap', chain: 'RSK', symbol: 'A-B',
      tvlUsd: 1e6, apy: 5, apyBase: 5, apyReward: null,
      underlyingTokens: ['0xAAAA', '0xBBBB']
    }] }) })
  });
  await LP3.llama.load();
  const m = LP3.llama.matchPool({
    pool: { network: 'rootstock', dexId: 'sushiswap', tvlUsd: 0,
            baseTokenId: 'rootstock_0xaaaa', quoteTokenId: 'rootstock_0xbbbb' }
  });
  check('a pool filed under the second alias is found', m.ok, JSON.stringify(m));
  check('and an unmapped network still says so plainly', (() => {
    const bad = LP3.llama.matchPool({
      pool: { network: 'not-a-chain', dexId: 'x', tvlUsd: 0,
              baseTokenId: 'a_0x1', quoteTokenId: 'a_0x2' }
    });
    return !bad.ok && /No DefiLlama chain mapping/.test(bad.reason);
  })());
}

report();
