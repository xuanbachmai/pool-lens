# Backtest — does any LP rule actually beat holding?

Everything here measures one thing: **excess return versus holding the same tokens.** Not raw
return. An LP who earns 40% in fees while the pair diverges 50% has lost money against doing
nothing, and a backtest that reported the 40% would be lying by omission.

For a two-sided pool that is `(1 + fees) × (1 + IL) − 1`, with IL computed from real token prices
via `2√r/(1+r) − 1` — the same closed form the app uses, path-independent, so the endpoints are
enough. For a pool with no IL, holding earns nothing, so excess return is simply the yield.

```bash
node backtest/fetch.mjs     # assemble and cache the dataset (~3 min)
node backtest/run.mjs       # one configuration
node backtest/sweep.mjs     # 27 configurations — this is the one to trust
node backtest/coverage.mjs backtest/data/pools.json   # DEX profile coverage audit
```

## What the data forced

Three corrections, each made because the first run produced something that could not be true.

**1. DefiLlama's `il7d` is unusable.** It is populated on 16.3% of history points, and only 39%
even for volatile pairs. That is why IL is computed from token prices instead. Had it been taken
at face value, most pools would have been modelled with no IL at all.

**2. Concentrated pools are excluded by default.** DefiLlama's `apyBase` divides fees by the
liquidity actually deployed, so for a v3-style pool it is the return on *in-range, actively
managed* capital. Taken literally it says a $156M WETH/USDC v3 pool paid **105% in fees over a
year** with a 666% peak — while v2-style pools in the same window read 6–9%, which is believable.
A passive full-range LP earns nothing like the former. Mixing the two produces a number that
describes neither, so `--type` picks one. (The app's own answer to this is τ_v, volume-weighted
time in range; there is no historical τ to apply here.)

**3. Yields are diluted to a real position size.** A quoted APY belongs to the capital already
there; adding yours makes it `apy × T/(T+S)`, the same own-dilution formula the analyser uses.
Without it, strategies get credit for yields that exist only while nobody takes them. APY is also
winsorised at 300% — one pool showed **16,247% cumulative over 365 days**, which is the signature
of TVL collapsing toward zero while the fee numerator stands still, not of money earned. The cap
touches 0.15% of points and the run prints how many.

## Results

365 days, constant-product pools, swept across rebalance period (14/30/60d), basket size (5/10/20)
and cost (10/25/50 bps) — **27 configurations**. The column that matters is how often a rule beat
the benchmark, not what it returned once.

### Dual-sided, IL-bearing

| strategy | median | worst | best | beats benchmark |
| --- | ---: | ---: | ---: | --- |
| chase top APY | +10.47% | +5.53% | +26.63% | **27/27** |
| chase fee APR | +10.13% | +3.76% | +20.93% | **27/27** |
| avoid emissions | +10.13% | +1.67% | +20.93% | **27/27** |
| avoid draining TVL | +9.68% | +3.27% | +20.27% | **27/27** |
| stable yield (σ<1) | +7.70% | +2.66% | +20.32% | **27/27** |
| *hold everything* | *+3.83%* | *−1.50%* | *+5.26%* | *(benchmark)* |
| calm pairs | +3.31% | −2.31% | +10.44% | 14/27 |

### No-IL / single-sided

| strategy | median | worst | best | beats benchmark |
| --- | ---: | ---: | ---: | --- |
| stable yield (σ<1) | +5.49% | +3.29% | +6.64% | **27/27** |
| chase fee APR | +5.44% | +3.34% | +6.56% | **27/27** |
| avoid draining TVL | +5.36% | +2.94% | +6.46% | **27/27** |
| avoid emissions | +5.27% | +3.34% | +6.54% | **27/27** |
| chase top APY | +5.20% | +3.44% | +6.51% | **27/27** |
| *hold everything* | *+1.83%* | *+1.19%* | *+2.35%* | *(benchmark)* |

## What this says

**Selection beat breadth, consistently.** Five of seven rules beat equal-weighting in all 27
configurations, on both sleeves. Concentration helped monotonically — top-5 beat top-10 beat
top-20 in every single run. The decision that mattered was *which pools*, not *which sleeve*.

**The one rule that failed is the instructive one.** "Calm pairs" — filter to pairs that have not
been diverging, to dodge IL — beat the benchmark only 14/27 times, the worst of the lot. Avoiding
the volatility that causes impermanent loss also avoids the volume that pays fees. You cannot
filter IL out and keep the income; they are the same phenomenon seen from two sides.

**Emissions were not the edge.** "Chase top APY" (+10.47%) and "chase fee APR" (+10.13%) are
statistically indistinguishable here, but only the first leans on emissions — and emissions end.
The median Merkl campaign has 21 days left. Fee APR reaches the same place without that
dependence, which is why the app's preset encodes fee APR rather than headline APY.

**The no-IL sleeve never lost.** Lower ceiling (+5.4% median against +10.1%), but its worst result
across all 27 configurations was still **+2.94%**. The dual-sided sleeve's benchmark went negative
at its worst (−1.50%). If the goal is "real profit" rather than "most profit", that asymmetry is
the finding.

Both rules are wired into the farm screener as **Backtested — dual-sided** and
**Backtested — never lost**.

## What this is not

These are the limits, stated plainly, because a backtest with the caveats buried is a sales
document.

- **Survivorship bias, unquantified and upward.** The universe is pools that exist *today* with
  365 days of history. Every pool that died, got rugged, or fell below the TVL floor is absent.
  This flatters every number here, the volatile sleeve most of all. It is the single largest
  reason not to read these as expected returns.
- **One year, one regime.** Over this window the median pair's price ratio fell ~41%. A different
  regime could reverse the ordering, and nothing here demonstrates otherwise.
- **A small universe.** 36 volatile and 78 no-IL constant-product pools clear the filters. That is
  enough to compare rules against each other; it is not enough to characterise the whole market.
- **Costs are a flat 25 bps on turnover**, not real gas on a real chain at a real moment. The app's
  minimum-viable-size panel models that properly for a specific position; this does not.
- **No slippage, MEV, rebalancing, or smart-contract risk**, and no range management — these are
  full-range positions throughout.
- **Past behaviour of a yield is not a forecast of it.** Every figure is an extrapolation of a
  window that will not repeat.

The honest summary: **selection beat passive exposure robustly, and the no-IL sleeve was the only
one that never lost in any configuration.** That is a finding about the past, strong enough to
shape a default and nowhere near strong enough to be a promise.
