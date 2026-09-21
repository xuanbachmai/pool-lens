/* Formatting and small math helpers. Classic script so the app runs from file://. */
window.LP = window.LP || {};

LP.util = (function () {
  const num = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };

  function usd(v, opts) {
    const n = num(v);
    if (n === null) return '—';
    const compact = !opts || opts.compact !== false;
    const abs = Math.abs(n);
    if (compact && abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (compact && abs >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (compact && abs >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    if (abs >= 1) return '$' + n.toFixed(2);
    if (abs === 0) return '$0';
    return '$' + n.toPrecision(3);
  }

  function pct(v, digits) {
    const n = num(v);
    if (n === null) return '—';
    const d = digits === undefined ? 2 : digits;
    return (n >= 0 ? '' : '') + n.toFixed(d) + '%';
  }

  function signedPct(v, digits) {
    const n = num(v);
    if (n === null) return '—';
    const d = digits === undefined ? 2 : digits;
    return (n > 0 ? '+' : '') + n.toFixed(d) + '%';
  }

  function ratio(v, digits) {
    const n = num(v);
    if (n === null) return '—';
    return n.toFixed(digits === undefined ? 2 : digits);
  }

  function price(v) {
    const n = num(v);
    if (n === null) return '—';
    const abs = Math.abs(n);
    if (abs >= 1000) return n.toFixed(2);
    if (abs >= 1) return n.toFixed(4);
    if (abs === 0) return '0';
    return n.toPrecision(4);
  }

  function int(v) {
    const n = num(v);
    if (n === null) return '—';
    return Math.round(n).toLocaleString('en-US');
  }

  /** Human age from an ISO timestamp or epoch ms. */
  function age(ts) {
    if (!ts) return null;
    const then = typeof ts === 'number' ? ts : Date.parse(ts);
    if (!Number.isFinite(then)) return null;
    const days = (Date.now() - then) / 86400000;
    if (days < 0) return null;
    return days;
  }

  function ageLabel(days) {
    if (days === null || days === undefined) return '—';
    if (days < 1) return Math.round(days * 24) + 'h';
    if (days < 60) return Math.round(days) + ' days';
    if (days < 730) return (days / 30.44).toFixed(1) + ' months';
    return (days / 365.25).toFixed(1) + ' years';
  }

  /** Sample standard deviation. */
  function stdev(xs) {
    const n = xs.length;
    if (n < 2) return null;
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const v = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1);
    return Math.sqrt(v);
  }

  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  return { num, usd, pct, signedPct, ratio, price, int, age, ageLabel, stdev, escapeHtml, clamp };
})();
