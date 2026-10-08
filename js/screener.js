/*
 * The farm screener.
 *
 * ~17,000 pools across both kinds of farming:
 *   single exposure -- lending vaults, staked stables, LSTs. No impermanent loss, yield comes
 *                      from interest or a vault strategy, risk is the protocol and the peg.
 *   multi exposure  -- ordinary two-token LP, which is what the analyser models in depth.
 *
 * The screen is built around one question the headline APY cannot answer: how much of this is
 * real? A pool paying 1,065% entirely in its own token is not a 1,065% pool.
 *
 * Measured rather than assumed: emission-heavy pools are a MINORITY -- about 16% of liquid pools
 * get more than half their yield from incentives, and most carry none. An earlier version of this
 * comment claimed sorting by APY surfaces them, which the data does not support (only 6 of the
 * top 25 by APY were majority emissions). What is true is that when a pool IS emission-dependent,
 * almost none of its yield is earned -- that group averages 7.8% advertised against 0.9% earned --
 * and the headline number does not reveal it. Hence: base yield as the default sort, emissions as
 * their own column, and the reward share as a bar you cannot miss.
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
    minConfidence: 0,
    minVr: 0,
    maxVr: 0,
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
      const fromLink = readHash();
      const slot = document.getElementById('askSlot');
      if (slot && window.LP.ask) { slot.innerHTML = LP.ask.render(); LP.ask.wire(); }
      wire();
      if (fromLink) syncControls();
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

  /* ------------------------------------------------------------------ sharing */

  /*
   * Filters live in the URL hash so a screen can be bookmarked or sent to someone. Short keys
   * keep it readable; only values that differ from the default are written, so a link carries
   * the intent rather than the whole state.
   */
  const SHARE_KEYS = {
    e: 'exposure', c: 'chain', s: 'sort', q: 'search',
    tvl: 'minTvl', apy: 'minApy', rw: 'maxRewardShare',
    cf: 'minConfidence', vrn: 'minVr', vrx: 'maxVr',
    st: 'stablecoin', nil: 'noIlRisk', ox: 'excludeOutliers', n: 'limit'
  };
  const DEFAULTS = {
    exposure: 'any', chain: 'any', sort: 'base', search: '',
    minTvl: 1e6, minApy: 0, maxRewardShare: null,
    minConfidence: 0, minVr: 0, maxVr: 0,
    stablecoin: false, noIlRisk: false, excludeOutliers: true, limit: 60
  };

  function writeHash() {
    const parts = [];
    for (const [short, key] of Object.entries(SHARE_KEYS)) {
      const v = state[key];
      const d = DEFAULTS[key];
      if (v === d) continue;
      if (v === null || v === undefined || v === '') continue;
      parts.push(short + '=' + encodeURIComponent(
        typeof v === 'boolean' ? (v ? 1 : 0) : v));
    }
    const hash = parts.join('&');
    // replaceState, not assignment: a filter tweak should not add a history entry per keystroke.
    try {
      history.replaceState(null, '', hash ? '#' + hash : location.pathname + location.search);
    } catch (e) { /* some embedded contexts disallow it; the filters still work */ }
  }

  function readHash() {
    const raw = String(location.hash || '').replace(/^#/, '');
    if (!raw) return false;
    let touched = false;
    for (const pair of raw.split('&')) {
      const [short, rawVal] = pair.split('=');
      const key = SHARE_KEYS[short];
      if (!key || rawVal === undefined) continue;
      const val = decodeURIComponent(rawVal);
      const d = DEFAULTS[key];
      if (typeof d === 'boolean') state[key] = val === '1' || val === 'true';
      else if (typeof d === 'number' || d === null) {
        const n = parseFloat(val);
        if (Number.isFinite(n)) state[key] = n;
      } else {
        state[key] = val;
      }
      touched = true;
    }
    return touched;
  }

  function shareLink() {
    writeHash();
    return location.href;
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
    writeHash();

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

      const conf = p.confidence === null ? null : Math.round(p.confidence);
      const confCell = conf === null
        ? '<span class="muted">—</span>'
        : '<span class="conf conf-' + esc(p.confidenceBand) + '" title="' +
          esc(p.confidenceWeakest ? 'weakest signal: ' + p.confidenceWeakest.note : '') +
          '">' + conf + '</span>';

      return `<tr>
        <td>
          <strong>${esc(p.symbol || '')}</strong>
          <div class="sc-sub">${esc(p.project)}${p.meta ? ' · ' + esc(p.meta) : ''} · ${esc(p.chain)}</div>
        </td>
        <td class="num">${u.pct(p.apy, 1)}</td>
        <td class="num up">${p.apyBase === null ? '—' : u.pct(p.apyBase, 1)}</td>
        <td class="num ${pctReward !== null && pctReward > 50 ? 'down' : ''}">${p.apyReward === null ? '—' : u.pct(p.apyReward, 1)}</td>
        <td class="rw-cell">${bar}</td>
        <td class="num">${confCell}</td>
        <td class="num ${p.vr !== null && p.vr >= 0.25 && p.vr <= 5 ? 'up' : ''}">${
          p.vr === null ? '<span class="muted">n/a</span>' : u.ratio(p.vr, 2)}</td>
        <td class="num">${u.usd(p.tvlUsd)}</td>
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

    // The contrast that justifies the whole page: the biggest number and the most
    // trustworthy number are almost never the same pool.
    const scored = rows.filter((p) => p.confidence !== null);
    const trusted = scored.slice().sort((a, b) => b.confidence - a.confidence)[0];
    const topConf = top.confidence === null ? null : Math.round(top.confidence);

    $('scSummary').innerHTML = `
      <div class="metrics">
        ${metric('Matching pools', rows.length.toLocaleString('en-US'),
          emissionHeavy + ' of them (' + u.pct((emissionHeavy / rows.length) * 100, 0) +
          ') are more than half emissions')}
        ${metric('Highest advertised', u.pct(top.apy, 0),
          esc(top.symbol) + ' · ' + esc(top.project) +
          (topConf === null ? '' : ' · confidence ' + topConf + '/100'),
          topConf !== null && topConf < 50 ? 'weak' : '')}
        ${metric('Highest earned yield', real.apyBase === null ? '—' : u.pct(real.apyBase, 1),
          esc(real.symbol) + ' · ' + esc(real.project) +
          (realShare === null ? '' : ' · ' + u.pct(realShare * 100, 0) + ' emissions'), 'good')}
        ${trusted ? metric('Most trustworthy figure', u.pct(trusted.apy, 1),
          esc(trusted.symbol) + ' · ' + esc(trusted.project) + ' · confidence ' +
          Math.round(trusted.confidence) + '/100', 'good') : ''}
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
    on('scConf', 'input', () => {
      state.minConfidence = +$('scConf').value;
      $('scConfV').textContent = state.minConfidence === 0 ? 'any' : state.minConfidence + '+';
      draw();
    });
    on('scVr', 'change', () => {
      const v = $('scVr').value;
      // Capping V/R at 5 is the point of the benchmark options: above that it is almost always
      // looped or wash volume rather than a genuinely busy pool.
      if (v === 'bench') { state.minVr = 0.25; state.maxVr = 5; }
      else if (v === 'high') { state.minVr = 1; state.maxVr = 5; }
      else if (v === 'suspect') { state.minVr = 5; state.maxVr = 0; }
      else { state.minVr = 0; state.maxVr = 0; }
      draw();
    });

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
      maxRewardShare: null, sort: 'apy', excludeOutliers: true, chain: 'any', search: '',
      minConfidence: 0, minVr: 0, maxVr: 0
    }));
    // Boring and verifiable rather than spectacular and unproven.
    on('scPresetTrusted', 'click', () => applyPreset({
      exposure: 'any', stablecoin: false, noIlRisk: false, minTvl: 5e6, minApy: 6,
      maxRewardShare: null, sort: 'confidence', excludeOutliers: true, chain: 'any', search: '',
      minConfidence: 70, minVr: 0, maxVr: 0
    }));
    // The OTS notes' ideal setup: heavily traded relative to its own size, with the
    // implausible readings that are really wash volume excluded.
    on('scShare', 'click', async () => {
      const btn = $('scShare');
      const link = shareLink();
      try {
        await navigator.clipboard.writeText(link);
        btn.textContent = 'Link copied';
      } catch (e) {
        // Clipboard access is denied in plenty of contexts; the URL bar already holds it.
        btn.textContent = 'Link is in the address bar';
      }
      setTimeout(() => { btn.textContent = 'Copy link to this screen'; }, 2200);
    });

    on('scCsv', 'click', () => exportCsv());

    on('scPresetTurnover', 'click', () => applyPreset({
      exposure: 'multi', stablecoin: false, noIlRisk: false, minTvl: 2e6, minApy: 0,
      maxRewardShare: null, sort: 'vr', excludeOutliers: true, chain: 'any', search: '',
      minConfidence: 40, minVr: 0.25, maxVr: 5
    }));

    /*
     * The two presets below come out of backtest/, not out of an opinion.
     *
     * Over the last 365 days, across 27 configurations of rebalance period, basket size and
     * cost, ranking IL-bearing constant-product pools by fee APR beat equal-weighting the whole
     * sleeve in 27 of 27, median +10.1% against +3.8% -- measured as excess return over simply
     * holding the same tokens, with impermanent loss computed from real token prices.
     *
     * Ranking by total APY scored marginally higher (+10.5%), but it leans on emissions, and
     * emissions end -- the campaign panel exists because the median Merkl campaign has 21 days
     * left. Fee APR is the same result without that dependence, so that is what this encodes.
     *
     * A TVL floor is part of the rule rather than decoration: the strategy was tested with
     * yields diluted to a $100k position, which small pools cannot sustain.
     */
    on('scPresetBtDual', 'click', () => applyPreset({
      exposure: 'multi', stablecoin: false, noIlRisk: false, minTvl: 5e6, minApy: 0,
      maxRewardShare: 0.5, sort: 'base', excludeOutliers: true, chain: 'any', search: '',
      minConfidence: 50, minVr: 0, maxVr: 0
    }));

    /*
     * The no-IL sleeve. Less spectacular and far more dependable: in all 27 configurations the
     * worst result was still positive (+2.9% at its worst, +5.4% median, against +1.8% for
     * equal-weighting the sleeve). Nothing here is a promise -- see backtest/README.md on
     * survivorship bias -- but it is the only sleeve that never lost in any configuration.
     */
    on('scPresetBtSingle', 'click', () => applyPreset({
      exposure: 'any', stablecoin: false, noIlRisk: true, minTvl: 5e6, minApy: 0,
      maxRewardShare: 0.5, sort: 'base', excludeOutliers: true, chain: 'any', search: '',
      minConfidence: 50, minVr: 0, maxVr: 0
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
    $('scConf').value = state.minConfidence || 0;
    $('scConfV').textContent = !state.minConfidence ? 'any' : state.minConfidence + '+';
    $('scVr').value = state.minVr >= 5 ? 'suspect'
      : state.minVr >= 1 ? 'high' : state.minVr > 0 ? 'bench' : 'any';
  }

  function applyPreset(o) {
    Object.assign(state, o);
    syncControls();
    draw();
  }

  /** Export the rows currently matched, with the derived columns, as CSV. */
  function exportCsv() {
    const rows = LP.llama.screen(Object.assign({}, state, { limit: null }));
    const head = ['symbol', 'project', 'chain', 'meta', 'exposure', 'apy', 'apyBase',
      'apyReward', 'emissionsShare', 'confidence', 'vr', 'tvlUsd', 'sigma', 'days',
      'stablecoin', 'ilRisk', 'outlier'];
    const cell = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [head.join(',')];
    for (const p of rows) {
      const share = LP.llama.rewardShare(p);
      lines.push([p.symbol, p.project, p.chain, p.meta, p.exposure,
        p.apy, p.apyBase, p.apyReward,
        share === null ? '' : share.toFixed(4),
        p.confidence === null ? '' : Math.round(p.confidence),
        p.vr === null ? '' : p.vr.toFixed(4),
        Math.round(p.tvlUsd), p.sigma, p.count,
        p.stablecoin ? 'yes' : 'no', p.ilRisk, p.outlier ? 'yes' : 'no'
      ].map(cell).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pool-lens-screen-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return { init, draw, syncControls, exportCsv, shareLink, state };
})();

document.addEventListener('DOMContentLoaded', LP.screener.init);
