/*
 * Minimal test harness.
 *
 * The app's modules are browser globals (window.LP.*), not ES modules, so this loads them
 * into a fake window and exposes LP to the tests. No dependencies -- the point of a test
 * suite here is that it runs anywhere, every time, without an install step.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Load the browser modules in dependency order into one shared context. */
export function loadLP(files = [
  'util', 'parse', 'fees', 'backtest', 'swap', 'analyze', 'model', 'llama'
], opts = {}) {
  // Tests get no network by default; pass a stub to exercise code paths behind fetch.
  const fetchImpl = opts.fetch || (async () => { throw new Error('network disabled in tests'); });
  const sandbox = { console, Math, Date, JSON, parseFloat, parseInt, Number, String, Object,
                    Array, Map, Set, isNaN, isFinite, URL, Promise, setTimeout,
                    performance, fetch: fetchImpl };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const f of files) {
    const src = readFileSync(join(ROOT, 'js', `${f}.js`), 'utf8');
    vm.runInContext(src, ctx, { filename: `js/${f}.js` });
  }
  return ctx.window.LP;
}

/* ------------------------------------------------------------------ runner */

let passed = 0, failed = 0, current = '';
const failures = [];

export function suite(name) { current = name; console.log(`\n${name}`); }

export function check(label, condition, detail) {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else {
    failed++;
    failures.push(`${current} > ${label}${detail ? `\n       ${detail}` : ''}`);
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
  }
}

/** Floating-point comparison with an explicit tolerance. */
export function near(label, actual, expected, tol = 1e-9) {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
  check(label, ok, ok ? '' : `expected ${expected}, got ${actual} (tol ${tol})`);
}

export function throwsOrNull(label, fn) {
  let r;
  try { r = fn(); } catch { check(label, true); return; }
  check(label, r === null || r === undefined,
    r === null || r === undefined ? '' : `expected null/throw, got ${JSON.stringify(r)}`);
}

export function report() {
  console.log(`\n${'-'.repeat(60)}`);
  if (failed) {
    console.log(`${failed} FAILED, ${passed} passed\n`);
    failures.forEach((f) => console.log(`  ${f}`));
    process.exitCode = 1;
  } else {
    console.log(`all ${passed} checks passed`);
  }
}
