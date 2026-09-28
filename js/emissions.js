/*
 * Emissions, and a third opinion on fee APR.
 *
 * Every other panel in this app measures swap fees and says, loudly, that it counts no
 * emissions. This is the panel that stops that being true. DefiLlama splits a pool's headline
 * APY into what it earns (apyBase) and what it is paid in tokens (apyReward), which is the
 * single distinction that decides whether an advertised yield is real.
 *
 * It also gives an independently computed fee APR. When that disagrees with ours the
 * disagreement is shown rather than hidden -- two sources computing the same quantity from the
 * same pool and getting different answers is information, not an embarrassment.
 *
 * Loaded on demand: the dataset is ~2.4 MB gzipped, which is not worth pulling on every
 * analysis for a figure that is often zero.
 */
window.LP = window.LP || {};

LP.emissions = (function () {
  const U = () => LP.util;
  const esc = (s) => LP.util.escapeHtml(s);

  const local = { state: 'idle', match: null, error: null, result: null };
  // state: idle | loading | done | error

  function reset() { local.state = 'idle'; local.match = null; local.error = null; }

  /* ------------------------------------------------------------------ render */

  function render(r) {
    local.result = r;

    if (local.state === 'idle') {
      return card(`
        <p class="muted">Every yield figure elsewhere on this page is swap fees only. Most
        advertised DEX APYs are mostly token emissions, which behave completely differently:
        they dilute as liquidity arrives, they can be switched off by a governance vote, and
        they are paid in a token whose price you are then exposed to.</p>
        <button class="btn" id="emLoad">Check emissions and cross-check the APR</button>
        <p class="fineprint">Pulls DefiLlama's yields dataset (~2.4 MB, about 17,000 pools) once
        per session. Also used by the farm screener, so it is only fetched once.</p>`);
    }

    if (local.state === 'loading') {
      return card('<p class="muted">Loading ~17,000 pools from DefiLlama…</p>');
    }

    if (local.state === 'error') {
      return card('<div class="callout warn"><strong>Could not load emissions data.</strong> ' +
        esc(local.error || '') + '</div>');
    }

    const m = local.match;
    if (!m || !m.ok) {
      return card(`<div class="callout">
          <strong>No emissions data for this pool.</strong> ${esc(m ? m.reason : '')}
          That is not the same as "no emissions" — it means DefiLlama does not track this pool,
          so the swap-fee figures elsewhere remain the whole of what this app can see.
        </div>`);
    }
    return card(renderMatch(r, m));
  }

  function card(inner) {
    return `<section class="card emissions">
      <h3>Emissions and incentives</h3>
      ${inner}
    </section>`;
  }

  function renderMatch(r, m) {
    const u = U();
    const row = m.row;
    const share = LP.llama.rewardShare(row);
    const ourApr = r.fees.aprFullRange;

    // Two independent estimates of the same thing. Worth comparing openly.
    const theirBase = row.apyBase;
    const gap = (ourApr !== null && theirBase !== null && theirBase > 0)
      ? ourApr / theirBase : null;

    const emissionHeavy = share !== null && share > 0.5;

    return `
      <div class="metrics">
        ${metric('Headline APY', u.pct(row.apy, 2), 'what a front-end would show you')}
        ${metric('Earned yield', row.apyBase === null ? '—' : u.pct(row.apyBase, 2),
          'swap fees — survives the emissions ending')}
        ${metric('Token emissions', row.apyReward === null ? '—' : u.pct(row.apyReward, 2),
          row.rewardTokens.length ? 'paid in ' + row.rewardTokens.length + ' reward token' +
            (row.rewardTokens.length === 1 ? '' : 's') : 'incentive rewards',
          emissionHeavy ? 'weak' : '')}
        ${metric('Emissions share', share === null ? '—' : u.pct(share * 100, 0),
          share === null ? '' : share > 0.8 ? 'almost all of the yield is incentives'
            : share > 0.5 ? 'more than half is incentives'
            : share > 0.15 ? 'a meaningful slice is incentives' : 'mostly real yield',
          emissionHeavy ? 'weak' : 'good')}
      </div>

      ${emissionHeavy ? `<div class="callout warn">
        <strong>${u.pct(share * 100, 0)} of this pool's advertised yield is token emissions.</strong>
        Emissions dilute as liquidity arrives — your share falls as others deposit — and they end
        when the campaign or the governance vote does. The ${row.apyBase === null ? 'earned' :
        u.pct(row.apyBase, 2)} of base yield is what remains if they stop tomorrow.
      </div>` : ''}

      <h4>Three sources, same question</h4>
      <div class="table-scroll"><table>
        <thead><tr><th>Source</th><th class="num">Fee APR</th><th>How it is derived</th></tr></thead>
        <tbody>
          <tr><td>This app</td><td class="num">${ourApr === null ? '—' : u.pct(ourApr, 2)}</td>
            <td class="muted">24h volume ÷ reserves × fee × LP share × 365</td></tr>
          <tr><td>DefiLlama</td><td class="num">${theirBase === null ? '—' : u.pct(theirBase, 2)}</td>
            <td class="muted">their own fee accounting${row.apyBase7d !== null
              ? ', 7-day: ' + u.pct(row.apyBase7d, 2) : ''}</td></tr>
          <tr><td>30-day mean</td><td class="num">${row.apyMean30d === null ? '—' : u.pct(row.apyMean30d, 2)}</td>
            <td class="muted">total APY averaged over 30 days, emissions included</td></tr>
        </tbody>
      </table></div>
      ${gap !== null && (gap > 1.6 || gap < 0.625) ? `<p class="fineprint">
        The two fee-APR estimates disagree by about ${u.ratio(gap > 1 ? gap : 1 / gap, 1)}×. Both are
        annualisations of a recent window, and pool volume genuinely swings several-fold day to
        day, so this is usually a timing difference rather than either being wrong. Treat the
        pair as a range, not a number.</p>` : ''}

      <h4>How stable is this yield?</h4>
      <div class="metrics">
        ${metric('Yield volatility (σ)', row.sigma === null ? '—' : u.ratio(row.sigma, 3),
          row.sigma === null ? 'not reported'
            : row.sigma < 0.3 ? 'steady' : row.sigma < 1 ? 'moves around' : 'very unstable')}
        ${metric('30-day APY change', row.apyPct30D === null ? '—' : u.signedPct(row.apyPct30D, 1),
          'where the headline number has been heading')}
        ${metric('Exposure', esc(row.exposure || '—'),
          row.ilRisk === 'no' ? 'no impermanent loss' : 'impermanent loss applies')}
        ${metric('Days of data', row.count === null ? '—' : u.int(row.count),
          row.outlier ? 'flagged as an outlier by DefiLlama' : 'observations behind these figures',
          row.outlier ? 'weak' : '')}
      </div>

      <p class="fineprint">Matched to DefiLlama's
        <code>${esc(row.project)}</code>${row.meta ? ' ' + esc(row.meta) : ''} pool on
        ${esc(row.chain)} by chain and both token addresses${m.confidence === 'fee tier'
          ? ', then by fee tier' : m.confidence === 'project' ? ', then by DEX' : ''}.
        Their TVL is ${u.usd(row.tvlUsd)} against our ${u.usd(r.pool.tvlUsd)}${m.suspect
          ? ' — <strong>a gap that large suggests this may be the wrong pool</strong>, so treat the ' +
            'emissions figure with suspicion' : ''}.</p>`;
  }

  function metric(label, value, sub, cls) {
    return `<div class="metric ${cls || ''}">
      <span class="m-label">${label}</span>
      <span class="m-value">${value}</span>
      ${sub ? '<span class="m-sub">' + sub + '</span>' : ''}
    </div>`;
  }

  /* ------------------------------------------------------------------ wiring */

  function wire(onChange) {
    const btn = document.getElementById('emLoad');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      local.state = 'loading';
      onChange();
      try {
        await LP.llama.load();
        local.match = LP.llama.matchPool(local.result);
        local.state = 'done';
      } catch (e) {
        local.error = e.message || String(e);
        local.state = 'error';
      }
      onChange();
    });
  }

  /** Once the dataset is in memory, later pools resolve without another click. */
  function autoMatch(r) {
    if (LP.llama.isLoaded() && local.state === 'idle') {
      local.match = LP.llama.matchPool(r);
      local.state = 'done';
    }
  }

  return { render, wire, reset, autoMatch };
})();
