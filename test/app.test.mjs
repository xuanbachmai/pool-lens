/*
 * Tests for the layers that aren't pure maths: URL parsing, fee profiles, the DefiLlama
 * client, and the position/strategy logic. These are where a bug is a wrong label or a
 * silently-dropped filter rather than a wrong number, so they need different assertions.
 */
import { loadLP, suite, check, near, report } from './harness.mjs';

const LP = loadLP(['util', 'parse', 'fees', 'backtest', 'swap', 'analyze', 'model', 'llama',
                   'execution', 'position', 'strategy']);
const P = LP.parse, F = LP.fees, L = LP.llama, A = LP.analyze;

/* ------------------------------------------------------------- URL parsing */
suite('parse.parseInput');
const cases = [
  ['uniswap v3 pool', 'https://app.uniswap.org/explore/pools/ethereum/0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',
    'pool', '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', 'eth'],
  ['dexscreener', 'https://dexscreener.com/ethereum/0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc',
    'pool', '0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc', 'eth'],
  ['geckoterminal base', 'https://www.geckoterminal.com/base/pools/0x1131DB5977242a03eBeaD1aCD18F80A9A29e5922',
    'pool', '0x1131db5977242a03ebead1acd18f80a9a29e5922', 'base'],
  ['pancake with chain param', 'https://pancakeswap.finance/info/v3/pairs/0x36696169c63e42cd08ce11f5deebbcebae652050?chain=bsc',
    'pool', '0x36696169c63e42cd08ce11f5deebbcebae652050', 'bsc'],
  ['balancer pool id truncated to address', 'https://app.balancer.fi/pools/ethereum/v2/0x32296969ef14eb0c6d29669c550d4a0449130230000200000000000000000080',
    'pool', '0x32296969ef14eb0c6d29669c550d4a0449130230', 'eth'],
  ['pendle chainId param', 'https://app.pendle.finance/trade/pools/0x1234567890abcdef1234567890abcdef12345678/zap/in?chainId=42161',
    'pool', '0x1234567890abcdef1234567890abcdef12345678', 'arbitrum'],
  ['aerodrome host implies base', 'https://aerodrome.finance/deposit?token0=0x4200000000000000000000000000000000000006&token1=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    'token', null, 'base'],
  ['uniswap token page', 'https://app.uniswap.org/explore/tokens/ethereum/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    'token', null, 'eth'],
  ['solana base58 via orca', 'https://www.orca.so/pools/HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ',
    'pool', 'HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ', 'solana'],
  ['bare evm address', '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',
    'pool', '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', null],
  ['curve name-only url is unresolvable', 'https://curve.finance/dex/ethereum/pools/factory-stable-ng-42/deposit',
    'none', null, null],
  ['garbage', 'not a url at all', 'none', null, null]
];
for (const [label, url, kind, addr, chain] of cases) {
  const r = P.parseInput(url);
  check(label + ' -> kind ' + kind, r.kind === kind, 'got ' + r.kind);
  if (addr) check(label + ' -> address', r.address === addr, 'got ' + r.address);
  if (chain) check(label + ' -> chain ' + chain, r.chain === chain, 'got ' + r.chain);
}
check('empty input is handled', P.parseInput('').kind === 'none');
check('null input is handled', P.parseInput(null).kind === 'none');
check('whitespace only is handled', P.parseInput('   ').kind === 'none');

/* -------------------------------------------------------------- fee profiles */
suite('fees.resolve');
const feeCase = (dexId, name, feePercent) => F.resolve({ dexId, name, feePercent });
check('v3 fee read from the API', feeCase('uniswap_v3', 'WETH / USDC 0.05%', 0.05).confidence === 'api');
check('v3 fee parsed from the name when API is null',
  feeCase('uniswap_v3', 'WETH / USDC 0.3%', null).confidence === 'name');
near('and the parsed value is right', feeCase('uniswap_v3', 'WETH / USDC 0.3%', null).fee, 0.3);
check('v2 falls back to the DEX default',
  feeCase('uniswap_v2', 'WETH / USDC', null).confidence === 'known');
near('v2 default is 0.30%', feeCase('uniswap_v2', 'WETH / USDC', null).fee, 0.30);
check('v2 is constant product', feeCase('uniswap_v2', 'WETH / USDC', null).type === 'cpmm');
check('v3 is concentrated', feeCase('uniswap_v3', 'A / B 0.05%', 0.05).type === 'cl');
check('slipstream is concentrated, not CPMM',
  feeCase('aerodrome-slipstream-3', 'SOL / USDC', 0.035).type === 'cl');
check('and still routes fees away from LPs',
  feeCase('aerodrome-slipstream-3', 'SOL / USDC', 0.035).lpShare === 0);
check('basic aerodrome is CPMM', feeCase('aerodrome-basic', 'A / B', null).type === 'cpmm');
check('ve(3,3) is flagged', feeCase('aerodrome-basic', 'A / B', null).isVeModel === true);
check('curve is stableswap', feeCase('curve', 'DAI / USDC / USDT', null).type === 'stable');
check('curve takes an admin cut', feeCase('curve', 'x', null).lpShare === 0.5);
check('pancake v2 diverts most of the fee',
  feeCase('pancakeswap_v2', 'A / B', null).lpShare < 0.7);
check('pendle is its own type', feeCase('pendle', 'PT / SY', null).type === 'pendle');
check('unknown DEX with an API fee is treated as concentrated',
  feeCase('brand-new-dex', 'A / B', 0.25).type === 'cl');
const assumed = feeCase('totally-unknown', 'A / B', null);
check('unknown DEX with no fee is flagged as assumed', assumed.confidence === 'assumed');
check('and says so in the notes', assumed.notes.some((n) => /assumed/i.test(n)));

/* ---------------------------------------------------------- llama client */
suite('llama.rewardShare');
const row = (apy, apyBase, apyReward) => L.shape({ apy, apyBase, apyReward, pool: 'x',
  chain: 'Ethereum', project: 'p', symbol: 's', tvlUsd: 1e6, underlyingTokens: [] });
near('all emissions is 1', L.rewardShare(row(100, 0, 100)), 1, 1e-12);
near('no emissions is 0', L.rewardShare(row(100, 100, 0)), 0, 1e-12);
near('half and half', L.rewardShare(row(20, 10, 10)), 0.5, 1e-12);
check('zero APY gives null, not NaN', L.rewardShare(row(0, 0, 0)) === null);
check('a reward with a null base still resolves',
  Math.abs(L.rewardShare(L.shape({ apy: 50, apyBase: null, apyReward: 50, underlyingTokens: [] })) - 1) < 1e-9);

suite('llama.shape');
const s1 = L.shape({ apy: 12, apyBase: null, apyReward: null, underlyingTokens: ['0xAbC', '0xDeF'],
  exposure: 'single', ilRisk: 'no', stablecoin: true, poolMeta: '0.05%', pool: 'id', chain: 'Base',
  project: 'proj', symbol: 'SYM', tvlUsd: 123 });
check('underlying token addresses are lowercased', s1.underlying.join() === '0xabc,0xdef');
check('booleans survive', s1.stablecoin === true);
check('meta survives', s1.meta === '0.05%');
check('missing apyBase does not become 0 silently', s1.apyBase === null || s1.apyBase === 12);

/* ---------------------------------------------------- position performance */
suite('position.performance');
const mkBars = (n, fn) => Array.from({ length: n }, (_, i) => ({
  t: Date.UTC(2026, 0, 1 + i), c: fn(i), v: 1e6
}));
const bars = mkBars(60, (i) => 100 * (1 + 0.005 * i));   // steady climb to ~130
const baseResult = {
  pool: { basePriceInQuote: bars[bars.length - 1].c, tvlUsd: 1e7, baseSymbol: 'A', quoteSymbol: 'B',
          volume: { h1: 1e5, h6: 6e5, h24: 3e6 }, quotePriceUsd: 1 },
  fees: { feePct: 0.3, lpShare: 1, dailyYield: 0.0003, aprFullRange: 10 },
  assumptions: { positionUsd: 10000, holdDays: 30, rangePct: 20 },
  isCl: true,
  stats: { bars, sdDaily: 0.01, volAnnual: 0.19, netRatio: 1.3, chop: 0.1, days: 60 },
  vr: { h24: 0.3, benchmark: 0.25 },
  range: { bars: bars.slice(-30) }
};
const pos = { sizeUsd: 10000, entryPrice: bars[30].c,
  entryDate: new Date(bars[30].t).toISOString().slice(0, 10), rangePct: 5 };
const perf = LP.position.performance(baseResult, pos);
check('replays against real bars', perf.replayed === true);
check('days held is positive', perf.daysHeld > 0);
check('a 5% range broke on a 15% climb', perf.inRangeNow === false);
check('bounds are around the entry price', perf.bounds.lo < pos.entryPrice && perf.bounds.hi > pos.entryPrice);
check('net is fees plus IL',
  Math.abs(perf.netPct - (perf.feesPct + perf.ilPct)) < 1e-9);
check('IL is a loss on a one-way move', perf.ilPct < 0);

const futurePos = Object.assign({}, pos, { entryDate: '2099-01-01' });
const futurePerf = LP.position.performance(baseResult, futurePos);
check('an entry date past the data does not crash', futurePerf !== null);
check('and reports it was not replayed', futurePerf.replayed === false);

/* --------------------------------------------------------- strategy ranking */
suite('strategy.build');
const built = LP.strategy.build(baseResult, pos, perf);
check('every strategy scores within 0..100',
  built.every((s) => s.score >= 0 && s.score <= 100),
  JSON.stringify(built.map((s) => [s.key, s.score])));
check('sorted by score descending',
  built.every((s, i) => i === 0 || s.score <= built[i - 1].score));
check('out of range puts re-centring at the top', built[0].key === 'recentre');
check('out of range does not advise holding',
  built.find((s) => s.key === 'hold').verdict === 'avoid');
check('every strategy carries numbers or explains why not',
  built.every((s) => Array.isArray(s.numbers)));
check('each has a verdict from the known set',
  built.every((s) => ['do', 'consider', 'avoid', 'info'].includes(s.verdict)));

const inRangePos = Object.assign({}, pos, { rangePct: 60 });
const inRangePerf = LP.position.performance(baseResult, inRangePos);
const inRangeBuilt = LP.strategy.build(baseResult, inRangePos, inRangePerf);
check('an in-range position stops advising a re-centre',
  inRangeBuilt.findIndex((s) => s.key === 'recentre') > 2);
check('all scores stay bounded',
  inRangeBuilt.every((s) => s.score >= 0 && s.score <= 100));

/*
 * The ranking has to separate the two market regimes the OTS notes care about: LPs win in
 * chop and lose in sustained one-way moves. baseResult is a steady +30% climb at 10% chop,
 * so exiting should outrank holding there -- and the reverse on a choppy pair.
 */
suite('strategy regime sensitivity');
const trendTop = inRangeBuilt.map((s) => s.key);
check('a trending pair ranks exiting above holding',
  trendTop.indexOf('exit') < trendTop.indexOf('hold'),
  trendTop.join(' > '));

const choppyBars = mkBars(60, (i) => 100 * (1 + 0.06 * Math.sin(i / 4)));
const choppyResult = Object.assign({}, baseResult, {
  pool: Object.assign({}, baseResult.pool, { basePriceInQuote: choppyBars[choppyBars.length - 1].c }),
  stats: { bars: choppyBars, sdDaily: 0.04, volAnnual: 0.76, netRatio: 1.01, chop: 0.95, days: 60 },
  range: { bars: choppyBars.slice(-30) }
});
const choppyPos = { sizeUsd: 10000, entryPrice: choppyBars[30].c,
  entryDate: new Date(choppyBars[30].t).toISOString().slice(0, 10), rangePct: 30 };
const choppyPerf = LP.position.performance(choppyResult, choppyPos);
const choppyBuilt = LP.strategy.build(choppyResult, choppyPos, choppyPerf);
const choppyTop = choppyBuilt.map((s) => s.key);
check('a choppy pair ranks holding first', choppyTop[0] === 'hold', choppyTop.join(' > '));
check('and demotes exiting below holding',
  choppyTop.indexOf('hold') < choppyTop.indexOf('exit'), choppyTop.join(' > '));
check('choppy scores stay bounded too',
  choppyBuilt.every((s) => s.score >= 0 && s.score <= 100));

suite('strategy.dailyYield');
check('out of range earns nothing',
  LP.strategy.dailyYield(baseResult, pos, perf).yieldPerDay === 0);
check('in range earns something',
  LP.strategy.dailyYield(baseResult, inRangePos, inRangePerf).yieldPerDay > 0);
check('no position at all still returns a number',
  Number.isFinite(LP.strategy.dailyYield(baseResult, null, null).yieldPerDay));

suite('strategy.hedgeSize');
const h = LP.strategy.hedgeSize(Object.assign({}, baseResult, { isCl: false }), pos);
near('full range delta is exactly half the position', h.fracOfPosition, 0.5, 1e-9);
const hcl = LP.strategy.hedgeSize(baseResult, pos);
check('a concentrated range has a different delta', Math.abs(hcl.fracOfPosition - 0.5) > 1e-6);
check('delta is positive and below 1', hcl.fracOfPosition > 0 && hcl.fracOfPosition < 1);

suite('strategy.alerts');
const alerts = LP.strategy.alerts(baseResult, pos, perf);
check('range alerts exist when there is a range',
  alerts.some((a) => a.key === 'range-lo') && alerts.some((a) => a.key === 'range-hi'));
check('the broken side is marked as fired',
  alerts.find((a) => a.key === 'range-hi').fired === true);
check('the intact side is not', alerts.find((a) => a.key === 'range-lo').fired === false);
check('every alert has a title and detail',
  alerts.every((a) => a.title && a.detail));
const noPosAlerts = LP.strategy.alerts(baseResult, null, null);
check('alerts still generate with no position', noPosAlerts.length > 0);
check('but no range alerts without a range',
  !noPosAlerts.some((a) => a.key === 'range-lo'));

suite('model.paramsFrom robustness');
check('a result with no pool does not throw',
  Number.isFinite(LP.model.paramsFrom({}).V));
check('a pool with no volume does not throw',
  Number.isFinite(LP.model.paramsFrom({ pool: { tvlUsd: 1 } }).V));
check('a result with no fees defaults the LP share to 1',
  LP.model.paramsFrom({ pool: { volume: {} } }).s === 1);
check('a result with no assumptions still has a hold period',
  LP.model.paramsFrom({ pool: { volume: {} } }).T === 30);
check('stats without a bars array does not throw',
  LP.model.paramsFrom({ pool: { volume: {} }, stats: {} }).bars === null);
check('evaluate survives those params',
  Number.isFinite(LP.model.evaluate(LP.model.paramsFrom({})).netPct));

report();
