/*
 * DefiLlama yields client.
 *
 * This is the source that fills the two biggest holes in the rest of the app:
 *
 *   1. EMISSIONS. Every other panel measures swap fees only and says so. DefiLlama splits
 *      `apy` into `apyBase` (what the pool actually earns) and `apyReward` (token emissions),
 *      which is the distinction that decides whether an advertised number is real. The top
 *      single-sided pool in the dataset advertises 1,065% APY of which precisely none is base.
 *   2. SINGLE-SIDED FARMS. `exposure` is 'single' or 'multi', so lending vaults, LSTs and
 *      staked stables -- none of which have a constant-product curve and none of which the
 *      rest of this app can model -- become screenable.
 *
 * The whole dataset is one 2.4 MB gzipped response covering ~17,000 pools. That is fine for a
 * screener, which needs all of it, and too heavy to pull on every pool analysis, so the
 * analyser loads it only when asked. Both share this cache.
 */
window.LP = window.LP || {};

LP.llama = (function () {
  const URL_POOLS = 'https://yields.llama.fi/pools';

  let cache = null;        // resolved pool array
  let inflight = null;     // de-dupe concurrent callers

  /** GeckoTerminal network id -> DefiLlama chain name. */
  const CHAINS = {
    eth: 'Ethereum', arbitrum: 'Arbitrum', optimism: 'Optimism', base: 'Base',
    polygon_pos: 'Polygon', bsc: 'BSC', avax: 'Avalanche', ftm: 'Fantom',
    xdai: 'Gnosis', celo: 'Celo', glmr: 'Moonbeam', cro: 'Cronos', metis: 'Metis',
    aurora: 'Aurora', zksync: 'zkSync Era', linea: 'Linea', scroll: 'Scroll',
    blast: 'Blast', mantle: 'Mantle', mode: 'Mode', sonic: 'Sonic',
    berachain: 'Berachain', hyperevm: 'Hyperliquid L1', unichain: 'Unichain',
    ink: 'Ink', taiko: 'Taiko', 'zora-network': 'Zora', 'world-chain': 'WorldChain',
    soneium: 'Soneium', fraxtal: 'Fraxtal', kava: 'Kava', ronin: 'Ronin',
    solana: 'Solana', 'sui-network': 'Sui', aptos: 'Aptos', 'sei-v2': 'Sei',
    'polygon-zkevm': 'Polygon zkEVM', tron: 'Tron', pulsechain: 'PulseChain'
  };

  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  /* -------------------------------------------------------------------- load */

  async function load() {
    if (cache) return cache;
    if (inflight) return inflight;

    inflight = (async () => {
      let res;
      try {
        res = await fetch(URL_POOLS, { headers: { accept: 'application/json' } });
      } catch (e) {
        inflight = null;
        throw new Error('Could not reach yields.llama.fi. It is a large response (~2.4 MB), so a ' +
          'slow or filtered connection can drop it.');
      }
      if (!res.ok) {
        inflight = null;
        throw new Error('yields.llama.fi returned HTTP ' + res.status + '.');
      }
      const json = await res.json();
      cache = (json && json.data) || [];
      inflight = null;
      return cache;
    })();
    return inflight;
  }

  const isLoaded = () => cache !== null;
  const count = () => (cache ? cache.length : 0);

  /* ------------------------------------------------------------------- shape */

  /** Normalise one DefiLlama row into the fields this app reasons about. */
  function shape(p) {
    const apy = num(p.apy);
    const base = num(p.apyBase);
    const reward = num(p.apyReward);
    // apyBase can be null while apy is populated; treat the remainder as reward, not as base.
    const total = apy !== null ? apy : (base || 0) + (reward || 0);
    const rewardPart = reward !== null ? reward : (base !== null && apy !== null ? apy - base : null);
    const basePart = base !== null ? base : (rewardPart !== null && apy !== null ? apy - rewardPart : null);

    return {
      id: p.pool,
      chain: p.chain,
      project: p.project,
      symbol: p.symbol,
      meta: p.poolMeta || null,
      tvlUsd: num(p.tvlUsd) || 0,
      apy: total || 0,
      apyBase: basePart,
      apyReward: rewardPart,
      apyMean30d: num(p.apyMean30d),
      apyBase7d: num(p.apyBase7d),
      apyPct30D: num(p.apyPct30D),
      sigma: num(p.sigma),
      mu: num(p.mu),
      outlier: !!p.outlier,
      exposure: p.exposure,            // 'single' | 'multi'
      ilRisk: p.ilRisk,                // 'yes' | 'no'
      stablecoin: !!p.stablecoin,
      count: num(p.count),
      volumeUsd1d: num(p.volumeUsd1d),
      volumeUsd7d: num(p.volumeUsd7d),
      rewardTokens: p.rewardTokens || [],
      underlying: (p.underlyingTokens || []).map((t) => String(t || '').toLowerCase()),
      predictedClass: p.predictions ? p.predictions.predictedClass : null,
      predictedProb: p.predictions ? num(p.predictions.predictedProbability) : null
    };
  }

  function num(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }

  /** Share of the headline APY that is token emissions rather than earned yield. */
  function rewardShare(row) {
    if (!(row.apy > 0)) return null;
    if (row.apyReward === null) return null;
    return LP.util.clamp(row.apyReward / row.apy, 0, 1);
  }

  /* ----------------------------------------------------------------- matching */

  /**
   * Find the DefiLlama row for a pool the analyser has already resolved.
   *
   * Matching is on chain plus BOTH underlying token addresses, which narrows ~17,000 pools to
   * the handful that trade that exact pair on that chain (21 for WETH/USDC on Ethereum). The
   * remaining ambiguity is fee tiers of the same pair on the same DEX, resolved by project and
   * then by the fee in `poolMeta`. Confidence is reported rather than assumed, because a
   * silently wrong match would attach someone else's emissions to your pool.
   */
  function matchPool(result) {
    if (!cache) return { ok: false, reason: 'not loaded' };
    const pool = result.pool;
    const chain = CHAINS[pool.network];
    if (!chain) {
      return { ok: false, reason: 'No DefiLlama chain mapping for "' + pool.network + '".' };
    }

    const baseAddr = tokenAddr(pool.baseTokenId, pool.network);
    const quoteAddr = tokenAddr(pool.quoteTokenId, pool.network);
    if (!baseAddr || !quoteAddr) {
      return { ok: false, reason: 'Token addresses for this pool are not available.' };
    }

    const want = new Set([baseAddr, quoteAddr]);
    let cands = cache.map(shape).filter((p) => {
      if (p.chain !== chain) return false;
      if (p.underlying.length !== 2) return false;
      return p.underlying.every((t) => want.has(t)) && new Set(p.underlying).size === 2;
    });

    if (!cands.length) {
      return { ok: false, reason: 'DefiLlama does not track a pool for this pair on ' + chain + '.' };
    }

    // Prefer the same DEX.
    const wantProject = slug(pool.dexId);
    const byProject = cands.filter((p) => {
      const s = slug(p.project);
      return s === wantProject || s.startsWith(wantProject) || wantProject.startsWith(s);
    });
    let pool2 = byProject.length ? byProject : cands;
    let confidence = byProject.length ? 'project' : 'pair';

    // Then the same fee tier, which is what distinguishes sibling pools on the same DEX.
    if (pool2.length > 1 && result.fees && result.fees.feePct) {
      const wantFee = result.fees.feePct;
      const byFee = pool2.filter((p) => {
        const m = String(p.meta || '').match(/([\d.]+)\s*%/);
        return m && Math.abs(parseFloat(m[1]) - wantFee) < 0.005;
      });
      if (byFee.length) { pool2 = byFee; confidence = 'fee tier'; }
    }

    // Last resort: the one whose TVL is closest to what we measured.
    if (pool2.length > 1 && result.pool.tvlUsd > 0) {
      pool2 = pool2.slice().sort((a, b) =>
        Math.abs(a.tvlUsd - result.pool.tvlUsd) - Math.abs(b.tvlUsd - result.pool.tvlUsd));
      if (confidence === 'project' || confidence === 'pair') confidence = 'closest TVL';
    }

    const best = pool2[0];
    // A large TVL disagreement means we probably matched the wrong pool.
    const tvlGap = result.pool.tvlUsd > 0
      ? Math.abs(best.tvlUsd - result.pool.tvlUsd) / result.pool.tvlUsd : null;

    return {
      ok: true,
      row: best,
      confidence,
      tvlGap,
      suspect: tvlGap !== null && tvlGap > 0.35,
      alternatives: cands.sort((a, b) => b.tvlUsd - a.tvlUsd).slice(0, 8)
    };
  }

  /** "eth_0xabc..." -> "0xabc..."; Solana ids keep their base58 mint. */
  function tokenAddr(tokenId, network) {
    if (!tokenId) return null;
    return String(tokenId).replace(network + '_', '').toLowerCase();
  }

  /* ----------------------------------------------------------------- screening */

  /**
   * @param o {exposure, chain, stablecoin, minTvl, minApy, maxRewardShare, search,
   *           project, noIlRisk, minCount, sort, limit}
   */
  function screen(o) {
    if (!cache) return [];
    const opt = o || {};
    const q = String(opt.search || '').trim().toLowerCase();

    let rows = cache.map(shape);

    if (opt.exposure && opt.exposure !== 'any') rows = rows.filter((p) => p.exposure === opt.exposure);
    if (opt.chain && opt.chain !== 'any') rows = rows.filter((p) => p.chain === opt.chain);
    if (opt.stablecoin === true) rows = rows.filter((p) => p.stablecoin);
    if (opt.noIlRisk === true) rows = rows.filter((p) => p.ilRisk === 'no');
    if (opt.minTvl) rows = rows.filter((p) => p.tvlUsd >= opt.minTvl);
    if (opt.minApy) rows = rows.filter((p) => p.apy >= opt.minApy);
    if (opt.minCount) rows = rows.filter((p) => (p.count || 0) >= opt.minCount);
    if (opt.excludeOutliers) rows = rows.filter((p) => !p.outlier);

    if (opt.maxRewardShare !== undefined && opt.maxRewardShare !== null) {
      rows = rows.filter((p) => {
        const s = rewardShare(p);
        return s === null ? false : s <= opt.maxRewardShare;
      });
    }
    if (q) {
      rows = rows.filter((p) =>
        String(p.symbol || '').toLowerCase().includes(q) ||
        String(p.project || '').toLowerCase().includes(q) ||
        String(p.meta || '').toLowerCase().includes(q));
    }

    const sort = opt.sort || 'apy';
    const key = {
      apy: (p) => p.apy,
      base: (p) => (p.apyBase === null ? -1 : p.apyBase),
      tvl: (p) => p.tvlUsd,
      stability: (p) => -(p.sigma === null ? 1e9 : p.sigma),
      mean30: (p) => (p.apyMean30d === null ? -1 : p.apyMean30d)
    }[sort] || ((p) => p.apy);

    rows.sort((a, b) => key(b) - key(a));
    return opt.limit ? rows.slice(0, opt.limit) : rows;
  }

  /** Distinct chains present, most pools first — for building a filter list. */
  function chains() {
    if (!cache) return [];
    const counts = new Map();
    cache.forEach((p) => counts.set(p.chain, (counts.get(p.chain) || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => ({ chain: c, n }));
  }

  return { load, isLoaded, count, screen, matchPool, shape, rewardShare, chains, CHAINS };
})();
