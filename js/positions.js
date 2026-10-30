/*
 * Find the liquidity positions an address actually holds.
 *
 * Read straight from the chain over public RPC, with no API key, no account and no library.
 * Everything is a plain eth_call, and calls are sent as JSON-RPC batches so a scan is a handful
 * of HTTP requests rather than hundreds.
 *
 * There are two kinds of position and they are found in completely different ways, which is the
 * thing that makes this harder than it first looks:
 *
 *   CONSTANT-PRODUCT pools issue a fungible ERC-20 LP token, so holding one is simply a
 *   balanceOf. Finding them means checking a list of candidate pools.
 *
 *   CONCENTRATED pools do not. A v3-style position is an NFT held by a position manager, with
 *   its range and liquidity stored against the token id. Finding them means asking the manager
 *   how many the address holds, then walking them.
 *
 * Checking balances alone would therefore miss most of the money: on Base the concentrated
 * pools hold several times what the v2-style ones do. Both paths are implemented.
 *
 * What this cannot see, stated because a position list that silently omits things is worse than
 * no list: anything staked into a farm or gauge (the LP token is held by the gauge, not by you),
 * anything inside a vault or auto-compounder, and any DEX whose position manager is not in the
 * table below.
 */
window.LP = window.LP || {};

LP.positions = (function () {
  const U = () => LP.util;

  /* Public RPCs, chosen because they answer browser requests with CORS headers. */
  const RPC = {
    base: 'https://mainnet.base.org',
    bsc: 'https://bsc-dataseed.binance.org',
    eth: 'https://ethereum-rpc.publicnode.com',
    arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
    optimism: 'https://optimism-rpc.publicnode.com',
    polygon_pos: 'https://polygon-bor-rpc.publicnode.com'
  };

  /*
   * Concentrated-liquidity position managers. Each holds positions as NFTs with the same
   * Uniswap v3 interface, which is why one decoder serves all of them.
   */
  const MANAGERS = {
    base: [
      { name: 'Uniswap v3', address: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1' },
      { name: 'Aerodrome Slipstream', address: '0x827922686190790b37229fd06084350E74485b72' }
    ],
    bsc: [
      { name: 'Uniswap v3', address: '0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613' },
      { name: 'PancakeSwap v3', address: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364' }
    ],
    eth: [
      { name: 'Uniswap v3', address: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' }
    ],
    arbitrum: [
      { name: 'Uniswap v3', address: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' }
    ],
    optimism: [
      { name: 'Uniswap v3', address: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' }
    ],
    polygon_pos: [
      { name: 'Uniswap v3', address: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' }
    ]
  };

  /* Function selectors. Hand-encoded because every one of these takes a single word. */
  const SEL = {
    balanceOf: '0x70a08231',
    totalSupply: '0x18160ddd',
    tokenOfOwnerByIndex: '0x2f745c59',
    positions: '0x99fbab88'
  };

  const MAX_NFTS = 60;          // a wallet, not a protocol treasury holding 120,000
  const MAX_POOLS = 240;        // candidate v2 pools to check per scan

  /* ------------------------------------------------------------------ encoding */

  const padAddr = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const padNum = (n) => BigInt(n).toString(16).padStart(64, '0');
  const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
  const toBig = (h) => { try { return BigInt('0x' + h); } catch { return 0n; } };

  /** Two's-complement int24, which is how ticks come back. */
  function toInt24(h) {
    const v = Number(BigInt('0x' + h.slice(-6)));
    return v >= 0x800000 ? v - 0x1000000 : v;
  }

  /* -------------------------------------------------------------------- rpc -- */

  /**
   * Send many eth_calls in one request.
   *
   * Public RPCs accept a JSON-RPC batch, which turns a scan of hundreds of pools into a few
   * HTTP round trips. Chunked, because a batch of several hundred is refused by some nodes.
   */
  async function batchCall(chain, calls, chunk = 20) {
    const url = RPC[chain];
    if (!url) throw new Error('No public RPC configured for ' + chain + '.');
    const out = new Array(calls.length).fill(null);

    for (let i = 0; i < calls.length; i += chunk) {
      const slice = calls.slice(i, i + chunk);
      const body = slice.map((c, j) => ({
        jsonrpc: '2.0', id: i + j, method: 'eth_call',
        params: [{ to: c.to, data: c.data }, 'latest']
      }));
      let res;
      try {
        res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body) });
      } catch (e) {
        throw new Error('Could not reach the ' + chain + ' RPC. ' + (e.message || ''));
      }
      if (!res.ok) throw new Error('The ' + chain + ' RPC returned HTTP ' + res.status + '.');
      const json = await res.json();

      /*
       * A batch normally answers with an array. A single object is an error for the whole
       * batch -- Base's public node allows 25 requests a second and counts each call in a
       * batch separately, so an oversized chunk comes back as one rate-limit object. Treating
       * that as data left every result null and looked like "no positions found", which is the
       * worst possible failure for this feature.
       */
      if (!Array.isArray(json)) {
        const msg = (json && json.error && json.error.message) || (json && json.message) || '';
        throw new Error('The ' + chain + ' RPC rejected the batch. ' + msg);
      }
      for (const r of json) {
        // A reverted call is information, not an error: it usually means "not that kind of pool".
        if (r && typeof r.id === 'number') out[r.id] = (r.result && r.result !== '0x') ? r.result : null;
      }
      // Stay under the per-second limit on the next chunk.
      if (i + chunk < calls.length) await new Promise((r) => setTimeout(r, 180));
    }
    return out;
  }

  /* --------------------------------------------- concentrated (NFT) positions */

  /**
   * Positions held in v3-style managers.
   *
   * Three rounds: how many, which ids, then what each one is. Positions with zero liquidity are
   * closed and are dropped — the NFT survives a withdrawal, so counting them would report
   * positions somebody has already exited.
   */
  async function scanConcentrated(chain, owner, onProgress, errors) {
    const managers = MANAGERS[chain] || [];
    if (!managers.length) return [];
    const found = [];

    for (const m of managers) {
      if (onProgress) onProgress('Checking ' + m.name + '…');
      let counts;
      try {
        counts = await batchCall(chain, [{ to: m.address, data: SEL.balanceOf + padAddr(owner) }]);
      } catch (e) {
        /*
         * Skipping quietly was a bug of exactly the kind this module is supposed to avoid: a
         * rate-limited RPC made the manager disappear, and the scan then reported "nothing
         * found" for an address that might hold a great deal. A manager that could not be
         * read is not a manager with no positions, and the difference is the whole point.
         */
        if (errors) errors.push(m.name + ' could not be read: ' + (e.message || e));
        continue;
      }
      const count = counts[0] ? Number(toBig(word(counts[0], 0))) : 0;
      if (!count) continue;

      const take = Math.min(count, MAX_NFTS);
      const idCalls = [];
      for (let i = 0; i < take; i++) {
        idCalls.push({ to: m.address, data: SEL.tokenOfOwnerByIndex + padAddr(owner) + padNum(i) });
      }
      const ids = (await batchCall(chain, idCalls))
        .map((h) => (h ? toBig(word(h, 0)) : null)).filter((v) => v !== null);

      const posCalls = ids.map((id) => ({ to: m.address, data: SEL.positions + padNum(id) }));
      const positions = await batchCall(chain, posCalls);

      positions.forEach((hex, i) => {
        if (!hex) return;
        const liquidity = toBig(word(hex, 7));
        if (liquidity === 0n) return;          // closed, the NFT just has not been burned
        found.push({
          kind: 'concentrated',
          dex: m.name,
          chain,
          tokenId: ids[i].toString(),
          token0: '0x' + word(hex, 2).slice(24),
          token1: '0x' + word(hex, 3).slice(24),
          feeTier: Number(toBig(word(hex, 4))) / 10000,
          tickLower: toInt24(word(hex, 5)),
          tickUpper: toInt24(word(hex, 6)),
          liquidity: liquidity.toString(),
          owedFees: (toBig(word(hex, 10)) > 0n || toBig(word(hex, 11)) > 0n)
        });
      });

      if (count > take) {
        found.push({ kind: 'truncated', dex: m.name, chain, total: count, shown: take });
      }
    }
    return found;
  }

  /* ----------------------------------------------- constant-product balances - */

  /*
   * Candidate pools for the LP-token sweep, from GeckoTerminal.
   *
   * DefiLlama identifies a pool by a UUID and never gives its on-chain address, so its universe
   * cannot be used here however convenient that would have been. GeckoTerminal returns real
   * addresses, twenty to a page, so a scan takes a few pages and caches them for the session.
   *
   * The 42-character filter is not pedantry: Uniswap v4 pools are identified by a 66-character
   * pool id rather than a contract address, and calling balanceOf on one is meaningless.
   */
  const poolCache = new Map();

  /*
   * Only a complete sweep is remembered.
   *
   * This used to cache whatever it had managed to fetch when a page failed, which turned one
   * rate-limited request into a permanently narrower search: every later scan of that chain
   * reused the short list, checked a third of the pools, and said nothing about why. It is
   * exactly the mistake the symbol cache made further down -- remember successes, never
   * failures -- so it gets the same rule, and a partial page now says so out loud instead of
   * quietly shrinking the search.
   */
  async function candidatePools(chain, pages = 3, errors) {
    if (poolCache.has(chain)) return poolCache.get(chain);
    const out = [];
    let complete = true;
    for (let page = 1; page <= pages; page++) {
      try {
        const res = await fetch('https://api.geckoterminal.com/api/v2/networks/' +
          encodeURIComponent(chain) + '/pools?page=' + page + '&sort=h24_volume_usd_desc',
          { headers: { accept: 'application/json' } });
        if (!res.ok) {
          complete = false;
          if (errors) {
            errors.push('The pool list stopped at page ' + page + ' (HTTP ' + res.status +
              '), so the LP sweep covered fewer pools than usual.');
          }
          break;
        }
        const j = await res.json();
        for (const r of (j.data || [])) {
          const a = r.attributes || {};
          // Only real ERC-20 contracts; a v4 pool id is 66 characters and has no balanceOf.
          if (typeof a.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a.address)) {
            out.push({ address: a.address, name: a.name, tvlUsd: parseFloat(a.reserve_in_usd) || 0 });
          }
        }
      } catch (e) {
        /*
         * GeckoTerminal sends no CORS header on a rejected request, so the browser rejects the
         * fetch outright and the 429 never arrives as a status. An opaque failure here is
         * therefore the rate limit far more often than it is the network.
         */
        complete = false;
        if (errors) {
          errors.push('The pool list could not be read past page ' + page +
            ', which is usually the data provider\'s rate limit. The LP sweep covered fewer ' +
            'pools than usual; try again in a minute for the full set.');
        }
        break;
      }
      /*
       * Spacing, not a rate. Measured against the live endpoint, three to five requests get
       * through from a rested start and the gap between them barely matters, so this delay is
       * not what keeps the scan inside the limit -- using few pages is. It is kept so a scan
       * does not fire its pages as one burst.
       */
      await new Promise((r) => setTimeout(r, 1100));
    }
    if (complete) poolCache.set(chain, out);
    return out;
  }

  /**
   * LP token balances across the busiest pools on the chain.
   *
   * There is no index of "which pools does this address hold", so this checks candidates and
   * reports how many it checked. A position in a pool outside the busiest few dozen will not be
   * found, which the UI says rather than implying the list is complete.
   */
  async function scanLpTokens(chain, owner, onProgress, errors) {
    const candidates = await candidatePools(chain, 3, errors);
    if (!candidates.length) return { found: [], checked: 0 };

    if (onProgress) onProgress('Checking ' + candidates.length + ' pools for LP tokens…');
    const results = await batchCall(chain,
      candidates.map((p) => ({ to: p.address, data: SEL.balanceOf + padAddr(owner) })));

    const found = [];
    results.forEach((hex, i) => {
      if (!hex) return;                       // reverted: a concentrated pool, not an LP token
      const bal = toBig(word(hex, 0));
      if (bal === 0n) return;
      const p = candidates[i];
      found.push({ kind: 'lp-token', chain, pool: p.address, symbol: p.name,
                   balance: bal.toString(), tvlUsd: p.tvlUsd });
    });
    return { found, checked: candidates.length };
  }

  /* ---------------------------------------------------------------- symbols */

  const symbolCache = new Map();

  /**
   * Resolve token symbols, because a position list of raw addresses is unreadable.
   *
   * symbol() returns a string, which ABI-encodes as offset + length + data. A handful of older
   * tokens (MKR among them) declare it as bytes32 instead and return the characters padded in
   * one word, so both shapes are decoded; anything else falls back to a short address.
   */
  async function resolveSymbols(chain, addresses) {
    const want = [...new Set(addresses.map((a) => String(a).toLowerCase()))]
      .filter((a) => /^0x[0-9a-f]{40}$/.test(a) && !symbolCache.has(chain + ':' + a));
    if (want.length) {
      let res = [];
      try {
        res = await batchCall(chain, want.map((a) => ({ to: a, data: '0x95d89b41' })));
      } catch (e) { res = want.map(() => null); }

      /*
       * Only a real symbol is remembered. Caching the address fallback would make one
       * transient failure permanent: the scan rate-limits on the symbol batch, every token
       * gets memoised as "0x4200...0006", and the filter above then skips re-resolving them
       * for the rest of the session. The list looked broken long after the cause had passed.
       */
      want.forEach((addr, i) => {
        const sym = decodeSymbol(res[i]);
        if (sym) symbolCache.set(chain + ':' + addr, sym);
      });
    }
    const out = {};
    for (const a of addresses) {
      const k = chain + ':' + String(a).toLowerCase();
      out[String(a).toLowerCase()] = symbolCache.get(k) || shortAddr(a);
    }
    return out;
  }

  const shortAddr = (a) => String(a).slice(0, 6) + '…' + String(a).slice(-4);

  function decodeSymbol(hex) {
    if (!hex || hex.length < 66) return null;
    const body = hex.slice(2);
    try {
      // Standard string: first word is the offset, then length, then the bytes.
      const offset = Number(BigInt('0x' + body.slice(0, 64)));
      if (offset === 32 && body.length >= 128) {
        const len = Number(BigInt('0x' + body.slice(64, 128)));
        if (len > 0 && len <= 32) {
          const chars = body.slice(128, 128 + len * 2);
          const s = hexToUtf8(chars);
          if (s) return s;
        }
      }
      // bytes32: the characters sit in the first word, right-padded with zeros.
      const s32 = hexToUtf8(body.slice(0, 64).replace(/(00)+$/, ''));
      return s32 || null;
    } catch (e) { return null; }
  }

  function hexToUtf8(h) {
    if (!h) return null;
    let s = '';
    for (let i = 0; i + 1 < h.length; i += 2) {
      const c = parseInt(h.slice(i, i + 2), 16);
      if (c === 0) continue;
      if (c < 32 || c > 126) return null;      // not a printable ticker; treat as undecodable
      s += String.fromCharCode(c);
    }
    return s.trim() || null;
  }

  /* -------------------------------------------------------------------- scan */

  /**
   * Everything findable for one address on one chain.
   * @returns { positions, truncated, lpChecked, chain, errors }
   */
  async function scan(chain, owner, onProgress) {
    const errors = [];
    let concentrated = [];
    let lp = { found: [], checked: 0 };

    try {
      concentrated = await scanConcentrated(chain, owner, onProgress, errors);
    } catch (e) { errors.push('Concentrated positions: ' + (e.message || e)); }

    try {
      lp = await scanLpTokens(chain, owner, onProgress, errors);
    } catch (e) { errors.push('LP tokens: ' + (e.message || e)); }

    // Name the tokens, so the list reads as pairs rather than as hex.
    const live = concentrated.filter((p) => p.kind === 'concentrated');
    if (live.length) {
      try {
        if (onProgress) onProgress('Naming tokens…');
        const syms = await resolveSymbols(chain,
          live.flatMap((p) => [p.token0, p.token1]));
        for (const p of live) {
          p.symbol0 = syms[p.token0.toLowerCase()];
          p.symbol1 = syms[p.token1.toLowerCase()];
          p.pair = p.symbol0 + ' / ' + p.symbol1;
        }
      } catch (e) { /* unnamed positions are still worth showing */ }
    }

    const truncated = concentrated.filter((p) => p.kind === 'truncated');
    return {
      chain,
      positions: concentrated.filter((p) => p.kind !== 'truncated').concat(lp.found),
      truncated,
      lpChecked: lp.checked,
      errors
    };
  }

  const chains = () => Object.keys(RPC);

  return { scan, scanConcentrated, scanLpTokens, candidatePools, resolveSymbols, decodeSymbol, chains, RPC, MANAGERS,
           MAX_NFTS, MAX_POOLS, _enc: { padAddr, padNum, word, toInt24, toBig } };
})();
