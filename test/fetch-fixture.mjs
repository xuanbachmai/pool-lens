/*
 * Captures a DefiLlama snapshot for the test suite.
 *
 * The full response is ~12 MB, which has no business in git. This trims it to the fields the
 * client actually reads and samples enough rows to keep the filter and sort tests meaningful.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'fixtures', 'llama-pools.json');
const KEEP = ['pool', 'chain', 'project', 'symbol', 'poolMeta', 'tvlUsd', 'apy', 'apyBase',
  'apyReward', 'apyMean30d', 'apyBase7d', 'apyPct30D', 'sigma', 'mu', 'outlier', 'exposure',
  'ilRisk', 'stablecoin', 'count', 'volumeUsd1d', 'volumeUsd7d', 'rewardTokens',
  'underlyingTokens', 'predictions'];

const res = await fetch('https://yields.llama.fi/pools', { headers: { accept: 'application/json' } });
if (!res.ok) { console.error('HTTP', res.status); process.exit(1); }
const json = await res.json();
const rows = json.data || [];

// Keep every pool above a TVL floor plus a deterministic sample of the tail, so the fixture
// stays small without losing the long-tail rows the emissions tests depend on.
const big = rows.filter((p) => (p.tvlUsd || 0) >= 1e6);
const tail = rows.filter((p) => (p.tvlUsd || 0) < 1e6).filter((_, i) => i % 7 === 0);
const picked = [...big, ...tail].map((p) => {
  const o = {};
  for (const k of KEEP) if (p[k] !== undefined) o[k] = p[k];
  return o;
});

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ status: 'success', data: picked }));
const mb = (JSON.stringify({ data: picked }).length / 1e6).toFixed(1);
console.log(`captured ${picked.length} of ${rows.length} pools (${big.length} above $1M) -> ${mb} MB`);
