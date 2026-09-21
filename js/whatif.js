/*
 * The "what if this number changes" panel, and the formula catalogue.
 *
 * Sliders drive LP.model.evaluate directly, so nothing here is a re-derivation of the main
 * analysis -- it is the same maths with one input moved. Recomputes are local: dragging a
 * slider rewrites only the output blocks, so the drag stays smooth and no API call is made.
 */
window.LP = window.LP || {};

LP.whatif = (function () {
  const U = () => LP.util;
  const esc = (s) => LP.util.escapeHtml(s);

  const local = { overrides: {}, driver: 'V', tornadoPct: 25, result: null, base: null };

  /* ---------------------------------------------------------------- slider scales */

  const SCALE = {
    V: { log: true, span: 10 },
    R: { log: true, span: 10 },
    Q: { log: true, min: 100, max: 5e6 },
    f: { log: true, min: 0.0001, max: 0.01 },
    s: { log: false, min: 0, max: 1 },
    T: { log: false, min: 1, max: 365 },
    r: { log: true, min: 0.25, max: 4 },
    w: { log: false, min: 0.005, max: 0.95 }
  };

  function bounds(key, base) {
    const c = SCALE[key] || { log: false, min: 0, max: base * 2 };
    if (c.min !== undefined && c.max !== undefined) return { lo: c.min, hi: c.max, log: c.log };
    const span = c.span || 4;
    return { lo: Math.max(base / span, 1e-9), hi: base * span, log: c.log };
  }

  function toSlider(key, base, v) {
    const b = bounds(key, base);
    const t = b.log
      ? (Math.log(Math.max(v, b.lo)) - Math.log(b.lo)) / (Math.log(b.hi) - Math.log(b.lo))
      : (v - b.lo) / (b.hi - b.lo);
    return Math.round(U().clamp(t, 0, 1) * 1000);
  }

  function fromSlider(key, base, t) {
    const b = bounds(key, base);
    const u = U().clamp(t / 1000, 0, 1);
    const v = b.log ? Math.exp(Math.log(b.lo) + u * (Math.log(b.hi) - Math.log(b.lo)))
      : b.lo + u * (b.hi - b.lo);
    return LP.model.clampDriver(key, v);
  }

  /* ------------------------------------------------------------------ formatting */

  function fmt(unit, v) {
    const u = U();
    switch (unit) {
      case 'usd': return u.usd(v);
      case 'feepct': return (v * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + '%';
      case 'sharepct': return Math.round(v * 100) + '%';
      case 'days': return Math.round(v) + ' d';
      case 'ratio': return '×' + v.toFixed(3) + ' (' + u.signedPct((v - 1) * 100, 1) + ')';
      case 'widthpct': return '±' + (v * 100).toFixed(1) + '%';
      default: return u.ratio(v, 3);
    }
  }

  function params() {
    return LP.model.paramsFrom(local.result, local.overrides);
  }

  /* ----------------------------------------------------------------- what-if card */

  function render(r) {
    local.result = r;
    local.base = LP.model.paramsFrom(r, {});
    // Drop overrides that no longer apply (e.g. switching from a CL pool to a v2 pool).
    if (!r.isCl) delete local.overrides.w;

    const p = params();
    const drivers = LP.model.driversFor(p);

    const sliders = drivers.map((d) => {
      const base = local.base[d.key];
      const cur = p[d.key];
      const changed = Math.abs(cur - base) > Math.abs(base) * 1e-6;
      return `
      <div class="wi-row ${changed ? 'changed' : ''}">
        <div class="wi-head">
          <label for="wi-${d.key}"><strong>${esc(d.label)}</strong> <code>${esc(d.key)}</code></label>
          <span class="wi-val" id="wiVal-${d.key}">${fmt(d.unit, cur)}</span>
        </div>
        <input type="range" id="wi-${d.key}" min="0" max="1000" step="1"
          value="${toSlider(d.key, base, cur)}" data-key="${d.key}" data-unit="${d.unit}">
        <div class="wi-foot">
          <span class="muted">${esc(d.hint)}</span>
          <span class="wi-base" id="wiBase-${d.key}">${changed
            ? 'was ' + fmt(d.unit, base) + ' · <button class="link" data-reset="' + d.key + '">reset</button>'
            : 'actual'}</span>
        </div>
      </div>`;
    }).join('');

    return `
    <section class="card whatif">
      <h3>What if a number changes?</h3>
      <p class="muted">Every input below is the real measured value for this pool. Move one and
      watch the outcome move — this is the same model the analysis above uses, with a single term
      replaced. Nothing here refetches data.</p>

      <div class="wi-grid">
        <div class="wi-controls">${sliders}
          <div class="wi-actions">
            <button class="btn secondary" id="wiResetAll">Reset all to actual</button>
            <button class="btn secondary" id="wiTodayVol">Use today's volume (${U().usd(local.base.todayV)})</button>
          </div>
          <p class="fineprint">Volume base is the <strong>${esc(local.base.vSource)}</strong>, not the
          last 24 hours, so the base case lines up with the historical replay rather than one busy day.</p>
        </div>
        <div class="wi-out" id="wiOutputs">${renderOutputs(p)}</div>
      </div>

      <h4>Which input matters most</h4>
      <p class="muted">Every driver moved ±<span id="wiTornadoPct">${local.tornadoPct}</span>% on its own,
      from the base case. The widest bar is the number worth being right about.</p>
      <div class="wi-tornado-ctl">
        <label>Perturbation
          <input type="range" id="wiTornadoRange" min="5" max="75" step="5" value="${local.tornadoPct}">
        </label>
      </div>
      <div id="wiTornado">${renderTornado(p)}</div>

      <h4>Sweep one input</h4>
      <div class="wi-sweep-ctl">
        <label>Driver
          <select id="wiDriver">
            ${drivers.map((d) => '<option value="' + d.key + '"' +
              (d.key === local.driver ? ' selected' : '') + '>' + esc(d.label) + '</option>').join('')}
          </select>
        </label>
      </div>
      <div id="wiSweep">${renderSweep(p)}</div>

      <h4>How far can each input move before you would rather have just held?</h4>
      <div id="wiBreakeven">${renderBreakeven(p)}</div>

      <h4>Net result across price move and volume</h4>
      <div id="wiGrid">${renderGrid(p)}</div>
    </section>`;
  }

  function renderOutputs(p) {
    const u = U();
    const m = LP.model.evaluate(p);
    const b = LP.model.evaluate(local.base);
    const delta = (cur, base, digits) => {
      const d = cur - base;
      if (Math.abs(d) < 5e-4) return '<span class="wi-delta flat">no change</span>';
      return '<span class="wi-delta ' + (d > 0 ? 'up' : 'down') + '">' +
        u.signedPct(d, digits === undefined ? 2 : digits) + ' vs base</span>';
    };

    return `
      <div class="wi-out-main ${m.netPct >= 0 ? 'good' : 'bad'}">
        <span class="wi-out-label">Net vs holding, over ${Math.round(p.T)} days</span>
        <span class="wi-out-value">${u.signedPct(m.netPct, 2)}</span>
        <span class="wi-out-sub">${u.usd(m.netUsd)} on a ${u.usd(p.Q)} position · ${delta(m.netPct, b.netPct)}</span>
      </div>
      <div class="wi-out-list">
        <div><span>Fees earned</span><strong class="up">${u.pct(m.feeYieldPct, 2)}</strong>
          <em>${u.usd(m.feesUsd)} · ${delta(m.feeYieldPct, b.feeYieldPct)}</em></div>
        <div><span>Impermanent loss</span><strong class="down">${u.pct(m.ilPct, 2)}</strong>
          <em>${u.usd(m.ilUsd)} · ${delta(m.ilPct, b.ilPct)}</em></div>
        <div><span>Fee APR</span><strong>${u.pct(m.feeAprPct, 1)}</strong>
          <em>${delta(m.feeAprPct, b.feeAprPct, 1)}</em></div>
        <div><span>Your share of the pool</span><strong>${u.pct(m.share * 100, 4)}</strong>
          <em>${p.R > 0 ? 'diluted from ' + u.pct((m.E * p.Q / p.R) * 100, 4) + ' undiluted' : ''}</em></div>
        ${m.isCl ? `<div><span>Concentration × active volume</span><strong>${u.ratio(m.E * m.tauVol, 2)}×</strong>
          <em>${u.ratio(m.E, 1)}× boost · in range ${u.pct(m.tau * 100, 0)} of days,
          carrying ${u.pct(m.tauVol * 100, 0)} of the volume</em></div>` : ''}
      </div>`;
  }

  function renderTornado(p) {
    const u = U();
    const rows = LP.model.tornado(p, local.tornadoPct, 'netPct');
    if (!rows.length) return '';
    const base = rows[0].base;
    const lo = Math.min.apply(null, rows.map((x) => x.low).concat([base]));
    const hi = Math.max.apply(null, rows.map((x) => x.high).concat([base]));
    const span = (hi - lo) || 1;
    const W = 560, rowH = 30, padL = 178, padR = 62;
    const H = rows.length * rowH + 26;
    const x = (v) => padL + ((v - lo) / span) * (W - padL - padR);

    const bars = rows.map((row, i) => {
      const y = 20 + i * rowH;
      const x1 = x(row.low), x2 = x(row.high);
      return `
        <text x="${padL - 10}" y="${y + 13}" class="tl" text-anchor="end">${esc(row.label)}</text>
        <rect x="${x1.toFixed(1)}" y="${y + 3}" width="${Math.max(1.5, x2 - x1).toFixed(1)}" height="16"
          rx="3" class="tb"></rect>
        <text x="${(x2 + 6).toFixed(1)}" y="${y + 15}" class="tv">${u.signedPct(row.high, 1)}</text>
        <text x="${(x1 - 6).toFixed(1)}" y="${y + 15}" class="tv" text-anchor="end">${u.signedPct(row.low, 1)}</text>`;
    }).join('');

    return `
      <svg class="tornado" viewBox="0 0 ${W} ${H}" role="img"
        aria-label="Tornado chart of net return sensitivity to each input">
        <line x1="${x(base).toFixed(1)}" y1="14" x2="${x(base).toFixed(1)}" y2="${H - 4}" class="tbase"></line>
        ${bars}
      </svg>
      <p class="fineprint">Vertical line is the base case (${u.signedPct(base, 2)}). Bars show where net
      return lands when that one input is ${local.tornadoPct}% lower or higher, everything else held.</p>`;
  }

  function renderSweep(p) {
    const u = U();
    const key = local.driver;
    const d = LP.model.DRIVERS.find((x) => x.key === key);
    if (!d) return '';
    const base = local.base[key];
    const b = bounds(key, base);
    const N = 13;
    const values = [];
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      values.push(b.log ? Math.exp(Math.log(b.lo) + t * (Math.log(b.hi) - Math.log(b.lo)))
        : b.lo + t * (b.hi - b.lo));
    }
    const rows = LP.model.sweep(p, key, values.map((v) => LP.model.clampDriver(key, v)));
    const elasN = LP.model.elasticity(p, key, 'netPct');
    const elasF = LP.model.elasticity(p, key, 'feeYieldPct');

    const body = rows.map((row) => {
      const isBase = Math.abs(row.value - p[key]) < Math.abs(p[key]) * 0.04;
      return `<tr class="${isBase ? 'here' : ''}">
        <td class="num">${fmt(d.unit, row.value)}</td>
        <td class="num up">${u.pct(row.feeYieldPct, 2)}</td>
        <td class="num down">${u.pct(row.ilPct, 2)}</td>
        <td class="num"><span class="${row.netPct >= 0 ? 'up' : 'down'}">${u.signedPct(row.netPct, 2)}</span></td>
        ${p.isCl && p.w ? '<td class="num">' + u.ratio(row.E, 1) + '× / ' + u.pct(row.tau * 100, 0) + '</td>' : ''}
      </tr>`;
    }).join('');

    /*
     * Elasticity is a ratio, not a percentage-point move, and net return is often a small number
     * -- an elasticity of 8 on a +0.8% net means a 1% input change is worth 0.07pp, not 8pp.
     * Spelling both out avoids the obvious misreading.
     */
    const baseNet = LP.model.evaluate(p).netPct;
    const ppPerPct = elasN === null ? null : (elasN * baseNet) / 100;

    return `
      <p class="muted">${esc(d.hint)}
        ${elasN === null ? '' : ' A 1% change in ' + esc(d.label.toLowerCase()) + ' moves net return by ' +
          '<strong>' + u.ratio(Math.abs(ppPerPct), 3) + ' percentage points</strong> ' +
          (elasN < 0 ? 'in the opposite direction' : 'in the same direction') +
          ' — an elasticity of ' + u.ratio(elasN, 2) + ' relative to the current ' +
          u.signedPct(baseNet, 2) + '.'}
        ${elasF === null ? '' : ' Fee income alone has elasticity <strong>' + u.ratio(elasF, 2) +
          '</strong> to this input.'}</p>
      <table>
        <thead><tr><th class="num">${esc(d.label)}</th><th class="num">Fees</th><th class="num">IL</th>
          <th class="num">Net vs holding</th>${p.isCl && p.w ? '<th class="num">E / in range</th>' : ''}</tr></thead>
        <tbody>${body}</tbody>
      </table>`;
  }

  function renderBreakeven(p) {
    const u = U();
    const drivers = LP.model.driversFor(p);
    const rows = drivers.map((d) => {
      const base = p[d.key];
      const b = bounds(d.key, local.base[d.key]);
      // Widen the search a little so a break-even just outside the slider range is still found.
      const lo = d.key === 'r' ? 0.05 : Math.max(b.lo / 5, 1e-9);
      const hi = d.key === 'r' ? 20 : b.hi * 5;
      const roots = LP.model.solve(p, d.key, 'netPct', 0, lo, hi);
      if (!roots.length) {
        return { d, text: 'No break-even in a plausible range — net return keeps the same sign.' };
      }
      const parts = roots.map((v) => {
        const move = base > 0 ? ((v - base) / base) * 100 : null;
        return fmt(d.unit, v) + (move === null ? '' : ' (' + u.signedPct(move, 0) + ')');
      });
      return { d, text: parts.join('  or  '), roots };
    });

    const body = rows.map((row) => `
      <tr>
        <td>${esc(row.d.label)}</td>
        <td class="num">${fmt(row.d.unit, p[row.d.key])}</td>
        <td>${esc(row.text)}</td>
      </tr>`).join('');

    return `
      <p class="muted">Holding everything else at the base case, the value each input would have to
      reach for this position to exactly match holding the two tokens.</p>
      <table>
        <thead><tr><th>Input</th><th class="num">Now</th><th>Break-even</th></tr></thead>
        <tbody>${body}</tbody>
      </table>`;
  }

  function renderGrid(p) {
    const u = U();
    const moves = [-60, -40, -25, -10, 0, 10, 25, 40, 60, 100];
    const volMults = [0.25, 0.5, 1, 2, 4];
    const xs = moves.map((mv) => 1 + mv / 100);
    const ys = volMults.map((k) => p.V * k);
    const rows = LP.model.grid(p, 'r', xs, 'V', ys, 'netPct');
    const all = rows.reduce((a, row) => a.concat(row.cells.map((c) => c.value)), []);
    const maxAbs = Math.max.apply(null, all.map(Math.abs)) || 1;

    const cell = (v) => {
      const t = Math.min(1, Math.abs(v) / maxAbs);
      const col = v >= 0 ? '53,201,138' : '239,95,107';
      return '<td class="num heat" style="background:rgba(' + col + ',' + (0.10 + 0.55 * t).toFixed(3) + ')">' +
        u.signedPct(v, 1) + '</td>';
    };

    const body = rows.map((row, i) => `
      <tr>
        <th class="num">${volMults[i] === 1 ? 'base' : volMults[i] + '×'}<br>
          <em>${u.usd(row.y)}/d</em></th>
        ${row.cells.map((c) => cell(c.value)).join('')}
      </tr>`).join('');

    return `
      <p class="muted">Net return versus holding, over ${Math.round(p.T)} days, for every combination
      of price move (columns) and daily volume (rows). Green beats holding; red does not.</p>
      <table class="heatgrid">
        <thead><tr><th>Volume \\ price move</th>${moves.map((mv) =>
          '<th class="num">' + (mv > 0 ? '+' : '') + mv + '%</th>').join('')}</tr></thead>
        <tbody>${body}</tbody>
      </table>
      <p class="fineprint">The asymmetry across a row is the shape of impermanent loss: it is symmetric
      in the price <em>ratio</em>, so −50% and +100% cost exactly the same.</p>`;
  }

  /* ---------------------------------------------------------------- formulas card */

  function renderFormulas(r) {
    const p = params();
    const m = LP.model.evaluate(p);
    const cat = LP.formulas.build(r, p, m);

    const legend = cat.symbols.map(([sym, meaning, value, src]) => `
      <tr>
        <td class="sym">${sym}</td>
        <td>${esc(meaning)}</td>
        <td class="num">${value}</td>
        <td class="muted">${esc(src || '')}</td>
      </tr>`).join('');

    const groups = cat.groups.map((g) => `
      <h4>${esc(g.group)}</h4>
      ${g.items.map((it) => `
        <div class="formula">
          <div class="f-name">${esc(it.name)}</div>
          <div class="f-sym">${it.sym}</div>
          <div class="f-sub">${it.sub}</div>
          <div class="f-val">= ${it.val}</div>
          ${it.note ? '<p class="f-note">' + esc(it.note) + '</p>' : ''}
          ${it.derivation ? '<details class="f-deriv"><summary>Where it comes from</summary><p>' +
            esc(it.derivation) + '</p></details>' : ''}
        </div>`).join('')}`).join('');

    return `
    <section class="card formulas">
      <h3>The formulas</h3>
      <p class="muted">Everything the page computes, shown symbolically and with this pool's numbers
      substituted in, so you can check any figure by hand. The substitution line uses whatever the
      what-if sliders are currently set to.</p>

      <h4>Symbols</h4>
      <table class="symbols">
        <thead><tr><th>Symbol</th><th>Meaning</th><th class="num">Value</th><th>Source</th></tr></thead>
        <tbody>${legend}</tbody>
      </table>

      ${groups}
    </section>`;
  }

  /* ------------------------------------------------------------------- refreshing */

  function refresh(scope) {
    const p = params();
    const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
    set('wiOutputs', renderOutputs(p));
    set('wiTornado', renderTornado(p));
    set('wiSweep', renderSweep(p));
    if (scope !== 'light') {
      set('wiBreakeven', renderBreakeven(p));
      set('wiGrid', renderGrid(p));
    }
    LP.model.driversFor(p).forEach((d) => {
      const base = local.base[d.key];
      const cur = p[d.key];
      const changed = Math.abs(cur - base) > Math.abs(base) * 1e-6;
      const vEl = document.getElementById('wiVal-' + d.key);
      if (vEl) vEl.textContent = fmt(d.unit, cur);
      const bEl = document.getElementById('wiBase-' + d.key);
      if (bEl) {
        bEl.innerHTML = changed
          ? 'was ' + fmt(d.unit, base) + ' · <button class="link" data-reset="' + d.key + '">reset</button>'
          : 'actual';
      }
      const row = vEl && vEl.closest('.wi-row');
      if (row) row.classList.toggle('changed', changed);
    });
    const fEl = document.querySelector('.card.formulas');
    if (fEl && local.result) fEl.outerHTML = renderFormulas(local.result);
    wireResetButtons();
  }

  function wireResetButtons() {
    document.querySelectorAll('[data-reset]').forEach((b) => {
      if (b.dataset.wired) return;
      b.dataset.wired = '1';
      b.addEventListener('click', () => {
        delete local.overrides[b.getAttribute('data-reset')];
        const key = b.getAttribute('data-reset');
        const sl = document.getElementById('wi-' + key);
        if (sl) sl.value = toSlider(key, local.base[key], local.base[key]);
        refresh();
      });
    });
  }

  function wire() {
    document.querySelectorAll('.whatif input[type=range][data-key]').forEach((sl) => {
      const key = sl.getAttribute('data-key');
      const onMove = () => {
        local.overrides[key] = fromSlider(key, local.base[key], +sl.value);
        refresh('light'); // cheap blocks only while dragging
      };
      sl.addEventListener('input', onMove);
      sl.addEventListener('change', () => { onMove(); refresh(); });
    });

    const tr = document.getElementById('wiTornadoRange');
    if (tr) tr.addEventListener('input', () => {
      local.tornadoPct = +tr.value;
      const lbl = document.getElementById('wiTornadoPct');
      if (lbl) lbl.textContent = local.tornadoPct;
      const el = document.getElementById('wiTornado');
      if (el) el.innerHTML = renderTornado(params());
    });

    const dv = document.getElementById('wiDriver');
    if (dv) dv.addEventListener('change', () => {
      local.driver = dv.value;
      const el = document.getElementById('wiSweep');
      if (el) el.innerHTML = renderSweep(params());
    });

    const ra = document.getElementById('wiResetAll');
    if (ra) ra.addEventListener('click', () => {
      local.overrides = {};
      LP.model.driversFor(local.base).forEach((d) => {
        const sl = document.getElementById('wi-' + d.key);
        if (sl) sl.value = toSlider(d.key, local.base[d.key], local.base[d.key]);
      });
      refresh();
    });

    const tv = document.getElementById('wiTodayVol');
    if (tv) tv.addEventListener('click', () => {
      local.overrides.V = local.base.todayV;
      const sl = document.getElementById('wi-V');
      if (sl) sl.value = toSlider('V', local.base.V, local.base.todayV);
      refresh();
    });

    wireResetButtons();
  }

  /** Forget slider positions when a different pool is analysed. */
  function reset() { local.overrides = {}; }

  return { render, renderFormulas, wire, reset, params };
})();
