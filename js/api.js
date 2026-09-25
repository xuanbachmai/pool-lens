/*
 * Data layer. Two free, key-less, CORS-open sources:
 *   GeckoTerminal (CoinGecko on-chain)  - pool detail, fee tier, OHLCV history
 *   DexScreener                          - cross-check + token metadata
 * Both are read-only public endpoints, so the whole app can run client-side.
 */
window.LP = window.LP || {};

LP.api = (function () {
  const GT = 'https://api.geckoterminal.com/api/v2';
  const DS = 'https://api.dexscreener.com/latest/dex';

  const cache = new Map();
  let chain = Promise.resolve(); // serialises requests so we don't burst the rate limit

  /** GeckoTerminal's free tier allows ~30 calls/min; space calls out a little. */
  function queued(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(() => new Promise((r) => setTimeout(r, 120)), () => new Promise((r) => setTimeout(r, 120)));
    return run;
  }

  async function getJson(url, opts) {
    const key = url;
    if (cache.has(key)) return cache.get(key);

    const p = queued(async () => {
      let res;
      try {
        res = await fetch(url, { headers: { accept: 'application/json' } });
      } catch (e) {
        /*
         * A rate-limited response from GeckoTerminal comes back without the CORS header, so
         * the browser surfaces the 429 as an opaque network/CORS failure rather than a status
         * code we can read. Blaming the user's connection here would be wrong most of the
         * time, so name the likelier cause first.
         */
        const host = new URL(url).host;
        throw new RateLimitError(
          'The request to ' + host + ' was blocked before a response could be read. That is ' +
          'almost always the free tier rate limit (about 30 requests per minute) — it drops ' +
          'the CORS header on rejected requests, so the browser cannot see the 429. Wait a ' +
          'moment and analyse again. If it persists, check your connection or an ad blocker.'
        );
      }
      if (res.status === 429) {
        throw new RateLimitError(
          'Rate limited by ' + new URL(url).host + '. The free tier allows about 30 requests ' +
          'per minute — wait a moment and analyse again.'
        );
      }
      if (res.status === 404) return null;
      if (!res.ok) throw new NetworkError(new URL(url).host + ' returned HTTP ' + res.status + '.');
      return res.json();
    });

    cache.set(key, p);
    p.catch(() => cache.delete(key)); // don't cache failures
    return p;
  }

  class NetworkError extends Error {}
  class RateLimitError extends Error {}

  /* ---------------------------------------------------------------- GeckoTerminal */

  function gtSearch(query) {
    return getJson(GT + '/search/pools?query=' + encodeURIComponent(query));
  }

  function gtPool(network, address) {
    return getJson(GT + '/networks/' + encodeURIComponent(network) + '/pools/' + encodeURIComponent(address));
  }

  function gtOhlcv(network, address, timeframe, limit) {
    const q = '?limit=' + (limit || 180) + '&currency=token&token=base';
    return getJson(
      GT + '/networks/' + encodeURIComponent(network) + '/pools/' +
      encodeURIComponent(address) + '/ohlcv/' + (timeframe || 'day') + q
    );
  }

  function gtTokenPools(network, tokenAddress) {
    return getJson(
      GT + '/networks/' + encodeURIComponent(network) + '/tokens/' +
      encodeURIComponent(tokenAddress) + '/pools?page=1'
    );
  }

  /* ----------------------------------------------------------------- DexScreener */

  function dsSearch(query) {
    return getJson(DS + '/search?q=' + encodeURIComponent(query));
  }

  /* ------------------------------------------------------------------- shaping */

  /** Flatten a GeckoTerminal pool record into the shape the analyser wants. */
  function shapeGtPool(rec) {
    if (!rec) return null;
    const a = rec.attributes || {};
    const rel = rec.relationships || {};
    const network = String(rec.id || '').split('_')[0];
    const names = String(a.pool_name || a.name || '').split('/').map((s) => s.trim());

    return {
      source: 'geckoterminal',
      id: rec.id,
      network,
      address: (a.address || '').toLowerCase(),
      name: a.name,
      poolName: a.pool_name,
      baseSymbol: names[0] || null,
      quoteSymbol: names[1] || null,
      dexId: rel.dex && rel.dex.data ? rel.dex.data.id : null,
      baseTokenId: rel.base_token && rel.base_token.data ? rel.base_token.data.id : null,
      quoteTokenId: rel.quote_token && rel.quote_token.data ? rel.quote_token.data.id : null,
      feePercent: LP.util.num(a.pool_fee_percentage),
      tvlUsd: LP.util.num(a.reserve_in_usd),
      createdAt: a.pool_created_at,
      lockedLiquidityPct: LP.util.num(a.locked_liquidity_percentage),
      fdvUsd: LP.util.num(a.fdv_usd),
      marketCapUsd: LP.util.num(a.market_cap_usd),
      basePriceUsd: LP.util.num(a.base_token_price_usd),
      quotePriceUsd: LP.util.num(a.quote_token_price_usd),
      basePriceInQuote: LP.util.num(a.base_token_price_quote_token),
      volume: {
        h1: LP.util.num((a.volume_usd || {}).h1),
        h6: LP.util.num((a.volume_usd || {}).h6),
        h24: LP.util.num((a.volume_usd || {}).h24)
      },
      priceChange: {
        h1: LP.util.num((a.price_change_percentage || {}).h1),
        h6: LP.util.num((a.price_change_percentage || {}).h6),
        h24: LP.util.num((a.price_change_percentage || {}).h24)
      },
      txns: a.transactions || {}
    };
  }

  /**
   * Resolve a parsed target into a single pool, plus the alternatives we rejected.
   * Ranking matters: the same address exists on chain forks (a $49 clone of the real
   * WETH/USDC pool shows up first in raw search results), so we rank by reserve size
   * and give a large bonus when the network matches the chain named in the URL.
   */
  async function resolvePool(target) {
    const address = target.address || (target.addresses || [])[0];
    if (!address) throw new Error('No address to look up.');

    let candidates = [];
    let matchedBy = 'pool';

    // If we know the chain, ask for the pool directly - one call, no ambiguity.
    if (target.chain) {
      const direct = await gtPool(target.chain, address).catch((e) => {
        if (e instanceof RateLimitError) throw e;
        return null;
      });
      if (direct && direct.data) candidates = [shapeGtPool(direct.data)];
    }

    if (!candidates.length) {
      const search = await gtSearch(address);
      const all = ((search && search.data) || []).map(shapeGtPool).filter(Boolean);
      const exact = all.filter((p) => p.address === address.toLowerCase());
      if (exact.length) {
        candidates = exact;
      } else if (all.length) {
        // The address was a token, not a pool: offer the pools that trade it.
        candidates = all;
        matchedBy = 'token';
      }
    }

    if (!candidates.length) {
      return { pool: null, candidates: [], matchedBy: 'none' };
    }

    candidates.forEach((c) => {
      const chainBonus = target.chain && c.network === target.chain ? 1e15 : 0;
      c._score = chainBonus + (c.tvlUsd || 0) + (c.volume.h24 || 0);
    });
    candidates.sort((a, b) => b._score - a._score);

    let pool = candidates[0];

    // Search results are lighter than the detail endpoint (no fee tier, no locked %).
    if (pool.feePercent === null || pool.lockedLiquidityPct === null) {
      const full = await gtPool(pool.network, pool.address).catch((e) => {
        if (e instanceof RateLimitError) throw e;
        return null;
      });
      if (full && full.data) pool = Object.assign({}, pool, shapeGtPool(full.data));
    }

    return { pool, candidates, matchedBy };
  }

  /** Best-effort DexScreener cross-check for the same pool address. */
  async function crossCheck(pool) {
    try {
      const res = await dsSearch(pool.address);
      const pairs = (res && res.pairs) || [];
      const hit = pairs.find((p) => (p.pairAddress || '').toLowerCase() === pool.address);
      if (!hit) return null;
      return {
        source: 'dexscreener',
        url: hit.url,
        chainId: hit.chainId,
        dexId: hit.dexId,
        labels: hit.labels || [],
        tvlUsd: LP.util.num((hit.liquidity || {}).usd),
        volume24h: LP.util.num((hit.volume || {}).h24),
        fdv: LP.util.num(hit.fdv),
        marketCap: LP.util.num(hit.marketCap),
        pairCreatedAt: hit.pairCreatedAt,
        baseToken: hit.baseToken,
        quoteToken: hit.quoteToken,
        reserves: hit.liquidity || null,
        websites: ((hit.info || {}).websites || []).map((w) => w.url).filter(Boolean),
        priceChange: hit.priceChange || {}
      };
    } catch (e) {
      return null; // a cross-check failing must never break the analysis
    }
  }

  /** Daily OHLCV, oldest-first, as {t, o, h, l, c, v} with prices in quote-token terms. */
  async function history(pool, days) {
    const res = await gtOhlcv(pool.network, pool.address, 'day', days || 180).catch((e) => {
      if (e instanceof RateLimitError) throw e;
      return null;
    });
    const list = res && res.data && res.data.attributes ? res.data.attributes.ohlcv_list : null;
    if (!list || !list.length) return [];
    return list
      .map((r) => ({ t: r[0] * 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }))
      .filter((b) => Number.isFinite(b.c) && b.c > 0)
      .sort((a, b) => a.t - b.t);
  }

  /**
   * Other pools trading the same base token, so the user can check whether the pool they
   * pasted is actually the best venue for that pair (fee-tier fragmentation is common:
   * the same pair often has 0.01%, 0.05%, 0.30% and 1% pools side by side).
   */
  async function siblingPools(pool) {
    const tokenAddr = String(pool.baseTokenId || '').replace(pool.network + '_', '');
    if (!tokenAddr) return [];
    const res = await gtTokenPools(pool.network, tokenAddr);
    const all = ((res && res.data) || []).map(shapeGtPool).filter(Boolean);
    const quote = (pool.quoteSymbol || '').toUpperCase();
    return all
      .filter((p) => {
        if (!quote) return true;
        const syms = String(p.poolName || p.name || '').toUpperCase();
        return syms.includes(quote);
      })
      .sort((a, b) => (b.tvlUsd || 0) - (a.tvlUsd || 0))
      .slice(0, 8);
  }

  return {
    resolvePool, crossCheck, history, siblingPools, gtSearch, gtPool, gtTokenPools, dsSearch,
    shapeGtPool, NetworkError, RateLimitError
  };
})();
