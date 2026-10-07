/*
 * Pendle markets: a different animal, analysed differently.
 *
 * Everywhere else this app assumes a spot pool, where the price can go anywhere and impermanent
 * loss is unbounded. A Pendle market trades a principal token against its yield-bearing asset,
 * and that changes the shape of the problem completely:
 *
 *   - PT is a zero-coupon claim on 1 asset at expiry, so its price CONVERGES TO PAR on a known
 *     date. Divergence is bounded and its direction is known, which is the opposite of a spot
 *     pool. "Impermanent loss" is the wrong frame.
 *   - The real question is a rate question: the market's implied fixed yield against what the
 *     asset actually earns floating. An LP sits between the two.
 *   - Time, not volatility, is the dominant variable. Everything decays toward expiry.
 *
 * Pricing follows the Notional-style curve Pendle V2 uses, from the V2 AMM paper:
 *     proportion    p = nPt / (nPt + nSy)
 *     rateScalar(t)   = scalarRoot / t
 *     priceAsset(t)   = ln( p / (1-p) ) / rateScalar(t) + rateAnchor(t)
 * with t the normalised time to expiry. The paper's "reasonable trading range" is p in
 * [0.1, 0.9], outside which slippage becomes severe — which is a concrete thing to check about
 * a live pool, so it is checked.
 *
 * Pendle publishes its own impliedApy. That is authoritative for its own market, so it is used
 * as the headline and the first-principles figure is shown beside it as a cross-check.
 */
window.LP = window.LP || {};

LP.pendle = (function () {
  const YEAR_MS = 365.25 * 24 * 3600 * 1000;

  /* Numeric chainId by GeckoTerminal network id, for the proxy. */
  const CHAIN_IDS = {
    eth: 1, optimism: 10, bsc: 56, sonic: 146, hyperevm: 999, mantle: 5000,
    base: 8453, arbitrum: 42161, berachain: 80094, avax: 43114
  };

  const cache = new Map();     // chainId -> markets
  const inflight = new Map();

  /* ------------------------------------------------------------------- fetch */

  async function markets(chainId) {
    if (cache.has(chainId)) return cache.get(chainId);
    if (inflight.has(chainId)) return inflight.get(chainId);

    const p = (async () => {
      let res;
      try {
        res = await fetch('/api/pendle?chainId=' + encodeURIComponent(chainId),
          { headers: { accept: 'application/json' } });
      } catch (e) {
        inflight.delete(chainId);
        throw new Error('Could not reach the Pendle proxy. It needs the site deployed with ' +
          'serverless functions — Pendle\'s own API sends no CORS header, so the browser cannot ' +
          'call it directly.');
      }
      if (res.status === 404) {
        inflight.delete(chainId);
        throw new Error('/api/pendle is not deployed here. Pendle analysis needs it, because ' +
          'Pendle\'s API cannot be called from a browser directly.');
      }
      if (!res.ok) {
        inflight.delete(chainId);
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || ('Pendle proxy returned HTTP ' + res.status + '.'));
      }
      const json = await res.json();
      cache.set(chainId, json.markets || []);
      inflight.delete(chainId);
      return cache.get(chainId);
    })();
    inflight.set(chainId, p);
    return p;
  }

  /** Find the market for a pool address, if this is a Pendle market at all. */
  async function find(network, address) {
    const chainId = CHAIN_IDS[network];
    if (!chainId) return { ok: false, reason: 'Pendle is not deployed on ' + network + '.' };
    const list = await markets(chainId);
    const want = String(address || '').toLowerCase();
    const hit = list.find((m) => String(m.address || '').toLowerCase() === want);
    if (!hit) {
      return { ok: false, reason: 'Not an active Pendle market on this chain.', count: list.length };
    }
    return { ok: true, market: hit, chainId };
  }

  /* ---------------------------------------------------------------- analysis */

  /**
   * Normalised time to expiry.
   *
   * The paper's t runs from 1 at pool launch to 0 at expiry, scaled by the pool's own term. We
   * do not know the launch date, so years-to-expiry is used directly: it is the quantity every
   * rate conversion actually needs, and it is what the scalar divides.
   */
  function timeToExpiry(expiry) {
    const t = Date.parse(expiry);
    if (!Number.isFinite(t)) return null;
    const ms = t - Date.now();
    return { ms, days: ms / 86400000, years: ms / YEAR_MS, expired: ms <= 0 };
  }

  /** Implied fixed yield from the PT price, as the paper defines it. */
  function impliedFromPrice(ptPriceInAsset, years) {
    if (!(ptPriceInAsset > 0) || !(years > 0)) return null;
    if (ptPriceInAsset >= 1) return 0;          // PT at or above par implies no positive yield
    return Math.pow(1 / ptPriceInAsset, 1 / years) - 1;
  }

  /** Pool composition, and where it sits in the paper's reasonable trading range. */
  function proportion(m) {
    const pt = m.totalPt, sy = m.totalSy;
    if (!(pt >= 0) || !(sy >= 0) || pt + sy <= 0) return null;
    const p = pt / (pt + sy);
    return {
      p,
      ptShare: p,
      syShare: 1 - p,
      // The paper defines p in [0.1, 0.9] as the range where slippage stays reasonable.
      inReasonableRange: p >= 0.1 && p <= 0.9,
      edge: p < 0.1 ? 'almost no PT left in the pool'
        : p > 0.9 ? 'almost no SY left in the pool' : null
    };
  }

  /** rateScalar(t) = scalarRoot / t — capital efficiency of the curve at this point in its life. */
  function rateScalar(scalarRoot, years) {
    if (!(scalarRoot > 0) || !(years > 0)) return null;
    return scalarRoot / years;
  }

  /**
   * Decompose what an LP here actually earns, and say how much of it is emissions.
   *
   * Pendle's own breakdown: swapFeeApy is earned, pendleApy is PENDLE emissions, and
   * aggregatedApy is the total a plain LP sees. maxBoostedApy is the same position with a full
   * vePENDLE boost, so the ratio between them is the boost on offer.
   */
  function yieldBreakdown(m) {
    const fee = num(m.swapFeeApy);
    const emissions = num(m.pendleApy);
    const extra = num(m.lpRewardApy);
    const total = num(m.aggregatedApy);
    const boosted = num(m.maxBoostedApy);

    const parts = [];
    if (fee !== null) parts.push({ key: 'fee', label: 'Swap fees', value: fee, earned: true });
    if (emissions !== null && emissions !== 0) {
      parts.push({ key: 'pendle', label: 'PENDLE emissions', value: emissions, earned: false });
    }
    if (extra !== null && extra !== 0) {
      parts.push({ key: 'reward', label: 'Other rewards', value: extra, earned: false });
    }
    // Whatever the total exceeds the named parts by is the underlying yield flowing through SY.
    const named = parts.reduce((a, x) => a + x.value, 0);
    if (total !== null && total - named > 1e-6) {
      parts.push({ key: 'underlying', label: 'Underlying yield', value: total - named, earned: true });
    }

    const earnedTotal = parts.filter((x) => x.earned).reduce((a, x) => a + x.value, 0);
    const emissionTotal = parts.filter((x) => !x.earned).reduce((a, x) => a + x.value, 0);

    return {
      parts, total, boosted,
      earnedTotal, emissionTotal,
      emissionShare: total > 0 ? emissionTotal / total : null,
      boostMultiple: total > 0 && boosted !== null ? boosted / total : null
    };
  }

  /**
   * The decision a Pendle LP actually faces: LP, hold PT, or hold YT.
   *
   * These are three different bets on the same market and Pendle gives the expected return of
   * each, so there is no need to guess. PT is the fixed-rate bet, YT the leveraged-long-yield
   * bet, and LP sits in between collecting fees and emissions.
   */
  function alternatives(m, t) {
    const out = [];
    const implied = num(m.impliedApy);
    const underlying = num(m.underlyingApy);
    const yb = yieldBreakdown(m);

    if (yb.total !== null) {
      out.push({
        key: 'lp', label: 'LP the pool', apy: yb.total,
        note: yb.emissionShare !== null && yb.emissionShare > 0.5
          ? 'Mostly PENDLE emissions, which end when the gauge vote does'
          : 'Fees plus emissions, with bounded divergence as PT nears par',
        boosted: yb.boosted
      });
    }
    if (implied !== null) {
      out.push({
        key: 'pt', label: 'Hold PT to expiry', apy: implied,
        note: 'Locked in. Pays regardless of what the underlying yield does, provided you hold ' +
              'to ' + (t && t.days > 0 ? Math.round(t.days) + ' days from now' : 'expiry')
      });
    }
    if (implied !== null && underlying !== null) {
      out.push({
        key: 'carry', label: 'Fixed vs floating', apy: implied - underlying,
        isSpread: true,
        note: implied > underlying
          ? 'The market pays ' + fmtPct(implied - underlying) + ' MORE than the asset currently ' +
            'earns — PT is the cheaper side, and YT is priced for yields to rise'
          : 'The market pays ' + fmtPct(underlying - implied) + ' LESS than the asset currently ' +
            'earns — holding the asset beats locking the rate, and YT is the cheaper side'
      });
    }
    const ytApy = num(m.ytFloatingApy);
    if (ytApy !== null && ytApy > -0.99) {
      out.push({
        key: 'yt', label: 'Hold YT (long yield)', apy: ytApy,
        note: 'Leveraged bet that the underlying out-earns the implied rate. Decays to zero at ' +
              'expiry, so it needs to be right quickly'
      });
    }
    return out;
  }

  /** Everything the panel needs, computed once. */
  function analyse(m) {
    const t = timeToExpiry(m.expiry);
    const ptPriceUsd = m.pt ? num(m.pt.priceUsd) : null;
    const accPriceUsd = m.accountingAsset ? num(m.accountingAsset.priceUsd) : null;
    const ptInAsset = ptPriceUsd !== null && accPriceUsd ? ptPriceUsd / accPriceUsd : null;

    const theirImplied = num(m.impliedApy);
    const myImplied = t && !t.expired ? impliedFromPrice(ptInAsset, t.years) : null;

    return {
      market: m,
      time: t,
      ptInAsset,
      impliedApy: theirImplied,
      impliedFromPrice: myImplied,
      // Both are annualisations of the same market from different inputs; a gap is a staleness
      // signal, not a contradiction.
      impliedGapPp: theirImplied !== null && myImplied !== null
        ? (myImplied - theirImplied) * 100 : null,
      underlyingApy: num(m.underlyingApy),
      ptDiscount: num(m.ptDiscount),
      proportion: proportion(m),
      rateScalar: t && !t.expired ? rateScalar(num(m.scalarRoot), t.years) : null,
      yields: yieldBreakdown(m),
      alternatives: alternatives(m, t),
      flags: buildFlags(m, t)
    };
  }

  function buildFlags(m, t) {
    const flags = [];
    const add = (level, title, detail) => flags.push({ level, title, detail });

    if (t && t.expired) {
      add('critical', 'This market has expired',
        'PT is redeemable for the asset at par and the pool no longer trades yield. There is ' +
        'nothing left to LP for.');
    } else if (t && t.days < 14) {
      add('warn', 'Expiry is ' + Math.round(t.days) + ' days away',
        'Everything decays into expiry: PT is nearly at par, so there is little price movement ' +
        'left to earn fees on, and the position will need unwinding or rolling shortly.');
    }

    const prop = proportion(m);
    if (prop && !prop.inReasonableRange) {
      add('warn', 'Pool is lopsided',
        'The pool is ' + Math.round(prop.p * 100) + '% PT against ' +
        Math.round((1 - prop.p) * 100) + '% SY — ' + prop.edge + '. The V2 AMM paper treats a ' +
        'proportion outside 0.1 to 0.9 as the point where slippage stops being reasonable, so ' +
        'trades here will fill badly and your deposit will be heavily skewed to one side.');
    }

    const yb = yieldBreakdown(m);
    if (yb.emissionShare !== null && yb.emissionShare > 0.5) {
      add('warn', 'Most of the LP yield is PENDLE emissions',
        Math.round(yb.emissionShare * 100) + '% of the ' + fmtPct(yb.total) + ' headline is ' +
        'PENDLE, not earned fees. Emissions are set by gauge votes and can be redirected at any ' +
        'vote, and they pay in a token whose price you then carry. The earned part is ' +
        fmtPct(yb.earnedTotal) + '.');
    }

    if (yb.boostMultiple !== null && yb.boostMultiple > 1.5) {
      add('info', 'A vePENDLE boost would roughly ' +
        (yb.boostMultiple >= 1.95 ? 'double' : 'multiply') + ' this',
        'A plain LP earns ' + fmtPct(yb.total) + '; with a maximum vePENDLE boost the same ' +
        'position earns ' + fmtPct(yb.boosted) + ', a ' + yb.boostMultiple.toFixed(2) +
        'x multiple. That boost requires locking PENDLE, which is a separate position with its ' +
        'own price risk and lock-up — the headline APYs on the Pendle UI usually quote the ' +
        'boosted number.');
    }

    const implied = num(m.impliedApy);
    const underlying = num(m.underlyingApy);
    if (implied !== null && underlying !== null && underlying > 0) {
      const ratio = implied / underlying;
      if (ratio > 2) {
        add('info', 'Implied yield is far above the underlying',
          'The market prices ' + fmtPct(implied) + ' fixed against ' + fmtPct(underlying) +
          ' actually being earned. Either the market expects yields to rise sharply, or PT is ' +
          'cheap. Buying PT locks the higher number; LPing captures fees from the disagreement.');
      }
    }

    if (num(m.liquidityUsd) !== null && m.liquidityUsd < 250000) {
      add('warn', 'Thin market',
        'Only ' + fmtUsd(m.liquidityUsd) + ' of liquidity. Entry and exit will move the implied ' +
        'rate against you, and a thin Pendle pool can be hard to leave before expiry.');
    }

    if (m.isNew) {
      add('info', 'New market',
        'Recently launched, so the yield figures rest on very little history.');
    }

    return flags;
  }

  /* ---------------------------------------------------------------- helpers */

  function num(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  const fmtPct = (v) => (v === null || v === undefined ? '—' : (v * 100).toFixed(2) + '%');
  const fmtUsd = (v) => (LP.util ? LP.util.usd(v) : '$' + Math.round(v));

  return {
    markets, find, analyse, timeToExpiry, impliedFromPrice, proportion, rateScalar,
    yieldBreakdown, alternatives, CHAIN_IDS
  };
})();

/* ------------------------------------------------------------------- render */

LP.pendleUi = (function () {
  const U = () => LP.util;
  const esc = (s) => LP.util.escapeHtml(s);
  const local = { state: 'idle', found: null, error: null, result: null };

  function reset() { local.state = 'idle'; local.found = null; local.error = null; }

  /** Called during analysis: decide whether this pool is a Pendle market at all. */
  async function detect(result) {
    local.result = result;
    const net = result.pool.network;
    if (!LP.pendle.CHAIN_IDS[net]) { local.state = 'notpendle'; return false; }
    local.state = 'loading';
    try {
      const hit = await LP.pendle.find(net, result.pool.address);
      if (!hit.ok) { local.state = 'notpendle'; return false; }
      local.found = LP.pendle.analyse(hit.market);
      local.state = 'done';
      return true;
    } catch (e) {
      // Only surface the proxy problem if the pool actually looked like Pendle.
      const looksPendle = /pendle/i.test(result.pool.dexId || '') ||
                          /pendle/i.test(LP.ui && LP.ui.state ? LP.ui.state.input : '');
      local.error = e.message || String(e);
      local.state = looksPendle ? 'error' : 'notpendle';
      return looksPendle;
    }
  }

  const isPendle = () => local.state === 'done';

  function render() {
    if (local.state === 'notpendle' || local.state === 'idle') return '';
    if (local.state === 'loading') {
      return card('<p class="muted">Checking whether this is a Pendle market…</p>');
    }
    if (local.state === 'error') {
      return card('<div class="callout warn"><strong>This looks like a Pendle market, but the ' +
        'analysis could not load.</strong> ' + esc(local.error || '') + '</div>');
    }
    return card(body(local.found));
  }

  function card(inner) {
    return '<section class="card pendle"><h3>Pendle market — fixed yield, not spot</h3>' +
      '<p class="muted">This pool trades a principal token against its yield-bearing asset, so ' +
      'the spot-pool maths elsewhere on this page does not describe it. PT is a claim on one ' +
      'unit of the asset at a known date, so its price converges to par rather than wandering: ' +
      'divergence is bounded, its direction is known, and time rather than volatility is the ' +
      'thing that moves the position.</p>' + inner + '</section>';
  }

  function body(a) {
    const u = U();
    const m = a.market;
    const t = a.time;
    const yb = a.yields;

    const spread = a.impliedApy !== null && a.underlyingApy !== null
      ? a.impliedApy - a.underlyingApy : null;

    const bars = yb.parts.length ? yb.parts.map((p) => {
      const share = yb.total > 0 ? (p.value / yb.total) * 100 : 0;
      return '<div class="pd-part">' +
        '<span class="pd-label">' + esc(p.label) +
        (p.earned ? '' : ' <em>emissions</em>') + '</span>' +
        '<span class="pd-bar"><i class="' + (p.earned ? 'earned' : 'emis') +
        '" style="width:' + Math.max(0, Math.min(100, share)).toFixed(1) + '%"></i></span>' +
        '<span class="pd-val">' + u.pct(p.value * 100, 2) + '</span></div>';
    }).join('') : '';

    const alts = a.alternatives.map((alt) =>
      '<tr class="' + (alt.key === 'lp' ? 'here' : '') + '">' +
      '<td>' + esc(alt.label) + '</td>' +
      '<td class="num ' + (alt.apy >= 0 ? 'up' : 'down') + '">' +
      (alt.isSpread ? u.signedPct(alt.apy * 100, 2) : u.pct(alt.apy * 100, 2)) +
      (alt.boosted ? '<em> → ' + u.pct(alt.boosted * 100, 1) + ' boosted</em>' : '') + '</td>' +
      '<td class="muted">' + esc(alt.note) + '</td></tr>').join('');

    const flags = a.flags.map((f) =>
      '<li class="flag ' + esc(f.level) + '"><strong>' + esc(f.title) + '</strong>' +
      '<p>' + esc(f.detail) + '</p></li>').join('');

    return `
      <div class="metrics">
        ${metric('Expires', t && !t.expired ? Math.round(t.days) + ' days' : 'expired',
          m.expiry ? new Date(m.expiry).toISOString().slice(0, 10) : '',
          t && !t.expired && t.days < 14 ? 'weak' : '')}
        ${metric('Implied fixed yield', u.pct((a.impliedApy || 0) * 100, 2),
          'what the market prices PT at' +
          (a.impliedFromPrice !== null
            ? ' · from PT price: ' + u.pct(a.impliedFromPrice * 100, 2) : ''))}
        ${metric('Underlying earns', u.pct((a.underlyingApy || 0) * 100, 2),
          'what the asset actually yields floating')}
        ${metric('Fixed minus floating', spread === null ? '—' : u.signedPct(spread * 100, 2),
          spread === null ? '' : spread > 0
            ? 'locking the rate beats holding the asset'
            : 'holding the asset beats locking the rate',
          spread === null ? '' : spread > 0 ? 'good' : 'weak')}
        ${metric('PT discount to par', u.pct((a.ptDiscount || 0) * 100, 2),
          'accretes to zero at expiry — this is the bounded part')}
        ${a.proportion ? metric('Pool composition',
          u.pct(a.proportion.ptShare * 100, 0) + ' PT',
          u.pct(a.proportion.syShare * 100, 0) + ' SY · proportion p = ' +
          u.ratio(a.proportion.p, 2) +
          (a.proportion.inReasonableRange ? '' : ' · outside the 0.1–0.9 band'),
          a.proportion.inReasonableRange ? '' : 'weak') : ''}
      </div>

      ${bars ? `<h4>Where the LP yield comes from</h4>
      <div class="pd-parts">${bars}</div>
      <p class="fineprint">Total ${u.pct((yb.total || 0) * 100, 2)}, of which
      ${u.pct(yb.earnedTotal * 100, 2)} is earned and ${u.pct(yb.emissionTotal * 100, 2)} is
      emissions${yb.boostMultiple !== null
        ? '. A full vePENDLE lock would take it to ' + u.pct((yb.boosted || 0) * 100, 2) +
          ', a ' + u.ratio(yb.boostMultiple, 2) + '× multiple — that lock is a separate position ' +
          'with its own price risk, and it is usually the number the Pendle front-end headlines'
        : ''}.</p>` : ''}

      <h4>LP, or just hold PT or YT?</h4>
      <div class="table-scroll"><table>
        <thead><tr><th>Position</th><th class="num">Expected</th><th>What it is</th></tr></thead>
        <tbody>${alts}</tbody>
      </table></div>

      ${flags ? '<h4>Worth knowing</h4><ul class="flags">' + flags + '</ul>' : ''}

      <p class="fineprint">Implied yield, the APY breakdown and the vePENDLE boost come from
      Pendle's own API, which is authoritative for its own market. The implied figure from the PT
      price is computed here as a cross-check —
      <span class="mono">(1 / PT price)<sup>1/years</sup> − 1</span> — and matched Pendle's
      number to about 0.01 percentage points across the live markets.
      ${a.rateScalar !== null ? 'Curve parameters: scalarRoot ' +
        u.ratio(m.scalarRoot, 2) + ', rateScalar at this point in the term ' +
        u.ratio(a.rateScalar, 2) + ', fee rate ' + u.pct((m.feeRate || 0) * 100, 3) + '. ' : ''}
      The 0.1–0.9 proportion band is the range the Pendle V2 AMM paper treats as the region where
      slippage stays reasonable.</p>`;
  }

  function metric(label, value, sub, cls) {
    return '<div class="metric ' + (cls || '') + '">' +
      '<span class="m-label">' + label + '</span>' +
      '<span class="m-value">' + value + '</span>' +
      (sub ? '<span class="m-sub">' + sub + '</span>' : '') + '</div>';
  }

  /** A whole page for a Pendle market: nothing from the spot analysis applies. */
  function renderPage(a, network) {
    const u = U();
    const m = a.market;
    const t = a.time;
    return `
    <section class="card head">
      <div class="head-main">
        <h2>${esc(m.name || m.symbol || 'Pendle market')}</h2>
        <div class="head-meta">
          <span class="tag">Pendle V2</span>
          <span class="tag">${esc(network)}</span>
          ${m.protocol ? '<span class="tag">' + esc(m.protocol) + '</span>' : ''}
          <span class="tag">fixed yield</span>
          ${t && !t.expired ? '<span class="tag">' + Math.round(t.days) + ' days to expiry</span>'
            : '<span class="pill weak">expired</span>'}
        </div>
        <div class="head-links">
          <a href="https://app.pendle.finance/trade/pools/${esc(m.address)}/zap/in?chainId=${
            LP.pendle.CHAIN_IDS[network] || 1}" target="_blank" rel="noopener">Open on Pendle</a>
        </div>
      </div>
      <div class="head-price">
        <div class="kv"><span>liquidity</span><strong>${u.usd(m.liquidityUsd)}</strong></div>
        <div class="kv"><span>24h volume</span><strong>${u.usd(m.volumeUsd)}</strong></div>
      </div>
    </section>

    ${card(body(a))}

    <section class="card provenance">
      <h3>Why this page looks different</h3>
      <p class="muted">A Pendle market is not a spot pool, so the panels this app shows for one —
      impermanent loss against a wandering price, a range backtest, constant-product slippage —
      would all be answering the wrong question. None of them are shown. What replaces them is the
      rate comparison above, because that is the actual trade.</p>
      <ul>
        <li>Market data from Pendle's own API via <code>/api/pendle</code>. Their API sends no CORS
          header, so a browser cannot call it directly and the request is proxied; no credentials
          are involved, so it works on any deployment.</li>
        <li>GeckoTerminal and DexScreener do not index Pendle markets, which is why the usual
          lookup is skipped entirely rather than attempted and failed.</li>
      </ul>
      <p class="fineprint">Not advice. PT only pays its fixed rate if held to expiry, LP yield
      includes emissions that a governance vote can redirect, and a thin Pendle market can be
      hard to leave early.</p>
    </section>`;
  }

  return { detect, render, renderPage, reset, isPendle };
})();
