# Pool Lens

Paste a link to a DEX liquidity pool, get a first-pass LP analysis.

Open `index.html` in a browser. That's the whole install — no server, no build step, no API keys,
no dependencies. Everything runs client-side against two free public APIs.

```
index.html          markup + styles
js/util.js          number formatting and small maths helpers
js/parse.js         pasted URL -> { chain, address }
js/fees.js          swap fee per DEX, and how much of it the LP actually keeps
js/api.js           GeckoTerminal + DexScreener clients, pool resolution
js/analyze.js       the analysis engine
js/backtest.js      range replay against real daily bars
js/model.js         one closed-form model of a position, built to be perturbed
js/formulas.js      the formula catalogue, with live numbers substituted in
js/whatif.js        sensitivity panel + formulas panel
js/ui.js            rendering and event wiring
```

You can also deep-link: `index.html?url=<pool url>`.

If you prefer to serve it rather than open the file directly, there is a launch config:

```bash
py -3 -m http.server 8765
```

## What it answers

The analysis is organised around the three goals of an LP, taken from a set of *Liquidity Providing
in DeFi* course notes (not included in this repo):

1. **If concentrated, how long does the price stay in range?** Replays the real daily bars for the
   pool through a range of your chosen width, and reports time in range, fees earned while active,
   impermanent loss, and net versus simply holding. A width sweep shows the trade-off directly —
   tight ranges multiply fees and lose them faster.
2. **Volume / reserves.** How much volume the pool does relative to its own size, against the
   0.25-over-1-to-3-days benchmark from those notes. Shown for 24h, 6h and a 3-day average.
3. **Do fees beat holding?** Impermanent loss from the constant-product formula
   `2√r/(1+r) − 1`, the price divergence that accumulated fees can absorb, a scenario table, and
   what actually happened over your hold period using the pool's real volume history.

Plus a risk-flag pass: thin liquidity, implausible V/R, bot-dominated trade counts, new pools,
FDV that dwarfs the pool, trending-rather-than-choppy price action, and pool types where the maths
above doesn't apply.

## What if a number changes?

Every input is a slider set to the pool's real measured value. Move one and the whole outcome
recomputes — same model, one term replaced, no refetch. The panel answers four questions:

- **What happens?** Net vs holding, fees, IL, APR and your pool share, each with the delta from base.
- **Which input matters most?** A tornado chart perturbing every driver ±25% on its own. The widest
  bar is the number worth being right about — usually the price ratio, rarely your position size.
- **How does one input behave across its range?** A sweep table, with the elasticity stated in
  percentage points as well as as a ratio.
- **How far can each input move before LPing stops being worth it?** A break-even solve per input.
  Non-monotonic drivers (range width, price ratio) correctly report *both* roots.

Then a heat grid of net return across every combination of price move and volume.

The model adds one term the main analysis leaves out: **your own dilution**. You do not earn the
pool's quoted fee rate, you earn a share of it, and your own deposit sits in the denominator —
`share = E·Q / (R + E·Q)`. On a large pool that term is invisible; on a small one it dominates
everything else on the page.

## Formulas

Every formula the app uses, shown three ways: symbolically, with this pool's numbers substituted
in, and the result — so any figure on the page can be checked by hand. Grouped into fee income,
impermanent loss, range mechanics, price behaviour, and how the scores are built. The
constant-product IL entry carries its derivation; the substitution lines follow the what-if sliders,
so you can watch a formula's arithmetic change as you drag.

## Input formats it understands

Pool pages from Uniswap, DexScreener, GeckoTerminal, PancakeSwap, Balancer, Aerodrome, Orca,
Pendle and most others — it pulls the address out of the URL and reads the chain from the path,
a `?chainId=` parameter, or the host for single-chain front-ends. A bare pool address works too.

Two fallbacks:

- **A token address instead of a pool** (e.g. a Uniswap token page): shows the deepest pool that
  trades it, with a picker for the rest.
- **URLs with no address at all** (Curve's `factory-stable-ng-42` style paths): explains what to
  copy instead. There is no way to resolve those without the pool contract address.

## What it deliberately does not do

- **No emissions or incentives.** Every yield figure is swap-fee only. On many pools the advertised
  APY is mostly token emissions or a Merkl campaign — add those separately, and remember they
  dilute as liquidity arrives.
- **No gas, MEV, rebalancing cost, or smart-contract risk.**
- **Not advice.** Fee APR is an extrapolation of recent volume and will not repeat.

## Known approximations

These are stated in the UI too, but collected here:

| Approximation | Why | Effect |
| --- | --- | --- |
| Historical fees use today's TVL against each day's real volume | Free endpoints don't expose historical reserves | Overstates past fees if the pool has grown since, understates them if it shrank |
| Concentration multiplier assumes the rest of the pool's liquidity distribution is static | We can't see the live tick distribution | Overstates fees for a tight range if others crowd in at the same prices |
| Backtest never rebalances | Keeps the comparison against holding clean | Real managed positions rebalance, which realises some IL but keeps fees flowing |
| LP fee share is a table of per-DEX defaults | These splits change by governance vote | Editable in the assumptions panel; the header says where each fee number came from |
| Fees accrue on the share of *volume* that traded in range (τ_v), not the share of days (τ) | The busy days and the in-range days are often not the same days | Using the day count overstated fees by ~45% on a tight WETH/USDC range in testing, so the model uses τ_v and the UI shows both |
| The what-if model holds volume flat at the trailing average | A single forward number has to come from somewhere | The sweep and heat grid exist precisely so you can see what other volumes would do |
| Stableswap, weighted and Pendle pools use the constant-product IL formula | It's the only closed form that fits every pool type | Flagged in the risk list — for those pools treat the IL column as an upper bound (stableswap) or as not applicable (Pendle) |

Fee tiers are read from the pool itself where the API exposes them (concentrated-liquidity pools),
parsed from the pool name, or fall back to a per-DEX default. The header badge always says which,
and `assumed` means you should check the pool page.

## Deploying

Pure static files, so any static host works. `vercel.json` sets `must-revalidate` on everything —
the JS filenames aren't content-hashed, so this is what stops a browser serving a stale module
after a deploy. It also sets a CSP that allows scripts only from this origin and network calls
only to the two data APIs.

## Data sources

- [GeckoTerminal](https://api.geckoterminal.com/api/v2) — pool state, fee tier, daily OHLCV.
  Free tier is roughly 30 requests/minute; the app uses 2 per analysis and reports a clear message
  when it gets limited.
- [DexScreener](https://api.dexscreener.com) — independent cross-check of liquidity and volume.

Both send `Access-Control-Allow-Origin: *`, which is why this works from a `file://` page with no
proxy.

## Possible next steps

- Pendle-specific mode using the Pendle V2 principal-token AMM (implied yield, time to expiry,
  PT-to-par convergence) instead of spot IL.
- Read the live v3 tick distribution on-chain so the concentration multiplier reflects real
  competing liquidity rather than assuming it's static.
- Pull Merkl campaign data to fold incentives into the yield figures.
- Multi-pool watchlist and a saveable comparison table.
