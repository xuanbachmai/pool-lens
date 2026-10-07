/*
 * Pendle markets proxy.
 *
 * Pendle's public API serves no Access-Control-Allow-Origin header, so a browser cannot call it
 * from a static page. This forwards the request and adds one. No credentials involved — the
 * endpoint is public — so unlike /api/ask this works on any deployment with nothing to
 * configure.
 *
 * Responses are cached at the edge: market data updates on the order of minutes, and every
 * visitor asking for the same chain's 45 markets should not become 45 upstream requests.
 */

const UPSTREAM = 'https://api-v2.pendle.finance/core/v1';

// Chains Pendle deploys on, keyed by the numeric id its API expects. Anything else is refused
// rather than forwarded, so this cannot be used as an open proxy.
const ALLOWED_CHAINS = new Set([1, 10, 56, 146, 999, 5000, 8453, 42161, 80094, 43114]);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Use GET.' });
  }

  const chainId = parseInt(req.query?.chainId, 10);
  if (!Number.isFinite(chainId) || !ALLOWED_CHAINS.has(chainId)) {
    return res.status(400).json({
      error: 'bad_chain',
      message: 'chainId must be one of: ' + [...ALLOWED_CHAINS].join(', ')
    });
  }

  try {
    /*
     * The upstream caps limit at 100 and returns HTTP 400 above it, so page rather than ask for
     * everything at once. Ethereum has ~45 active markets today, but a chain could exceed one
     * page and silently losing the tail would be worse than a slightly slower response.
     */
    const PAGE = 100;
    const results = [];
    let total = null;
    for (let skip = 0; skip < 500; skip += PAGE) {
      const url = `${UPSTREAM}/${chainId}/markets?limit=${PAGE}&skip=${skip}&is_active=true`;
      const upstream = await fetch(url, { headers: { accept: 'application/json' } });
      if (!upstream.ok) {
        if (skip === 0) {
          return res.status(502).json({
            error: 'upstream',
            message: `Pendle returned HTTP ${upstream.status}.`
          });
        }
        break;       // keep the pages we did get rather than failing the whole request
      }
      const page = await upstream.json();
      const batch = page.results || [];
      results.push(...batch);
      if (total === null) total = page.total;
      if (batch.length < PAGE) break;
    }
    const json = { results };

    /*
     * Forward only the fields the analysis reads. The raw response is ~8 KB per market, most of
     * it icon URLs and four spellings of every name; trimming keeps a 45-market chain small
     * enough to send on every page load.
     */
    const markets = (json.results || []).map((m) => ({
      address: m.address,
      chainId: m.chainId,
      expiry: m.expiry,
      protocol: m.protocol,
      name: m.simpleName || m.name,
      symbol: m.symbol,
      pt: tok(m.pt),
      yt: tok(m.yt),
      sy: tok(m.sy),
      lp: tok(m.lp),
      accountingAsset: tok(m.accountingAsset),
      underlyingAsset: tok(m.underlyingAsset),
      totalPt: m.totalPt,
      totalSy: m.totalSy,
      totalLp: m.totalLp,
      liquidityUsd: m.liquidity?.usd ?? null,
      volumeUsd: m.tradingVolume?.usd ?? null,
      // The yield decomposition, which is the whole point.
      impliedApy: m.impliedApy ?? null,
      underlyingApy: m.underlyingApy ?? null,
      underlyingInterestApy: m.underlyingInterestApy ?? null,
      underlyingRewardApy: m.underlyingRewardApy ?? null,
      ptDiscount: m.ptDiscount ?? null,
      swapFeeApy: m.swapFeeApy ?? null,
      pendleApy: m.pendleApy ?? null,
      lpRewardApy: m.lpRewardApy ?? null,
      aggregatedApy: m.aggregatedApy ?? null,
      maxBoostedApy: m.maxBoostedApy ?? null,
      ytFloatingApy: m.ytFloatingApy ?? null,
      ptRoi: m.ptRoi ?? null,
      ytRoi: m.ytRoi ?? null,
      // Notional AMM parameters, so the curve can be reconstructed rather than assumed.
      scalarRoot: m.scalarRoot ?? null,
      initialAnchor: m.initialAnchor ?? null,
      feeRate: m.extendedInfo?.feeRate ?? null,
      yieldRangeMin: m.extendedInfo?.yieldRange?.min ?? null,
      yieldRangeMax: m.extendedInfo?.yieldRange?.max ?? null,
      isNew: !!m.isNew,
      categoryIds: m.categoryIds || [],
      dataUpdatedAt: m.dataUpdatedAt || null
    }));

    // Market data moves on the order of minutes; serve stale while revalidating.
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
    return res.status(200).json({ chainId, count: markets.length, markets });
  } catch (err) {
    return res.status(502).json({
      error: 'upstream',
      message: err?.message || 'Could not reach the Pendle API.'
    });
  }
}

function tok(t) {
  if (!t) return null;
  return {
    address: t.address,
    symbol: t.symbol,
    name: t.simpleName || t.name,
    decimals: t.decimals,
    priceUsd: t.price?.usd ?? null,
    expiry: t.expiry ?? null
  };
}
