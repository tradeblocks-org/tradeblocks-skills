# TradeBlocks Skills

Agent skills for analyzing Option Omega backtests and options trading portfolios. Works with [Claude Code](https://claude.ai/code), [Claude.ai](https://claude.ai), and other [Agent Skills](https://agentskills.io)-compatible tools.

Requires the [TradeBlocks](https://github.com/tradeblocks-org/tradeblocks) MCP server, installed and running separately; this plugin does not bundle it.

## What's included

Guided workflows that chain TradeBlocks MCP tools together for common analysis tasks:

| Skill | What it does |
|-------|-------------|
| `profile` | Strategy profile — create or update a block's profile from an OO screenshot, a description, or its trade data; the analysis skills read it |
| `dc-analysis` | Double calendar health check — exit attribution, S/L ratio analysis, VIX regime fit, edge decay, curve fit detection |
| `health-check` | Strategy health check — core metrics, Monte Carlo stress testing, position sizing |
| `wfa` | Walk-forward analysis — test parameter robustness across rolling time windows |
| `optimize` | Parameter exploration — sweep entry time, DTE, delta, VIX, and other fields to find patterns |
| `portfolio` | Portfolio analysis — correlation, diversification, marginal contribution |
| `risk` | Risk assessment — tail dependence, drawdown attribution, stress scenarios |
| `compare` | Strategy comparison — side-by-side metrics across blocks |
| `market-data` | Market data setup — fetch daily and intraday bars, VIX context, and option quotes, or import minute bars from CSV or DuckDB |
| `oo-capture` | Capture a saved OO backtest, saved portfolio or run as one verified TradeBlocks block with its marked daily curve (whole-book for a portfolio) |
| `is-this-optimum-real` | Test an OO optimizer winner against a stable-region centre using separately verified scratch runs and a paired TradeBlocks comparison |

## Install

### Claude Code (plugin)

First, add the marketplace:

```
/plugin marketplace add tradeblocks-org/tradeblocks-skills
```

Then install the plugin:

```
/plugin install tradeblocks@tradeblocks-skills
```

### Manual skill installation

Copy an analysis skill folder into your `.claude/skills/` directory:

```bash
cp -r skills/dc-analysis ~/.claude/skills/
```

`oo-capture` and `is-this-optimum-real` need the plugin install. They run the plugin's `scripts/oo-capture.mjs`, and capture records through the plugin's `PostToolUse` hook in `hooks/hooks.json`; a copied skill folder carries neither.

## Prerequisites

- **TradeBlocks MCP server**: Must be installed and running — see [TradeBlocks](https://github.com/tradeblocks-org/tradeblocks)
- **Trade data**: Export your Option Omega backtest's trade log as CSV, and optionally its daily log. Import both into one block with a single `import_csv` call:

  ```
  import_csv({ csvPath: "~/Downloads/tradelog.csv", blockName: "My Strategy", dailyLogPath: "~/Downloads/dailylog.csv" })
  ```

  Omit `dailyLogPath` for a trade log alone. Do not import the daily log in a second call: `import_csv` always creates a new block, so a second call with the same `blockName` is refused because that block already exists.
- **Market data**: Import SPX/QQQ daily OHLCV and VIX context for regime analysis
- **API key** (optional): Set `MASSIVE_API_KEY` for automatic intraday data fetching during trade replay


### Capture OO data in Claude Code

Capture needs the plugin install (see [Manual skill installation](#manual-skill-installation)) and is verified on Claude Code 2.1.283. Use TradeBlocks 4.0.0 or later; capture is not supported with TradeBlocks' Docker image or HTTP mode. See the [changelog](CHANGELOG.md) for what 4.0.0 adds.

With this plugin, Node.js, a separately installed local TradeBlocks MCP server and OO's MCP server, run `/tradeblocks:oo-capture` to opt in to saving a complete OO backtest, saved portfolio or run's trade log and marked daily equity curve. Portfolio trades are labelled by member from the saved portfolio snapshot; case-insensitive name collisions receive stable member-ID suffixes, and every member's count and profit reconcile to OO's `strategyResults`. The daily log is the portfolio's **whole-book** marked curve, not a per-member curve. A PostToolUse hook runs only during an explicitly started capture. Raw OO JSON, recorded tool arguments, named failures and verified `tradelog.csv` and `dailylog.csv` live under `${XDG_DATA_HOME:-~/.local/share}/tradeblocks/oo-captures/<capture-id>/` until you use the skill's `list`/`delete` commands. Deleting a capture does not delete an imported TradeBlocks block. When the running TradeBlocks server supports `import_csv.dailyLogPath`, the skill imports both CSVs into **one** block and distinguishes analysis over OO's marked daily curve from trade-realized strategy-filtered analysis. An older server without that input (or a run whose OO headline reports no range) imports trade-only and names why its marked curve is missing. The capture reads OO's trade-log table (`tradeColumns` plus `trades` rows) by column name and keeps OO's own leg text, with per-share quotes, in the `Legs` cell; a column it does not recognise, or a missing required column, refuses with a named reason. Other clients can export OO's CSV and use `import_csv` directly.
## Usage

Once installed, skills are available via `/tradeblocks:<skill>` or Claude will invoke them automatically when relevant.

```
/tradeblocks:dc-analysis
```

The DC analysis skill will ask which block to analyze, load the strategy profile, and run through exit attribution, regime performance, predictive fields, edge decay, and curve fit detection.

## Data flow

```
Option Omega CSV --> import_csv --> DuckDB --> Tools --> Skills --> Analysis
                                      ^
                                      |
                              Market data (daily/intraday)
                              via fetch_bars / fetch_quotes / import_market_csv
```

## Links

- [TradeBlocks](https://github.com/tradeblocks-org/tradeblocks) — Main application
- [Option Omega](https://optionomega.com) — Options backtesting platform
- [Agent Skills spec](https://agentskills.io) — Open standard for agent skills
