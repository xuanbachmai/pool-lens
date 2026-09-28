/*
 * Natural language -> a screener filter.
 *
 * The one design rule here: THE MODEL NEVER PRODUCES A NUMBER THAT REACHES THE ANALYSIS.
 * It translates a sentence into filter parameters — exposure, thresholds, sort order — and
 * those parameters are then applied by the same deterministic code the checkboxes drive.
 * Every APY, TVL and emissions figure on the page is still computed from the data.
 *
 * That matters because the failure modes are completely different. A filter that comes back
 * slightly wrong is visible: the compiled parameters are shown to the user and are editable.
 * A hallucinated yield is indistinguishable from a real one, which is why none are asked for.
 *
 * Runs server-side on Vercel so the API key stays out of the browser.
 */

import Anthropic from '@anthropic-ai/sdk';

/*
 * Mirrors the options LP.llama.screen() understands. additionalProperties:false plus a full
 * required list is what makes the structured output strict, so the response always parses.
 */
const FILTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'exposure', 'stablecoin', 'noIlRisk', 'excludeOutliers',
    'minTvl', 'minApy', 'maxRewardShare', 'chain', 'search', 'sort', 'reasoning'
  ],
  properties: {
    exposure: {
      type: 'string',
      enum: ['any', 'single', 'multi'],
      description: 'single = one-sided deposits with no impermanent loss (lending vaults, ' +
        'staked stables, LSTs). multi = two-token LP positions, which have impermanent loss.'
    },
    stablecoin: { type: 'boolean', description: 'Restrict to stablecoin pools.' },
    noIlRisk: { type: 'boolean', description: 'Restrict to pools with no impermanent-loss risk.' },
    excludeOutliers: {
      type: 'boolean',
      description: 'Drop rows DefiLlama has flagged as unreliable. Default true unless the ' +
        'user explicitly wants to see everything.'
    },
    minTvl: { type: 'number', description: 'Minimum TVL in USD. Use 0 for no floor.' },
    minApy: { type: 'number', description: 'Minimum total APY as a percentage, e.g. 12 for 12%.' },
    maxRewardShare: {
      type: ['number', 'null'],
      description: 'Ceiling on the share of APY that is token emissions, 0 to 1. Use 0.25 for ' +
        '"real yield" or "not mostly emissions". null means no limit.'
    },
    chain: {
      type: ['string', 'null'],
      description: 'Exact DefiLlama chain name such as Ethereum, Arbitrum, Base, Solana. ' +
        'null for any chain.'
    },
    search: {
      type: ['string', 'null'],
      description: 'Free-text match against the pool symbol, project or fee tier. Use only for ' +
        'a specific asset or protocol the user named, e.g. "USDC" or "pendle". null otherwise.'
    },
    sort: {
      type: 'string',
      enum: ['base', 'apy', 'mean30', 'tvl', 'stability'],
      description: 'base = earned yield excluding emissions (the sane default). apy = headline. ' +
        'mean30 = 30-day average. stability = steadiest yield first.'
    },
    reasoning: {
      type: 'string',
      description: 'One or two sentences, plain language, explaining the choices you made and ' +
        'anything you had to assume. Addressed to the user.'
    }
  }
};

const SYSTEM = `You translate a request about DeFi yield farming into filter parameters for a
pool screener. You do not estimate, predict or invent any figure — every yield, TVL and
emissions number comes from the dataset, and your only job is to decide how to filter and sort it.

Context for interpreting requests:
- "single-sided", "no IL", "one token", "just deposit X" means exposure=single.
- "LP", "pool", "pair", "dual" means exposure=multi.
- "real yield", "not emissions", "sustainable", "not farm-and-dump" means a maxRewardShare
  around 0.25 and sort=base.
- "safe" usually means a high minTvl (5000000 or more), stablecoin=true and noIlRisk=true. It
  does not mean risk-free; say so in reasoning when someone asks for safety.
- Bare "good yield" with no number: leave minApy at 0 and sort by base rather than guessing a
  threshold the user did not give.
- Prefer sort=base unless the user explicitly asks for the highest headline number.

Be conservative. A filter that is too loose shows the user more and they can narrow it; one that
is too tight silently hides what they were looking for.`;

const MAX_QUERY = 400;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST.' });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    // 501 rather than 500: the page uses this to show setup instructions instead of an error.
    return res.status(501).json({
      error: 'not_configured',
      message: 'ANTHROPIC_API_KEY is not set on this deployment. Add it in Vercel under ' +
        'Settings → Environment Variables and redeploy. The filters below work without it.'
    });
  }

  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  if (!query) return res.status(400).json({ error: 'Missing "query".' });
  if (query.length > MAX_QUERY) {
    return res.status(400).json({ error: `Query too long (max ${MAX_QUERY} characters).` });
  }

  try {
    const client = new Anthropic({ apiKey: key });

    const response = await client.beta.messages.create({
      model: 'claude-opus-5',
      max_tokens: 2000,
      // Simple translation task: low effort keeps it fast and cheap without hurting accuracy.
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: FILTER_SCHEMA }
      },
      // If a safety classifier declines, the same request is retried on a fallback model
      // inside this call rather than the user getting nothing back.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{ role: 'user', content: query }]
    });

    if (response.stop_reason === 'refusal') {
      return res.status(422).json({
        error: 'refused',
        message: 'That request was declined. Rephrase it as a description of the pools you want.'
      });
    }

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    let filter;
    try {
      filter = JSON.parse(text);
    } catch {
      return res.status(502).json({
        error: 'bad_output',
        message: 'The model did not return a usable filter. Try rephrasing.'
      });
    }

    return res.status(200).json({
      filter,
      usage: {
        input: response.usage?.input_tokens ?? null,
        output: response.usage?.output_tokens ?? null
      }
    });
  } catch (err) {
    const status = err?.status;
    if (status === 401) {
      return res.status(502).json({ error: 'auth', message: 'The API key was rejected.' });
    }
    if (status === 429) {
      return res.status(429).json({ error: 'rate_limited', message: 'Rate limited — try again shortly.' });
    }
    return res.status(502).json({
      error: 'upstream',
      message: err?.message || 'The request to the model failed.'
    });
  }
}
