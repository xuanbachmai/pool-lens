/*
 * The universe, grouped.
 *
 * The screener answers "which pool"; this answers "where should I even be looking". It takes the
 * same 16,000-odd pools and aggregates them along whichever dimension you pick -- DefiLlama's own
 * category, a coarser group, the chain, or the protocol.
 *
 * Medians throughout, never means. A category's mean APY is set by whichever pool is quoting four
 * figures today, which is a fact about one outlier rather than about the category; the median says
 * what a typical pool there actually pays. Pools DefiLlama flags as outliers are excluded from the
 * yield medians but still counted in the pool and TVL totals, because they are real money even
 * when their quoted rate is not believable.
 */
window.LP = window.LP || {};

LP.explore = (function () {
  const $ = (id) => document.getElementById(id);
  const U = () => LP.util;
  const esc = (s) => LP.util.escapeHtml(s);

  const state = { dim: 'category', rows: [] };

  const LABELS = {
    category: { title: 'By category', col: 'Category',
      lede: 'DefiLlama’s own taxonomy. A DEX pool and a lending market are not the same ' +
            'trade, and nothing below mixes them.' },
    group: { title: 'By group', col: 'Group',
      lede: 'The 42 categories folded into the handful of things people actually choose between.' },
    chain: { title: 'By chain', col: 'Chain',
      lede: 'The same pools divided by where they live. Gas differs by orders of magnitude ' +
            'between these, which decides the smallest position worth opening.' },
    project: { title: 'By protocol', col: 'Protocol',
      lede: 'Every protocol with pools in the dataset, largest first.' }
  };

  /* -------------------------------------------------------------------- load */

  async function init() {
    try {
      await LP.llama.load();
    } catch (e) {
      $('exStatus').className = 'status error';
      $('exStatus').innerHTML = '<strong>Could not load the pool data.</strong> ' +
        esc(e.message || String(e));
      return;
    }
    $('exStatus').className = 'status hidden';
    $('exMain').classList.remove('hidden');

    $('exDims').addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-dim]');
      if (!b) return;
      state.dim = b.dataset.dim;
      for (const x of $('exDims').querySelectorAll('button')) x.classList.toggle('on', x === b);
      draw();
    });

    // A row is a link into the screener, so it behaves like one.
    $('exBody').addEventListener('click', (ev) => {
      const tr = ev.target.closest('tr[data-key]');
      if (tr) location.href = screenerLink(tr.dataset.key);
    });

    readHash();
    draw();
  }

  /** Carry the selection into the screener as its own filter. */
  function screenerLink(key) {
    const p = new URLSearchParams();
    if (state.dim === 'chain') p.set('ch', key);
    else if (state.dim === 'project') p.set('q', key);
    else if (state.dim === 'group') p.set('gr', key);
    else p.set('cat', key);
    return 'farm.html#' + p.toString();
  }

  function readHash() {
    const h = new URLSearchParams(location.hash.replace(/^#/, ''));
    const d = h.get('dim');
    if (d && LABELS[d]) {
      state.dim = d;
      for (const x of $('exDims').querySelectorAll('button')) {
        x.classList.toggle('on', x.dataset.dim === d);
      }
    }
  }

  /* ------------------------------------------------------------------ render */

  function draw() {
    const rows = LP.llama.breakdown(state.dim, {});
    state.rows = rows;
    location.hash = 'dim=' + state.dim;

    const lab = LABELS[state.dim];
    $('exTitle').textContent = lab.title;
    $('exLede').textContent = lab.lede;
    $('exHName').textContent = lab.col;

    renderSummary(rows);
    renderFresh();

    const u = U();
    const maxTvl = rows.reduce((a, r) => Math.max(a, r.tvlUsd), 0) || 1;
    // A long tail of one-pool protocols is noise in a view about where to look.
    const shown = state.dim === 'project' ? rows.slice(0, 60) : rows;

    $('exBody').innerHTML = shown.map((r) => {
      const share = r.emissionShare;
      const earned = share === null ? null : (1 - share) * 100;
      return `
      <tr class="ex-row" data-key="${esc(r.key)}">
        <td>
          <div class="ex-name">
            <strong>${esc(r.key)}</strong>
            ${r.group && r.group !== 'Other' && state.dim === 'category'
              ? '<span class="tag">' + esc(r.group) + '</span>' : ''}
          </div>
          ${r.outliers ? '<div class="ex-big">' + r.outliers + ' flagged as outliers</div>' : ''}
        </td>
        <td class="num">${u.int(r.pools)}</td>
        <td class="num ex-bar">${u.usd(r.tvlUsd)}
          <i class="rail" style="width:${Math.max(2, (r.tvlUsd / maxTvl) * 100).toFixed(1)}%"></i></td>
        <td class="num">${r.medianApy === null ? '—' : u.pct(r.medianApy, 2)}</td>
        <td class="num">${r.medianBase === null ? '—' : u.pct(r.medianBase, 2)}</td>
        <td>
          ${share === null ? '<span class="muted">—</span>' : `
            <div class="ex-mix" title="${earned.toFixed(0)}% earned, ${(share * 100).toFixed(0)}% emissions">
              <i class="earned" style="width:${earned.toFixed(1)}%"></i>
              <i class="emitted" style="width:${(share * 100).toFixed(1)}%"></i>
            </div>
            <div class="ex-big">${(share * 100).toFixed(0)}% emissions</div>`}
        </td>
        <td class="num ${r.ilShare > 0.66 ? 'down' : ''}">${u.pct(r.ilShare * 100, 0)}</td>
        <td>
          <div>${esc(r.biggest ? r.biggest.symbol : '—')}</div>
          <div class="ex-big">${r.biggest
            ? esc(r.biggest.project) + ' · ' + esc(r.biggest.chain) +
              ' · ' + u.usd(r.biggest.tvlUsd)
            : ''}</div>
        </td>
      </tr>`;
    }).join('');
  }

  function renderSummary(rows) {
    const u = U();
    const all = LP.llama.rows();
    const tvl = rows.reduce((a, r) => a + r.tvlUsd, 0);
    const chains = new Set(all.map((p) => p.chain)).size;
    const cats = new Set(all.map((p) => p.category)).size;
    const twoSided = all.filter((p) => p.ilRisk === 'yes').length;

    const protocols = new Set(all.map((p) => p.project)).size;

    const cell = (k, v, s) =>
      `<div><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;

    /*
     * Six cells, not five. The grid is three wide at desktop and two at tablet, and five items
     * left an empty slot in both — a gap that reads as a missing tile rather than as a choice.
     */
    $('exSummary').innerHTML =
      cell('Pools', u.int(all.length), 'tracked by DefiLlama') +
      cell('Total TVL', u.usd(tvl), 'across every category') +
      cell('Protocols', u.int(protocols), 'with pools in the data') +
      cell('Chains', u.int(chains), 'with at least one pool') +
      cell('Categories', u.int(cats), 'protocol types') +
      cell('Two-sided', u.pct((twoSided / all.length) * 100, 0), 'carry impermanent-loss risk');
  }

  function renderFresh() {
    const age = LP.llama.ageSeconds();
    if (age === null) { $('exFresh').textContent = ''; return; }
    const mins = Math.floor(age / 60);
    const when = mins < 1 ? 'just now'
      : mins < 60 ? mins + ' minute' + (mins === 1 ? '' : 's') + ' ago'
      : Math.floor(mins / 60) + ' hour' + (Math.floor(mins / 60) === 1 ? '' : 's') + ' ago';
    $('exFresh').innerHTML = 'Live from DefiLlama, fetched <strong>' + when + '</strong>. ' +
      'Categories are joined from DefiLlama’s protocol list, which covered every project in ' +
      'the dataset when it was last built.';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { draw, _state: () => state };
})();
