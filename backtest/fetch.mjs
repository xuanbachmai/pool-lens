/*
 * Assemble the backtest dataset.
 *
 * Three sources, cached to disk so the strategy work can be re-run for free:
 *
 *   1. yields.llama.fi/pools        the universe, as it stands today
 *   2. yields.llama.fi/chart/{id}   daily apy / apyBase / apyReward / tvlUsd per pool
 *   3. coins.llama.fi/chart/{coin}  daily token prices, for computing impermanent loss
 *
 * (3) is here because of a finding that decides what this backtest is allowed to claim:
 * DefiLlama's own il7d field is populated on only 16% of history points, and just 39% even for
 * volatile pairs. Modelling yield without netting off IL would flatter every two-sided pool, so
 * IL is computed from the token prices themselves instead -- exactly the closed form the app
 * uses, 2*sqrt(r)/(1+r) - 1, which is path-independent and therefore needs only the endpoints.
 *
 *   node backtest/fetch.mjs            refresh anything missing or stale
 *   node backtest/fetch.mjs --pools N  change how many pools per sleeve (default 80)
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : process.argv[i + 1];
};
const PER_SLEEVE = parseInt(arg('--pools', '80'), 10);
const MIN_TVL = 2e6;
const MIN_DAYS = 365;

/* ------------------------------------------------------------------ fetching */

/** Polite GET with backoff: DefiLlama rate-limits, and a half-fetched dataset is worthless. */
async function get(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    let res;
    try {
      res = await fetch(url, { headers: { accept: 'application/json' } });
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1000 * (i + 1));
      continue;
    }
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      await sleep(1500 * (i + 1));
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  throw new Error(`gave up on ${url}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cached(name, produce) {
  const fp = join(DATA, name);
  if (existsSync(fp)) return JSON.parse(await readFile(fp, 'utf8'));
  const v = await produce();
  await writeFile(fp, JSON.stringify(v));
  return v;
}

/* ------------------------------------------------------------------ universe */

/**
 * Two sleeves, because they are different trades and the user's question spans both:
 *
 *   volatile  two-sided pools that bear impermanent loss -- the "dual" case
 *   stable    pools DefiLlama marks ilRisk=no, including single-sided -- the "single" case
 *
 * Ranked by TVL rather than by APY on purpose. Ranking the universe by the thing a strategy is
 * about to select on would bake the answer in before the backtest started.
 */
function selectUniverse(pools) {
  const long = (p) => (p.count || 0) >= MIN_DAYS && (p.tvlUsd || 0) >= MIN_TVL && p.apy !== null;
  const byTvl = (a, b) => (b.tvlUsd || 0) - (a.tvlUsd || 0);

  const volatile = pools
    .filter((p) => long(p) && p.exposure === 'multi' && p.ilRisk === 'yes' &&
                   (p.underlyingTokens || []).length === 2)
    .sort(byTvl).slice(0, PER_SLEEVE);

  const stable = pools
    .filter((p) => long(p) && p.ilRisk === 'no')
    .sort(byTvl).slice(0, PER_SLEEVE);

  return { volatile, stable };
}

/* ---------------------------------------------------------------------- main */

async function main() {
  await mkdir(DATA, { recursive: true });

  console.log('1/3  pool universe');
  const raw = await cached('pools.json', () => get('https://yields.llama.fi/pools'));
  const pools = raw.data || raw;
  const { volatile, stable } = selectUniverse(pools);
  console.log(`     ${pools.length} pools -> ${volatile.length} volatile + ${stable.length} stable`);

  const universe = [...volatile.map((p) => ({ ...p, sleeve: 'volatile' })),
                    ...stable.map((p) => ({ ...p, sleeve: 'stable' }))];
  await writeFile(join(DATA, 'universe.json'), JSON.stringify(universe.map((p) => ({
    pool: p.pool, project: p.project, chain: p.chain, symbol: p.symbol,
    tvlUsd: p.tvlUsd, apy: p.apy, apyBase: p.apyBase, apyReward: p.apyReward,
    exposure: p.exposure, ilRisk: p.ilRisk, stablecoin: p.stablecoin,
    underlyingTokens: p.underlyingTokens || [], sleeve: p.sleeve, count: p.count
  })), null, 2));

  console.log('2/3  per-pool history');
  const charts = {};
  let i = 0;
  for (const p of universe) {
    const key = `chart-${p.pool}.json`;
    try {
      charts[p.pool] = await cached(key, async () => {
        const j = await get(`https://yields.llama.fi/chart/${p.pool}`);
        return j.data || [];
      });
    } catch (e) {
      console.log(`     skip ${p.symbol}: ${e.message}`);
    }
    if (++i % 25 === 0) console.log(`     ${i}/${universe.length}`);
    await sleep(90);
  }
  await writeFile(join(DATA, 'charts.json'), JSON.stringify(charts));
  console.log(`     ${Object.keys(charts).length} histories`);

  console.log('3/3  token prices (for impermanent loss)');
  // Only the volatile sleeve needs prices; the stable sleeve is selected for having no IL.
  const chainName = { Ethereum: 'ethereum', Arbitrum: 'arbitrum', Base: 'base',
    'OP Mainnet': 'optimism', Polygon: 'polygon', BSC: 'bsc', Avalanche: 'avax',
    Solana: 'solana', Linea: 'linea', Blast: 'blast', Scroll: 'scroll', Mantle: 'mantle',
    Sonic: 'sonic', Unichain: 'unichain', Berachain: 'berachain', Gnosis: 'xdai',
    Fantom: 'fantom', Celo: 'celo', Mode: 'mode', Fraxtal: 'fraxtal', Ink: 'ink',
    'ZKsync Era': 'era', Taiko: 'taiko', Sui: 'sui', Aptos: 'aptos' };

  const wanted = new Set();
  for (const p of universe) {
    if (p.sleeve !== 'volatile') continue;
    const c = chainName[p.chain];
    if (!c) continue;
    for (const t of p.underlyingTokens || []) {
      if (typeof t === 'string' && t.length > 10) wanted.add(`${c}:${t}`);
    }
  }
  console.log(`     ${wanted.size} distinct tokens`);

  const prices = {};
  const start = Math.floor(Date.now() / 1000) - 400 * 86400;
  i = 0;
  for (const coin of wanted) {
    const key = `price-${coin.replace(/[^a-z0-9]/gi, '_')}.json`;
    try {
      prices[coin] = await cached(key, async () => {
        // 500-point cap across all coins in one call, so one coin at a time at 400 days.
        const j = await get(`https://coins.llama.fi/chart/${coin}?start=${start}&span=400&period=1d`);
        return (j.coins?.[coin]?.prices) || [];
      });
    } catch (e) {
      prices[coin] = [];
    }
    if (++i % 25 === 0) console.log(`     ${i}/${wanted.size}`);
    await sleep(90);
  }
  await writeFile(join(DATA, 'prices.json'), JSON.stringify(prices));
  const withData = Object.values(prices).filter((v) => v.length > 0).length;
  console.log(`     ${withData}/${wanted.size} tokens have price history`);

  console.log('\ndone -> backtest/data/');
}

main().catch((e) => { console.error(e); process.exit(1); });
