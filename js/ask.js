/*
 * The natural-language box on the screener.
 *
 * Sends a sentence to /api/ask, gets filter parameters back, and applies them with the same
 * deterministic screening code the checkboxes use. The compiled filter is then SHOWN — every
 * parameter the model chose is visible and every control stays editable, so the model's work
 * can be checked and corrected rather than trusted.
 *
 * Degrades honestly: with no API key configured on the deployment the endpoint returns 501 and
 * this panel explains the one-time setup instead of erroring. The rest of the page is unaffected.
 */
window.LP = window.LP || {};

LP.ask = (function () {
  const U = () => LP.util;
  const esc = (s) => LP.util.escapeHtml(s);
  const $ = (id) => document.getElementById(id);

  const EXAMPLES = [
    'single-sided stables above 10% that aren\'t mostly emissions',
    'real yield LP pairs on Base, at least $5M deep',
    'the steadiest stablecoin yields, no impermanent loss',
    'high APY farms on Arbitrum — show me the emission-heavy ones too'
  ];

  let busy = false;

  function render() {
    return `
      <section class="card ask">
        <h3>Describe what you want</h3>
        <p class="muted">Plain English. It is turned into filter settings — never into numbers.
        Every yield, TVL and emissions figure on this page stays computed from the data; the
        model only decides how to filter and sort it, and you can see and change exactly what it
        chose.</p>
        <div class="ask-row">
          <input type="text" id="askInput" maxlength="400" autocomplete="off"
            placeholder="single-sided stables above 10% that aren't mostly emissions">
          <button class="btn" id="askGo">Find pools</button>
        </div>
        <div class="ask-examples">
          ${EXAMPLES.map((e) => '<button class="link" data-ask-example="' + esc(e) + '">' +
            esc(e) + '</button>').join('')}
        </div>
        <div id="askOut"></div>
      </section>`;
  }

  function setOut(html) { const el = $('askOut'); if (el) el.innerHTML = html; }

  async function run(query) {
    if (busy || !query.trim()) return;
    busy = true;
    $('askGo').disabled = true;
    setOut('<p class="muted">Translating…</p>');

    let res, body;
    try {
      res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query })
      });
      body = await res.json().catch(() => ({}));
    } catch (e) {
      busy = false; $('askGo').disabled = false;
      setOut(`<div class="callout warn"><strong>Could not reach the endpoint.</strong>
        This feature needs the site deployed with a serverless function — it does not work from a
        plain file:// page or a static file server. The filters below work either way.</div>`);
      return;
    }

    busy = false;
    $('askGo').disabled = false;

    if (res.status === 501) {
      setOut(`<div class="callout">
        <strong>Not configured yet.</strong> ${esc(body.message || '')}
        <br><br>One-time setup: create a key at console.anthropic.com, add it in Vercel under
        Settings → Environment Variables as <code>ANTHROPIC_API_KEY</code>, and redeploy. The key
        stays server-side and never reaches the browser.
      </div>`);
      return;
    }
    if (!res.ok || !body.filter) {
      setOut('<div class="callout warn"><strong>That didn\'t work.</strong> ' +
        esc(body.message || body.error || 'Unknown error') + '</div>');
      return;
    }

    apply(body.filter);
  }

  /** Apply the compiled filter through the normal deterministic path, then show what it did. */
  function apply(f) {
    const u = U();
    const s = LP.screener.state;

    if (['any', 'single', 'multi'].includes(f.exposure)) s.exposure = f.exposure;
    if (typeof f.stablecoin === 'boolean') s.stablecoin = f.stablecoin;
    if (typeof f.noIlRisk === 'boolean') s.noIlRisk = f.noIlRisk;
    if (typeof f.excludeOutliers === 'boolean') s.excludeOutliers = f.excludeOutliers;
    if (Number.isFinite(f.minTvl)) s.minTvl = Math.max(0, f.minTvl);
    if (Number.isFinite(f.minApy)) s.minApy = Math.max(0, f.minApy);
    s.maxRewardShare = Number.isFinite(f.maxRewardShare)
      ? u.clamp(f.maxRewardShare, 0, 1) : null;
    s.chain = f.chain || 'any';
    s.search = f.search || '';
    if (['base', 'apy', 'mean30', 'tvl', 'stability'].includes(f.sort)) s.sort = f.sort;

    LP.screener.syncControls();
    LP.screener.draw();

    const rows = [
      ['Exposure', s.exposure === 'any' ? 'either' : s.exposure],
      ['Chain', s.chain === 'any' ? 'any' : s.chain],
      ['Minimum TVL', u.usd(s.minTvl)],
      ['Minimum APY', s.minApy + '%'],
      ['Emissions share', s.maxRewardShare === null ? 'any' : 'at most ' +
        Math.round(s.maxRewardShare * 100) + '%'],
      ['Stablecoins only', s.stablecoin ? 'yes' : 'no'],
      ['No IL risk', s.noIlRisk ? 'yes' : 'no'],
      ['Sort by', { base: 'earned yield', apy: 'headline APY', mean30: '30-day average',
        tvl: 'TVL', stability: 'yield stability' }[s.sort] || s.sort],
      s.search ? ['Text match', s.search] : null
    ].filter(Boolean);

    setOut(`
      ${f.reasoning ? '<div class="callout">' + esc(f.reasoning) + '</div>' : ''}
      <h4>What it set</h4>
      <dl class="ask-filter">${rows.map(([k, v]) =>
        '<dt>' + esc(k) + '</dt><dd>' + esc(String(v)) + '</dd>').join('')}</dl>
      <p class="fineprint">Every one of these is a normal control above — change anything that
      looks wrong and the table updates. The results themselves were computed by the same code
      the checkboxes use, not by the model.</p>`);
  }

  function wire() {
    const go = $('askGo');
    if (go) go.addEventListener('click', () => run($('askInput').value));
    const input = $('askInput');
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); run(input.value); }
      });
    }
    document.querySelectorAll('[data-ask-example]').forEach((b) => {
      b.addEventListener('click', () => {
        const q = b.getAttribute('data-ask-example');
        $('askInput').value = q;
        run(q);
      });
    });
  }

  return { render, wire, apply };
})();
