/*
 * Tests for the Merkl incentive client.
 *
 * Two things here are worth more than the rest. The dilution identity is checked against an
 * independent derivation rather than against itself, so a sign or inversion error cannot pass.
 * And the flag shape is asserted against what the risk list actually renders -- the first draft
 * emitted { level: 'bad', text } where the UI reads { level, title, detail }, which would have
 * rendered "undefined" on a live pool without failing anything.
 */
import { loadLP, suite, check, near, report } from './harness.mjs';

const NOW = 1_800_000_000;          // fixed clock, so "days left" is deterministic
const DAY = 86_400;

/** A campaign whose APR reconstructs from the pot: the pro-rata case. */
function proRataCampaign(over = {}) {
  const tvl = over.tvl ?? 1_000_000;
  const daily = over.daily ?? 1_000;
  return {
    name: over.name ?? 'Test campaign',
    type: 'CLAMM',
    action: 'POOL',
    status: 'LIVE',
    identifier: '0x' + 'a'.repeat(40),
    apr: over.apr ?? (daily * 365 / tvl) * 100,
    tvl,
    dailyRewards: daily,
    latestCampaignEnd: String(NOW + (over.daysLeft ?? 30) * DAY),
    earliestCampaignStart: String(NOW - 10 * DAY),
    liveCampaigns: 1,
    depositUrl: over.depositUrl ?? 'https://example.org/campaign',
    rewardsRecord: { breakdowns: [{ token: { symbol: over.symbol ?? 'OP' } }] }
  };
}

const LP = loadLP(['util', 'merkl'], { fetch: async () => { throw new Error('no network'); } });
const M = LP.merkl;

/* ------------------------------------------------------------------- shaping */

suite('merkl.shape');
{
  const c = M.shape(proRataCampaign({ daily: 1000, tvl: 1_000_000, daysLeft: 30 }), NOW);
  near('apr reconstructs from the pot', c.apr, 36.5, 1e-9);
  near('implied apr matches the published one', c.impliedApr, c.apr, 1e-9);
  check('recognised as pro rata', c.proRata === true);
  near('days left read from the campaign end', c.daysLeft, 30, 1e-6);
  near('remaining value is the apr over what is left, not a year',
    c.remainingPct, 36.5 * (30 / 365), 1e-9);
  check('reward token symbol captured', c.rewardTokens.join() === 'OP');
}
{
  // A restricted campaign: the published apr does not follow from pot over TVL.
  const c = M.shape(proRataCampaign({ apr: 82.49, daily: 1628.22, tvl: 377_694 }), NOW);
  check('restricted campaign is not treated as pro rata', c.proRata === false,
    'implied ' + c.impliedApr.toFixed(1) + '% vs published ' + c.apr + '%');
}
{
  const c = M.shape({ name: 'x', apr: null, tvl: null, dailyRewards: null }, NOW);
  check('missing numbers stay null rather than becoming 0',
    c.apr === null && c.tvl === null && c.daysLeft === null);
  check('no remaining value without an end date', c.remainingPct === null);
  check('not pro rata when nothing can be checked', c.proRata === false);
}

/* ------------------------------------------------------------------ dilution */

suite('merkl dilution');
{
  const c = M.shape(proRataCampaign({ daily: 1000, tvl: 1_000_000 }), NOW);
  const P = 100_000;

  // Derived independently: your share of the fixed daily pot, annualised, over your own capital.
  const share = P / (c.tvl + P);
  const independent = (c.daily * 365 * share) / P * 100;

  near('diluted apr matches an independent pro-rata derivation',
    M.dilutedApr(c, P), independent, 1e-9);
  near('and equals apr * T/(T+P)', M.dilutedApr(c, P), c.apr * (c.tvl / (c.tvl + P)), 1e-12);

  check('a bigger position dilutes further',
    M.dilutedApr(c, 500_000) < M.dilutedApr(c, 100_000));
  check('a negligible position barely dilutes',
    Math.abs(M.dilutedApr(c, 1) - c.apr) < 1e-3);
  check('dilution is never an increase', M.dilutedApr(c, P) < c.apr);
}
{
  const restricted = M.shape(proRataCampaign({ apr: 82.49, daily: 1628.22, tvl: 377_694 }), NOW);
  check('no dilution figure for a restricted campaign, rather than a wrong one',
    M.dilutedApr(restricted, 10_000) === null);
  const c = M.shape(proRataCampaign(), NOW);
  check('no dilution figure without a position size', M.dilutedApr(c, null) === null);
  check('a zero or negative position gives null, not Infinity',
    M.dilutedApr(c, 0) === null && M.dilutedApr(c, -5) === null);
}

/* ------------------------------------------------------------------ analysis */

suite('merkl.analyse');
{
  const a = M.analyse([
    proRataCampaign({ name: 'A', daily: 1000, tvl: 1_000_000, daysLeft: 30 }),
    proRataCampaign({ name: 'B', daily: 500, tvl: 1_000_000, daysLeft: 5, symbol: 'ARB' })
  ], { nowSec: NOW, poolUsd: 1_000_000, positionUsd: 100_000 });

  check('both campaigns are live', a.live.length === 2 && a.ended.length === 0);
  near('aprs add', a.totalApr, 36.5 + 18.25, 1e-9);
  near('soonest end wins the countdown', a.soonestDays, 5, 1e-6);
  near('latest end is kept too', a.latestDays, 30, 1e-6);
  near('remaining value adds across campaigns',
    a.totalRemainingPct, 36.5 * (30 / 365) + 18.25 * (5 / 365), 1e-9);
  check('reward tokens are deduplicated across campaigns',
    a.rewardTokens.length === 2 && a.rewardTokens.includes('OP') && a.rewardTokens.includes('ARB'));
  check('diluted total is below the headline total', a.totalDilutedApr < a.totalApr);
}
{
  // An ended campaign must not inflate the totals, but must still be remembered.
  const a = M.analyse([
    proRataCampaign({ name: 'live', daysLeft: 10 }),
    proRataCampaign({ name: 'over', daysLeft: -3 })
  ], { nowSec: NOW, poolUsd: 1_000_000 });
  check('expired campaign excluded from live', a.live.length === 1);
  check('expired campaign still reported', a.ended.length === 1);
  near('totals count only the live one', a.totalApr, 36.5, 1e-9);
}
{
  const a = M.analyse([], { nowSec: NOW, poolUsd: 1_000_000 });
  check('no campaigns gives nulls, not zeros', a.totalApr === null && a.soonestDays === null);
  check('and no flags', a.flags.length === 0);
}

/* --------------------------------------------------------------------- flags */

suite('merkl flags');
{
  // The regression this file exists for: the shape the risk list actually reads.
  const a = M.analyse([proRataCampaign({ daysLeft: 3 })], { nowSec: NOW, poolUsd: 1_000_000 });
  const levels = ['critical', 'warn', 'info'];
  check('a flag is raised for a campaign ending this week', a.flags.length >= 1);
  check('every flag uses a level the risk list sorts on',
    a.flags.every((f) => levels.includes(f.level)),
    JSON.stringify(a.flags.map((f) => f.level)));
  check('every flag has the title and detail the risk list renders',
    a.flags.every((f) => typeof f.title === 'string' && f.title.length > 0 &&
                         typeof f.detail === 'string' && f.detail.length > 0));
  check('no flag carries the old text field instead',
    a.flags.every((f) => f.text === undefined));
}
{
  const soon = M.analyse([proRataCampaign({ daysLeft: 0.5 })], { nowSec: NOW, poolUsd: 1e6 });
  check('ending within a day is critical',
    soon.flags.some((f) => f.level === 'critical'));
  const week = M.analyse([proRataCampaign({ daysLeft: 3 })], { nowSec: NOW, poolUsd: 1e6 });
  check('ending within a week is a warning, not critical',
    week.flags.some((f) => f.level === 'warn') &&
    !week.flags.some((f) => f.level === 'critical'));
  const far = M.analyse([proRataCampaign({ daysLeft: 120 })], { nowSec: NOW, poolUsd: 1e6 });
  check('a long campaign raises no expiry flag',
    !far.flags.some((f) => /ends/i.test(f.title)));
}
{
  /*
   * The threshold must agree with what the panel displays. A live campaign with 7.39 days left
   * was shown as "7 days" while a `< 7` test stayed silent, so the reader saw a week-away
   * expiry with no warning beside it.
   */
  const expiryFlag = (daysLeft) => M.analyse([proRataCampaign({ daysLeft })],
    { nowSec: NOW, poolUsd: 1e6 }).flags.filter((f) => /ends/i.test(f.title));

  check('7.39 days, which displays as "7 days", does flag',
    expiryFlag(7.39).length === 1 && expiryFlag(7.39)[0].level === 'warn');
  check('and says the same number the panel shows',
    /7 days/.test(expiryFlag(7.39)[0].title), expiryFlag(7.39)[0].title);
  check('7.6 days, which displays as "8 days", does not flag',
    expiryFlag(7.6).length === 0);
  check('the critical threshold is under a day, not under a week',
    expiryFlag(0.9)[0].level === 'critical' && expiryFlag(1.5)[0].level === 'warn');
}
{
  // Merkl measuring a different TVL than the pool holds means the campaign is scoped elsewhere.
  const a = M.analyse([proRataCampaign({ tvl: 50_000_000 })],
    { nowSec: NOW, poolUsd: 1_000_000 });
  check('a wide TVL gap is flagged', a.tvlSuspect === true);
  check('and explained in the risk list', a.flags.some((f) => /TVL/.test(f.title + f.detail)));
  const ok = M.analyse([proRataCampaign({ tvl: 1_100_000 })],
    { nowSec: NOW, poolUsd: 1_000_000 });
  check('a close TVL is not flagged', ok.tvlSuspect === false);
}

/* -------------------------------------------------------------------- lookup */

suite('merkl.lookup guards');
{
  const unsupported = await M.lookup('solana', '0x' + 'a'.repeat(40));
  check('a chain Merkl does not run on says so', unsupported.ok === false &&
    unsupported.unsupported === true);
  check('which is distinct from having no campaign',
    /does not run/.test(unsupported.reason));

  const bad = await M.lookup('eth', 'not-an-address');
  check('a non-address is rejected before any request', bad.ok === false);
  check('and is not reported as unsupported', bad.unsupported === undefined);
}
{
  // Chains must map to the ids Merkl published, not to guesses.
  const ids = M.CHAIN_IDS;
  check('ethereum is 1', ids.eth === 1);
  check('base is 8453', ids.base === 8453);
  check('arbitrum is 42161', ids.arbitrum === 42161);
  check('optimism is 10', ids.optimism === 10);
  check('katana is 747474', ids.katana === 747474);
  check('chains Merkl does not support are absent',
    ids.solana === undefined && ids.starknet === undefined && ids.aptos === undefined);
  check('every mapped id is a positive integer',
    Object.values(ids).every((v) => Number.isInteger(v) && v > 0));
  check('no duplicate chain ids',
    new Set(Object.values(ids)).size === Object.values(ids).length);
}

/* ------------------------------------------------------- fetch and the cache */

suite('merkl fetch');
{
  let calls = 0;
  const raw = [proRataCampaign({ daysLeft: 12 })];
  const LP2 = loadLP(['util', 'merkl'], {
    fetch: async (url) => {
      calls++;
      return { ok: true, status: 200, url, json: async () => raw };
    }
  });
  const M2 = LP2.merkl;
  const addr = '0x' + 'B'.repeat(40);          // deliberately upper case

  const first = await M2.lookup('base', addr);
  check('a campaign is found', first.ok === true && first.raw.length === 1);
  check('the address is lower-cased for the query', calls === 1);

  await M2.lookup('base', addr.toLowerCase());
  check('a repeat lookup is served from cache', calls === 1, 'calls=' + calls);

  await M2.lookup('eth', addr);
  check('a different chain is a different cache key', calls === 2);

  // Both requests in flight at once must share one fetch.
  const LP3 = loadLP(['util', 'merkl'], {
    fetch: async () => { calls++; return { ok: true, status: 200, json: async () => raw }; }
  });
  calls = 0;
  await Promise.all([
    LP3.merkl.lookup('base', addr),
    LP3.merkl.lookup('base', addr)
  ]);
  check('concurrent lookups are de-duplicated', calls === 1, 'calls=' + calls);
}
{
  const LP4 = loadLP(['util', 'merkl'], {
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) })
  });
  let threw = null;
  try { await LP4.merkl.lookup('base', '0x' + 'c'.repeat(40)); }
  catch (e) { threw = e.message; }
  check('an HTTP error surfaces the status', threw !== null && /503/.test(threw), String(threw));
}
{
  const LP5 = loadLP(['util', 'merkl'], {
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ notAnArray: true }) })
  });
  const r = await LP5.merkl.lookup('base', '0x' + 'd'.repeat(40));
  check('an unexpected body shape becomes an empty list, not a crash',
    r.ok === true && Array.isArray(r.raw) && r.raw.length === 0);
}

report();
