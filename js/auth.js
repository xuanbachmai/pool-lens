/*
 * Accounts, and what they unlock.
 *
 * Three things need one: natural-language search, CSV export, and the saved book. Only the
 * first is actually enforced, and the distinction is worth being straight about rather than
 * blurring:
 *
 *   /api/ask        ENFORCED. It runs on the server and spends the operator's Anthropic
 *                   credits per question, so the server refuses it without a session. No
 *                   amount of fiddling in the browser gets around that.
 *
 *   CSV export      ADVISORY. The rows are already in the page; anyone determined can copy
 *                   them out of the DOM. The gate marks the feature, it does not protect data.
 *
 *   The book        ADVISORY, and local. Saved positions live in this browser's localStorage
 *                   and never reach a server, so signing in neither syncs them nor secures
 *                   them. It gates the feature, not the data.
 *
 * Calling the second two "locked" would be a lie the devtools console disproves in ten
 * seconds, so the UI says "needs an account" and the README says which is which.
 */
window.LP = window.LP || {};

LP.auth = (function () {
  const esc = (s) => LP.util.escapeHtml(s);

  const state = {
    signedIn: false,
    email: null,
    checked: false,          // has /api/auth?action=me answered yet
    available: true,         // false when the function is not deployed at all
    stage: 'email',          // email | code
    pending: null,           // address a code was sent to
    busy: false,
    error: null,
    notice: null
  };

  /** What requires an account. Everything not listed is free and public. */
  const GATED = {
    ask: { label: 'Natural-language search',
           why: 'Each question costs the operator money to answer, so it needs an account.',
           enforced: true },
    csv: { label: 'CSV export',
           why: 'Exports are for signed-in users.',
           enforced: false },
    book: { label: 'Your book',
            why: 'Saving positions is for signed-in users.',
            enforced: false }
  };

  const isGated = (feature) => !!GATED[feature];
  const allows = (feature) => !isGated(feature) || state.signedIn;

  /* -------------------------------------------------------------------- api */

  async function call(action, body) {
    const res = await fetch('/api/auth?action=' + encodeURIComponent(action), {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    });
    if (res.status === 404) {
      state.available = false;
      throw new Error('/api/auth is not deployed here, so sign-in is unavailable. Everything ' +
        'that does not need an account still works.');
    }
    /*
     * Anything that is not a 404 proves the endpoint exists, including a 401. Without this the
     * flag latched: one missing deployment, or a single network blip during boot, disabled
     * sign-in for the rest of the session even after the function came back.
     */
    state.available = true;

    let json = {};
    try { json = await res.json(); } catch { /* keep the status-based message below */ }
    if (!res.ok) throw new Error(json.message || ('Sign-in failed with HTTP ' + res.status));
    return json;
  }

  /** Ask the server who we are. Safe to call on every page. */
  async function refresh() {
    try {
      const me = await call('me');
      state.signedIn = !!me.signedIn;
      state.email = me.email || null;
    } catch (e) {
      state.signedIn = false;
      state.email = null;
    }
    state.checked = true;
    return state.signedIn;
  }

  async function requestCode(email) {
    state.busy = true; state.error = null; state.notice = null;
    try {
      const r = await call('request', { email });
      state.stage = 'code';
      state.pending = email;
      state.notice = r.message || 'Check your email for a six-digit code.';
      // Only ever present when running locally with no mail provider configured.
      if (r.devCode) {
        state.notice += ' (Local development, no mail provider configured — your code is ' +
          r.devCode + '.)';
      }
    } catch (e) {
      state.error = e.message || String(e);
    } finally {
      state.busy = false;
    }
  }

  async function verifyCode(code) {
    state.busy = true; state.error = null;
    try {
      const r = await call('verify', { email: state.pending, code });
      state.signedIn = !!r.signedIn;
      state.email = r.email || state.pending;
      state.stage = 'email';
      state.notice = null;
    } catch (e) {
      state.error = e.message || String(e);
    } finally {
      state.busy = false;
    }
  }

  async function signOut() {
    try { await call('signout'); } catch { /* clearing a cookie that may already be gone */ }
    state.signedIn = false;
    state.email = null;
  }

  /* ----------------------------------------------------------------- render */

  /** The header control: who you are, or a way to become someone. */
  function renderBadge() {
    if (!state.checked || !state.available) return '';
    return state.signedIn
      ? `<span class="auth-badge" title="${esc(state.email || '')}">
           <span class="auth-dot"></span>${esc(shortEmail(state.email))}
           <button class="linklike" id="authOut" type="button">Sign out</button>
         </span>`
      : `<button class="btn secondary auth-in" id="authIn" type="button">Sign in</button>`;
  }

  function shortEmail(e) {
    const s = String(e || '');
    return s.length > 22 ? s.slice(0, 19) + '…' : s;
  }

  /**
   * The panel shown in place of a gated feature.
   *
   * It names what is behind the gate and why, rather than only refusing, and says plainly when
   * a gate is a product boundary rather than a security one.
   */
  function renderGate(feature) {
    const g = GATED[feature];
    if (!g) return '';
    if (!state.available) {
      return `<div class="callout"><strong>${esc(g.label)} is unavailable here.</strong>
        Sign-in needs <code>/api/auth</code>, which is not deployed on this host. Everything
        that does not need an account still works.</div>`;
    }
    return `<div class="auth-gate">
      <div>
        <strong>${esc(g.label)} needs an account.</strong>
        <p class="fineprint">${esc(g.why)}${g.enforced ? '' :
          ' This one is a product boundary rather than a lock — the data is already in the page.'}
          Signing in takes an email address and a six-digit code. No password.</p>
      </div>
      <button class="btn" data-auth-open="1" type="button">Sign in</button>
    </div>`;
  }

  /** The sign-in dialog itself. */
  function renderDialog() {
    if (!state.open) return '';
    const onCode = state.stage === 'code';
    return `<div class="auth-overlay" id="authOverlay">
      <div class="auth-modal" role="dialog" aria-modal="true" aria-labelledby="authTitle">
        <h3 id="authTitle">${onCode ? 'Enter your code' : 'Sign in'}</h3>
        ${onCode
          ? `<p class="muted">We sent a six-digit code to <strong>${esc(state.pending || '')}</strong>.
             It works for ten minutes.</p>
             <input id="authCode" type="text" inputmode="numeric" autocomplete="one-time-code"
               maxlength="6" placeholder="123456" aria-label="Six-digit code">
             <div class="auth-actions">
               <button class="btn" id="authVerify" type="button" ${state.busy ? 'disabled' : ''}>
                 ${state.busy ? 'Checking…' : 'Sign in'}</button>
               <button class="linklike" id="authBack" type="button">Use a different address</button>
             </div>`
          : `<p class="muted">Enter your email and we will send a six-digit code. There is no
             password to choose or forget.</p>
             <input id="authEmail" type="email" autocomplete="email" placeholder="you@example.com"
               aria-label="Email address">
             <div class="auth-actions">
               <button class="btn" id="authSend" type="button" ${state.busy ? 'disabled' : ''}>
                 ${state.busy ? 'Sending…' : 'Send code'}</button>
               <button class="linklike" id="authCancel" type="button">Cancel</button>
             </div>`}
        ${state.notice ? '<p class="auth-notice">' + esc(state.notice) + '</p>' : ''}
        ${state.error ? '<p class="auth-error">' + esc(state.error) + '</p>' : ''}
        <p class="fineprint">Your address is used to send the code and to remember you. It is
        not shared, and the free analysis on this site never required one.</p>
      </div>
    </div>`;
  }

  /* ----------------------------------------------------------------- wiring */

  let onChange = () => {};

  function open() { state.open = true; state.error = null; onChange(); }
  function close() { state.open = false; state.stage = 'email'; state.error = null;
                     state.notice = null; onChange(); }

  /**
   * Mount into a page. `rerender` is called whenever the auth state changes so the host page
   * can redraw whatever depended on it.
   */
  function mount(rerender) {
    onChange = rerender || (() => {});
    document.addEventListener('click', async (ev) => {
      const t = ev.target;
      if (t.closest('[data-auth-open]') || t.id === 'authIn') { open(); return; }
      if (t.id === 'authCancel' || t.id === 'authOverlay') { close(); return; }
      if (t.id === 'authBack') { state.stage = 'email'; state.error = null; onChange(); return; }
      if (t.id === 'authOut') { await signOut(); onChange(); return; }
      if (t.id === 'authSend') {
        const el = document.getElementById('authEmail');
        await requestCode(el ? el.value : '');
        onChange();
        const c = document.getElementById('authCode');
        if (c) c.focus();
        return;
      }
      if (t.id === 'authVerify') {
        const el = document.getElementById('authCode');
        await verifyCode(el ? el.value : '');
        onChange();
        if (state.signedIn) close();
        return;
      }
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && state.open) close();
      if (ev.key === 'Enter' && state.open) {
        const send = document.getElementById('authSend');
        const verify = document.getElementById('authVerify');
        if (verify) verify.click(); else if (send) send.click();
      }
    });
  }

  /*
   * Boot on every page.
   *
   * The badge and dialog go into #authSlot wherever it exists, and any change fires an
   * `lp:auth` event on the document so a page can redraw whatever depended on the session
   * without this module needing to know what that is.
   */
  function paint() {
    const slot = document.getElementById('authSlot');
    if (slot) slot.innerHTML = renderBadge() + renderDialog();
    document.dispatchEvent(new CustomEvent('lp:auth', { detail: { signedIn: state.signedIn } }));
  }

  async function boot() {
    mount(paint);
    paint();                 // render the slot immediately, before the server answers
    await refresh();
    paint();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  return { refresh, mount, open, close, signOut, boot, paint,
           renderBadge, renderGate, renderDialog,
           allows, isGated, GATED, state: () => state };
})();
