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

  let cache = null;        // raw pool array as returned by the API
  let shaped = null;       // the same rows normalised, built once (see rows())
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
      shaped = null;          // invalidate the normalised view
      inflight = null;
      return cache;
    })();
    return inflight;
  }

  const isLoaded = () => cache !== null;
  const count = () => (cache ? cache.length : 0);

  /**
   * The dataset normalised once.
   *
   * shape() over ~17,000 rows costs about 35 ms and allocates an object per row. Both screen()
   * and matchPool() used to call it on every invocation, and screen() runs on the search box's
   * input event -- so typing one character re-shaped the entire dataset. Doing it once on first
   * use turns every later filter into predicate checks over an existing array.
   */
  function rows() {
    if (!cache) return [];
    if (!shaped) shaped = cache.map((p) => enrich(shape(p)));
    return shaped;
  }

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

  /** Attach the derived metrics once, at shape time, so screening stays a predicate pass. */
  function enrich(row) {
    row.vr = vrRatio(row);
    const c = confidence(row);
    row.confidence = c.score;
    row.confidenceBand = c.band || null;
    row.confidenceWeakest = c.weakest || null;
    return row;
  }

  function num(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Volume / reserves, the metric the OTS notes call the most important one for choosing a
   * pool. DefiLlama reports swap volume for about 65% of dual-sided pools and none of the
   * single-sided ones (a lending vault has no swaps), so this is null where it cannot be known
   * rather than zero -- those are very different claims.
   */
  function vrRatio(row) {
    if (!(row.tvlUsd > 0)) return null;
    if (row.volumeUsd1d === null || !(row.volumeUsd1d >= 0)) return null;
    return row.volumeUsd1d / row.tvlUsd;
  }

  /**
   * How much the headline number can be trusted -- NOT how good the pool is.
   *
   * A yield figure is a snapshot, and snapshots lie. Measured across the dataset: for the
   * bottom decile of pools today's APY is under 0.40x its own 30-day average, for the top
   * decile it is over 1.46x, 5% are showing more than double, and 6% have under a month of
   * history behind them. None of that is visible in the number itself.
   *
   * Scored on four things the data does support, each a reason to distrust:
   *   history   - days of observations behind the figure
   *   stability - sigma, the volatility of the APY itself
   *   spike     - today versus the pool's own 30-day mean
   *   durability- how much of it is emissions, which end when a vote says so
   *
   * Deliberately not included: the size of the yield. A trustworthy 4% scores higher than a
   * suspect 400%, which is the whole point.
   */
  function confidence(row) {
    const parts = [];
    const clamp = (v) => Math.max(0, Math.min(100, v));

    // History: 30 days is a pass, 180+ is full marks.
    if (row.count !== null) {
      parts.push({ key: 'history', weight: 1.2, score: clamp((row.count / 180) * 100),
        note: row.count + ' days of data' });
    }

    // Stability of the APY itself. sigma under ~0.3 is steady, over ~1.5 is noise.
    if (row.sigma !== null) {
      parts.push({ key: 'stability', weight: 1.0, score: clamp(100 - (row.sigma / 1.5) * 100),
        note: 'sigma ' + row.sigma.toFixed(2) });
    }

    // Spike: today against the pool's own 30-day mean. 1.0 is ideal in both directions.
    if (row.apyMean30d !== null && row.apyMean30d > 0 && row.apy > 0) {
      const ratio = row.apy / row.apyMean30d;
      const drift = Math.abs(Math.log(ratio));          // symmetric: 2x and 0.5x score alike
      parts.push({ key: 'spike', weight: 1.3, score: clamp(100 - (drift / Math.log(3)) * 100),
        note: ratio.toFixed(2) + 'x its 30-day mean' });
    }

    // Durability: emissions are real income that stops on a governance vote.
    const share = rewardShare(row);
    if (share !== null) {
      parts.push({ key: 'durability', weight: 0.9, score: clamp(100 - share * 100),
        note: Math.round(share * 100) + '% emissions' });
    }

    if (!parts.length) return { score: null, parts: [], reason: 'no history reported' };

    let score = parts.reduce((a, p) => a + p.weight * p.score, 0) /
                parts.reduce((a, p) => a + p.weight, 0);

    // DefiLlama's own unreliability flag caps the result rather than nudging it.
    if (row.outlier) score = Math.min(score, 25);

    return {
      score,
      parts,
      band: score >= 75 ? 'high' : score >= 50 ? 'fair' : score >= 30 ? 'low' : 'poor',
      weakest: parts.slice().sort((a, b) => a.score - b.score)[0]
    };
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
    let cands = rows().filter((p) => {
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
    const all = rows();
    // Named `list`, not `rows`: a local called `rows` shadows the module-level rows() helper
    // and turns the call above into a temporal-dead-zone error.
    let list = all;

    if (opt.exposure && opt.exposure !== 'any') list = list.filter((p) => p.exposure === opt.exposure);
    if (opt.chain && opt.chain !== 'any') list = list.filter((p) => p.chain === opt.chain);
    if (opt.stablecoin === true) list = list.filter((p) => p.stablecoin);
    if (opt.noIlRisk === true) list = list.filter((p) => p.ilRisk === 'no');
    if (opt.minTvl) list = list.filter((p) => p.tvlUsd >= opt.minTvl);
    if (opt.minApy) list = list.filter((p) => p.apy >= opt.minApy);
    if (opt.minCount) list = list.filter((p) => (p.count || 0) >= opt.minCount);
    if (opt.excludeOutliers) list = list.filter((p) => !p.outlier);
    if (opt.minConfidence) list = list.filter((p) => (p.confidence || 0) >= opt.minConfidence);
    if (opt.minVr) list = list.filter((p) => p.vr !== null && p.vr >= opt.minVr);
    // V/R above ~5 is usually looped or wash volume rather than a genuinely busy pool.
    if (opt.maxVr) list = list.filter((p) => p.vr === null || p.vr <= opt.maxVr);

    if (opt.maxRewardShare !== undefined && opt.maxRewardShare !== null) {
      list = list.filter((p) => {
        const sh = rewardShare(p);
        return sh === null ? false : sh <= opt.maxRewardShare;
      });
    }
    if (q) {
      list = list.filter((p) =>
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
      mean30: (p) => (p.apyMean30d === null ? -1 : p.apyMean30d),
      confidence: (p) => (p.confidence === null ? -1 : p.confidence),
      vr: (p) => (p.vr === null ? -1 : p.vr)
    }[sort] || ((p) => p.apy);

    // Copy before sorting: list may still BE the memoised array when no filter narrowed it,
    // and sorting in place would permanently reorder the shared view for every later caller.
    const sorted = list === all ? list.slice() : list;
    sorted.sort((a, b) => key(b) - key(a));
    return opt.limit ? sorted.slice(0, opt.limit) : sorted;
  }

  /** Distinct chains present, most pools first — for building a filter list. */
  function chains() {
    if (!cache) return [];
    const counts = new Map();
    cache.forEach((p) => counts.set(p.chain, (counts.get(p.chain) || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => ({ chain: c, n }));
  }

  return { load, isLoaded, count, rows, screen, matchPool, shape, enrich, rewardShare,
           vrRatio, confidence, chains, CHAINS };
})();
