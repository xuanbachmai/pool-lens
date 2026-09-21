/*
 * Where the swap fee comes from, and how much of it an LP actually keeps.
 *
 * The OTS notes make the point explicitly: "Don't always trust the frontend, try to find
 * out how the protocol is calculating APY." Two things get conflated on DEX front-ends:
 *   1. the swap fee the trader pays, and
 *   2. the share of that fee that reaches the liquidity provider.
 * We track them separately and always say which numbers we assumed.
 */
window.LP = window.LP || {};

LP.fees = (function () {
  /*
   * lpShare = fraction of the swap fee that accrues to the LP.
   * Anything below 1.0 means part of the fee is diverted (protocol treasury, veToken
   * voters, buybacks). These splits change by governance vote, so they are labelled
   * "assumed" and are editable in the UI.
   */
  const PROFILES = [
    {
      test: /uniswap.*v4/i,
      label: 'Uniswap v4', type: 'cl', fee: null, lpShare: 1.0,
      note: 'v4 hooks can add their own fees on top of the pool fee.'
    },
    { test: /uniswap.*v3/i, label: 'Uniswap v3', type: 'cl', fee: null, lpShare: 1.0 },
    { test: /uniswap.*v2|uniswap_v2/i, label: 'Uniswap v2', type: 'cpmm', fee: 0.30, lpShare: 1.0 },
    {
      test: /pancakeswap.*v3/i,
      label: 'PancakeSwap v3', type: 'cl', fee: null, lpShare: 0.68,
      note: 'Pancake splits the swap fee between LPs, treasury and CAKE buyback; the LP share varies by fee tier.'
    },
    {
      test: /pancakeswap/i,
      label: 'PancakeSwap v2', type: 'cpmm', fee: 0.25, lpShare: 0.68,
      note: 'Of the 0.25% fee, roughly 0.17% reaches LPs — the rest goes to treasury and buyback.'
    },
    {
      test: /sushiswap.*v3/i, label: 'SushiSwap v3', type: 'cl', fee: null, lpShare: 1.0
    },
    {
      test: /sushiswap/i,
      label: 'SushiSwap v2', type: 'cpmm', fee: 0.30, lpShare: 0.833,
      note: 'Historically 0.25% to LPs and 0.05% to xSUSHI stakers.'
    },
    {
      test: /curve/i,
      label: 'Curve', type: 'stable', fee: 0.04, lpShare: 0.50,
      note: 'Curve fees vary per pool (often 0.01%–0.4%) and roughly half is taken as an admin fee for veCRV. Check the pool page and correct the fee if needed.'
    },
    {
      test: /balancer/i,
      label: 'Balancer', type: 'weighted', fee: null, lpShare: 0.50,
      note: 'Balancer swap fees are set per pool and a protocol cut (often 50%) is taken. Weighted pools (80/20 etc.) also have a different IL profile than the 50/50 maths used here.'
    },
    {
      // Aerodrome/Velodrome Slipstream (and CL forks) are concentrated-liquidity pools that
      // still route fees to voters, so they need the range maths but a zero LP fee share.
      test: /slipstream|(aerodrome|velodrome|thena|ramses|shadow)[-_]?(cl|v3)/i,
      label: 've(3,3) concentrated pool', type: 'cl', fee: null, lpShare: 0.0,
      veModel: true,
      note: 'This is a concentrated-liquidity pool on a ve(3,3) DEX: swap fees go to veToken voters, not to LPs. LP return comes from token emissions instead, so the fee APR below reads ~0 by design. The range analysis still applies — going out of range still stops your emissions.'
    },
    {
      test: /aerodrome|velodrome|solidly|thena|ramses|equalizer|shadow-exchange/i,
      label: 've(3,3) DEX', type: 'cpmm', fee: 0.30, lpShare: 0.0,
      veModel: true,
      note: 'On ve(3,3) DEXes the swap fees are paid to veToken voters, not to LPs — LP return comes from token emissions instead. Fee APR here will read ~0 by design; the real yield is emissions, which this tool does not measure.'
    },
    {
      test: /raydium.*clmm|raydium.*cpmm/i, label: 'Raydium CLMM', type: 'cl', fee: null, lpShare: 0.84
    },
    {
      test: /raydium/i,
      label: 'Raydium AMM', type: 'cpmm', fee: 0.25, lpShare: 0.88,
      note: '0.22% of the 0.25% fee goes to LPs, 0.03% to RAY buyback.'
    },
    { test: /orca|whirlpool/i, label: 'Orca Whirlpools', type: 'cl', fee: null, lpShare: 0.87 },
    {
      test: /meteora/i,
      label: 'Meteora DLMM', type: 'cl', fee: null, lpShare: 0.80,
      note: 'DLMM uses a dynamic fee that rises with volatility, so a single fee number is only a rough average.'
    },
    {
      test: /camelot|algebra|quickswap.*v3|swapsicle/i,
      label: 'Algebra dynamic-fee DEX', type: 'cl', fee: null, lpShare: 1.0,
      note: 'This DEX uses a dynamic fee that changes with volatility — treat the fee figure as an average.'
    },
    {
      test: /trader_joe|traderjoe|lfj/i,
      label: 'Trader Joe Liquidity Book', type: 'cl', fee: null, lpShare: 1.0,
      note: 'Liquidity Book charges a base fee plus a variable fee that scales with volatility.'
    },
    {
      test: /maverick/i, label: 'Maverick', type: 'cl', fee: null, lpShare: 1.0,
      note: 'Maverick pools move their liquidity automatically; static range maths does not fully apply.'
    },
    {
      test: /pendle/i,
      label: 'Pendle', type: 'pendle', fee: null, lpShare: 1.0,
      note: 'This is a Pendle PT/asset pool. Its AMM prices fixed yield, not spot, so the constant-product IL maths below does not describe it. Pendle LP risk is closer to "PT drifts to par by expiry" than to conventional IL.'
    },
    { test: /fluid/i, label: 'Fluid DEX', type: 'cl', fee: null, lpShare: 1.0 },
    { test: /dodo/i, label: 'DODO PMM', type: 'other', fee: null, lpShare: 1.0 },
    { test: /pumpswap|pump-fun|four-meme|moonshot/i,
      label: 'Memecoin launchpad AMM', type: 'cpmm', fee: null, lpShare: 0.80,
      note: 'Launchpad pools are usually short-lived and dominated by one volatile token.' }
  ];

  const V3_TIERS = [0.01, 0.05, 0.30, 1.00];

  /** Pull "0.05%" out of a GeckoTerminal pool name like "WETH / USDC 0.05%". */
  function feeFromName(name) {
    if (!name) return null;
    const m = String(name).match(/(\d+(?:\.\d+)?)\s*%/);
    if (!m) return null;
    const v = parseFloat(m[1]);
    return Number.isFinite(v) && v > 0 && v <= 10 ? v : null;
  }

  function profileFor(dexId) {
    const id = String(dexId || '');
    for (const p of PROFILES) if (p.test.test(id)) return p;
    return { label: id || 'Unknown DEX', type: 'unknown', fee: null, lpShare: 1.0 };
  }

  /**
   * Resolve the fee for a pool.
   * @returns {{fee:number, lpShare:number, confidence:'api'|'name'|'known'|'assumed',
   *            profile:object, type:string, notes:string[]}}
   */
  function resolve(pool) {
    const profile = profileFor(pool.dexId);
    const notes = [];
    if (profile.note) notes.push(profile.note);

    let fee = LP.util.num(pool.feePercent);
    let confidence = 'api';

    if (fee === null || fee <= 0) {
      fee = feeFromName(pool.name);
      confidence = fee !== null ? 'name' : null;
    }
    if (fee === null) {
      fee = profile.fee;
      confidence = fee !== null ? 'known' : null;
    }
    if (fee === null) {
      // Last resort: the most common fee tier, clearly flagged.
      fee = 0.30;
      confidence = 'assumed';
      notes.push(
        'The data source did not expose this pool\'s swap fee, so 0.30% is assumed. ' +
        'Check the pool page and correct it — fee APR scales linearly with this number.'
      );
    }

    /*
     * Pool type. GeckoTerminal only populates pool_fee_percentage for concentrated-liquidity
     * pools (it is null for v2, Curve and Balancer pools), so an API-sourced fee is good
     * evidence of a CL pool when the DEX itself isn't in the table above.
     */
    let type = profile.type;
    if (type === 'unknown') type = confidence === 'api' || fee <= 0.06 ? 'cl' : 'cpmm';

    if (profile.veModel) notes.push('Fee APR below is the LP share only; it excludes emissions.');

    return {
      fee,
      lpShare: profile.lpShare === null || profile.lpShare === undefined ? 1.0 : profile.lpShare,
      confidence,
      profile,
      type,
      isVeModel: !!profile.veModel,
      notes
    };
  }

  return { resolve, profileFor, feeFromName, V3_TIERS };
})();
