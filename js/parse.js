/* Turn a pasted DEX URL (or bare address) into something we can look up. */
window.LP = window.LP || {};

LP.parse = (function () {
  /*
   * Chain aliases seen in DEX front-end URLs -> GeckoTerminal network id.
   * The hint is only used to disambiguate look-up candidates, so an unknown
   * chain degrades to "rank by reserve size" rather than failing.
   */
  const CHAINS = {
    ethereum: 'eth', eth: 'eth', mainnet: 'eth', 'ethereum-mainnet': 'eth', homestead: 'eth',
    arbitrum: 'arbitrum', arb: 'arbitrum', 'arbitrum-one': 'arbitrum', arbitrum_one: 'arbitrum', 42161: 'arbitrum',
    optimism: 'optimism', op: 'optimism', 'optimism-mainnet': 'optimism',
    base: 'base',
    polygon: 'polygon_pos', matic: 'polygon_pos', polygon_pos: 'polygon_pos',
    bsc: 'bsc', bnb: 'bsc', binance: 'bsc', 'bnb-chain': 'bsc', bnbchain: 'bsc',
    avalanche: 'avax', avax: 'avax',
    fantom: 'ftm', ftm: 'ftm', sonic: 'sonic',
    gnosis: 'xdai', xdai: 'xdai',
    celo: 'celo', moonbeam: 'glmr', cronos: 'cro', metis: 'metis', aurora: 'aurora',
    zksync: 'zksync', 'zksync-era': 'zksync', zkevm: 'polygon-zkevm', 'polygon-zkevm': 'polygon-zkevm',
    linea: 'linea', scroll: 'scroll', blast: 'blast', mantle: 'mantle', mode: 'mode',
    berachain: 'berachain', bera: 'berachain',
    hyperevm: 'hyperevm', hyperliquid: 'hyperevm',
    monad: 'monad', unichain: 'unichain', ink: 'ink', taiko: 'taiko',
    zora: 'zora-network', worldchain: 'world-chain', 'world-chain': 'world-chain',
    soneium: 'soneium', abstract: 'abstract', fraxtal: 'fraxtal', plasma: 'plasma', katana: 'katana',
    kava: 'kava', pulsechain: 'pulsechain', ronin: 'ronin', tron: 'tron',
    solana: 'solana', sol: 'solana',
    sui: 'sui-network', 'sui-network': 'sui-network',
    aptos: 'aptos',
    sei: 'sei-v2', 'sei-network': 'sei-v2'
  };

  /* Numeric chainId -> GeckoTerminal network id (Pendle and others put ?chainId= in the URL). */
  const CHAIN_IDS = {
    1: 'eth', 10: 'optimism', 56: 'bsc', 100: 'xdai', 137: 'polygon_pos', 146: 'sonic',
    250: 'ftm', 252: 'fraxtal', 324: 'zksync', 480: 'world-chain', 1101: 'polygon-zkevm',
    5000: 'mantle', 8453: 'base', 34443: 'mode', 42161: 'arbitrum', 43114: 'avax',
    59144: 'linea', 80094: 'berachain', 81457: 'blast', 130: 'unichain', 999: 'hyperevm',
    534352: 'scroll', 143: 'monad', 57073: 'ink', 1868: 'soneium'
  };

  /*
   * Single-chain DEX front-ends don't put the chain in the URL because there is only one.
   * Recognising the host saves a cross-chain search and avoids picking a fork's clone pool.
   */
  const HOST_CHAINS = [
    [/aerodrome\.finance$/i, 'base'],
    [/velodrome\.finance$/i, 'optimism'],
    [/(^|\.)orca\.so$/i, 'solana'],
    [/raydium\.io$/i, 'solana'],
    [/meteora\.ag$/i, 'solana'],
    [/(^|\.)jup\.ag$/i, 'solana'],
    [/aerodrome|basescan\.org$/i, 'base'],
    [/etherscan\.io$/i, 'eth'],
    [/arbiscan\.io$/i, 'arbitrum'],
    [/optimistic\.etherscan\.io$/i, 'optimism'],
    [/bscscan\.com$/i, 'bsc'],
    [/polygonscan\.com$/i, 'polygon_pos'],
    [/snowtrace\.io|snowscan\.xyz$/i, 'avax'],
    [/solscan\.io|solana\.fm$/i, 'solana'],
    [/thena\.fi$/i, 'bsc'],
    [/camelot\.exchange$/i, 'arbitrum'],
    [/quickswap\.exchange$/i, 'polygon_pos'],
    [/(^|\.)cetus\.zone$/i, 'sui-network'],
    [/hyperswap\.exchange$/i, 'hyperevm']
  ];

  const EVM_ADDR = /0x[a-fA-F0-9]{40,64}/g;
  const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  /* Path words that look like base58 but never are pool addresses. */
  const STOPWORDS = new Set([
    'pools', 'pool', 'pairs', 'pair', 'tokens', 'token', 'explore', 'trade', 'swap',
    'deposit', 'withdraw', 'liquidity', 'positions', 'position', 'info', 'add', 'remove'
  ]);

  /** Normalise an EVM address candidate: Balancer pool ids are the address + 12 bytes of suffix. */
  function normEvm(raw) {
    const hex = raw.slice(2);
    return ('0x' + hex.slice(0, 40)).toLowerCase();
  }

  function findChainHint(url) {
    const lower = url.toLowerCase();

    // Explicit numeric chain id in the query string wins (?chainId=1, ?chain=42161).
    const idMatch = lower.match(/[?&](?:chainid|chain_id|chain)=(\d+)/);
    if (idMatch && CHAIN_IDS[+idMatch[1]]) return CHAIN_IDS[+idMatch[1]];

    // Otherwise the first path/query token that names a chain we know.
    const tokens = lower.split(/[/?#&=,:]+/).filter(Boolean);
    for (const t of tokens) {
      if (Object.prototype.hasOwnProperty.call(CHAINS, t)) return CHAINS[t];
    }

    // Last resort: a single-chain front-end implies its chain.
    const host = (lower.match(/^https?:\/\/([^/]+)/) || [])[1];
    if (host) {
      const bare = host.replace(/^www\./, '');
      for (const [re, chain] of HOST_CHAINS) if (re.test(bare)) return chain;
    }
    return null;
  }

  /** Does the URL point at a token page rather than a pool page? */
  function looksLikeTokenPage(url) {
    return /\/(tokens?|coins?)\//i.test(url) || /[?&]token[01]=/i.test(url);
  }

  function isPoolPage(url) {
    return /\/(pools?|pairs?|positions?|market)\b/i.test(url);
  }

  /**
   * Parse input into a lookup target.
   * Returns one of:
   *   { kind:'pool',  address, chain, source, dexHint }
   *   { kind:'token', addresses:[...], chain, source }
   *   { kind:'none',  reason }
   */
  function parseInput(input) {
    const raw = (input || '').trim();
    if (!raw) return { kind: 'none', reason: 'Nothing pasted yet.' };

    const chain = findChainHint(raw);
    const source = detectSource(raw);

    // Collect EVM addresses in order of appearance, de-duplicated.
    const evm = [];
    let m;
    EVM_ADDR.lastIndex = 0;
    while ((m = EVM_ADDR.exec(raw)) !== null) {
      const a = normEvm(m[0]);
      if (!evm.includes(a)) evm.push(a);
    }

    // Collect base58 (Solana-style) candidates from discrete path/query segments.
    const b58 = [];
    for (const seg of raw.split(/[/?#&=,]+/)) {
      const s = seg.trim();
      if (!s || STOPWORDS.has(s.toLowerCase())) continue;
      if (BASE58.test(s) && !/^0x/i.test(s)) b58.push(s);
    }

    const found = evm.length ? evm : b58;

    if (!found.length) {
      return {
        kind: 'none',
        chain,
        source,
        reason:
          'No pool or token address found in that link. Some front-ends (Curve, some ' +
          'Aerodrome pages) put a pool *name* in the URL instead of its address — open the ' +
          'pool page, copy the pool contract address, and paste that instead.'
      };
    }

    // A token page (or an Aerodrome-style ?token0=&token1=) means we have to go find the pool.
    if (looksLikeTokenPage(raw) && !isPoolPage(raw)) {
      return { kind: 'token', addresses: found.slice(0, 2), chain, source };
    }

    // token0/token1 query params alongside a pool path: still a token pair, no pool address.
    if (/[?&]token0=/i.test(raw) && /[?&]token1=/i.test(raw) && found.length >= 2) {
      return { kind: 'token', addresses: found.slice(0, 2), chain, source };
    }

    return {
      kind: 'pool',
      address: found[0],
      alternates: found.slice(1, 3),
      chain,
      source,
      isPendle: /pendle/i.test(raw)
    };
  }

  function detectSource(url) {
    const host = (url.match(/^https?:\/\/([^/]+)/i) || [])[1];
    if (!host) return 'address';
    return host.replace(/^www\./, '').toLowerCase();
  }

  return { parseInput, CHAINS, CHAIN_IDS, findChainHint };
})();
