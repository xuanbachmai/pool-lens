# Scheduled alerts

The web app computes alert levels but cannot send anything — it is a static page with no
backend, so nothing runs once you close the tab. This directory is what runs instead.

`check.mjs` re-fetches live pool state on a schedule, evaluates the same thresholds, and posts
what has fired. Dependency-free: Node 18+ has `fetch` built in.

## Setup

1. **List your positions** in `positions.json`:

```json
[
  {
    "label": "WETH/USDC 0.05% — Uniswap v3",
    "network": "eth",
    "address": "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
    "entryPrice": 2400,
    "rangePct": 15,
    "sizeUsd": 10000,
    "tvlAtEntry": 99000000
  }
]
```

`network` and `address` are the two values in the pool's GeckoTerminal URL. `entryPrice` is the
base token in quote terms — the same number the analyser shows as your entry price. Set
`rangePct` to `0` for a full-range position.

2. **Pick a channel.** Add these as repository secrets under Settings → Secrets and variables →
   Actions. Set either the Telegram pair or the webhook, not both:

| Secret | For |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Telegram |
| `ALERT_WEBHOOK_URL` | Discord or Slack incoming webhook |

With no channel configured the job prints to the Actions log instead of failing, which is a
fine way to try it first.

3. **Install the workflow.** It ships here as `alerts/workflow.yml` rather than in
   `.github/workflows/` because pushing to that directory needs a GitHub token with the
   `workflow` scope, which the CLI does not have by default. Either:

   - **In the browser** (no scope needed): open the repo on GitHub → Add file → Create new file →
     name it `.github/workflows/alerts.yml` → paste the contents of `alerts/workflow.yml` → commit.
   - **From the CLI**, grant the scope once and move it:

     ```bash
     gh auth refresh -h github.com -s workflow
     mkdir -p .github/workflows
     git mv alerts/workflow.yml .github/workflows/alerts.yml
     git commit -m "Install alert workflow" && git push
     ```

   It runs every 30 minutes once installed. Adjust the cron inside the file, or trigger it by
   hand from the Actions tab.

## Try it locally

```bash
node alerts/check.mjs --dry-run
```

`--dry-run` evaluates and prints without sending anything or writing state.

## Why state.json exists

Alerts fire on the **edge**, not on every run. `state.json` records which conditions were
already active last time, so a broken range notifies once rather than every thirty minutes for
a week. A job that repeats itself is one you mute, and a muted alert is the same as no alert.

A failed fetch carries the previous state forward rather than clearing it, so a transient
network problem does not re-fire everything on the next successful run.

## What it checks

- **Range broken**, above or below, and a warning when the price enters the last 10% of either
  side while still inside.
- **Volume below the 0.25 V/R benchmark** — the pool has gone quiet.
- **Pool grown past 1.75× its size at entry** — your share of the fees has been diluted.

Those work from pool state alone. Two more are dated events, which pool state cannot show you:

- **An incentive campaign ending.** Checked against Merkl. The message carries what the campaign
  is worth over the life it has left rather than its annualised rate — “3.39% APR, 7 days to
  run, about 0.07% of capital”.
- **A Pendle market approaching expiry.** GeckoTerminal indexes no Pendle markets, so a Pendle
  position fails the pool lookup entirely; that failure is the cue to check Pendle instead. Without
  this a Pendle position produced a weekly “pool not found” and nothing else.

Both count down through 30, 14, 7, 3 and 1 day. The threshold is part of the state key, so each
one fires once as it is crossed instead of either going silent after the first or repeating every
run. The bucket is taken from the *rounded* day count that the message displays: bucketing the raw
value sent two alerts a day apart both reading “expires in 14 days”.

The alert runner calls Merkl and Pendle directly rather than through `api/merkl.js` and
`api/pendle.js`. Those proxies exist only to add a CORS header for the browser, and this is Node.

Anything needing price history stays in the browser, where the full analysis runs.
