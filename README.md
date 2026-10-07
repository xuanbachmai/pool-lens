# Pool Lens

Paste a link to a DEX liquidity pool, get a first-pass LP analysis.

Open `index.html` in a browser. That's the whole install — no server, no build step, no API keys,
no dependencies. Everything runs client-side against two free public APIs.

```
index.html          the pool analyser
book.html           every saved position at once
amm.html            the AMM formula demo, standalone
farm.html           the farm screener: single- and dual-sided
css/app.css         shared stylesheet for both pages
js/util.js          number formatting and small maths helpers
js/parse.js         pasted URL -> { chain, address }
js/fees.js          swap fee per DEX, and how much of it the LP actually keeps
js/api.js           GeckoTerminal + DexScreener clients, pool resolution
js/analyze.js       the analysis engine
js/backtest.js      range replay against real daily bars
js/swap.js          constant-product curve maths: quotes, slippage, entry/exit cost
js/execution.js     the "getting in and out" panel
js/position.js      your saved position, and how it has actually done
js/strategy.js      ranked strategies and the exact levels to watch
js/model.js         one closed-form model of a position, built to be perturbed
js/formulas.js      the formula catalogue, with live numbers substituted in
js/whatif.js        sensitivity panel + formulas panel
js/lab.js           the AMM demo's controls and charts
js/llama.js         DefiLlama yields client: emissions split, single/dual exposure
js/emissions.js     emissions panel on the analyser
js/screener.js      the farm screener's filters and table
js/portfolio.js     the book: totals, concentration, urgency ranking
js/ask.js           natural-language filter box
api/ask.js          serverless function: language -> filter spec (Vercel)
alerts/check.mjs    scheduled alert check (GitHub Actions)
js/ui.js            rendering and event wiring for the analyser
```

You can also deep-link: `index.html?url=<pool url>`.

If you prefer to serve it rather than open the file directly, there is a launch config:

```bash
py -3 -m http.server 8765
```

## Four pages

**`index.html`** analyses a real pool you paste a link to.

**`book.html`** shows every position you've saved at once.

**`farm.html`** screens ~17,000 farms across both kinds of exposure.

**`amm.html`** is a standalone demo of the formula underneath it — drag a trade along the curve,
compare depth across pool sizes, test whether splitting an order helps, watch impermanent loss
against the price ratio, and find the arbitrage that closes a gap.

The demo is not a second implementation. It imports `js/swap.js` and `js/analyze.js` — the exact
modules the analyser runs on — so the two cannot drift apart. If a formula is wrong in the demo it
is wrong in the tool, which is the point of sharing them.

Things the demo makes concrete, all computed live rather than asserted:

- At **zero fee, splitting a trade changes nothing** — one trade and twenty pieces both cost
  150.0000 to four decimals, because the curve is path-independent. Add a fee and each piece
  raises k, so splitting always costs more.
- **IL(r) = IL(1/r)**: −50% and +100% both cost exactly 5.719%.
- The **no-arbitrage band is only a fee wide** — $2,991.00 to $3,009.03 on a $3,000 pool at 0.30%,
  which is ±f/(1−f). Set the fee to zero and it collapses to a point.
- The same 20 ETH trade costs **25.4% in a 100 ETH pool and 2.3% in a 1,000 ETH pool**.

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

## Getting in and out

Every other panel reasons from aggregate TVL and volume, and quietly assumes you can enter and
leave at mid price. You can't: opening a position means swapping into the pair and closing it
means swapping back, and both legs pay the fee and move the price against you.

Given the pool's real token reserves this panel prices that round trip exactly — entry swap, exit
swap, depth table, and a price-impact curve — then converts it into the number that matters:
**how many days in the position it takes just to earn the round trip back.**

Two details that are easy to get wrong and are handled explicitly:

- You only swap the part that has to change hands, not the whole position. Full range is 50/50;
  a concentrated range is not, and the required split comes from the position formulas exactly.
- The exit is priced against the pool **after** your own liquidity is withdrawn. Pulling out makes
  the pool thinner, and on a small pool that is most of the exit cost.

The effect is not subtle. Same $10k position, same 0.3% fee:

| Pool size | Position as % of pool | Round trip cost |
| --- | --- | --- |
| $20M | 0.05% | 0.35% |
| $500k | 2% | 2.27% |
| $100k | 10% | 9.79% |
| $25k | 40% | 34.4% |

### Where this is valid, and where it refuses to answer

For a constant-product pool the reserves define the whole curve and every number here is exact.
For a **concentrated-liquidity** pool the totals are inventory spread across many price ranges and
say nothing about depth at the current price — running the same arithmetic on them would produce a
confident-looking number that is simply wrong.

The app detects which case it is in from the data rather than trusting the DEX label: on a real
CPMM pool the reserve ratio equals the spot price to within rounding, and on a concentrated pool it
does not. A live check across three pools:

| Pool | reserve ratio | spot price | verdict |
| --- | --- | --- | --- |
| Uniswap v2 WETH/USDC | 2680.301 | 2680.3011 | curve valid, priced exactly |
| Uniswap v3 WETH/USDC | 8243.16 | 2673.60 | refuses to quote slippage |
| Aerodrome Slipstream | 241.43 | 116.40 | refuses to quote slippage |

For concentrated pools the panel still gives the exact deposit split and the position-vs-pool
ratio, and states plainly that tick-level liquidity — which the free APIs don't expose — is what
would be needed for the rest.

## Is this a good % to farm? — single and dual

`farm.html` pulls DefiLlama's yields dataset and splits farming into the two things that get
conflated:

- **single-sided** — lending vaults, staked stables, LSTs. No impermanent loss, so the yield *is*
  the return. The risks sit elsewhere: protocol risk, a stablecoin losing its peg, and withdrawal
  cooldowns.
- **dual-sided** — ordinary two-token LP, which has impermanent loss that no headline APY deducts.

The page is built around the one question a headline APY cannot answer: **how much of it is real?**
DefiLlama splits `apy` into `apyBase` (earned) and `apyReward` (token emissions). Three presets
cover the questions people actually arrive with: real yield only, safe single-sided stables, and
dual-sided LP.

What the data actually shows — measured on a snapshot in `test/fixtures/`, not assumed:

| | Majority-emissions pools | In the top 25 by APY |
| --- | --- | --- |
| Single-sided | 11% | 4% |
| Dual-sided | 22% | 24% |
| All liquid pools | 16% | 24% |

So emission-dependence is a **minority** condition, and most pools carry none at all. An earlier
version of this README claimed that sorting by headline APY surfaces the emission-heavy pools; the
test suite disproved it (only 6 of the top 25 by APY were majority-emissions, and the median
emissions share is 0%), and the claim has been corrected here and in the UI.

What *is* true is narrower and more useful: when a pool is emission-dependent, almost none of its
yield is earned — that group averages **7.8% advertised against 0.9% earned** — and the headline
number doesn't reveal it. That's why the split is its own column, why the reward share is a bar you
can't miss, and why the default sort is earned yield: not because APY surfaces emissions, but
because earned yield never flatters a pool whose yield wouldn't survive the campaign ending.

### The analyser now counts emissions too

Every panel used to say "emissions are not counted". The analyser can now load the same dataset on
demand and match the pool by chain plus both token addresses, then by DEX and fee tier. That also
gives an **independent cross-check on fee APR** — on a live Uniswap v3 WETH/USDC 0.05% pool, this
app computed 10.52% from reserves and volume while DefiLlama independently reported 10.4976%, a
0.02pp gap with a 0% TVL difference. Where the two disagree, the disagreement is shown rather than
hidden.

It is loaded only when asked: ~2.4 MB gzipped is not worth pulling on every analysis for a figure
that is often zero. Both pages share one cache.

## Does it use an LLM?

Only for language. Every number in this app — APY, impermanent loss, slippage, break-even,
capital efficiency — is closed-form maths over live market data, and that is deliberate: those
figures are checkable by hand, and a hallucinated one is indistinguishable from a real one.

The one place a model earns its place is translating a sentence into a filter. `api/ask.js` takes
"single-sided stables above 10% that aren't mostly emissions" and returns filter *parameters* —
exposure, thresholds, sort order — which are then applied by the same deterministic screening
code the checkboxes drive. The model never produces a figure that reaches the analysis.

The compiled filter is shown and every control stays editable, so its work can be corrected
rather than trusted. Structured outputs with a strict JSON schema make the response always
parse; `claude-opus-5` at low effort, since this is translation rather than reasoning.

The key lives in a Vercel environment variable (`ANTHROPIC_API_KEY`) and never reaches the
browser. Without it the endpoint returns 501 and the page explains the one-time setup — the rest
of the screener is unaffected.

## Automated alerts

The web app computes alert levels but cannot send anything: it is a static page, so nothing runs
once you close the tab. `alerts/check.mjs` is what runs instead — a GitHub Actions cron that
re-fetches pool state, evaluates the same thresholds, and posts to Telegram or a Discord/Slack
webhook. Dependency-free; Node 18+ has `fetch` built in.

Alerts fire on the **edge**, not every run. `alerts/state.json` records which conditions were
already active, so a broken range notifies once rather than every thirty minutes for a week.
Setup is in [`alerts/README.md`](alerts/README.md).

## Is this number even real? — the confidence score

A yield figure is a snapshot, and snapshots lie. Measured across the dataset: for the bottom
decile of pools today's APY is under **0.40x** its own 30-day average, for the top decile it is
over **1.46x**, 5% are showing more than double, and 6% have under a month of history behind them.
None of that is visible in the number itself.

So the screener scores **how much the figure can be trusted** — explicitly not how good the pool
is — on four things the data supports: days of history, the volatility of the APY itself, how far
today sits from the pool's own 30-day mean, and how much is emissions. DefiLlama's own
unreliability flag caps the result rather than nudging it.

The size of the yield is deliberately *not* an input. A trustworthy 4% scores higher than a
suspect 400%, which is the entire point:

| Ranked by headline APY | Confidence | Weakest signal |
| --- | --- | --- |
| 43,041% USDC-PROS | **25 poor** | sigma 9.42 |
| 20,625% USDC-VELVET | **25 poor** | sigma 8.83 |
| 500% CDT-BTC | **25 poor** | **2 days of data** |

| Ranked by confidence | APY | |
| --- | --- | --- |
| UPSSYLVA / upshift | 27% | **100 high** |
| COREUSDC / upshift | 10% | **100 high** |

Five pools in the set advertise over 1,000% APY. At a confidence floor of 70, **none** survive.

## V/R across every pool

The OTS notes call volume-over-reserves the single most important metric for picking a pool, and
the analyser has always computed it for one pool. The screener now computes it for all 739
dual-sided pools that report swap volume — DefiLlama doesn't rank by it. Only **31%** clear the
0.25 benchmark.

It is blank, not zero, for single-sided pools: a lending vault has no swaps, and "unknown" and
"none" are different claims. Anything above about 5x is usually looped or wash volume rather than
a genuinely busy pool, so the presets cap it there — `CDT-OSMO` at V/R 858 is not a find.

## Is your position big enough to bother?

Gas does not care how much you deposit. Swap cost is proportional and slippage grows faster than
linearly, so cost as a share of the position is **U-shaped** — ruinous when small because gas is
the whole bill, ruinous when large because slippage is. Both ends matter and neither appears on a
DEX front-end.

On a $20M pool at 0.05%, charging Ethereum gas for four transactions:

| Position | Gas | Fee + slippage | All-in | Fees to repay |
| --- | --- | --- | --- | --- |
| $99 | 60.57% | 0.05% | **60.62%** | 758 days |
| $2,009 | 2.99% | 0.06% | 3.05% | 38 days |
| $47,039 | 0.13% | 0.29% | **0.41%** | 5 days |
| $954,133 | 0.01% | 4.71% | **4.71%** | 59 days |

The same economics on a cheaper chain move the floor by two orders of magnitude — cheapest size
$35,316 on Ethereum against $638 on Solana. When no size repays inside the chosen horizon, the
panel says so and reports the fastest payback the pool can manage, because "no size works" is a
verdict on the pool rather than on your sizing.

Gas is a rough per-chain default and editable; the spread between chains is the part that matters.

## Is the pool dying?

Pools die quietly. Fee APR is annualised from recent volume, so a pool whose trading has halved
keeps advertising yesterday's yield until someone looks. The analyser compares the **median** daily
volume of the last week against the month before it — medians, because one wash-trading day or one
airdrop farm can double a mean and invent a trend that is not there.

Four states: collapsing (under 0.4x), draining (under 0.7x), steady, growing (over 1.5x).
Collapsing is a critical flag; draining is a warning. Verified against synthetic series, including
the case that matters — a single 50x volume spike still reads as *steady*.

## Sharing a screen

Filters live in the URL hash, short keys, defaults omitted:
`farm.html#s=confidence&tvl=5000000&apy=6&cf=70`. Bookmark it or send it; it restores every filter
and reproduces the same result count. There's a CSV export of exactly the rows on screen, derived
columns included.

## Your book

Every page before this reasoned about one pool. A book asks different questions, and `book.html`
answers them from the positions already in local storage:

- **Which position needs attention first** — ranked by urgency, not size. A broken range outranks
  a large position, because capital earning nothing is the costliest state to leave alone.
- **How much capital is earning nothing** — the share of the book sitting outside its range. The
  number nobody tracks.
- **Whether five positions are really one bet** — token and chain concentration. Positions in
  different pools are not diversification if they share a token.

It also catches a mistake that silently produces a confident catastrophe. A pool's price is quoted
base-in-quote, and which token is "base" is the data source's choice — a WETH/USDC pool may be
indexed as USDC/WETH, where the price is 0.00037 rather than 2700. Entering it the wrong way round
gives a price ratio off by orders of magnitude, and the IL formula returns **-100%** for it, which
reads exactly like a real answer. Those positions are now flagged, excluded from the book's
totals, and offered the inverse. On the test book that was the difference between **-16.02% on
$50,000** and **+4.97% on $40,000**.

## Your position, strategies and alerts

Tell the app what you actually hold — size, entry price, entry date, and your range — and it
replays that position against the pool's real daily bars since the day you opened it. Positions
are saved per pool in `localStorage`, so they survive a reload and nothing leaves your machine.

**Strategies** are ranked by relevance on a single 0–100 scale, and each one carries its own
arithmetic — cost, gain and payback. A strategy whose economics can't be computed isn't offered,
because "consider rebalancing" without a number is a horoscope. The set covers holding,
re-centring a range, changing width to the one the backtest actually favours, hedging the
directional exposure, switching fee tier, and closing.

The hedge size is computed rather than hand-waved: for a full-range position `V = Q·√r`, so the
delta at entry is exactly half the position's value in base exposure. For a concentrated position
there's no clean closed form worth hard-coding, so the position value is differentiated
numerically.

**Alerts** are numbers, not moods. Each is a level you can paste into whatever alerting you
already use: where your range breaks, where fees stop covering divergence, the daily volume the
pool needs to stay above the benchmark, and how long until your entry cost is earned back. On
revisit the app re-fetches and marks which have already fired.

This page has no backend, so **it cannot push a notification** — that limit is stated in the UI
rather than papered over. What it does is compute the exact triggers and tell you which have hit.

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

## When does the incentive stop?

An incentive APR is quoted as an annual rate, and almost never lasts a year. Merkl runs a large
share of DeFi's campaigns and publishes the one fact that decides what the rate is worth: the end
date. Sampling 366 live campaigns while building this:

| | |
| --- | --- |
| Median days remaining | **21** |
| Ending within 30 days | 269 of 366 (73%) |
| Ending within 7 days | 89 (24%) |
| Running beyond 180 days | **2** |

So the panel leads with the end date and with what the campaign pays over its remaining life,
keeping the annualised figure as the secondary number. On a live Balancer pool: a **3.39% APR
with 7 days to run is worth 0.07% of capital**, not 3.39%. Both numbers are true; only one of
them is what you would receive.

Dilution is exact rather than hand-waved. For 92% of those campaigns the published APR
reconstructs to within 10% of `dailyRewards x 365 / TVL` (median ratio 1.000), which means the
reward pot is fixed and shared pro rata — so your own rate is `APR x T/(T+P)`, and the panel
shows it at your position size. For the other 8% the identity fails because the campaign has
eligibility conditions attached, and those are labelled `restricted` with no dilution figure
rather than modelled anyway. A campaign ending within 7 days reaches the main risk list, at the
same rounded day count the panel displays.

### A CORS lesson worth writing down

Merkl *looks* like it needs no proxy. Asked with curl it returns
`access-control-allow-origin: *`. Asked by a browser it does not — that one header disappears
when an `Origin` is present, while `allow-credentials`, `allow-methods` and `allow-headers` all
remain. (`allow-credentials: true` is invalid alongside `*`, which is the likely cause.) The
symptom is a bare "Failed to fetch".

**A CORS check is only valid with an `Origin` header**, because that is what the server keys its
answer on. Re-checked that way, DefiLlama really does send the header and really does need no
proxy; Merkl needs `api/merkl.js`, which also trims a ~10 KB opportunity down to about 560 bytes.

## Pendle markets get a different page

Paste a Pendle market and none of the above applies. A Pendle pool trades a principal token
against its yield-bearing wrapper, so "impermanent loss against holding" is the wrong question —
the PT converges to par at expiry by construction. The spot panels are therefore not rendered at
all, and the page says why instead of quietly showing numbers that don't mean anything.

What it computes instead, from Pendle's own market endpoint:

- **Implied yield** — the fixed rate the market is currently offering, `(1/P_pt)^(1/years) − 1`.
  Cross-checked against the figure Pendle publishes: across 45 live Ethereum markets the median
  disagreement was **0.01pp**.
- **Implied vs underlying** — the spread between the fixed rate you can lock and the floating
  rate the asset is actually earning. That spread, not IL, is the trade.
- **Time to expiry and PT discount**, since every number on the page decays toward zero.
- **Where the market sits on its curve.** Pendle's AMM prices off a proportion
  `p = nPt/(nPt + nSy)` with a scalar that sharpens as expiry approaches (`rateScalar(t) =
  scalarRoot/t`). The V2 paper treats `p ∈ [0.1, 0.9]` as the reasonable band; outside it, quotes
  move fast. 41 of those 45 markets were inside it.
- **What the LP APY is actually made of** — swap fees and accrued yield separately from PENDLE
  emissions, with the vePENDLE boost shown as a multiple rather than folded in. Five of the 45
  were more than half emissions.
- **The alternatives, side by side:** LP, hold PT to expiry for the fixed rate, or hold YT for the
  floating leg.

Two things worth knowing about how this is wired:

- **GeckoTerminal indexes no Pendle markets at all.** A Pendle URL has to be routed to Pendle's
  API *before* the DEX lookup, not after it — otherwise resolution fails first and the Pendle
  analysis is unreachable code, which is exactly what the first attempt turned out to be.
- It goes through **`api/pendle.js`**, a small CORS proxy, because Pendle's endpoint sends no
  `Access-Control-Allow-Origin` header. On a `file://` page or a static host without that
  function, a Pendle link says precisely that rather than "no pool found".

## What it deliberately does not do

- **No third-party campaign data beyond Merkl.** Emissions are covered three ways — DefiLlama's
  `apyBase`/`apyReward` split, Merkl campaigns directly, and Pendle markets' own breakdown — but
  an incentive run outside those is still invisible here.
- **No MEV, rebalancing cost, or smart-contract risk.** Gas enters only the minimum-viable-size
  calculation, as an editable per-chain round-trip estimate.
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
| Execution cost assumes both swaps route through this pool | Modelling aggregator routing needs quotes the free APIs don't give | Overstates cost for well-traded pairs, where an aggregator finds a better path; accurate for thin pools, which are the ones where it matters |
| Execution cost is priced off the pool's own mid, not an external USD price | The two data sources are sampled independently and disagreed by 0.25% on a live pool — comparable to the fee itself | Keeps a symmetric round trip symmetric instead of leaking source disagreement into "cost" |
| Stableswap and weighted pools use the constant-product IL formula | It's the only closed form that fits every pool type | Flagged in the risk list — treat the IL column as an upper bound. Pendle markets are exempt: they route to their own analysis and never reach this formula |

Fee tiers are read from the pool itself where the API exposes them (concentrated-liquidity pools),
parsed from the pool name, or fall back to a per-DEX default. The header badge always says which,
and `assumed` means you should check the pool page.

## Tests

```bash
npm test
```

No dependencies — a small harness loads the browser modules into a fake `window` and runs
assertions against them. 207 checks across three files: the maths (`math.test.mjs`), the
app layer (`app.test.mjs`), and the DefiLlama client against a captured snapshot
(`llama.test.mjs`).

The suite earns its keep. Writing it found five real bugs, one of them in a fix made minutes
earlier, and disproved a claim this README had been making — details in the commit history.

Refresh the DefiLlama fixture with `npm run test:fixture` (trims a 12 MB response to the
fields the client reads).

## Deploying

Static files plus two serverless functions in `api/`. The pages work on any static host; the two
functions need a host that runs them (Vercel, Netlify, Cloudflare Pages with Functions), and each
degrades with a specific message rather than breaking the page if it's absent:

| Function | Needed for | Without it |
| --- | --- | --- |
| `api/pendle.js` | Pendle markets — their API sends no CORS header | A Pendle link says the proxy isn't deployed; everything else is unaffected |
| `api/merkl.js` | Checking incentive campaigns — Merkl withholds its CORS header from browsers | The campaign panel says the function is missing; every other panel is unaffected |
| `api/ask.js` | The natural-language screening box | The box reports that the key isn't configured; the filter controls still work |

`api/ask.js` reads `ANTHROPIC_API_KEY` from the host's environment. It is deliberately server-side
only — the key must never reach the browser, which is the reason this function exists at all
instead of calling the API from the page.

`vercel.json` sets `must-revalidate` on everything: the JS filenames aren't content-hashed, so this
is what stops a browser serving a stale module after a deploy. It also sets a CSP allowing scripts
only from this origin and network calls only to `'self'` plus the three data APIs — GeckoTerminal,
DexScreener and DefiLlama. `'self'` is what permits the two functions above, so dropping it breaks
them in production only, which is a bad place to find out.

## Chain coverage

Four separate lists, because they answer different questions:

| | Count |
| --- | --- |
| URL aliases accepted (`ethereum`, `eth`, `mainnet`, `arb`…) | 70 |
| Distinct networks those resolve to | 43 |
| Numeric `chainId` values recognised (`?chainId=42161`) | 25 |
| DefiLlama chain mappings, for emissions and the screener | 47 |
| Chains with a gas estimate, for minimum viable size | 28 |
| **Distinct chains named anywhere in the codebase** | **44** |

Two ceilings sit above those. The **analyser** works on any pool GeckoTerminal indexes — 100+
networks — because an unrecognised chain just falls back to resolving by address instead of by
name. The **screener** shows whatever DefiLlama returns, currently **104 chains**, regardless of
whether we have a mapping for them; the mapping only matters for tying a screener row back to an
analysed pool.

Chains without a gas estimate fall back to a flat $5 round trip rather than zero, which is
deliberate — an unknown chain should read as "probably cheap, but check" and not as free.

### A silent failure worth knowing about

Chain mappings are a third party's display strings. They drift, and a wrong one fails *silently*:
the pool reports "not tracked", the emissions panel stays empty, and that is indistinguishable
from a chain that genuinely has no pools. Four were wrong, found by comparing every mapping
against the live chain list:

| We sent | DefiLlama actually uses | Pools affected |
| --- | --- | --- |
| `Optimism` | **`OP Mainnet`** | 435 |
| `zkSync Era` | **`ZKsync Era`** | 10 |
| `WorldChain` | **`World Chain`** | 1 |
| *(no mapping)* | **`Monad`** | 260 |

Emissions never resolved for a single Optimism pool. Mappings resolving against the data went
from 30/39 to 34/47, and 96% of the sampled set is now reachable. A test asserts that no mapping
differs from a real chain name by case or punctuation alone — which catches a typo while still
tolerating a chain that legitimately has no pools this month.

## Data sources

- [GeckoTerminal](https://api.geckoterminal.com/api/v2) — pool state, fee tier, daily OHLCV.
  Free tier is roughly 30 requests/minute; the app uses 2 per analysis and reports a clear message
  when it gets limited.
- [DexScreener](https://api.dexscreener.com) — independent cross-check of liquidity and volume.

Both send `Access-Control-Allow-Origin: *`, which is why this works from a `file://` page with no
proxy.

- [Pendle](https://api-v2.pendle.finance) — active markets per chain, for the Pendle analysis.
  This one sends no CORS header, so it is the only source needing the `api/pendle.js` proxy. The
  upstream caps `limit` at 100 and returns 400 above it, so the proxy pages instead of asking for
  200 in one request.
- [Merkl](https://api.merkl.xyz) — live incentive campaigns and, crucially, their end dates.
  Sends its CORS header to everything except a browser, so it goes through `api/merkl.js` too.
  Its `items` parameter caps at 100 as well, though the per-pool lookup filters server-side by
  address and needs only one request.

## Possible next steps

- Read the live v3 tick distribution on-chain so the concentration multiplier reflects real
  competing liquidity rather than assuming it's static.
- Multi-pool watchlist and a saveable comparison table.
