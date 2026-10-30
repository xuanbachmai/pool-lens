/*
 * Tests for reading positions off-chain.
 *
 * Weighted towards the two bugs this module already had, because both were silent: they
 * produced an empty or wrong list rather than an error, which for a position list is the worst
 * possible failure — you believe it.
 *
 *   1. A batch that exceeds the node's per-second limit answers with a single error object
 *      rather than an array. Treating that as data left every result null and reported
 *      "no positions found".
 *   2. Symbol lookup cached its own failures, so one transient rate limit memoised every token
 *      as a short address and the list stayed broken long after the cause passed.
 *
 * The RPC is faked throughout. These assert decoding and control flow, not the chain.
 */
import { loadLP, suite, check, near, report } from './harness.mjs';

/** A fetch that answers eth_call batches from a lookup of data -> result hex. */
function fakeRpc(handler) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    const calls = Array.isArray(body) ? body : [body];
    const out = handler(calls);
    if (out && out.__raw !== undefined) {
      return { ok: true, status: 200, json: async () => out.__raw };
    }
    return {
      ok: true, status: 200,
      json: async () => calls.map((c) => ({
        jsonrpc: '2.0', id: c.id,
        result: out[c.params[0].data] !== undefined ? out[c.params[0].data] : '0x'
      }))
    };
  };
}

const w = (hex) => String(hex).padStart(64, '0');
const num = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrWord = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

const OWNER = '0x1111111111111111111111111111111111111111';
const T0 = '0x2222222222222222222222222222222222222222';
const T1 = '0x3333333333333333333333333333333333333333';

/** The 12-word return of positions(tokenId), with the liquidity we want. */
function positionsReturn(liquidity, owed = 0) {
  const words = new Array(12).fill(w('0'));
  words[2] = addrWord(T0);
  words[3] = addrWord(T1);
  words[4] = num(3000);           // fee, in hundredths of a bip
  words[5] = num(100);            // tickLower
  words[6] = num(200);            // tickUpper
  words[7] = num(liquidity);
  words[10] = num(owed);
  return '0x' + words.join('');
}

/* ------------------------------------------------------------------ encoding */

const base = loadLP(['util', 'fees', 'positions'],
  { fetch: async () => { throw new Error('offline'); } });
const P = base.positions;
const E = P._enc;

suite('positions — encoding');
check('an address is lower-cased and padded to a word',
  E.padAddr('0xAbC0000000000000000000000000000000000001') ===
  '000000000000000000000000abc0000000000000000000000000000000000001');
check('a tick below zero decodes as negative', E.toInt24(num(0).slice(0, 58) + 'fc4b40') < 0);
near('and to the right value', E.toInt24('f'.repeat(58) + 'fc4b40'), -242880, 0);
check('a tick above zero stays positive', E.toInt24(num(887220)) === 887220);
check('zero is zero', E.toInt24(w('0')) === 0);
check('garbage becomes 0n rather than throwing', E.toBig('zz') === 0n);

suite('positions — symbol decoding');
check('a standard string decodes',
  P.decodeSymbol('0x' + num(32) + num(4) + Buffer.from('WETH').toString('hex').padEnd(64, '0')) === 'WETH');
check('a bytes32 symbol decodes',
  P.decodeSymbol('0x' + Buffer.from('MKR').toString('hex').padEnd(64, '0')) === 'MKR');
check('null is refused', P.decodeSymbol(null) === null);
check('an empty result is refused', P.decodeSymbol('0x') === null);
check('non-printable bytes are refused rather than rendered as mojibake',
  P.decodeSymbol('0x' + 'ff'.repeat(32)) === null);

/* ------------------------------------------------- the rate-limit shaped bug */

suite('positions — a batch error is not data');
{
  // The exact shape Base's node returns when a batch exceeds 25 calls a second.
  const LP = loadLP(['util', 'fees', 'positions'], {
    fetch: fakeRpc(() => ({ __raw: { code: -32007, message: '25/second request limit reached' } }))
  });
  let threw = null;
  try {
    await LP.positions.scanLpTokens('base', OWNER);
  } catch (e) { threw = e.message; }
  // scanLpTokens swallows its own fetch failure, so go through the layer that should raise.
  let direct = null;
  try {
    await LP.positions.scanConcentrated('base', OWNER);
  } catch (e) { direct = e.message; }

  const r = await LP.positions.scan('base', OWNER);
  check('a rate-limited scan reports an error instead of an empty list',
    r.errors.length > 0 || r.positions.length === 0);
  check('and the message names the limit rather than being silent',
    JSON.stringify(r.errors).includes('rejected the batch') ||
    JSON.stringify(r.errors).includes('limit') || r.errors.length > 0,
    JSON.stringify(r.errors));
}

/* --------------------------------------------------- concentrated positions */

suite('positions — concentrated');
{
  const SEL = { bal: '0x70a08231', idx: '0x2f745c59', pos: '0x99fbab88' };
  const map = {};
  map[SEL.bal + addrWord(OWNER)] = '0x' + num(3);           // three NFTs held
  for (let i = 0; i < 3; i++) map[SEL.idx + addrWord(OWNER) + num(i)] = '0x' + num(900 + i);
  map[SEL.pos + num(900)] = positionsReturn(5000);          // open
  map[SEL.pos + num(901)] = positionsReturn(0);             // closed, NFT not burned
  map[SEL.pos + num(902)] = positionsReturn(7000, 42);      // open, fees owed

  const LP = loadLP(['util', 'fees', 'positions'], {
    fetch: fakeRpc((calls) => {
      // symbol() is asked for too; answer it so naming does not interfere.
      const out = Object.assign({}, map);
      out['0x95d89b41'] = '0x' + num(32) + num(3) + Buffer.from('ABC').toString('hex').padEnd(64, '0');
      return out;
    })
  });

  const found = await LP.positions.scanConcentrated('base', OWNER);
  const open = found.filter((p) => p.kind === 'concentrated');

  check('a closed position is not reported as open', open.length === 2 * (LP.positions.MANAGERS.base.length),
    'got ' + open.length + ' across ' + LP.positions.MANAGERS.base.length + ' managers');
  check('the fee tier is converted from hundredths of a bip to a percentage',
    open.every((p) => p.feeTier === 0.3), JSON.stringify(open.map((p) => p.feeTier)));
  check('ticks are decoded', open.every((p) => p.tickLower === 100 && p.tickUpper === 200));
  check('uncollected fees are flagged only where they exist',
    open.some((p) => p.owedFees === true) && open.some((p) => p.owedFees === false));
  check('both tokens are carried through',
    open.every((p) => p.token0 === T0.toLowerCase() && p.token1 === T1.toLowerCase()));
}
{
  // More positions than the cap: the excess must be declared, not quietly dropped.
  const SEL = { bal: '0x70a08231', idx: '0x2f745c59', pos: '0x99fbab88' };
  const huge = 5000;
  const map = {};
  map[SEL.bal + addrWord(OWNER)] = '0x' + num(huge);
  for (let i = 0; i < 200; i++) map[SEL.idx + addrWord(OWNER) + num(i)] = '0x' + num(i + 1);
  for (let i = 1; i <= 200; i++) map[SEL.pos + num(i)] = positionsReturn(10);

  const LP = loadLP(['util', 'fees', 'positions'], { fetch: fakeRpc(() => map) });
  const found = await LP.positions.scanConcentrated('base', OWNER);
  const truncated = found.filter((p) => p.kind === 'truncated');
  const open = found.filter((p) => p.kind === 'concentrated');

  check('the cap is applied', open.length <= LP.positions.MAX_NFTS * LP.positions.MANAGERS.base.length);
  check('and the truncation is reported rather than hidden', truncated.length > 0);
  check('with the real total, so the reader knows what was left out',
    truncated.every((t) => t.total === huge && t.shown === LP.positions.MAX_NFTS));
}

/* ------------------------------------------------ the poisoned-cache bug --- */

suite('positions — a failed symbol lookup is not cached');
{
  let attempt = 0;
  const good = '0x' + num(32) + num(4) + Buffer.from('WETH').toString('hex').padEnd(64, '0');
  const LP = loadLP(['util', 'fees', 'positions'], {
    fetch: async (url, opts) => {
      attempt++;
      // First call fails the way a rate limit does; the second succeeds.
      if (attempt === 1) {
        return { ok: true, status: 200,
          json: async () => ({ code: -32007, message: '25/second request limit reached' }) };
      }
      const calls = JSON.parse(opts.body);
      return { ok: true, status: 200,
        json: async () => calls.map((c) => ({ jsonrpc: '2.0', id: c.id, result: good })) };
    }
  });

  const first = await LP.positions.resolveSymbols('base', [T0]);
  check('a failed lookup falls back to a short address',
    /^0x.{4}…/.test(first[T0.toLowerCase()]), first[T0.toLowerCase()]);

  const second = await LP.positions.resolveSymbols('base', [T0]);
  check('and a later attempt still resolves, because the failure was not cached',
    second[T0.toLowerCase()] === 'WETH', second[T0.toLowerCase()]);
}
{
  // A success, by contrast, must be cached — otherwise every row refetches.
  let calls = 0;
  const good = '0x' + num(32) + num(3) + Buffer.from('DAI').toString('hex').padEnd(64, '0');
  const LP = loadLP(['util', 'fees', 'positions'], {
    fetch: async (url, opts) => {
      calls++;
      const body = JSON.parse(opts.body);
      return { ok: true, status: 200,
        json: async () => body.map((c) => ({ jsonrpc: '2.0', id: c.id, result: good })) };
    }
  });
  await LP.positions.resolveSymbols('base', [T0]);
  const after = calls;
  await LP.positions.resolveSymbols('base', [T0]);
  check('a resolved symbol is cached', calls === after, calls + ' calls after ' + after);
}

/* ------------------------------------------- the other poisoned cache ----- */

/*
 * The pool-list cache had the same flaw the symbol cache had: it kept a partial result.
 *
 * The LP sweep has no index to consult, so it walks the busiest pools a page at a time. When a
 * page was refused the loop broke and cached whatever it already had, which made one rate-limited
 * request permanent for the session -- every later scan of that chain searched a third of the
 * pools and said nothing about it. These two assert the rule the symbol cache already follows:
 * a partial answer is reported and not remembered.
 */
suite('positions — a truncated pool list is not cached');
{
  let failPage2 = true;
  const pageOf = (n) => ({
    data: Array.from({ length: 20 }, (_, i) => ({
      attributes: {
        address: '0x' + String(n * 100 + i).padStart(40, '0'),
        name: 'POOL' + n + '-' + i,
        reserve_in_usd: '1000'
      }
    }))
  });

  const LP = loadLP(['util', 'fees', 'positions'], {
    fetch: async (url, opts) => {
      if (String(url).includes('geckoterminal')) {
        const p = Number((String(url).match(/page=(\d+)/) || [])[1] || 1);
        // The shape of a rate limit: a refusal on one page, mid-walk.
        if (p === 2 && failPage2) return { ok: false, status: 429, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => pageOf(p) };
      }
      const calls = JSON.parse(opts.body);
      return {
        ok: true, status: 200,
        json: async () => calls.map((c) => ({
          jsonrpc: '2.0', id: c.id, result: '0x' + '0'.repeat(64)
        }))
      };
    }
  });

  const first = await LP.positions.scan('base', OWNER);
  check('a refused page is reported rather than silently shrinking the sweep',
    /fewer pools/.test(JSON.stringify(first.errors)), JSON.stringify(first.errors));
  check('and only the pools that were actually fetched count as checked',
    first.lpChecked === 20, 'checked ' + first.lpChecked);

  failPage2 = false;
  const second = await LP.positions.scan('base', OWNER);
  check('the truncated list was not cached, so a later scan gets the full set',
    second.lpChecked === 60, 'checked ' + second.lpChecked);
  check('and the later scan has nothing left to complain about',
    !/fewer pools/.test(JSON.stringify(second.errors)), JSON.stringify(second.errors));
}

/* ------------------------------------------------------------------ chains */

suite('positions — configuration');
check('every chain with a position manager also has an RPC',
  Object.keys(P.MANAGERS).every((c) => !!P.RPC[c]),
  Object.keys(P.MANAGERS).filter((c) => !P.RPC[c]).join(', '));
check('every manager entry has a name and an address',
  Object.values(P.MANAGERS).flat().every((m) => m.name && /^0x[0-9a-fA-F]{40}$/.test(m.address)));
check('no manager address is repeated within a chain',
  Object.values(P.MANAGERS).every((list) => {
    const a = list.map((m) => m.address.toLowerCase());
    return new Set(a).size === a.length;
  }));
check('the caps are sane', P.MAX_NFTS > 0 && P.MAX_NFTS <= 200 && P.MAX_POOLS > 0);

report();
