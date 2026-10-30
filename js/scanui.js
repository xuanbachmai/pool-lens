/*
 * The address panel on the book page.
 *
 * Reads positions for any address. The paste field comes first and the connect button second,
 * deliberately: the feature needs an address, not a wallet, and pasting one lets you look at
 * addresses you do not own — which is most of the interesting ones.
 *
 * What it finds and what it misses is stated on the panel rather than left to be discovered.
 * A position list that quietly omits your staked LP is worse than no list at all, because you
 * would believe it.
 */
window.LP = window.LP || {};

LP.scanui = (function () {
  const U = () => LP.util;
  const esc = (s) => LP.util.escapeHtml(s);

  const CHAIN_LABEL = {
    base: 'Base', bsc: 'BSC', eth: 'Ethereum',
    arbitrum: 'Arbitrum', optimism: 'OP Mainnet', polygon_pos: 'Polygon'
  };

  const local = {
    chain: 'base',
    state: 'idle',        // idle | scanning | done | error
    progress: '',
    result: null,
    error: null
  };

  /*
   * Links into the analyser.
   *
   * It deep-links on ?url= and parses GeckoTerminal URLs, which carry the chain. The first
   * version of this pointed at ?pool=&chain=, parameters nothing reads, so every link landed on
   * an empty analyser.
   */
  const poolLink = (chain, address) => 'index.html?url=' +
    encodeURIComponent('https://www.geckoterminal.com/' + chain + '/pools/' + address);

  /*
   * A concentrated position carries its two tokens but not the pool address, which lives behind
   * a CREATE2 hash this page cannot compute. The token link is honest about that: the analyser
   * resolves a token to its deepest pool and offers a picker for the rest, so it lands you in
   * the right place without claiming to be the exact position.
   */
  const tokenLink = (chain, token) => 'index.html?url=' +
    encodeURIComponent('https://www.geckoterminal.com/' + chain + '/tokens/' + token);

  /* ------------------------------------------------------------------ render */

  function render() {
    const addr = LP.wallet.address();
    const w = LP.wallet.state();

    return `<section class="card scan">
      <h3>Positions at an address</h3>
      <p class="muted">Reads liquidity positions straight from the chain. Works for any
      address &mdash; yours or anyone's &mdash; and asks for nothing but the address itself.</p>

      <div class="scan-controls">
        <input id="scanAddr" type="text" spellcheck="false" autocomplete="off"
          placeholder="0x… paste any address" value="${esc(addr || '')}"
          aria-label="Address to look up">
        <select id="scanChain" aria-label="Chain">
          ${LP.positions.chains().map((c) =>
            `<option value="${c}"${c === local.chain ? ' selected' : ''}>${esc(CHAIN_LABEL[c] || c)}</option>`).join('')}
        </select>
        <button class="btn" id="scanGo" type="button"
          ${local.state === 'scanning' ? 'disabled' : ''}>
          ${local.state === 'scanning' ? 'Reading…' : 'Find positions'}</button>
      </div>

      <div class="scan-connect">
        ${LP.wallet.available()
          ? `<button class="linklike" id="scanConnect" type="button">or connect a wallet to fill it in</button>
             <span class="fineprint">Reads your address only. No signature, no transaction, ever.</span>`
          : `<span class="fineprint">No wallet extension detected, which changes nothing here
             &mdash; pasting an address does exactly the same job.</span>`}
      </div>

      ${w.error ? `<p class="scan-error">${esc(w.error)}</p>` : ''}
      ${local.state === 'scanning' ? `<p class="muted scan-progress">${esc(local.progress || 'Reading the chain…')}</p>` : ''}
      ${local.state === 'error' ? `<div class="callout warn"><strong>Could not read that address.</strong>
        ${esc(local.error || '')}</div>` : ''}
      ${local.state === 'done' ? renderResult() : ''}
    </section>`;
  }

  function renderResult() {
    const r = local.result;
    const u = U();
    if (!r) return '';

    const conc = r.positions.filter((p) => p.kind === 'concentrated');
    const lp = r.positions.filter((p) => p.kind === 'lp-token');

    if (!conc.length && !lp.length) {
      return `<div class="callout">
        <strong>Nothing found on ${esc(CHAIN_LABEL[r.chain] || r.chain)}.</strong>
        That is not the same as "no positions" &mdash; see what this cannot see, below.
      </div>${renderLimits(r)}`;
    }

    return `
      <div class="metrics">
        ${metric('Concentrated positions', u.int(conc.length),
          conc.length ? 'open, with liquidity still in them' : 'none found')}
        ${metric('LP token holdings', u.int(lp.length),
          r.lpChecked + ' pools checked')}
        ${metric('Chain', esc(CHAIN_LABEL[r.chain] || r.chain), 'scan one chain at a time')}
      </div>

      ${conc.length ? `
      <h4>Concentrated positions</h4>
      <div class="table-scroll"><table>
        <thead><tr><th>Pair</th><th>DEX</th><th class="num">Fee</th><th class="num">Range (ticks)</th>
          <th class="num">Liquidity</th><th>Fees owed</th><th></th></tr></thead>
        <tbody>${conc.map((p) => `<tr>
          <td><strong>${esc(p.pair || (p.symbol0 + ' / ' + p.symbol1))}</strong>
            <div class="sc-sub">#${esc(p.tokenId)}</div></td>
          <td>${esc(p.dex)}</td>
          <td class="num">${u.pct(p.feeTier, 2)}</td>
          <td class="num">${p.tickLower} … ${p.tickUpper}</td>
          <td class="num">${esc(shortNum(p.liquidity))}</td>
          <td>${p.owedFees ? '<span class="up">uncollected</span>' : '<span class="muted">none</span>'}</td>
          <td><a href="${tokenLink(p.chain, p.token0)}">find pool →</a></td>
        </tr>`).join('')}</tbody>
      </table></div>` : ''}

      ${lp.length ? `
      <h4>LP token holdings</h4>
      <div class="table-scroll"><table>
        <thead><tr><th>Pool</th><th class="num">Balance</th><th class="num">Pool TVL</th><th></th></tr></thead>
        <tbody>${lp.map((p) => `<tr>
          <td><strong>${esc(p.symbol || p.pool)}</strong></td>
          <td class="num">${esc(shortNum(p.balance))}</td>
          <td class="num">${u.usd(p.tvlUsd)}</td>
          <td><a href="${poolLink(p.chain, p.pool)}">analyse →</a></td>
        </tr>`).join('')}</tbody>
      </table></div>` : ''}

      ${r.truncated.length ? `<div class="callout warn"><strong>Only the first
        ${LP.positions.MAX_NFTS} positions were read.</strong>
        ${r.truncated.map((t) => esc(t.dex) + ' reports ' + U().int(t.total) +
          ' positions at this address').join('; ')}. That is a protocol or a vault rather than
        a wallet, and reading them all would take hundreds of calls.</div>` : ''}

      ${r.errors.length ? `<p class="scan-error">${r.errors.map(esc).join(' · ')}</p>` : ''}
      ${renderLimits(r)}`;
  }

  /** Said plainly, because an incomplete list you believe is worse than no list. */
  function renderLimits(r) {
    return `<p class="fineprint"><strong>What this cannot see.</strong> Anything staked in a
      farm or gauge, because the LP token is then held by the gauge and not by you. Anything
      inside a vault or auto-compounder. Positions on a DEX whose position manager is not in the
      table this reads. And LP tokens in pools outside the ${r.lpChecked} busiest on the chain,
      since there is no index of which pools an address holds &mdash; they have to be checked
      one by one. Concentrated positions are found precisely; everything else is a sweep.</p>`;
  }

  function shortNum(s) {
    const n = Number(s);
    if (!isFinite(n)) return String(s).slice(0, 10) + '…';
    if (n >= 1e15) return (n / 1e18).toFixed(4);
    return U().int(Math.round(n));
  }

  function metric(label, value, sub) {
    return `<div class="metric">
      <span class="m-label">${label}</span>
      <span class="m-value">${value}</span>
      ${sub ? '<span class="m-sub">' + sub + '</span>' : ''}
    </div>`;
  }

  /* ------------------------------------------------------------------ wiring */

  let onChange = () => {};

  async function go() {
    const field = document.getElementById('scanAddr');
    const typed = field ? field.value : '';
    const addr = LP.wallet.isAddress(typed) ? LP.wallet.setAddress(typed) : LP.wallet.address();
    if (!addr) { onChange(); return; }

    local.state = 'scanning';
    local.progress = '';
    local.error = null;
    onChange();

    try {
      local.result = await LP.positions.scan(local.chain, addr, (m) => {
        local.progress = m;
        const el = document.querySelector('.scan-progress');
        if (el) el.textContent = m;        // update in place; a full redraw would steal focus
      });
      local.state = 'done';
    } catch (e) {
      local.error = e.message || String(e);
      local.state = 'error';
    }
    onChange();
  }

  function mount(rerender) {
    onChange = rerender || (() => {});
    document.addEventListener('click', async (ev) => {
      if (ev.target.id === 'scanGo') { await go(); return; }
      if (ev.target.id === 'scanConnect') {
        await LP.wallet.connect();
        const f = document.getElementById('scanAddr');
        if (f && LP.wallet.address()) f.value = LP.wallet.address();
        onChange();
        if (LP.wallet.address()) await go();
      }
    });
    document.addEventListener('change', (ev) => {
      if (ev.target.id === 'scanChain') {
        local.chain = ev.target.value;
        // A result from another chain would be misread as this one's.
        if (local.state === 'done') { local.state = 'idle'; local.result = null; }
        onChange();
      }
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && ev.target.id === 'scanAddr') { ev.preventDefault(); go(); }
    });
  }

  return { render, mount, go, state: () => local };
})();
