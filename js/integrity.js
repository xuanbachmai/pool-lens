/*
 * Is this pool real?
 *
 * Every other panel assumes the pool is what it says it is and asks whether it pays well. This
 * one asks the prior question, which matters more for anything outside the top few hundred
 * pairs: can you sell what you buy, is the volume real people trading, and is the "market cap"
 * supportable by the liquidity behind it.
 *
 * Two halves, because they fail in different ways and from different evidence.
 *
 *   Contract risk comes from GoPlus, which reads the token contract: honeypots, transfer taxes,
 *   mint authority, ownership, pause and blacklist powers, holder concentration. Free, no key,
 *   and it genuinely supports browser CORS -- verified from a real browser rather than from
 *   curl, because the Merkl work taught that curl sends no Origin and therefore proves nothing.
 *
 *   Market integrity comes from data this app already fetches and has been throwing away: the
 *   buy/sell and buyer/seller counts, fully diluted value against the liquidity behind it, the
 *   locked-liquidity share, and the pool's age. No new requests for any of it.
 *
 * The one rule here: SEVERITY COMES FROM AGREEMENT, NOT FROM ANY SINGLE FLAG.
 *
 * USDT reports mintable, pausable, blacklist-capable, owner not renounced, and 49% of supply in
 * ten addresses. On a memecoin that combination would be damning; on a regulated stablecoin it
 * is the design, and a checker that shouted about it would be wrong in the way that teaches
 * people to ignore checkers. So a lone flag is reported as context and only escalates when
 * independent signals corroborate it -- a mint authority matters much more on a pool three days
 * old with four liquidity providers than on one with a million holders.
 *
 * And the verdict never says "safe". It says what was checked, what was not, and what the
 * checks are blind to.
 */
window.LP = window.LP || {};

LP.integrity = (function () {
  const U = () => LP.util;
  const esc = (s) => LP.util.escapeHtml(s);

  const API = 'https://api.gopluslabs.io/api/v1/token_security/';

  /* GeckoTerminal network -> the id GoPlus expects. Non-EVM chains use a name, not a number. */
  const CHAIN_IDS = {
    eth: '1', bsc: '56', polygon_pos: '137', arbitrum: '42161', optimism: '10',
    avax: '43114', base: '8453', zksync: '324', linea: '59144', scroll: '534352',
    mantle: '5000', cro: '25', xdai: '100', ftm: '250', unichain: '130',
    opbnb: '204', zircuit: '48900', solana: 'solana', tron: 'tron'
  };

  const local = { state: 'idle', sec: null, error: null, result: null };
  // state: idle | loading | done | unsupported | error

  const num = (v) => {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return (typeof n === 'number' && isFinite(n)) ? n : null;
  };
  const flag = (v) => String(v) === '1';

  /* ------------------------------------------------------------------- fetch */

  async function tokenSecurity(network, tokenAddress) {
    const chain = CHAIN_IDS[network];
    if (!chain) {
      return { ok: false, unsupported: true,
        reason: 'Contract checks are not available on ' + (network || 'this chain') + '.' };
    }
    const addr = String(tokenAddress || '').trim();
    if (!addr) return { ok: false, reason: 'No token address to check.' };

    const res = await fetch(API + encodeURIComponent(chain) +
      '?contract_addresses=' + encodeURIComponent(addr));
    if (!res.ok) throw new Error('GoPlus returned HTTP ' + res.status + '.');
    const json = await res.json();
    if (String(json.code) !== '1') {
      throw new Error(json.message || 'GoPlus could not read that token.');
    }
    // Keys come back lower-cased, which will not match a checksummed address.
    const row = Object.entries(json.result || {})
      .find(([k]) => k.toLowerCase() === addr.toLowerCase());
    if (!row) return { ok: false, reason: 'GoPlus has no record of that token yet, which is ' +
      'normal for one deployed in the last few hours.' };
    return { ok: true, sec: row[1] };
  }

  /* --------------------------------------------------- market-side signals */

  /**
   * What the trading itself says, from counts this app already has.
   *
   * The useful one is trades per trader. Genuine trading has many addresses doing a few trades
   * each; volume manufactured to look real has few addresses doing many. It is not proof --
   * arbitrage bots trade often and legitimately -- which is why it is weighed rather than
   * pronounced on.
   */
  function marketSignals(r) {
    const pool = r.pool || {};
    const t = (pool.txns && (pool.txns.h24 || pool.txns.h6)) || {};
    const buys = num(t.buys), sells = num(t.sells);
    const buyers = num(t.buyers), sellers = num(t.sellers);

    const trades = (buys || 0) + (sells || 0);
    const traders = (buyers || 0) + (sellers || 0);
    const perTrader = traders > 0 ? trades / traders : null;

    // Buys with almost no sells is what a honeypot looks like from the outside.
    const sellRatio = (buys && buys > 0) ? (sells || 0) / buys : null;

    const fdv = num(pool.fdvUsd);
    const tvl = num(pool.tvlUsd);
    // How much notional value each dollar of liquidity is holding up.
    const fdvToLiquidity = (fdv && tvl && tvl > 0) ? fdv / tvl : null;

    const ageDays = pool.createdAt ? U().age(pool.createdAt) : null;
    const lockedPct = num(pool.lockedLiquidityPct);

    return { buys, sells, buyers, sellers, trades, traders, perTrader, sellRatio,
             fdv, tvl, fdvToLiquidity, ageDays, lockedPct };
  }

  /**
   * What it would cost to leave.
   *
   * This is the question a market-cap figure cannot answer and this app can, because it already
   * models the curve: a token with a $900M notional value and $40k of liquidity is not worth
   * $900M to anyone trying to realise it.
   */
  function exitCost(r, sizeUsd) {
    // Only the constant-product curve is modelled here; a concentrated pool's depth depends on
    // the live tick distribution, which this app cannot see.
    if (!LP.swap || !r.pool || r.poolType !== 'cpmm') return null;
    try {
      // quote() takes the fee as a fraction and returns impact as a fraction, while
      // r.fees.feePct is a percentage. Same conversion the execution panel makes.
      // The curve is not on the pool object; poolFrom builds it from the reserves, and
      // refuses when the source reported none. Same construction the execution panel uses.
      const built = LP.swap.poolFrom(r);
      if (!built || !built.ok) return null;
      const fee = ((r.fees && r.fees.feePct) || 0.3) / 100;
      const q = LP.swap.costOfUsd(built.pool || built, sizeUsd, 'sellBase', fee);
      // exFee, not impact: impact folds the swap fee in, which is the same percentage at any
      // depth and so says nothing about whether the liquidity is real. exFee is pure curve
      // slippage, which is exactly the thing that exposes a thin pool behind a large notional.
      if (!q || !isFinite(q.exFee)) return null;
      return { sizeUsd, impactPct: Math.abs(q.exFee) * 100,
               totalCostPct: isFinite(q.lostPct) ? Math.abs(q.lostPct) : null };
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------- assessment */

  /**
   * Combine both halves into findings.
   *
   * `weight` is what makes a finding escalate: a flag on a pool that is also young, thinly
   * provided and concentrated is a different proposition from the same flag on a pool with a
   * million holders, and the copy says which situation it is looking at.
   */
  function assess(r, sec) {
    const m = marketSignals(r);
    const f = [];
    const add = (level, title, detail) => f.push({ level, title, detail });

    /* ---- context: how established is this thing ---- */
    const holders = sec ? num(sec.holder_count) : null;
    const lpHolders = sec ? num(sec.lp_holder_count) : null;
    const young = m.ageDays !== null && m.ageDays < 30;
    const thinlyProvided = lpHolders !== null && lpHolders < 10;
    const smallCrowd = holders !== null && holders < 2000;
    // Corroboration count: how many independent "this is not established" signals agree.
    const fragile = [young, thinlyProvided, smallCrowd].filter(Boolean).length;

    /* ---- contract: the things that stop you selling ---- */
    if (sec) {
      if (flag(sec.is_honeypot)) {
        add('critical', 'Reported as a honeypot',
          'GoPlus reports that this token cannot be sold after it is bought. Treat any yield ' +
          'figure on this page as irrelevant — the position cannot be exited.');
      }
      const buyTax = num(sec.buy_tax) || 0;
      const sellTax = num(sec.sell_tax) || 0;
      if (sellTax >= 0.5 || buyTax >= 0.5) {
        add('critical', 'Punitive transfer tax',
          'Buy tax ' + (buyTax * 100).toFixed(1) + '%, sell tax ' + (sellTax * 100).toFixed(1) +
          '%. At this level the tax, not the price, decides what you get back.');
      } else if (sellTax > 0.1 || buyTax > 0.1) {
        add('warn', 'Transfer tax of more than 10%',
          'Buy ' + (buyTax * 100).toFixed(1) + '%, sell ' + (sellTax * 100).toFixed(1) + '%. ' +
          'A round trip costs ' + ((buyTax + sellTax) * 100).toFixed(1) + '% before any price ' +
          'move or fee, which no LP yield on this page accounts for.');
      } else if (sellTax > buyTax * 2 && sellTax > 0.02) {
        add('warn', 'Selling is taxed more than buying',
          'Sell tax ' + (sellTax * 100).toFixed(1) + '% against a buy tax of ' +
          (buyTax * 100).toFixed(1) + '%. Asymmetry in that direction makes exiting dearer ' +
          'than entering by design.');
      }
      if (flag(sec.cannot_sell_all)) {
        add('warn', 'You cannot sell the whole position',
          'The contract prevents selling an entire balance, so some portion is always stranded.');
      }
      if (flag(sec.trading_cooldown)) {
        add('info', 'Trading cooldown',
          'The contract enforces a wait between trades, which constrains how quickly a ' +
          'position can be unwound.');
      }

      /* ---- contract: the things that let someone change the rules ---- */
      const ownerActive = sec.owner_address &&
        !/^0x0+$/.test(String(sec.owner_address)) &&
        String(sec.owner_address) !== '';

      if (flag(sec.is_mintable) && ownerActive) {
        add(fragile >= 2 ? 'critical' : 'warn', 'Supply can still be minted',
          'An active owner can create more tokens, diluting holders.' +
          (fragile >= 2 ? ' On a pool this young and thinly provided, that is the shape of a ' +
            'rug rather than a governance power.' : ' Plenty of legitimate tokens keep this ' +
            'power — it matters most when the project is new or the holders few.'));
      }
      if (flag(sec.can_take_back_ownership)) {
        add('warn', 'Ownership can be reclaimed',
          'Even if ownership looks renounced, the contract allows taking it back, so a ' +
          '"renounced" badge elsewhere does not mean what it appears to.');
      }
      if (flag(sec.hidden_owner)) {
        add('critical', 'Hidden owner',
          'The contract conceals who controls it. There is rarely a benign reason to hide ' +
          'control while advertising decentralisation.');
      }
      if (flag(sec.selfdestruct)) {
        add('critical', 'The contract can destroy itself',
          'A self-destruct path exists, which can render holdings worthless in one transaction.');
      }
      if (flag(sec.is_proxy) && ownerActive) {
        add('warn', 'Upgradeable contract with an active owner',
          'The logic can be replaced, so the rules you checked today are not necessarily the ' +
          'rules tomorrow.');
      }
      if (flag(sec.transfer_pausable) || flag(sec.is_blacklisted)) {
        add(fragile >= 2 ? 'warn' : 'info', 'Transfers can be paused or addresses blocked',
          'Someone can stop transfers or block specific addresses.' +
          (fragile >= 2 ? ' On a young, thinly held token this is a live risk to your exit.'
                        : ' Most regulated stablecoins have exactly this, by design and by ' +
                          'law, so on an established token it is expected rather than alarming.'));
      }
      if (sec.is_open_source !== undefined && !flag(sec.is_open_source)) {
        add('warn', 'Source code not published',
          'The contract is unverified, so none of the checks above could read what it ' +
          'actually does. Absence of a flag here is absence of evidence.');
      }

      /* ---- who holds it ---- */
      const top10 = Array.isArray(sec.holders)
        ? sec.holders.slice(0, 10).reduce((a, h) => a + (num(h.percent) || 0), 0) : null;
      if (top10 !== null && top10 > 0.5) {
        add(fragile >= 2 ? 'critical' : 'warn', 'Concentrated in few hands',
          'The ten largest addresses hold ' + U().pct(top10 * 100, 0) + ' of supply. One of ' +
          'them selling moves the price more than every other holder combined.' +
          (fragile < 2 ? ' This is common on established tokens with treasuries and exchange ' +
            'wallets, so read it alongside the age and holder count.' : ''));
      }
      if (lpHolders !== null && lpHolders > 0 && lpHolders < 5) {
        add('warn', 'Liquidity comes from very few providers',
          'Only ' + lpHolders + ' address' + (lpHolders === 1 ? '' : 'es') + ' provide this ' +
          'liquidity. If they withdraw, there is no market left to sell into.');
      }
    }

    /* ---- market: does the trading look like people ---- */
    if (m.perTrader !== null && m.traders >= 20) {
      if (m.perTrader > 12) {
        add('warn', 'Trading is concentrated in very few addresses',
          U().int(m.trades) + ' trades from ' + U().int(m.traders) + ' addresses, about ' +
          m.perTrader.toFixed(1) + ' each. Genuine activity is many addresses trading a few ' +
          'times; this shape is what manufactured volume looks like. Arbitrage bots also ' +
          'trade often, so weigh it with the rest rather than alone.');
      } else if (m.perTrader > 6) {
        add('info', 'Fewer traders than the trade count suggests',
          'About ' + m.perTrader.toFixed(1) + ' trades per address. Not unusual where bots ' +
          'arbitrage actively, but worth knowing before reading the volume as demand.');
      }
    }
    /*
     * Twelve buys is the floor, not thirty. If sells were genuinely possible at even a 30%
     * rate, seeing none across twelve buys happens about 1.4% of the time, so the sample is
     * already informative -- and a real honeypot is usually caught in its first hours, when a
     * threshold of thirty would still be waiting. The count is quoted so the reader can judge
     * the sample for themselves.
     */
    if (m.sellRatio !== null && m.buys >= 12 && m.sellRatio < 0.1) {
      add('critical', 'People are buying but almost nobody is selling',
        U().int(m.buys) + ' buys against ' + U().int(m.sells || 0) + ' sells in 24 hours. That ' +
        'is what a honeypot looks like from the market side, whatever the contract check says. ' +
        'On a small sample it can be innocent, but it is the one pattern worth stopping for.');
    }

    /* ---- market: is the valuation supportable ---- */
    if (m.fdvToLiquidity !== null && m.fdvToLiquidity > 200) {
      add(m.fdvToLiquidity > 1000 ? 'warn' : 'info', 'Notional value far exceeds the liquidity',
        'Fully diluted value is ' + U().usd(m.fdv) + ' against ' + U().usd(m.tvl) + ' of ' +
        'liquidity here — about ' + U().int(m.fdvToLiquidity) + 'x. A market cap is only ' +
        'meaningful to the extent anyone can realise it, and at this ratio most of it cannot be.');
    }
    if (m.ageDays !== null && m.ageDays < 7) {
      add('warn', 'The pool is ' + (m.ageDays < 1 ? 'less than a day old'
        : Math.round(m.ageDays) + ' days old'),
        'There is not enough history here for the volatility, fee and impermanent-loss figures ' +
        'elsewhere on this page to mean much, and most pools that fail do so early.');
    }
    if (m.lockedPct !== null && m.lockedPct < 0.01 && m.ageDays !== null && m.ageDays < 90) {
      add('warn', 'Effectively none of the liquidity is locked',
        'Whoever provided it can withdraw at any moment. On a pool this young that is the ' +
        'single most common way holders are left with nothing to sell into.');
    }

    /* ---- what it costs to get out ---- */
    const exits = [1000, 10000, 100000].map((s) => exitCost(r, s)).filter(Boolean);
    const bigExit = exits.find((e) => e.sizeUsd === 10000);
    if (bigExit && bigExit.impactPct > 10) {
      add('warn', 'Getting out moves the price sharply',
        'Selling ' + U().usd(10000) + ' into this pool moves it ' +
        U().pct(bigExit.impactPct, 1) + '. The quoted price applies to trades far smaller ' +
        'than the position you are considering.');
    }

    const order = { critical: 0, warn: 1, info: 2 };
    f.sort((a, b) => order[a.level] - order[b.level]);
    return { findings: f, market: m, exits, sec, fragile,
             holders, lpHolders,
             counts: {
               critical: f.filter((x) => x.level === 'critical').length,
               warn: f.filter((x) => x.level === 'warn').length
             } };
  }

  /* ------------------------------------------------------------------ render */

  function reset() { local.state = 'idle'; local.sec = null; local.error = null; }

  function render(r) {
    local.result = r;
    if (local.state === 'idle') {
      return card(`
        <p class="muted">Every other panel on this page assumes the pool is what it claims and
        asks whether it pays. This one asks first whether you could sell what you bought, whether
        the volume is people or wash trading, and whether the headline valuation is supportable
        by the liquidity actually behind it.</p>
        <button class="btn" id="inLoad">Check this pool for manipulation</button>
        <p class="fineprint">Reads the token contract through GoPlus, and re-reads trading data
        this page already has. One request, no account.</p>`);
    }
    if (local.state === 'loading') return card('<p class="muted">Reading the contract…</p>');
    if (local.state === 'unsupported') {
      return card('<p class="muted">' + esc(local.error || '') + ' The market-side checks below ' +
        'still apply.</p>' + renderBody(r, assess(r, null)));
    }
    if (local.state === 'error') {
      return card('<div class="callout warn"><strong>The contract check could not run.</strong> ' +
        esc(local.error || '') + '</div>' + renderBody(r, assess(r, null)));
    }
    return card(renderBody(r, assess(r, local.sec)));
  }

  function renderBody(r, a) {
    const u = U();
    const m = a.market;
    const verdict = verdictFor(a);

    return `
      <div class="callout ${verdict.cls}"><strong>${esc(verdict.headline)}</strong>
        ${esc(verdict.detail)}</div>

      <div class="metrics">
        ${metric('Trades per address', m.perTrader === null ? '—' : u.ratio(m.perTrader, 1),
          m.traders ? u.int(m.trades) + ' trades, ' + u.int(m.traders) + ' addresses (24h)'
                    : 'no trade counts reported',
          m.perTrader !== null && m.perTrader > 12 ? 'weak' : '')}
        ${metric('Sells per buy', m.sellRatio === null ? '—' : u.ratio(m.sellRatio, 2),
          'below 0.1 is what a honeypot looks like',
          m.sellRatio !== null && m.sellRatio < 0.1 ? 'weak' : '')}
        ${metric('Value vs liquidity', m.fdvToLiquidity === null ? '—'
          : u.int(m.fdvToLiquidity) + '×',
          'fully diluted value per dollar of liquidity',
          m.fdvToLiquidity !== null && m.fdvToLiquidity > 1000 ? 'weak' : '')}
        ${metric('Holders', a.holders === null ? '—' : u.int(a.holders),
          a.lpHolders === null ? 'token holders'
            : a.lpHolders + ' providing liquidity',
          a.lpHolders !== null && a.lpHolders < 5 ? 'weak' : '')}
      </div>

      ${a.exits.length ? `
      <h4>What it costs to leave</h4>
      <div class="table-scroll"><table>
        <thead><tr><th class="num">Selling</th><th class="num">Price slippage</th><th>What that means</th></tr></thead>
        <tbody>${a.exits.map((e) => `<tr>
          <td class="num">${u.usd(e.sizeUsd)}</td>
          <td class="num ${e.impactPct > 10 ? 'down' : ''}">${u.pct(e.impactPct, 2)}</td>
          <td class="muted">${e.impactPct > 25 ? 'the quoted price is fiction at this size'
            : e.impactPct > 10 ? 'you would take a serious haircut getting out'
            : e.impactPct > 2 ? 'noticeable, plan the exit' : 'the pool absorbs this comfortably'}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : ''}

      ${a.findings.length ? `
      <h4>${a.findings.length} thing${a.findings.length === 1 ? '' : 's'} worth knowing</h4>
      <ul class="flags">${a.findings.map((x) => `
        <li class="flag ${esc(x.level)}"><strong>${esc(x.title)}</strong><p>${esc(x.detail)}</p></li>
      `).join('')}</ul>` : `
      <p class="muted">None of the checks raised anything. That is not the same as safe — see
      below for what they do not cover.</p>`}

      <p class="fineprint"><strong>What this cannot tell you.</strong> Contract checks read code,
      not intent: a contract with no dangerous powers can still belong to a project that walks
      away. They can be stale or wrong, and a token deployed in the last few hours may have no
      record at all. Nothing here inspects the team, the social accounts, or off-chain promises,
      and none of it is a recommendation. A clean result means these particular checks found
      nothing, and no more than that.</p>`;
  }

  /** The headline. Deliberately never the word "safe". */
  function verdictFor(a) {
    const c = a.counts.critical, w = a.counts.warn;
    if (c >= 2) {
      return { cls: 'bad', headline: 'Several serious problems.',
        detail: 'More than one check found something that can stop you getting your money ' +
          'back. Read them below before considering any yield figure on this page.' };
    }
    if (c === 1) {
      return { cls: 'bad', headline: 'One serious problem.',
        detail: 'A check found something that can prevent an exit. It is listed below.' };
    }
    if (w >= 3) {
      return { cls: 'warn', headline: 'Several things do not look right together.',
        detail: 'No single finding is damning, but they corroborate each other, which is ' +
          'usually more informative than any one of them.' };
    }
    if (w >= 1) {
      return { cls: 'warn', headline: 'A few things worth reading before you commit.',
        detail: 'Nothing that blocks an exit outright, but enough to understand first.' };
    }
    return { cls: '', headline: 'Nothing alarming in what could be checked.',
      detail: 'The contract checks found no dangerous powers and the trading looks like ' +
        'ordinary activity. That is a statement about these checks, not a verdict on the pool.' };
  }

  function metric(label, value, sub, cls) {
    return `<div class="metric ${cls || ''}">
      <span class="m-label">${label}</span>
      <span class="m-value">${value}</span>
      ${sub ? '<span class="m-sub">' + sub + '</span>' : ''}
    </div>`;
  }

  function card(inner) {
    return `<section class="card integrity">
      <h3>Is this pool real?</h3>
      ${inner}
    </section>`;
  }

  /* ------------------------------------------------------------------ wiring */

  function wire(onChange) {
    const btn = document.getElementById('inLoad');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const r = local.result;
      local.state = 'loading';
      onChange();
      try {
        // The base token is the one being valued; the quote is usually ETH or a stablecoin.
        // GeckoTerminal ids look like "eth_0xabc…"; GoPlus wants the bare address.
        const token = String(r.pool.baseTokenId || '')
          .replace(r.pool.network + '_', '');
        const hit = await tokenSecurity(r.pool.network, token);
        if (!hit.ok) {
          local.state = hit.unsupported ? 'unsupported' : 'error';
          local.error = hit.reason;
        } else {
          local.sec = hit.sec;
          local.state = 'done';
        }
      } catch (e) {
        local.error = e.message || String(e);
        local.state = 'error';
      }
      onChange();
    });
  }

  return { tokenSecurity, marketSignals, assess, exitCost, verdictFor,
           render, wire, reset, CHAIN_IDS, _state: () => local };
})();
