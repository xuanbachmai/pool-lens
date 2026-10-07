/*
 * Merkl incentive campaigns proxy.
 *
 * Merkl looks like it needs no proxy and does not. Requested without an Origin header -- curl,
 * a server, anything that is not a browser -- it answers with `access-control-allow-origin: *`.
 * Send an actual browser Origin and that one header disappears, while allow-credentials,
 * allow-methods and allow-headers all stay. The likely cause is that `allow-credentials: true`
 * is invalid alongside `*`, so something downstream strips the wildcard; the effect is that the
 * fetch fails in the browser with a bare "Failed to fetch".
 *
 * The lesson, which cost a round of debugging: CORS cannot be verified with a plain curl. The
 * request has to carry an Origin header, because that is what the server keys its answer on.
 * DefiLlama, checked the same way, really does send the header and really does need no proxy.
 *
 * No credentials involved -- the endpoint is public -- so this needs nothing configured.
 */

const UPSTREAM = 'https://api.merkl.xyz/v4/opportunities';

/*
 * Chains Merkl runs on, from its own /v4/chains listing. Anything else is refused rather than
 * forwarded, so this cannot be turned into an open proxy for arbitrary chain ids.
 */
const ALLOWED_CHAINS = new Set([
  1, 10, 14, 30, 50, 56, 100, 122, 130, 137, 143, 146, 151, 169, 196, 239, 250, 252, 324,
  480, 592, 747, 988, 999, 1101, 1135, 1284, 1329, 1672, 1868, 1923, 2020, 2818, 4114, 4217,
  4326, 4663, 5000, 5042, 5464, 6900, 8217, 8453, 9745, 13371, 16661, 25363, 31612, 34443,
  42161, 42220, 42793, 43111, 43114, 48900, 57073, 59144, 60808, 80094, 81457, 98866, 167000,
  534352, 685689, 747474, 1440000, 5064014, 21000000, 2046399126
]);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Use GET.' });
  }

  const chainId = parseInt(req.query?.chainId, 10);
  if (!Number.isFinite(chainId) || !ALLOWED_CHAINS.has(chainId)) {
    return res.status(400).json({
      error: 'bad_chain',
      message: 'chainId must be a chain Merkl operates on.'
    });
  }

  // Matched on the pool address. Validated here so the upstream is never handed free-form input.
  const identifier = String(req.query?.identifier || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(identifier)) {
    return res.status(400).json({
      error: 'bad_identifier',
      message: 'identifier must be a 0x-prefixed 20-byte pool address.'
    });
  }

  try {
    const url = `${UPSTREAM}?identifier=${identifier}&chainId=${chainId}`;
    const upstream = await fetch(url, { headers: { accept: 'application/json' } });
    if (!upstream.ok) {
      return res.status(502).json({
        error: 'upstream',
        message: `Merkl returned HTTP ${upstream.status}.`
      });
    }
    const json = await upstream.json();
    const list = Array.isArray(json) ? json : [];

    /*
     * Forward only what the analysis reads. A raw opportunity carries description prose,
     * how-to steps, chain and protocol objects with icon URLs, and full APR/TVL history --
     * about 10 KB each, of which this keeps a few hundred bytes.
     */
    const campaigns = list.map((o) => ({
      name: o.name ?? null,
      type: o.type ?? null,
      action: o.action ?? null,
      status: o.status ?? null,
      identifier: o.identifier ?? null,
      chainId: o.chainId ?? null,
      apr: o.apr ?? null,
      tvl: o.tvl ?? null,
      dailyRewards: o.dailyRewards ?? null,
      liveCampaigns: o.liveCampaigns ?? null,
      earliestCampaignStart: o.earliestCampaignStart ?? null,
      latestCampaignEnd: o.latestCampaignEnd ?? null,
      depositUrl: o.depositUrl ?? null,
      protocol: o.protocol?.name ?? null,
      // Only the reward token symbols, not the full token objects.
      rewardsRecord: {
        breakdowns: ((o.rewardsRecord && o.rewardsRecord.breakdowns) || []).map((b) => ({
          token: { symbol: b.token?.symbol ?? null }
        }))
      }
    }));

    // Campaign terms change on the order of hours, not seconds.
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    return res.status(200).json(campaigns);
  } catch (err) {
    return res.status(502).json({
      error: 'upstream',
      message: err?.message || 'Could not reach the Merkl API.'
    });
  }
}
