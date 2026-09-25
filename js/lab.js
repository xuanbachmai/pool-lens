/*
 * The AMM formula demo.
 *
 * This page is a teaching surface, not a second implementation. Every number below comes
 * out of LP.swap and LP.analyze -- the exact modules the pool analyser runs on -- so the
 * demo cannot drift away from the tool. If a formula is wrong here it is wrong there too,
 * which is the point of sharing them.
 *
 * Default pool is 100 ETH + 300,000 USDC at $3,000, so the worked examples stay comparable
 * to the lecture material.
 */
window.LP = window.LP || {};

LP.lab = (function () {
  const U = () => LP.util;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => LP.util.escapeHtml(s);

  const state = {
    ethReserve: 100,
    usdcReserve: 300000,
    tradeEth: 20,
    fee: 0.003,
    splitTotal: 60,
    splitPieces: 20,
    splitFee: 0.003,
    priceMove: 50,
    rangeW: 0.20,
    external: 3300,
    gas: 40,
    positionUsd: 10000
  };

  const pool = () => ({
    base: state.ethReserve,
    quote: state.usdcReserve,
    baseUsd: state.usdcReserve / state.ethReserve,
    quoteUsd: 1
  });

  const money = (v) => U().usd(v);
  /*
   * Prices need full precision here. The compact formatter renders the no-arb band as
   * "$3.0K - $3.0K", which hides the exact thing that section is about: the band is only
   * a fee wide, so rounding to three significant figures erases it entirely.
   */
  const px = (v) => !Number.isFinite(v) ? '—'
    : '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (v, d) => U().pct(v, d === undefined ? 2 : d);
  const sgn = (v, d) => U().signedPct(v, d === undefined ? 2 : d);

  /* --------------------------------------------------------------- 1. the curve */

  function drawCurve() {
    const p = pool();
    const d = state.tradeEth;
    const f = state.fee;
    const mid = p.quote / p.base;

    let x1 = p.base, y1 = p.quote, fill = mid, feePaid = 0, impact = 0;
    if (d !== 0) {
      const dir = d > 0 ? 'buyBase' : 'sellBase';
      // Size the trade in ETH either way, then let the shared quote maths do the work.
      const sizeIn = d > 0
        ? LP.swap.amountIn(Math.min(Math.abs(d), p.base * 0.98), p.quote, p.base, f)
        : Math.abs(d);
      const q = sizeIn ? LP.swap.quote(p, sizeIn, dir, f) : null;
      if (q) {
        fill = q.fill; impact = q.impact; feePaid = q.feePaid * (d > 0 ? 1 : fill);
        if (d > 0) { x1 = p.base - q.out; y1 = p.quote + sizeIn; }
        else { x1 = p.base + sizeIn; y1 = p.quote - q.out; }
      }
    }
    const spotAfter = y1 / x1;

    $('poolV').textContent = state.ethReserve.toLocaleString('en-US') + ' ETH · ' +
      money(state.ethReserve * 3000 * 2);
    $('tradeV').textContent = (d > 0 ? 'buy ' : d < 0 ? 'sell ' : '') + Math.abs(d).toFixed(1) + ' ETH';
    $('cSpot0').textContent = px(mid);
    $('cSpot1').textContent = px(spotAfter);
    $('cFill').textContent = d ? px(fill) : '—';
    $('cImpact').textContent = d ? pct(impact * 100, 3) : '—';
    $('cRes').textContent = x1.toFixed(2) + ' ETH / ' + Math.round(y1).toLocaleString('en-US');
    $('cFee').textContent = d ? px(Math.abs(feePaid)) : '—';
    $('cK').textContent = Math.round(p.base * p.quote).toLocaleString('en-US');

    // --- plot -------------------------------------------------------------
    const W = 600, H = 400, L = 62, R = 18, T = 18, B = 42;
    const xMax = p.base * 2.4, yMax = p.quote * 2.4;
    const sx = (v) => L + (v / xMax) * (W - L - R);
    const sy = (v) => T + (1 - v / yMax) * (H - T - B);
    const K = p.base * p.quote;

    let g = `<defs><clipPath id="labclip"><rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}"/></clipPath></defs>`;
    for (let i = 0; i <= 4; i++) {
      const v = (xMax * i) / 4;
      g += `<line class="lg" x1="${sx(v).toFixed(1)}" x2="${sx(v).toFixed(1)}" y1="${T}" y2="${H - B}"/>
            <text x="${sx(v).toFixed(1)}" y="${H - B + 16}" text-anchor="middle">${v.toFixed(0)}</text>`;
    }
    for (let i = 0; i <= 4; i++) {
      const v = (yMax * i) / 4;
      g += `<line class="lg" x1="${L}" x2="${W - R}" y1="${sy(v).toFixed(1)}" y2="${sy(v).toFixed(1)}"/>
            <text x="${L - 7}" y="${(sy(v) + 4).toFixed(1)}" text-anchor="end">${kfmt(v)}</text>`;
    }
    g += `<text x="${(L + W - R) / 2}" y="${H - 5}" text-anchor="middle">x · ETH reserve</text>
          <text transform="translate(13 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle">y · USDC reserve</text>`;

    let path = '';
    const xLo = p.base * 0.18;
    for (let i = 0; i <= 260; i++) {
      const x = xLo + (xMax - xLo) * (i / 260);
      path += (path ? 'L' : 'M') + sx(x).toFixed(1) + ' ' + sy(K / x).toFixed(1);
    }

    g += `<g clip-path="url(#labclip)">`;
    // Tangent at the start point: slope is the spot price.
    g += `<line class="ltan" x1="${sx(0)}" y1="${sy(p.quote + mid * p.base).toFixed(1)}"
            x2="${sx(xMax)}" y2="${sy(p.quote - mid * (xMax - p.base)).toFixed(1)}"/>`;
    g += `<path class="lcurve" d="${path}"/>`;
    if (d !== 0) {
      g += `<line class="lchord" x1="${sx(p.base).toFixed(1)}" y1="${sy(p.quote).toFixed(1)}"
              x2="${sx(x1).toFixed(1)}" y2="${sy(y1).toFixed(1)}"/>
            <circle class="lp1" cx="${sx(x1).toFixed(1)}" cy="${sy(y1).toFixed(1)}" r="5.5"/>`;
    }
    g += `<circle class="lp0" cx="${sx(p.base).toFixed(1)}" cy="${sy(p.quote).toFixed(1)}" r="5.5"/></g>`;
    $('curveSvg').innerHTML = g;
  }

  function kfmt(v) {
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return Math.round(v / 1e3) + 'k';
    return String(Math.round(v));
  }

  /* --------------------------------------------------------------- 2. depth */

  function drawDepth() {
    const f = state.fee;
    const sizes = [1e3, 1e4, 1e5, 1e6];
    const pools = [
      ['Thin · $50k', 50e3],
      ['Small · $500k', 500e3],
      ['Mid · $5M', 5e6],
      ['Deep · $100M', 100e6]
    ];
    const head = '<tr><th>Pool</th>' + sizes.map((s) => '<th class="num">' + money(s) + ' buy</th>').join('') + '</tr>';
    const body = pools.map(([name, usd]) => {
      const half = usd / 2;
      const px = 3000;
      const pl = { base: half / px, quote: half, baseUsd: px, quoteUsd: 1 };
      const cells = sizes.map((s) => {
        const q = LP.swap.costOfUsd(pl, s, 'buyBase', f);
        if (!q) return '<td class="num muted">—</td>';
        const cls = q.lostPct > 5 ? 'down' : q.lostPct > 1 ? '' : 'up';
        return `<td class="num ${cls}">${pct(q.lostPct, 2)}</td>`;
      }).join('');
      return `<tr><td>${esc(name)}</td>${cells}</tr>`;
    }).join('');
    $('depthTbl').innerHTML = '<thead>' + head + '</thead><tbody>' + body + '</tbody>';
    $('depthFee').textContent = pct(f * 100, 2);
  }

  /* --------------------------------------------------------------- 3. splitting */

  function splitCost(total, pieces, f) {
    // Replay the trade piece by piece against a 100/100 pool, exactly as the lecture does.
    let X = 100, Y = 100, spent = 0;
    const d = total / pieces;
    for (let i = 0; i < pieces; i++) {
      const c = LP.swap.amountIn(d, X, Y, f);
      if (c === null) return null;
      X += c; Y -= d; spent += c;
    }
    return spent;
  }

  function drawSplit() {
    const tot = state.splitTotal, n = state.splitPieces, f = state.splitFee;
    $('splitTotV').textContent = tot + ' token B';
    $('splitNV').textContent = n + (n === 1 ? ' trade' : ' trades');

    const one = splitCost(tot, 1, f);
    const many = splitCost(tot, n, f);
    const extra = many - one;
    $('sOne').textContent = one.toFixed(4) + ' A';
    $('sMany').textContent = many.toFixed(4) + ' A';
    $('sExtra').textContent = (Math.abs(extra) < 1e-9 ? 'identical' : '+' + extra.toFixed(4) + ' A') +
      (one > 0 ? '  (' + sgn((extra / one) * 100, 3) + ')' : '');
    $('sExtra').className = 'm-value ' + (extra > 1e-9 ? 'down' : '');

    $('splitVerdict').textContent = f === 0
      ? 'With no fee the two are identical to the last decimal: the curve is path-independent, so ' +
        'how you slice a trade cannot change its cost.'
      : 'With a fee, each piece leaves its fee in the pool and nudges k upward, so every later ' +
        'piece buys on a slightly worse curve. Splitting always costs more.';

    // --- plot cost vs number of pieces ------------------------------------
    const W = 560, H = 260, L = 76, R = 16, T = 16, B = 40;
    const vals = [];
    for (let i = 1; i <= 60; i++) { const v = splitCost(tot, i, f); if (v !== null) vals.push({ n: i, v }); }
    if (!vals.length) { $('splitSvg').innerHTML = ''; return; }
    let lo = Math.min.apply(null, vals.map((a) => a.v));
    let hi = Math.max.apply(null, vals.map((a) => a.v));
    if (hi - lo < Math.max(lo, 1e-9) * 1e-9) { lo *= 0.999; hi *= 1.001; }
    const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
    const sx = (v) => L + ((v - 1) / 59) * (W - L - R);
    const sy = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

    let g = '';
    [1, 15, 30, 45, 60].forEach((v) => {
      g += `<line class="lg" x1="${sx(v).toFixed(1)}" x2="${sx(v).toFixed(1)}" y1="${T}" y2="${H - B}"/>
            <text x="${sx(v).toFixed(1)}" y="${H - B + 16}" text-anchor="middle">${v}</text>`;
    });
    for (let i = 0; i <= 4; i++) {
      const v = lo + ((hi - lo) * i) / 4;
      g += `<line class="lg" x1="${L}" x2="${W - R}" y1="${sy(v).toFixed(1)}" y2="${sy(v).toFixed(1)}"/>
            <text x="${L - 7}" y="${(sy(v) + 4).toFixed(1)}" text-anchor="end">${v.toFixed(3)}</text>`;
    }
    g += `<text x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle">number of equal pieces</text>`;
    g += `<path class="lcurve" d="${vals.map((a, i) => (i ? 'L' : 'M') + sx(a.n).toFixed(1) + ' ' + sy(a.v).toFixed(1)).join('')}"/>`;
    const here = vals.find((a) => a.n === n);
    if (here) g += `<circle class="lp1" cx="${sx(n).toFixed(1)}" cy="${sy(here.v).toFixed(1)}" r="5.5"/>`;
    $('splitSvg').innerHTML = g;
  }

  /* --------------------------------------------------------------- 4. IL */

  function drawIL() {
    const r = 1 + state.priceMove / 100;
    const il = LP.analyze.ilV2(r) * 100;
    $('moveV').textContent = sgn(state.priceMove, 0);
    $('ilNow').textContent = pct(il, 3);
    $('ilHodl').textContent = px(state.positionUsd * (1 + r) / 2);
    $('ilLp').textContent = px(state.positionUsd * Math.sqrt(r));
    $('ilGap').textContent = px(state.positionUsd * Math.sqrt(r) - state.positionUsd * (1 + r) / 2);

    const clIl = LP.analyze.ilCl(r, 1, 1 - state.rangeW, 1 + state.rangeW);
    const eff = LP.analyze.capitalEfficiency(1, 1 - state.rangeW, 1 + state.rangeW);
    $('rangeV').textContent = '±' + (state.rangeW * 100).toFixed(0) + '%';
    $('clEff').textContent = eff ? U().ratio(eff, 1) + '×' : '—';
    $('clIl').textContent = clIl === null ? '—' : pct(clIl * 100, 3);
    $('clRatio').textContent = (clIl === null || Math.abs(il) < 1e-9)
      ? '—' : U().ratio((clIl * 100) / il, 1) + '× the full-range loss';

    const W = 600, H = 320, L = 58, R = 16, T = 16, B = 42;
    const lo = Math.log(0.25), hi = Math.log(4);
    const sx = (rr) => L + ((Math.log(rr) - lo) / (hi - lo)) * (W - L - R);
    const yMin = -0.45, yMax = 0.06;
    const sy = (v) => T + (1 - (v - yMin) / (yMax - yMin)) * (H - T - B);

    let g = '';
    [0.25, 0.5, 1, 2, 4].forEach((v) => {
      g += `<line class="lg" x1="${sx(v).toFixed(1)}" x2="${sx(v).toFixed(1)}" y1="${T}" y2="${H - B}"/>
            <text x="${sx(v).toFixed(1)}" y="${H - B + 16}" text-anchor="middle">${v === 1 ? '0%' : sgn((v - 1) * 100, 0)}</text>`;
    });
    for (let v = 0; v >= yMin; v -= 0.1) {
      g += `<line class="${Math.abs(v) < 1e-9 ? 'lzero' : 'lg'}" x1="${L}" x2="${W - R}" y1="${sy(v).toFixed(1)}" y2="${sy(v).toFixed(1)}"/>
            <text x="${L - 7}" y="${(sy(v) + 4).toFixed(1)}" text-anchor="end">${(v * 100).toFixed(0)}%</text>`;
    }
    g += `<text x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle">price ratio r (log scale)</text>`;

    let full = '', conc = '';
    for (let i = 0; i <= 240; i++) {
      const rr = Math.exp(lo + ((hi - lo) * i) / 240);
      full += (full ? 'L' : 'M') + sx(rr).toFixed(1) + ' ' + sy(LP.analyze.ilV2(rr)).toFixed(1);
      const c = LP.analyze.ilCl(rr, 1, 1 - state.rangeW, 1 + state.rangeW);
      if (c !== null) conc += (conc ? 'L' : 'M') + sx(rr).toFixed(1) + ' ' + sy(Math.max(c, yMin)).toFixed(1);
    }
    g += `<path class="lil" d="${full}"/><path class="lilc" d="${conc}"/>`;
    g += `<line class="lmark" x1="${sx(r).toFixed(1)}" x2="${sx(r).toFixed(1)}" y1="${T}" y2="${H - B}"/>
          <circle class="lp1" cx="${sx(r).toFixed(1)}" cy="${sy(il / 100).toFixed(1)}" r="5"/>`;
    $('ilSvg').innerHTML = g;
  }

  /* --------------------------------------------------------------- 5. arbitrage */

  function drawArb() {
    const p = pool();
    const f = state.fee;
    const mid = p.quote / p.base;
    const a = LP.swap.arbSize(p, state.external, f);
    const net = a.dir === 'none' ? 0 : a.grossUsd - state.gas;

    $('extV').textContent = px(state.external);
    $('gasV').textContent = px(state.gas);
    $('aAction').textContent = a.dir === 'none'
      ? 'No trade — inside the fee band'
      : a.dir === 'buyBase' ? 'Buy ETH from the pool, sell it outside'
      : 'Buy ETH outside, sell it into the pool';
    $('aSize').textContent = a.dir === 'none' ? '—' : Math.abs(a.sizeBase).toFixed(3) + ' ETH';
    $('aAfter').textContent = px(a.priceAfter);
    $('aGross').textContent = px(a.grossUsd);
    $('aNet').textContent = a.dir === 'none' ? '—' : px(net);
    $('aNet').className = 'm-value ' + (net > 0 ? 'up' : net < 0 ? 'down' : '');

    const lower = mid * (1 - f), upper = mid / (1 - f);
    $('aBand').textContent = px(lower) + ' – ' + px(upper) + '  (±' + pct((f / (1 - f)) * 100, 3) + ')';

    const W = 600, H = 250, L = 64, R = 16, T = 16, B = 40;
    const pLo = mid * 0.6, pHi = mid * 1.45;
    const sx = (v) => L + ((v - pLo) / (pHi - pLo)) * (W - L - R);
    let maxNet = 0;
    const pts = [];
    for (let i = 0; i <= 240; i++) {
      const px = pLo + ((pHi - pLo) * i) / 240;
      const r = LP.swap.arbSize(p, px, f);
      const n = r.dir === 'none' ? 0 : Math.max(r.grossUsd - state.gas, 0);
      pts.push({ px, n });
      if (n > maxNet) maxNet = n;
    }
    const top = Math.max(maxNet, 1);
    const sy = (v) => T + (1 - v / top) * (H - T - B);

    let g = `<rect class="lband" x="${sx(lower).toFixed(1)}" y="${T}"
              width="${(sx(upper) - sx(lower)).toFixed(1)}" height="${H - T - B}"/>`;
    for (let i = 0; i <= 4; i++) {
      const v = pLo + ((pHi - pLo) * i) / 4;
      g += `<line class="lg" x1="${sx(v).toFixed(1)}" x2="${sx(v).toFixed(1)}" y1="${T}" y2="${H - B}"/>
            <text x="${sx(v).toFixed(1)}" y="${H - B + 16}" text-anchor="middle">${px(v)}</text>`;
    }
    for (let i = 0; i <= 4; i++) {
      const v = (top * i) / 4;
      g += `<line class="lg" x1="${L}" x2="${W - R}" y1="${sy(v).toFixed(1)}" y2="${sy(v).toFixed(1)}"/>
            <text x="${L - 7}" y="${(sy(v) + 4).toFixed(1)}" text-anchor="end">${kfmt(v)}</text>`;
    }
    g += `<text x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle">price outside the pool (pool mid ${px(mid)})</text>`;
    g += `<path class="lprofit" d="${pts.map((a2, i) => (i ? 'L' : 'M') + sx(a2.px).toFixed(1) + ' ' + sy(a2.n).toFixed(1)).join('')}"/>`;
    g += `<line class="lmark" x1="${sx(state.external).toFixed(1)}" x2="${sx(state.external).toFixed(1)}" y1="${T}" y2="${H - B}"/>
          <circle class="lp1" cx="${sx(state.external).toFixed(1)}" cy="${sy(Math.max(net, 0)).toFixed(1)}" r="5"/>`;
    $('arbSvg').innerHTML = g;
  }

  /* --------------------------------------------------------------- wiring */

  function drawAll() { drawCurve(); drawDepth(); drawSplit(); drawIL(); drawArb(); }

  function bind(id, key, transform) {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      if (!Number.isFinite(v)) return;
      state[key] = transform ? transform(v) : v;
      drawAll();
    });
  }

  function init() {
    bind('trade', 'tradeEth');
    bind('poolSize', 'ethReserve', (v) => {
      // Keep the pool at $3,000 a coin however large it gets, and rescale the trade slider
      // with it so the demo stays interesting at every depth.
      state.usdcReserve = v * 3000;
      const tr = $('trade');
      if (tr) {
        const span = Math.max(2, Math.round(v * 0.6));
        tr.min = -span; tr.max = span; tr.step = Math.max(0.1, +(span / 120).toFixed(2));
        if (Math.abs(state.tradeEth) > span) state.tradeEth = Math.sign(state.tradeEth) * span;
        tr.value = state.tradeEth;
      }
      return v;
    });
    bind('splitTot', 'splitTotal');
    bind('splitN', 'splitPieces');
    bind('move', 'priceMove');
    bind('rangeW', 'rangeW', (v) => v / 100);
    bind('ext', 'external');
    bind('gas', 'gas');

    ['fee', 'splitFeeSel'].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('change', () => {
        if (id === 'fee') state.fee = parseFloat(el.value);
        else state.splitFee = parseFloat(el.value);
        drawAll();
      });
    });

    drawAll();
  }

  return { init, state, splitCost };
})();

document.addEventListener('DOMContentLoaded', LP.lab.init);
