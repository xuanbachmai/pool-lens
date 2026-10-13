/*
 * Tests for the manipulation and health checks.
 *
 * The one worth reading is the context pair. USDT genuinely reports mintable, pausable,
 * blacklist-capable, an active owner and half its supply in ten addresses. A checker that
 * shouted "critical" at that would be wrong in the way that teaches people to ignore checkers,
 * so severity has to come from corroboration rather than from any single flag. There is a test
 * below that fails if someone makes a lone flag critical again.
 *
 * The rest are mostly about not crying wolf: missing fields must produce no findings rather
 * than false ones, and the verdict must never use the word "safe".
 */
import { loadLP, suite, check, near, report } from './harness.mjs';

const LP = loadLP(['util', 'fees', 'swap', 'integrity'], {
  fetch: async () => { throw new Error('offline'); }
});
const I = LP.integrity;

const DAY = 86400000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

/** A pool result in the shape the analyser produces. */
function result(over = {}) {
  const pool = Object.assign({
    network: 'eth', poolName: 'TEST / WETH',
    baseTokenId: 'eth_0x' + 'a'.repeat(40),
    tvlUsd: 5_000_000, fdvUsd: 50_000_000,
    createdAt: ago(400), lockedLiquidityPct: 0.5,
    txns: { h24: { buys: 400, sells: 380, buyers: 220, sellers: 200 } }
  }, over.pool || {});
  return Object.assign({ pool, poolType: 'cpmm', fees: { feePct: 0.3 },
    cross: { reserves: { base: 1e9, quote: 1000 } } }, over);
}

/** A GoPlus record. Defaults are a clean, established token. */
function sec(over = {}) {
  return Object.assign({
    is_honeypot: '0', buy_tax: '0', sell_tax: '0', is_open_source: '1',
    is_mintable: '0', owner_address: '0x0000000000000000000000000000000000000000',
    is_proxy: '0', can_take_back_ownership: '0', hidden_owner: '0', selfdestruct: '0',
    transfer_pausable: '0', is_blacklisted: '0', cannot_sell_all: '0', trading_cooldown: '0',
    holder_count: '500000', lp_holder_count: '120',
    holders: [{ percent: '0.03' }, { percent: '0.02' }]
  }, over);
}

const titles = (a) => a.findings.map((f) => f.title);
const levelOf = (a, re) => (a.findings.find((f) => re.test(f.title)) || {}).level || null;

/* --------------------------------------------------------- the context rule */

suite('integrity — severity comes from corroboration');
{
  // The USDT shape: alarming flags on a thoroughly established token.
  const established = I.assess(
    result({ pool: { createdAt: ago(900), txns: { h24: { buys: 600, sells: 300, buyers: 380, sellers: 160 } } } }),
    sec({ is_mintable: '1', owner_address: '0xabc0000000000000000000000000000000000001',
          transfer_pausable: '1', is_blacklisted: '1',
          holder_count: '15000000', lp_holder_count: '300',
          // SHIB's real split: 64% in ten addresses on a token with 1.7m holders. USDT's
          // actual 49% sits just under the threshold and raises nothing, which is also fine.
          holders: [{ percent: '0.45' }, { percent: '0.19' }] }));

  check('an established token is not called critical for being mintable',
    levelOf(established, /minted/i) === 'warn', String(levelOf(established, /minted/i)));
  check('pausable on an established token is only context',
    levelOf(established, /paused/i) === 'info', String(levelOf(established, /paused/i)));
  check('concentration on an established token is a warning, not critical',
    levelOf(established, /few hands/i) === 'warn', String(levelOf(established, /few hands/i)));
  check('and the verdict is not a red alert', established.counts.critical === 0);
}
{
  // The identical flags on something young, thinly provided and barely held.
  const fragile = I.assess(
    result({ pool: { createdAt: ago(3), tvlUsd: 20000, fdvUsd: 40_000_000,
                     lockedLiquidityPct: 0,
                     txns: { h24: { buys: 90, sells: 80, buyers: 50, sellers: 45 } } } }),
    sec({ is_mintable: '1', owner_address: '0xabc0000000000000000000000000000000000001',
          transfer_pausable: '1', holder_count: '300', lp_holder_count: '2',
          holders: [{ percent: '0.60' }, { percent: '0.19' }] }));

  check('the same mint power on a fragile pool is critical',
    levelOf(fragile, /minted/i) === 'critical', String(levelOf(fragile, /minted/i)));
  check('the same concentration is critical there',
    levelOf(fragile, /few hands/i) === 'critical');
  check('and pausable escalates to a warning',
    levelOf(fragile, /paused/i) === 'warn');
  check('few liquidity providers is reported', titles(fragile).some((t) => /few providers/i.test(t)));
  check('so is the age', titles(fragile).some((t) => /days old|less than a day/i.test(t)));
  check('so is unlocked liquidity', titles(fragile).some((t) => /locked/i.test(t)));
}

/* ------------------------------------------------------- the hard blockers */

suite('integrity — things that stop an exit');
{
  const a = I.assess(result(), sec({ is_honeypot: '1' }));
  check('a honeypot is critical', levelOf(a, /honeypot/i) === 'critical');
  check('and the verdict reflects it', /serious problem/i.test(I.verdictFor(a).headline));
}
{
  const a = I.assess(result(), sec({ buy_tax: '0.6', sell_tax: '0.7' }));
  check('a punitive tax is critical', levelOf(a, /punitive/i) === 'critical');
  const b = I.assess(result(), sec({ buy_tax: '0.15', sell_tax: '0.15' }));
  check('a double-digit tax is a warning', levelOf(b, /tax of more than 10/i) === 'warn');
  const c = I.assess(result(), sec({ buy_tax: '0.01', sell_tax: '0.08' }));
  check('an asymmetric tax is called out even when small',
    levelOf(c, /taxed more than buying/i) === 'warn');
  const d = I.assess(result(), sec());
  check('no tax raises nothing', !titles(d).some((t) => /tax/i.test(t)));
}
{
  check('hidden ownership is critical',
    levelOf(I.assess(result(), sec({ hidden_owner: '1' })), /hidden owner/i) === 'critical');
  check('self-destruct is critical',
    levelOf(I.assess(result(), sec({ selfdestruct: '1' })), /destroy itself/i) === 'critical');
  check('reclaimable ownership is a warning',
    levelOf(I.assess(result(), sec({ can_take_back_ownership: '1' })), /reclaimed/i) === 'warn');
  check('unverified source is a warning',
    levelOf(I.assess(result(), sec({ is_open_source: '0' })), /not published/i) === 'warn');
}

/* ------------------------------------------------------------ market shape */

suite('integrity — market signals');
{
  // Buying with no selling, which is a honeypot seen from outside the contract.
  const a = I.assess(result({ pool: { txns: { h24: { buys: 40, sells: 1, buyers: 35, sellers: 1 } } } }), sec());
  check('buys with no sells is critical', levelOf(a, /nobody is selling/i) === 'critical');

  // The threshold must not fire on a tiny sample.
  const b = I.assess(result({ pool: { txns: { h24: { buys: 5, sells: 0, buyers: 5, sellers: 0 } } } }), sec());
  check('five buys is too small a sample to call it', levelOf(b, /nobody is selling/i) === null);

  // Twelve is the documented floor.
  const c = I.assess(result({ pool: { txns: { h24: { buys: 12, sells: 0, buyers: 12, sellers: 0 } } } }), sec());
  check('twelve buys with no sells does fire', levelOf(c, /nobody is selling/i) === 'critical');
}
{
  // Few addresses doing many trades is the wash-trading shape.
  const a = I.assess(result({ pool: { txns: { h24: { buys: 500, sells: 500, buyers: 20, sellers: 20 } } } }), sec());
  check('25 trades per address is flagged', levelOf(a, /concentrated in very few addresses/i) === 'warn');

  const b = I.assess(result({ pool: { txns: { h24: { buys: 500, sells: 500, buyers: 400, sellers: 350 } } } }), sec());
  check('ordinary trading is not flagged', levelOf(b, /concentrated in very few addresses/i) === null);

  // Too few addresses to judge at all.
  const c = I.assess(result({ pool: { txns: { h24: { buys: 10, sells: 2, buyers: 1, sellers: 1 } } } }), sec());
  check('a handful of traders is not judged for wash trading',
    levelOf(c, /concentrated in very few addresses/i) === null);
}
{
  const a = I.assess(result({ pool: { tvlUsd: 20000, fdvUsd: 900_000_000 } }), sec());
  check('a notional far above the liquidity is reported',
    titles(a).some((t) => /exceeds the liquidity/i.test(t)));
  const b = I.assess(result({ pool: { tvlUsd: 5_000_000, fdvUsd: 50_000_000 } }), sec());
  check('a sane ratio is not', !titles(b).some((t) => /exceeds the liquidity/i.test(t)));
}

/* ----------------------------------------------------------- not crying wolf */

suite('integrity — absent data');
{
  const bare = I.assess({ pool: { network: 'eth' }, poolType: 'cpmm', fees: {} }, null);
  check('no contract data and no pool data produces no findings', bare.findings.length === 0,
    JSON.stringify(titles(bare)));
  check('and does not throw', typeof bare.counts.critical === 'number');
  check('and the verdict is the neutral one',
    /nothing alarming/i.test(I.verdictFor(bare).headline));
}
{
  const a = I.assess(result({ pool: { txns: {} } }), sec());
  check('missing trade counts raise nothing about trading',
    !titles(a).some((t) => /selling|addresses/i.test(t)));
  const m = I.marketSignals(result({ pool: { txns: {} } }));
  check('and the signals are null rather than zero', m.perTrader === null && m.sellRatio === null);
}
{
  check('a concentrated-liquidity pool gets no exit quote, since the curve is unknown',
    I.exitCost(result({ poolType: 'cl' }), 10000) === null);
  check('a pool with no reserves gets none either',
    I.exitCost(result({ cross: { reserves: null } }), 10000) === null);
}

/* -------------------------------------------------------------- the verdict */

suite('integrity — the verdict never claims safety');
{
  const clean = I.assess(result(), sec());
  const v = I.verdictFor(clean);
  check('a clean result raises nothing', clean.findings.length === 0, JSON.stringify(titles(clean)));
  check('and the headline does not say safe', !/\bsafe\b/i.test(v.headline + ' ' + v.detail),
    v.headline + ' ' + v.detail);
  check('and it says what it is a statement about',
    /these checks|could be checked|not a verdict/i.test(v.headline + ' ' + v.detail));
}
{
  const two = I.assess(result(), sec({ is_honeypot: '1', hidden_owner: '1' }));
  check('two criticals read as several', /several serious/i.test(I.verdictFor(two).headline));
  const one = I.assess(result(), sec({ is_honeypot: '1' }));
  check('one critical reads as one', /^one serious/i.test(I.verdictFor(one).headline));
}
{
  const levels = ['critical', 'warn', 'info'];
  const a = I.assess(
    result({ pool: { createdAt: ago(2), lockedLiquidityPct: 0, tvlUsd: 10000, fdvUsd: 9e8 } }),
    sec({ is_mintable: '1', owner_address: '0xabc0000000000000000000000000000000000001',
          holder_count: '100', lp_holder_count: '1', is_open_source: '0',
          holders: [{ percent: '0.9' }] }));
  check('every finding uses a level the list renders',
    a.findings.every((f) => levels.includes(f.level)), JSON.stringify(a.findings.map((f) => f.level)));
  check('every finding has a title and a detail',
    a.findings.every((f) => f.title && f.detail && f.detail.length > 20));
  check('findings are ordered worst first',
    a.findings.every((f, i) => i === 0 ||
      levels.indexOf(a.findings[i - 1].level) <= levels.indexOf(f.level)));
}

/* ----------------------------------------------------------------- chains */

suite('integrity — chain support');
{
  check('ethereum maps to 1', I.CHAIN_IDS.eth === '1');
  check('base maps to 8453', I.CHAIN_IDS.base === '8453');
  check('solana uses a name, not a number', I.CHAIN_IDS.solana === 'solana');
  check('an unsupported chain is absent', I.CHAIN_IDS.osmosis === undefined);
  check('every id is a non-empty string',
    Object.values(I.CHAIN_IDS).every((v) => typeof v === 'string' && v.length > 0));
}

report();
