/*
 * Your actual position in the pool.
 *
 * Everything else in this app answers "is this pool worth entering". This answers "given that
 * I am already in it, where do I stand and what should I do next" -- which needs three things
 * the analysis never asked for: when you entered, at what price, and how much.
 *
 * Positions are saved per pool in localStorage so they survive a reload. Storage can throw
 * (private windows, blocked site data), so every read and write is guarded and the app works
 * unchanged when it fails.
 */
window.LP = window.LP || {};

LP.position = (function () {
  const U = () => LP.util;
  const esc = (s) => LP.util.escapeHtml(s);
  const KEY = 'poollens.positions.v1';

  /* ------------------------------------------------------------------ storage */

  function readAll() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function writeAll(map) {
    try {
      localStorage.setItem(KEY, JSON.stringify(map));
      return true;
    } catch (e) {
      return false;   // private window or blocked storage: carry on without persisting
    }
  }

  const poolKey = (pool) => pool.network + ':' + pool.address;

  function load(pool) {
    const all = readAll();
    return all[poolKey(pool)] || null;
  }

  function save(pool, pos) {
    const all = readAll();
    all[poolKey(pool)] = pos;
    return writeAll(all);
  }

  function clear(pool) {
    const all = readAll();
    delete all[poolKey(pool)];
    return writeAll(all);
  }

  /** Every saved position, for the "other pools you're in" list. */
  function listAll() {
    const all = readAll();
    return Object.keys(all).map((k) => Object.assign({ key: k }, all[k]));
  }

  /* ------------------------------------------------------------------- state */

  const local = { result: null, draft: null, editing: false };

  function defaultsFor(r) {
    const bars = r.stats ? r.stats.bars : [];
    const price = r.pool.basePriceInQuote || (bars.length ? bars[bars.length - 1].c : 1);
    return {
      sizeUsd: r.assumptions.positionUsd,
      entryPrice: price,
      entryDate: todayIso(),
      rangePct: r.isCl ? r.assumptions.rangePct : null,
      hedged: false
    };
  }

  function todayIso() {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  }

  function current(r) {
    if (local.draft) return local.draft;
    const saved = load(r.pool);
    return saved || null;
  }

  /* ----------------------------------------------------------------- analysis */

  /** Index of the first daily bar on or after the entry date. */
  function entryIndex(bars, entryDate) {
    if (!bars || !bars.length) return -1;
    const t = Date.parse(entryDate + 'T00:00:00Z');
    if (!Number.isFinite(t)) return -1;
    for (let i = 0; i < bars.length; i++) if (bars[i].t >= t) return i;
    return -1;      // entry is after the last bar, i.e. today
  }

  /**
   * How the position has actually done since entry, replayed against real bars.
   *
   * For a concentrated position this reuses the same replay the range panel runs, with the
   * range centred on the entry price rather than on today's -- which is what a real position
   * does, since you set the range when you opened it and it has not moved since.
   */
  function performance(r, pos) {
    if (!pos) return null;
    const bars = r.stats ? r.stats.bars : [];
    const lpFeeFrac = (r.fees.feePct / 100) * r.fees.lpShare;
    const tvl = r.pool.tvlUsd;
    const priceNow = r.pool.basePriceInQuote;
    const entryPrice = pos.entryPrice > 0 ? pos.entryPrice : priceNow;
    const ratio = priceNow / entryPrice;

    const idx = entryIndex(bars, pos.entryDate);
    const slice = idx >= 0 ? bars.slice(idx) : [];
    const daysHeld = slice.length
      ? Math.max(1, Math.round((slice[slice.length - 1].t - slice[0].t) / 86400000) + 1)
      : 0;

    let feesPct = null, ilPct = null, inRangePct = null, replayed = false;

    if (r.isCl && pos.rangePct > 0 && slice.length >= 2) {
      const w = pos.rangePct / 100;
      const bt = LP.backtest.run(slice, {
        P0: entryPrice, pa: entryPrice * (1 - w), pb: entryPrice * (1 + w),
        lpFeeFrac, tvl
      });
      if (bt) {
        feesPct = bt.feesPct; ilPct = bt.ilPct; inRangePct = bt.pctTimeInRange; replayed = true;
      }
    } else if (slice.length >= 2) {
      const vol = slice.reduce((a, b) => a + (b.v || 0), 0);
      feesPct = tvl > 0 ? (vol * lpFeeFrac / tvl) * 100 : null;
      ilPct = LP.analyze.ilV2(ratio) * 100;
      inRangePct = 100;
      replayed = true;
    }

    // No history to replay: fall back to the closed forms, clearly flagged.
    if (!replayed) {
      ilPct = r.isCl && pos.rangePct > 0
        ? (LP.analyze.ilCl(ratio, 1, 1 - pos.rangePct / 100, 1 + pos.rangePct / 100) || 0) * 100
        : LP.analyze.ilV2(ratio) * 100;
      feesPct = 0;
      inRangePct = null;
    }

    const netPct = (feesPct || 0) + (ilPct || 0);
    const inRangeNow = r.isCl && pos.rangePct > 0
      ? priceNow >= entryPrice * (1 - pos.rangePct / 100) &&
        priceNow <= entryPrice * (1 + pos.rangePct / 100)
      : true;

    return {
      entryPrice, priceNow, ratio, movePct: (ratio - 1) * 100,
      daysHeld, replayed,
      feesPct, ilPct, netPct, inRangePct, inRangeNow,
      feesUsd: feesPct === null ? null : (feesPct / 100) * pos.sizeUsd,
      ilUsd: ilPct === null ? null : (ilPct / 100) * pos.sizeUsd,
      netUsd: (netPct / 100) * pos.sizeUsd,
      bounds: r.isCl && pos.rangePct > 0
        ? { lo: entryPrice * (1 - pos.rangePct / 100), hi: entryPrice * (1 + pos.rangePct / 100) }
        : null,
      // Annualised, so it is comparable with the fee APR everywhere else.
      aprPct: daysHeld > 0 && feesPct !== null ? (feesPct / daysHeld) * 365 : null
    };
  }

  /* ------------------------------------------------------------------ render */

  function render(r) {
    local.result = r;
    const pos = current(r);
    const u = U();

    if (!pos && !local.editing) {
      return `<section class="card position">
        <h3>Your position</h3>
        <p class="muted">Tell the app what you actually hold and it will track this position
        against holding the two tokens, rank the moves available to you, and work out the exact
        price levels worth watching.</p>
        <button class="btn" id="posAdd">Add my position</button>
      </section>`;
    }

    const p = pos || defaultsFor(r);
    const perf = pos ? performance(r, pos) : null;

    return `<section class="card position">
      <h3>Your position</h3>
      ${local.editing || !pos ? renderForm(r, p) : renderSummary(r, pos, perf)}
    </section>`;
  }

  function renderForm(r, p) {
    return `
      <p class="muted">Saved in this browser only — nothing leaves your machine.</p>
      <div class="fields">
        <label>Position size (USD)
          <input type="number" id="posSize" min="1" step="100" value="${p.sizeUsd}">
        </label>
        <label>Entry price (${esc(r.pool.baseSymbol || 'base')} in ${esc(r.pool.quoteSymbol || 'quote')})
          <input type="number" id="posPrice" min="0" step="any" value="${p.entryPrice}">
          <em>now ${U().price(r.pool.basePriceInQuote)}</em>
        </label>
        <label>Entry date
          <input type="date" id="posDate" value="${esc(p.entryDate)}" max="${todayIso()}">
        </label>
        ${r.isCl ? `<label>Your range (&plusmn;%)
          <input type="number" id="posRange" min="0.5" max="95" step="0.5" value="${p.rangePct || r.assumptions.rangePct}">
          <em>around your entry price</em>
        </label>` : ''}
      </div>
      <div class="pos-actions">
        <button class="btn" id="posSave">Save position</button>
        <button class="btn secondary" id="posCancel">Cancel</button>
      </div>`;
  }

  function renderSummary(r, pos, perf) {
    const u = U();
    const good = perf.netPct >= 0;
    const rangeLine = perf.bounds
      ? u.price(perf.bounds.lo) + ' – ' + u.price(perf.bounds.hi) +
        (perf.inRangeNow ? '' : ' · <strong class="down">out of range</strong>')
      : 'full range';

    return `
      <div class="pos-head">
        <div>
          <div class="pos-size">${u.usd(pos.sizeUsd)}</div>
          <div class="muted">entered ${esc(pos.entryDate)} at ${u.price(perf.entryPrice)} ·
            held ${perf.daysHeld} day${perf.daysHeld === 1 ? '' : 's'} · ${rangeLine}</div>
        </div>
        <div class="pos-net ${good ? 'good' : 'bad'}">
          <span>${u.signedPct(perf.netPct, 2)}</span>
          <em>vs holding · ${u.usd(perf.netUsd)}</em>
        </div>
      </div>

      <div class="metrics">
        ${m('Price move since entry', u.signedPct(perf.movePct, 2),
            u.price(perf.entryPrice) + ' → ' + u.price(perf.priceNow))}
        ${m('Fees earned', perf.feesPct === null ? '—' : u.pct(perf.feesPct, 2),
            perf.feesUsd === null ? '' : u.usd(perf.feesUsd) +
            (perf.aprPct !== null ? ' · ' + u.pct(perf.aprPct, 0) + ' APR realised' : ''))}
        ${m('Impermanent loss', perf.ilPct === null ? '—' : u.pct(perf.ilPct, 2),
            perf.ilUsd === null ? '' : u.usd(perf.ilUsd))}
        ${perf.inRangePct === null ? '' :
          m('Time in range', u.pct(perf.inRangePct, 0), 'since you entered',
            perf.inRangePct >= 70 ? '' : 'weak')}
      </div>

      ${perf.replayed
        ? '<p class="fineprint">Replayed against the pool\'s real daily bars since your entry date, ' +
          'using today\'s TVL for the fee share.</p>'
        : '<p class="fineprint">No daily bars cover your entry date, so impermanent loss is computed ' +
          'from the price move alone and fees are not estimated.</p>'}

      <div class="pos-actions">
        <button class="btn secondary" id="posEdit">Edit</button>
        <button class="btn secondary" id="posClear">Remove</button>
      </div>`;
  }

  function m(label, value, sub, cls) {
    return `<div class="metric ${cls || ''}">
      <span class="m-label">${label}</span>
      <span class="m-value">${value}</span>
      ${sub ? '<span class="m-sub">' + sub + '</span>' : ''}
    </div>`;
  }

  /* ------------------------------------------------------------------- wiring */

  function wire(onChange) {
    const r = local.result;
    if (!r) return;
    const el = (id) => document.getElementById(id);

    const add = el('posAdd');
    if (add) add.addEventListener('click', () => {
      local.editing = true; local.draft = defaultsFor(r); onChange();
    });

    const edit = el('posEdit');
    if (edit) edit.addEventListener('click', () => {
      local.editing = true; local.draft = Object.assign({}, load(r.pool)); onChange();
    });

    const cancel = el('posCancel');
    if (cancel) cancel.addEventListener('click', () => {
      local.editing = false; local.draft = null; onChange();
    });

    const clearBtn = el('posClear');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      clear(r.pool); local.editing = false; local.draft = null; onChange();
    });

    const saveBtn = el('posSave');
    if (saveBtn) saveBtn.addEventListener('click', () => {
      const num = (id, dflt) => {
        const e = el(id); if (!e) return dflt;
        const v = parseFloat(e.value);
        return Number.isFinite(v) ? v : dflt;
      };
      const d = el('posDate');
      const pos = {
        sizeUsd: Math.max(1, num('posSize', r.assumptions.positionUsd)),
        entryPrice: Math.max(1e-12, num('posPrice', r.pool.basePriceInQuote)),
        entryDate: d && d.value ? d.value : todayIso(),
        rangePct: r.isCl ? U().clamp(num('posRange', r.assumptions.rangePct), 0.5, 95) : null,
        savedAt: Date.now()
      };
      const ok = save(r.pool, pos);
      local.editing = false; local.draft = null;
      onChange(ok ? null : 'Could not save to this browser (private window or blocked site data). ' +
        'The position is still analysed for this session.');
      if (!ok) local.draft = pos;
    });
  }

  function reset() { local.editing = false; local.draft = null; }

  return { render, wire, reset, current, performance, load, save, clear, listAll, defaultsFor };
})();
