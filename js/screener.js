/*
 * The farm screener.
 *
 * ~17,000 pools across both kinds of farming:
 *   single exposure -- lending vaults, staked stables, LSTs. No impermanent loss, yield comes
 *                      from interest or a vault strategy, risk is the protocol and the peg.
 *   multi exposure  -- ordinary two-token LP, which is what the analyser models in depth.
 *
 * The screen is built around one question the headline APY cannot answer: how much of this is
 * real? A pool paying 1,065% entirely in its own token is not a 1,065% pool, and sorting by APY
 * puts exactly those at the top. So the default sort is base yield, emissions are always shown
 * as their own column, and the reward share is rendered as a bar you cannot miss.
 */
window.LP = window.LP || {};

LP.screener = (function () {
  const U = () => LP.util;
  const esc = (s) => LP.util.escapeHtml(s);
  const $ = (id) => document.getElementById(id);

  const state = {
    exposure: 'any',
    chain: 'any',
    stablecoin: false,
    noIlRisk: false,
    excludeOutliers: true,
    minTvl: 1e6,
    minApy: 0,
    maxRewardShare: null,
    minCount: 0,
    search: '',
    sort: 'base',
    limit: 60,
    loaded: false,
    error: null
  };

  /* -------------------------------------------------------------------- load */

  async function init() {
    const status = $('scStatus');
    status.textContent = 'Loading ~17,000 pools from DefiLlama (about 2.4 MB)…';
    try {
      await LP.llama.load();
      state.loaded = true;
      status.textContent = '';
      buildChainFilter();
      const slot = document.getElementById('askSlot');
      if (slot && window.LP.ask) { slot.innerHTML = LP.ask.render(); LP.ask.wire(); }
      wire();
      draw();
    } catch (e) {
      state.error = e.message || String(e);
      status.innerHTML = '<div class="callout warn"><strong>Could not load the dataset.</strong> ' +
        esc(state.error) + '</div>';
    }
  }

  function buildChainFilter() {
    const sel = $('scChain');
    const chains = LP.llama.chains().slice(0, 40);
    sel.innerHTML = '<option value="any">Any chain</option>' +
      chains.map((c) => '<option value="' + esc(c.chain) + '">' + esc(c.chain) +
        ' (' + c.n + ')</option>').join('');
  }

  /* ------------------------------------------------------------------- render */

  function draw() {
    if (!state.loaded) return;
    const u = U();
    /*
     * Screen without the row limit, then slice for display. Passing state straight through
     * truncated inside screen(), so the "N pools match" headline reported the page size rather
     * than the match count -- it read "60" for every filter, including ones matching thousands.
     */
    const rows = LP.llama.screen(Object.assign({}, state, { limit: null }));
    const shown = rows.slice(0, state.limit);

    $('scCount').textContent = rows.length.toLocaleString('en-US');
    $('scTotal').textContent = LP.llama.count().toLocaleString('en-US');

    if (!rows.length) {
      $('scBody').innerHTML = '';
      $('scEmpty').innerHTML = '<p class="muted">Nothing matches those filters. The most common ' +
        'cause is a reward-share cap combined with a high minimum APY — high yields are usually ' +
        'high because of emissions, which is the point the filter is making.</p>';
      return;
    }
    $('scEmpty').innerHTML = '';

    $('scBody').innerHTML = shown.map((p) => {
      const share = LP.llama.rewardShare(p);
      const pctReward = share === null ? null : share * 100;
      const bar = share === null ? '<span class="muted">—</span>' : `
        <div class="rw-bar" title="${u.pct(100 - pctReward, 0)} earned, ${u.pct(pctReward, 0)} emissions">
          <i class="rw-base" style="width:${(100 - pctReward).toFixed(1)}%"></i>
          <i class="rw-rew" style="width:${pctReward.toFixed(1)}%"></i>
        </div>
        <span class="rw-label ${pctReward > 50 ? 'down' : ''}">${u.pct(pctReward, 0)} emissions</span>`;

      return `<tr>
        <td>
          <strong>${esc(p.symbol || '')}</strong>
          <div class="sc-sub">${esc(p.project)}${p.meta ? ' · ' + esc(p.meta) : ''} · ${esc(p.chain)}</div>
        </td>
        <td class="num">${u.pct(p.apy, 1)}</td>
        <td class="num up">${p.apyBase === null ? '—' : u.pct(p.apyBase, 1)}</td>
        <td class="num ${pctReward !== null && pctReward > 50 ? 'down' : ''}">${p.apyReward === null ? '—' : u.pct(p.apyReward, 1)}</td>
        <td class="rw-cell">${bar}</td>
        <td class="num">${u.usd(p.tvlUsd)}</td>
        <td class="num">${p.sigma === null ? '—' : u.ratio(p.sigma, 2)}</td>
        <td>
          <span class="pill ${p.exposure === 'single' ? 'good' : ''}">${esc(p.exposure || '?')}</span>
          ${p.stablecoin ? '<span class="pill">stable</span>' : ''}
          ${p.ilRisk === 'no' ? '<span class="pill good">no IL</span>' : ''}
          ${p.outlier ? '<span class="pill weak">outlier</span>' : ''}
        </td>
      </tr>`;
    }).join('');

    drawSummary(rows);
  }

  /** The headline finding: what sorting by APY would have given you. */
  function drawSummary(rows) {
    const u = U();
    const byApy = rows.slice().sort((a, b) => b.apy - a.apy);
    const byBase = rows.slice().sort((a, b) =>
      (b.apyBase === null ? -1 : b.apyBase) - (a.apyBase === null ? -1 : a.apyBase));
    const top = byApy[0], real = byBase[0];
    if (!top || !real) { $('scSummary').innerHTML = ''; return; }

    const topShare = LP.llama.rewardShare(top);
    const realShare = LP.llama.rewardShare(real);
    const emissionHeavy = rows.filter((p) => {
      const s = LP.llama.rewardShare(p);
      return s !== null && s > 0.5;
    }).length;

    $('scSummary').innerHTML = `
      <div class="metrics">
        ${metric('Matching pools', rows.length.toLocaleString('en-US'),
          emissionHeavy + ' of them (' + u.pct((emissionHeavy / rows.length) * 100, 0) +
          ') are more than half emissions')}
        ${metric('Highest advertised', u.pct(top.apy, 0),
          esc(top.symbol) + ' · ' + esc(top.project) +
          (topShare === null ? '' : ' · ' + u.pct(topShare * 100, 0) + ' of it emissions'),
          topShare !== null && topShare > 0.5 ? 'weak' : '')}
        ${metric('Highest earned yield', real.apyBase === null ? '—' : u.pct(real.apyBase, 1),
          esc(real.symbol) + ' · ' + esc(real.project) +
          (realShare === null ? '' : ' · ' + u.pct(realShare * 100, 0) + ' emissions'), 'good')}
      </div>`;
  }

  function metric(label, value, sub, cls) {
    return `<div class="metric ${cls || ''}">
      <span class="m-label">${label}</span>
      <span class="m-value">${value}</span>
      ${sub ? '<span class="m-sub">' + sub + '</span>' : ''}
    </div>`;
  }

  /* ------------------------------------------------------------------- wiring */

  function wire() {
    const on = (id, ev, fn) => { const e = $(id); if (e) e.addEventListener(ev, fn); };

    on('scExposure', 'change', () => { state.exposure = $('scExposure').value; draw(); });
    on('scChain', 'change', () => { state.chain = $('scChain').value; draw(); });
    on('scSort', 'change', () => { state.sort = $('scSort').value; draw(); });
    on('scStable', 'change', () => { state.stablecoin = $('scStable').checked; draw(); });
    on('scNoIl', 'change', () => { state.noIlRisk = $('scNoIl').checked; draw(); });
    on('scOutliers', 'change', () => { state.excludeOutliers = $('scOutliers').checked; draw(); });
    on('scSearch', 'input', () => { state.search = $('scSearch').value; draw(); });

    on('scTvl', 'input', () => {
      // Log scale: $10k to $1B across the slider.
      const t = +$('scTvl').value / 100;
      state.minTvl = Math.round(Math.exp(Math.log(1e4) + t * (Math.log(1e9) - Math.log(1e4))));
      $('scTvlV').textContent = U().usd(state.minTvl);
      draw();
    });
    on('scApy', 'input', () => {
      state.minApy = +$('scApy').value;
      $('scApyV').textContent = state.minApy + '%';
      draw();
    });
    on('scReward', 'input', () => {
      const v = +$('scReward').value;
      state.maxRewardShare = v >= 100 ? null : v / 100;
      $('scRewardV').textContent = v >= 100 ? 'any' : 'at most ' + v + '%';
      draw();
    });
    on('scLimit', 'change', () => { state.limit = +$('scLimit').value; draw(); });

    // Presets: the three questions people actually arrive with.
    on('scPresetReal', 'click', () => applyPreset({
      exposure: 'any', stablecoin: false, noIlRisk: false, minTvl: 5e6, minApy: 8,
      maxRewardShare: 0.25, sort: 'base', excludeOutliers: true, chain: 'any', search: ''
    }));
    on('scPresetSingle', 'click', () => applyPreset({
      exposure: 'single', stablecoin: true, noIlRisk: true, minTvl: 5e6, minApy: 5,
      maxRewardShare: null, sort: 'base', excludeOutliers: true, chain: 'any', search: ''
    }));
    on('scPresetLp', 'click', () => applyPreset({
      exposure: 'multi', stablecoin: false, noIlRisk: false, minTvl: 2e6, minApy: 10,
      maxRewardShare: null, sort: 'apy', excludeOutliers: true, chain: 'any', search: ''
    }));
  }

  /**
   * Push `state` back onto the controls. Shared by the presets and by the natural-language
   * box, so however a filter arrives the visible controls always show what is actually applied
   * -- a filter you cannot see is a filter you cannot correct.
   */
  function syncControls() {
    $('scExposure').value = state.exposure;
    $('scChain').value = state.chain;
    $('scSort').value = state.sort;
    $('scSearch').value = state.search;
    $('scStable').checked = state.stablecoin;
    $('scNoIl').checked = state.noIlRisk;
    $('scOutliers').checked = state.excludeOutliers;
    $('scApy').value = state.minApy;
    $('scApyV').textContent = state.minApy + '%';
    const t = (Math.log(Math.max(state.minTvl, 1e4)) - Math.log(1e4)) /
      (Math.log(1e9) - Math.log(1e4));
    $('scTvl').value = Math.round(U().clamp(t, 0, 1) * 100);
    $('scTvlV').textContent = U().usd(state.minTvl);
    const rw = state.maxRewardShare === null ? 100 : Math.round(state.maxRewardShare * 100);
    $('scReward').value = rw;
    $('scRewardV').textContent = rw >= 100 ? 'any' : 'at most ' + rw + '%';
  }

  function applyPreset(o) {
    Object.assign(state, o);
    syncControls();
    draw();
  }

  return { init, draw, syncControls, state };
})();

document.addEventListener('DOMContentLoaded', LP.screener.init);
