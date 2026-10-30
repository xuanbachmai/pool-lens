/*
 * Keep the baked data current, and report what it cannot fix by itself.
 *
 * Several things in this app are snapshots: the project-to-category map, the per-chain gas
 * estimates, the chain name mappings, the DEX fee profiles. They were all correct when written
 * and all drift. This runs on a schedule and splits the problem in two:
 *
 *   UPDATED AUTOMATICALLY   The category map. It is a mechanical join on project slug with no
 *                           judgement in it, so a regeneration is always safe.
 *
 *   REPORTED FOR A HUMAN    New chains, new DEXes, and gas drift. Each of these needs a decision
 *                           that a script would get wrong. Adding a chain means picking the
 *                           exact DefiLlama name string, and a wrong guess fails silently -- the
 *                           "OP Mainnet" bug cost 435 pools before anyone noticed. Adding a DEX
 *                           profile means knowing whether it is constant-product or
 *                           concentrated, which decides which maths runs.
 *
 * Writing code that guesses at those would trade a visible gap for an invisible error, so it
 * writes a report instead and leaves the decision alone.
 *
 *   node tools/refresh.mjs              check everything, write the report
 *   node tools/refresh.mjs --write      also regenerate js/categories.js
 *   node tools/refresh.mjs --no-gas     skip the RPC round, which is the slow part
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLP } from '../test/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const WRITE = process.argv.includes('--write');
const NO_GAS = process.argv.includes('--no-gas');

const LP = loadLP(['util', 'fees', 'categories', 'llama'],
  { fetch: async () => { throw new Error('offline'); } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (res.ok) return res.json();
      if (res.status === 429 || res.status >= 500) { await sleep(1500 * (i + 1)); continue; }
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1000 * (i + 1));
    }
  }
}

const report = [];
const say = (s) => { console.log(s); report.push(s); };
let needsAttention = 0;

/* ------------------------------------------------------- 1. the universe -- */

say('## Data refresh — ' + new Date().toISOString().slice(0, 10));
say('');

const poolsRaw = await get('https://yields.llama.fi/pools');
const pools = poolsRaw.data || poolsRaw;
const protocols = await get('https://api.llama.fi/protocols');
const llamaChains = await get('https://api.llama.fi/v2/chains');

say(`Universe: ${pools.length.toLocaleString('en-US')} pools, ${protocols.length} protocols, ` +
    `${llamaChains.length} chains.`);
say('');

/* ------------------------------------------------- 2. categories (auto) --- */

const bySlug = new Map();
for (const p of protocols) if (p.slug) bySlug.set(p.slug, p.category || null);

const used = new Map();
for (const p of pools) if (!used.has(p.project)) used.set(p.project, bySlug.get(p.project) || null);

const categories = [...new Set([...used.values()].filter(Boolean))].sort();
const index = new Map(categories.map((c, i) => [c, i]));
const map = {};
for (const [slug, cat] of [...used.entries()].sort()) if (cat) map[slug] = index.get(cat);

const currentSize = LP.categories.size;
const delta = Object.keys(map).length - currentSize;

say('### Category map');
say(`Baked: ${currentSize} projects. Live: ${Object.keys(map).length} ` +
    `(${delta >= 0 ? '+' : ''}${delta}), ${categories.length} categories.`);

if (WRITE && delta !== 0) {
  const body = await buildCategoriesFile(categories, map, used.size);
  await writeFile(join(ROOT, 'js', 'categories.js'), body);
  say(`Regenerated \`js/categories.js\`.`);
} else if (delta !== 0) {
  say(`Out of date by ${Math.abs(delta)} projects — rerun with \`--write\` to regenerate.`);
} else {
  say('Up to date.');
}
say('');

async function buildCategoriesFile(cats, m, total) {
  const tmpl = await readFile(join(ROOT, 'js', 'categories.js'), 'utf8');
  // Replace only the generated parts, so hand-written helpers below survive a regeneration.
  return tmpl
    .replace(/\* Built \d{4}-\d{2}-\d{2} from \d+ projects across \d+ categories\./,
      `* Built ${new Date().toISOString().slice(0, 10)} from ${total} projects across ${cats.length} categories.`)
    .replace(/const NAMES = \[[\s\S]*?\];/, `const NAMES = ${JSON.stringify(cats)};`)
    .replace(/const MAP = \{[\s\S]*?\};\n/, `const MAP = ${JSON.stringify(m)};\n`);
}

/* ------------------------------------------------ 3. chains (reported) ---- */

say('### Chains');

const gtNets = [];
for (const page of [1, 2, 3]) {
  try {
    const d = await get(`https://api.geckoterminal.com/api/v2/networks?page=${page}`);
    gtNets.push(...(d.data || []));
  } catch (e) { say(`Could not read GeckoTerminal networks page ${page}: ${e.message}`); }
  await sleep(1200);
}

const tvlByName = new Map(llamaChains.map((c) => [String(c.name).toLowerCase(), c.tvl || 0]));
const mapped = LP.llama.CHAINS;

/*
 * The name that has to go into CHAINS comes from the YIELDS data, not from /v2/chains. The two
 * disagree, and only one of them is ever matched against: the chain list calls X Layer
 * "X Layer", while every pool on that chain is filed under "Xlayer".
 *
 * This report used to print the chain-list name beside an instruction to copy it exactly, which
 * is the most expensive kind of wrong -- advice that produces a mapping that looks right and
 * matches nothing. The pool count below is the proof: a name with no pools behind it is not the
 * name to use.
 */
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const yieldsByNorm = new Map();
for (const p of pools) {
  const k = norm(p.chain);
  if (!yieldsByNorm.has(k)) yieldsByNorm.set(k, { names: new Set(), n: 0 });
  const e = yieldsByNorm.get(k);
  e.names.add(p.chain);
  e.n++;
}

const unmapped = [];
for (const n of gtNets) {
  if (mapped[n.id]) continue;
  const name = n.attributes?.name || n.id;
  const y = yieldsByNorm.get(norm(name));
  unmapped.push({
    id: n.id, name,
    tvl: tvlByName.get(String(name).toLowerCase()) || 0,
    yieldsNames: y ? [...y.names] : [],
    nPools: y ? y.n : 0
  });
}
unmapped.sort((a, b) => b.tvl - a.tvl);

say(`GeckoTerminal indexes ${gtNets.length} networks; ${Object.keys(mapped).length} are mapped.`);

/*
 * Near misses matter more than absences. A key that is almost right -- starknet against
 * starknet-alpha -- looks mapped and returns nothing, which is how the OP Mainnet bug survived.
 */
const ourKeys = Object.keys(mapped);
const nearMiss = unmapped.filter((u) => ourKeys.some((k) =>
  k !== u.id && (u.id.startsWith(k) || k.startsWith(u.id.split('-')[0])) && u.id.split('-')[0] === k.split('-')[0]
))
  /*
   * A near miss is only worth a human's attention if there is something behind it. `sei-evm`
   * and `sonic-svm` match the shape of the bug this looks for, and both have no pools and no
   * TVL -- there is nothing to map and nothing being missed. They were reported every week
   * regardless, which is how a report trains its reader to skim past it.
   */
  .filter((u) => u.nPools > 0 || u.tvl > 0);

if (nearMiss.length) {
  needsAttention++;
  say('');
  say('**Possible key mismatches** — we have a similar key, so these look mapped and are not:');
  for (const m of nearMiss.slice(0, 8)) {
    const ours = ourKeys.find((k) => m.id.split('-')[0] === k.split('-')[0]);
    say(`- GeckoTerminal says \`${m.id}\`, we have \`${ours}\` — ${m.name}, ` +
        `$${(m.tvl / 1e6).toFixed(0)}M, ${m.nPools} pools in the yields data`);
  }
}

const bigUnmapped = unmapped.filter((u) => u.tvl > 50e6);
if (bigUnmapped.length) {
  needsAttention++;
  say('');
  say(`**${bigUnmapped.length} unmapped chains hold more than $50M:**`);
  say('');
  say('| GeckoTerminal id | Chain | TVL | Name to map | Pools |');
  say('| --- | --- | ---: | --- | ---: |');
  for (const u of bigUnmapped.slice(0, 15)) {
    const nm = u.yieldsNames.length
      ? u.yieldsNames.map((s) => '`' + s + '`').join(' + ')
      : '_nothing under this name_';
    say(`| \`${u.id}\` | ${u.name} | $${(u.tvl / 1e6).toFixed(0)}M | ${nm} | ${u.nPools} |`);
  }
  say('');
  say('**Name to map** is the spelling taken from the yields dataset, which is what `CHAINS` ' +
      'in `js/llama.js` is compared against — not the name DefiLlama displays for the chain. ' +
      'They differ more often than you would guess, and a near-miss returns zero pools in ' +
      'silence. Where two names are listed, map the key to an array of both: one chain is ' +
      'sometimes filed under several. Where none is listed, the yields data has no pools under ' +
      'that name, so mapping it now would add an entry that can only ever match nothing.');
}
say('');

/* ------------------------------------------- 4. DEX profiles (reported) --- */

say('### DEX fee profiles');

const NOT_DEX = /morpho|aave|compound|extra-finance|beefy|convex|stake-dao|yearn|gmx|venus|spark|maple|concrete|40-acres/i;
const amm = pools.filter((p) => p.exposure === 'multi' && p.ilRisk === 'yes' && !NOT_DEX.test(p.project));
const agg = new Map();
for (const p of amm) {
  const e = agg.get(p.project) || { tvl: 0, n: 0, chains: new Set() };
  e.tvl += p.tvlUsd || 0; e.n++; e.chains.add(p.chain);
  agg.set(p.project, e);
}
const rows = [...agg.entries()].map(([project, v]) => ({
  project, ...v, type: LP.fees.profileFor(project).type
}));
const total = rows.reduce((a, b) => a + b.tvl, 0);
const known = rows.filter((r) => r.type !== 'unknown').reduce((a, b) => a + b.tvl, 0);
const gaps = rows.filter((r) => r.type === 'unknown' && r.tvl > 2e6).sort((a, b) => b.tvl - a.tvl);

say(`Coverage: ${(known / total * 100).toFixed(1)}% of $${(total / 1e6).toFixed(0)}M in genuine AMM pools.`);

if (gaps.length) {
  needsAttention++;
  say('');
  say(`**${gaps.length} DEXes above $2M have no fee profile:**`);
  say('');
  say('| Project | TVL | Pools | Chains |');
  say('| --- | ---: | ---: | --- |');
  for (const g of gaps.slice(0, 12)) {
    say(`| \`${g.project}\` | $${(g.tvl / 1e6).toFixed(1)}M | ${g.n} | ${[...g.chains].slice(0, 3).join(', ')} |`);
  }
  say('');
  say('Adding one means deciding constant-product versus concentrated, which decides which ' +
      'maths runs. See `PROFILES` in `js/fees.js`.');
}
say('');

/* ------------------------------------------------- 5. gas (reported) ------ */

if (!NO_GAS) {
  say('### Gas estimates');

  const RPCS = {
    eth: ['https://ethereum-rpc.publicnode.com', 2500],
    base: ['https://mainnet.base.org', 2500],
    arbitrum: ['https://arbitrum-one-rpc.publicnode.com', 2500],
    optimism: ['https://optimism-rpc.publicnode.com', 2500],
    bsc: ['https://bsc-dataseed.binance.org', 740],
    polygon_pos: ['https://polygon-bor-rpc.publicnode.com', 0.23],
    avax: ['https://avalanche-c-chain-rpc.publicnode.com', 10.3]
  };
  const GAS_UNITS = 450000;      // approve + add + remove, the same basis the table uses

  const drift = [];
  for (const [chain, [url, nativeUsd]] of Object.entries(RPCS)) {
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_gasPrice', params: [], id: 1 })
      });
      const j = await res.json();
      if (!j.result) continue;
      const wei = parseInt(j.result, 16);
      const measured = wei * GAS_UNITS / 1e18 * nativeUsd;
      const table = LP.swap ? null : null;
      drift.push({ chain, gwei: wei / 1e9, measured });
    } catch (e) { /* a chain being unreachable is not a failure of the run */ }
  }

  if (drift.length) {
    say('Measured now, against the table in `js/swap.js` (450k gas round trip):');
    say('');
    say('| Chain | Gas price | Measured | In table | Ratio |');
    say('| --- | ---: | ---: | ---: | ---: |');
    const tableVals = await readTable();
    for (const d of drift) {
      const t = tableVals[d.chain];
      const ratio = (t && d.measured > 0) ? t / d.measured : null;
      const flag = ratio && (ratio > 6 || ratio < 0.2) ? ' ⚠️' : '';
      if (flag) needsAttention++;
      say(`| ${d.chain} | ${d.gwei.toFixed(4)} gwei | $${d.measured.toFixed(4)} | ` +
          `${t === undefined ? '—' : '$' + t} | ${ratio ? ratio.toFixed(1) + '×' + flag : '—'} |`);
    }
    say('');
    say('The table sits deliberately above the quiet-hour floor, so a ratio of a few times is ' +
        'expected. A flag means it is off by enough to change the minimum viable position size.');
  }
  say('');
}

async function readTable() {
  const src = await readFile(join(ROOT, 'js', 'swap.js'), 'utf8');
  const block = src.match(/const GAS_ROUND_TRIP = \{([\s\S]*?)\};/);
  if (!block) return {};
  const out = {};
  for (const m of block[1].matchAll(/'?([a-z_'-]+)'?\s*:\s*([\d.]+)/g)) {
    out[m[1].replace(/'/g, '')] = parseFloat(m[2]);
  }
  return out;
}

/* ------------------------------------------------------------- summary --- */

say('---');
say(needsAttention === 0
  ? '**Nothing needs a decision.** Everything mechanical is current.'
  : `**${needsAttention} thing${needsAttention === 1 ? '' : 's'} need a human decision** — see above.`);

await writeFile(join(ROOT, 'tools', 'refresh-report.md'), report.join('\n') + '\n');
console.log('\nreport written to tools/refresh-report.md');

// Non-zero tells CI to surface the report rather than pass quietly.
process.exit(needsAttention > 0 ? 2 : 0);
