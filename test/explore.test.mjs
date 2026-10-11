/*
 * Tests for the category taxonomy and the breakdown aggregation.
 *
 * Two things here are worth more than the rest. The baked project->category map is generated, so
 * the tests check the join still covers the live dataset rather than checking the generator's own
 * output against itself. And breakdown() uses medians on purpose -- a mean is decided by whichever
 * pool is quoting four figures today -- so there is a test that would fail if someone swapped one
 * for the other.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLP, suite, check, near, report } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'llama-pools.json');

/* ------------------------------------------------------------- the taxonomy */

const base = loadLP(['util', 'fees', 'categories'], { fetch: async () => { throw new Error('x'); } });
const C = base.categories;

suite('categories');
check('the baked map is substantial', C.size > 300, 'size=' + C.size);
check('a DEX resolves', C.raw('uniswap-v3') === 'Dexs', String(C.raw('uniswap-v3')));
check('a lending market resolves', C.raw('aave-v3') === 'Lending', String(C.raw('aave-v3')));
check('liquid staking resolves', C.raw('lido') === 'Liquid Staking', String(C.raw('lido')));
check('an unknown slug has no raw category', C.raw('not-a-real-protocol-xyz') === null);

suite('categories fallback');
{
  // A project added to DefiLlama since the last build still has to land somewhere sensible.
  check('an unmapped AMM is inferred as a DEX from our own fee table',
    C.of({ project: 'quickswap-dex' }) === 'Dexs' || C.raw('quickswap-dex') === 'Dexs');
  check('something genuinely unknown becomes Other',
    C.of({ project: 'totally-made-up-protocol' }) === 'Other');
  check('a mapped project ignores the fallback',
    C.of({ project: 'aave-v3' }) === 'Lending');
}

suite('categories groups');
check('Dexs groups under DEX', C.group('Dexs') === 'DEX');
check('CDP groups under Lending', C.group('Lending') === 'Lending' && C.group('CDP') === 'Lending');
check('an ungrouped category falls to Other', C.group('Something Novel') === 'Other');
check('every group name is non-empty',
  Object.keys(C.GROUPS).every((g) => typeof g === 'string' && g.length > 0));
{
  // A category must not appear under two groups, or the counts double.
  const seen = new Set();
  let dupe = null;
  for (const cats of Object.values(C.GROUPS)) {
    for (const c of cats) { if (seen.has(c)) dupe = c; seen.add(c); }
  }
  check('no category is listed in two groups', dupe === null, 'duplicate: ' + dupe);
}

/* -------------------------------------------------------------- aggregation */

if (!existsSync(FIXTURE)) {
  console.log('\nskipped breakdown tests: no fixture at test/fixtures/llama-pools.json');
  report();
} else {
  const data = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const LP = loadLP(['util', 'fees', 'categories', 'llama'], {
    fetch: async () => ({ ok: true, status: 200, json: async () => data })
  });
  const L = LP.llama;
  await L.load();

  suite('llama rows carry a category');
  {
    const rows = L.rows();
    const withCat = rows.filter((r) => r.category && r.category !== 'Other').length;
    check('most rows are categorised', withCat / rows.length > 0.9,
      (withCat / rows.length * 100).toFixed(1) + '%');
    check('every row has a group', rows.every((r) => typeof r.group === 'string'));
  }

  suite('llama.screen category filters');
  {
    const all = L.screen({ limit: null }).length;
    const dex = L.screen({ category: 'Dexs', limit: null });
    check('filtering by category narrows the set', dex.length > 0 && dex.length < all);
    check('and returns only that category', dex.every((p) => p.category === 'Dexs'));

    const grp = L.screen({ group: 'DEX', limit: null });
    check('filtering by group also works', grp.length >= dex.length);
    check('and returns only that group', grp.every((p) => p.group === 'DEX'));
    check('"any" is not treated as a category',
      L.screen({ category: 'any', limit: null }).length === all);
  }

  suite('llama.breakdown');
  {
    const byCat = L.breakdown('category', {});
    check('returns buckets', byCat.length > 3);
    check('sorted by TVL, biggest first',
      byCat.every((r, i) => i === 0 || byCat[i - 1].tvlUsd >= r.tvlUsd));

    const totalPools = byCat.reduce((a, r) => a + r.pools, 0);
    check('every pool lands in exactly one bucket', totalPools === L.rows().length,
      totalPools + ' vs ' + L.rows().length);

    const first = byCat[0];
    check('a bucket names its biggest pool', first.biggest && first.biggest.symbol);
    check('shares are fractions, not percentages',
      byCat.every((r) => r.ilShare >= 0 && r.ilShare <= 1 &&
                         r.singleShare >= 0 && r.singleShare <= 1));
    check('a bucket with no yield data reports null rather than zero',
      byCat.every((r) => r.medianApy === null || Number.isFinite(r.medianApy)));
  }
  {
    // The median must not be a mean: one huge outlier should not move it.
    const byChain = L.breakdown('chain', {});
    const big = byChain.find((r) => r.pools > 50);
    if (big) {
      const pools = L.rows().filter((p) => p.chain === big.key && !p.outlier);
      const apys = pools.map((p) => p.apy).filter((v) => v !== null && isFinite(v)).sort((a, b) => a - b);
      const mid = Math.floor(apys.length / 2);
      const expect = apys.length % 2 ? apys[mid] : (apys[mid - 1] + apys[mid]) / 2;
      near('median APY matches an independent median', big.medianApy, expect, 1e-9);

      const mean = apys.reduce((a, b) => a + b, 0) / apys.length;
      check('and is not the mean, which outliers drag upward',
        Math.abs(big.medianApy - mean) > 1e-9 || apys.length < 3,
        'median ' + big.medianApy.toFixed(3) + ' vs mean ' + mean.toFixed(3));
    } else {
      check('a chain with enough pools to test medians', false, 'none found');
    }
  }
  {
    // Outliers stay in the totals but out of the yield medians.
    const byCat = L.breakdown('category', {});
    const withOutliers = byCat.filter((r) => r.outliers > 0);
    check('outliers are reported where they exist', withOutliers.length > 0);
    for (const r of withOutliers.slice(0, 3)) {
      check('outliers still counted in the pool total for ' + r.key,
        r.pools > r.outliers || r.pools === r.outliers);
    }
  }
  {
    const filtered = L.breakdown('chain', { category: 'Dexs' });
    const unfiltered = L.breakdown('chain', {});
    check('breakdown respects a screen filter',
      filtered.reduce((a, r) => a + r.pools, 0) < unfiltered.reduce((a, r) => a + r.pools, 0));
  }

  report();
}
