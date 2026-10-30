/*
 * An address, however you want to give it.
 *
 * The important design point: this feature needs an ADDRESS, not a wallet. Pasting one works
 * identically to connecting, lets you look at any address rather than only your own, and asks
 * nothing of you. Connecting is offered as a convenience for filling the field in, not as a
 * requirement, and the paste box comes first in the UI for that reason.
 *
 * What this will never do:
 *
 *   - ask for a signature. Reading positions needs no proof you own the address.
 *   - build, send or suggest a transaction.
 *   - ask for a seed phrase or private key, which nothing legitimate ever does.
 *
 * It calls exactly one wallet method, eth_requestAccounts, and reads the first account. Anything
 * beyond that would be a reason for someone to distrust the page, and there is no feature here
 * worth that.
 */
window.LP = window.LP || {};

LP.wallet = (function () {
  const state = {
    address: null,
    source: null,        // 'wallet' | 'typed'
    connecting: false,
    error: null
  };

  const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || '').trim());
  const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';

  /** Is there an injected provider at all? */
  const available = () => typeof window.ethereum !== 'undefined';

  /**
   * Ask the wallet which account it is willing to share.
   *
   * Deliberately the only wallet call in the codebase. No signature, no chain switch, no
   * transaction — the page has nothing to do with an address except read public chain state
   * about it.
   */
  async function connect() {
    if (!available()) {
      state.error = 'No wallet extension found in this browser. Paste an address instead — ' +
        'it does exactly the same thing here.';
      return null;
    }
    state.connecting = true;
    state.error = null;
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      const a = Array.isArray(accounts) ? accounts[0] : null;
      if (!isAddress(a)) throw new Error('The wallet did not return an address.');
      state.address = a.toLowerCase();
      state.source = 'wallet';
      return state.address;
    } catch (e) {
      // 4001 is the standard "user rejected" code; it is a choice, not a failure.
      state.error = (e && e.code === 4001)
        ? 'Connection declined. You can paste an address instead.'
        : 'Could not read an address from the wallet. ' + ((e && e.message) || '');
      return null;
    } finally {
      state.connecting = false;
    }
  }

  /** Use a typed or pasted address. Works for any address, including ones you do not own. */
  function setAddress(a) {
    const v = String(a || '').trim();
    if (!isAddress(v)) {
      state.error = 'That is not a valid address. It should be 0x followed by 40 characters.';
      return null;
    }
    state.address = v.toLowerCase();
    state.source = 'typed';
    state.error = null;
    return state.address;
  }

  function clear() {
    state.address = null;
    state.source = null;
    state.error = null;
  }

  return { connect, setAddress, clear, available, isAddress, short,
           address: () => state.address, source: () => state.source,
           error: () => state.error, state: () => state };
})();
