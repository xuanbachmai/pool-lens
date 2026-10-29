/*
 * The hero figure: impermanent loss, drawn rather than described.
 *
 * The thesis of this whole app is one picture. A pool sits on the curve x*y = k. When the price
 * moves, the pool slides along that curve and rebalances you into whichever asset is falling,
 * while someone who simply held sits on the straight line through their starting basket. The
 * gap between the curve and that line IS the impermanent loss, and it is the thing every yield
 * figure has to beat.
 *
 * Everything here is computed from the real constant-product relation and the same closed form
 * the analyser uses, so the shaded gap is the actual loss at the marked price, not an artist's
 * impression. The number printed on it is evaluated, not typed.
 *
 * Colours come from the theme tokens, so one drawing serves both palettes.
 */
window.LP = window.LP || {};

LP.hero = (function () {

  const W = 560, H = 400;
  const M = { l: 46, r: 30, t: 26, b: 44 };
  const PW = W - M.l - M.r;
  const PH = H - M.t - M.b;

  /*
   * A pool holding x of the base and y of the quote, so k = x*y. The price is y/x, so a price
   * move to m times the start puts the pool at x' = x0/sqrt(m), y' = y0*sqrt(m).
   */
  const X0 = 10, Y0 = 10;
  const K = X0 * Y0;
  const MOVE = 2;    // the price multiple shown, matching the -5.72% quoted on the page

  const xAt = (m) => X0 / Math.sqrt(m);
  const yAt = (m) => Y0 * Math.sqrt(m);

  // Plot bounds, in token units.
  const xMax = 22, yMax = 22;
  const px = (x) => M.l + (x / xMax) * PW;
  const py = (y) => M.t + PH - (y / yMax) * PH;

  function curvePath() {
    const pts = [];
    for (let i = 0; i <= 160; i++) {
      const x = 2.6 + (i / 160) * (xMax - 2.6);
      const y = K / x;
      if (y > yMax) continue;
      pts.push(px(x).toFixed(1) + ' ' + py(y).toFixed(1));
    }
    return 'M' + pts.join(' L');
  }

  function render() {
    const il = (r) => (window.LP && LP.analyze) ? LP.analyze.ilV2(r)
      : (2 * Math.sqrt(r)) / (1 + r) - 1;

    const x1 = xAt(MOVE), y1 = yAt(MOVE);

    /*
     * The price, not its square root. The multiple applies to the price directly; the square
     * roots live in the quantities (x = x0/sqrt(m), y = y0*sqrt(m)). Using sqrt(m) here made
     * both value lines land on identical totals, so the gap they are drawn to show collapsed
     * to a degenerate sliver.
     */
    const p1 = MOVE;

    // Value of a basket in quote units at the new price: x*p + y.
    const holdY = X0 * p1 + Y0;           // the two tokens, simply kept
    const poolY = x1 * p1 + y1;           // what the pool rebalanced you into

    // The loss, from the same closed form the analyser uses.
    const loss = il(MOVE);
    const lossPct = (loss * 100).toFixed(2);

    /*
     * A constant-value line is y = total - x*p. Clipped to the plot box properly: entering at
     * the top edge when the intercept is above it, leaving at the right edge when it would run
     * past. Clamping both endpoints to the corners, as the first version did, flattened the two
     * lines onto each other.
     */
    const clipLine = (total) => {
      let ax, ay;
      if (total <= yMax) { ax = 0; ay = total; }
      else { ay = yMax; ax = (total - yMax) / p1; }
      let bx, by;
      if (total / p1 <= xMax) { bx = total / p1; by = 0; }
      else { bx = xMax; by = total - xMax * p1; }
      return { x0: ax, y0: ay, x1: bx, y1: by };
    };
    const cp = clipLine(poolY), ch = clipLine(holdY);

    return `
<svg viewBox="0 0 ${W} ${H}" role="img" xmlns="http://www.w3.org/2000/svg"
  aria-label="The constant-product curve. After a ${MOVE}x price move the pool sits below the
  value of simply holding, and the gap is ${lossPct}% — the impermanent loss.">

  <defs>
    <linearGradient id="heroGap" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--bad)" stop-opacity="0.26"/>
      <stop offset="100%" stop-color="var(--bad)" stop-opacity="0.04"/>
    </linearGradient>
  </defs>

  <!-- axes -->
  <line x1="${M.l}" y1="${M.t}" x2="${M.l}" y2="${M.t + PH}"
    stroke="var(--line)" stroke-width="1" fill="none"/>
  <line x1="${M.l}" y1="${M.t + PH}" x2="${M.l + PW}" y2="${M.t + PH}"
    stroke="var(--line)" stroke-width="1" fill="none"/>
  <text x="${M.l + PW / 2}" y="${H - 10}" text-anchor="middle" font-size="12"
    fill="var(--muted)" font-family="var(--sans)">tokens of the asset that fell</text>
  <text x="15" y="${M.t + PH / 2}" text-anchor="middle" font-size="12" fill="var(--muted)"
    font-family="var(--sans)" transform="rotate(-90 15 ${M.t + PH / 2})">tokens of the one that rose</text>

  <!-- the gap between holding and the pool: this is the loss -->
  <polygon points="${px(ch.x0)},${py(ch.y0)} ${px(ch.x1)},${py(ch.y1)}
    ${px(cp.x1)},${py(cp.y1)} ${px(cp.x0)},${py(cp.y0)}"
    fill="url(#heroGap)"/>

  <!-- what holding would have been worth -->
  <line x1="${px(ch.x0)}" y1="${py(ch.y0)}" x2="${px(ch.x1)}" y2="${py(ch.y1)}"
    stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="5 4" fill="none"/>
  <text x="${px(ch.x1) - 4}" y="${py(ch.y1) - 10}" text-anchor="end" font-size="12.5"
    fill="var(--muted)" font-family="var(--sans)">if you had just held</text>

  <!-- the constant-product curve itself -->
  <path d="${curvePath()}" fill="none" stroke="var(--accent)" stroke-width="2.5"
    stroke-linecap="round"/>

  <!-- where you started -->
  <circle cx="${px(X0)}" cy="${py(Y0)}" r="5" fill="var(--bg)"
    stroke="var(--accent)" stroke-width="2.5"/>
  <text x="${px(X0) + 12}" y="${py(Y0) - 8}" font-size="12.5" fill="var(--text)"
    font-family="var(--sans)">you deposit here</text>

  <!-- where the pool put you after the move -->
  <circle cx="${px(x1)}" cy="${py(y1)}" r="5.5" fill="var(--bad)"/>
  <text x="${px(x1) + 13}" y="${py(y1) + 5}" font-size="12.5" fill="var(--text)"
    font-family="var(--sans)">the price moves ${MOVE}×</text>

  <!-- the measured loss -->
  <g transform="translate(${M.l + 14}, ${M.t + 8})">
    <text x="0" y="14" font-size="26" font-weight="650" fill="var(--bad)"
      font-family="var(--mono)">${lossPct}%</text>
    <text x="0" y="33" font-size="12.5" fill="var(--muted)"
      font-family="var(--sans)">behind holding, before any fees</text>
  </g>

  <text x="${M.l + PW}" y="${M.t + PH - 8}" text-anchor="end" font-size="12.5"
    fill="var(--accent)" font-family="var(--mono)" opacity="0.75">x · y = k</text>
</svg>`;
  }

  function mount() {
    const slot = document.getElementById('heroFigure');
    if (slot) slot.innerHTML = render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else { mount(); }

  return { render, mount };
})();
