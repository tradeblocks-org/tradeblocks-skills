# Changelog

## 4.0.2

### Fixed

- **`oo-capture` retains OO's optional trade-log values.** Both `verify` and `combine` now write Opening VIX, Closing VIX, Gap, Movement, Max Profit and Max Loss. Values keep OO export units: VIX levels, underlying-price points for Gap/Movement, and percentage points for Max Profit/Loss (not dollars or fractional returns). Zero and negative values are preserved without rounding. Missing fields and null cells are empty, which TradeBlocks loads as absent; invalid non-numeric values refuse publication with `INVALID_TRADE`.
- Headers and units are checked against a public real OO CSV export, with a round-trip through TradeBlocks 4.6.1's actual block-loader. The pinned server package is a development-only test dependency; the plugin still requires a separately installed server and never calls OO from TradeBlocks.

### Updating and repairing existing blocks

Update with `/plugin marketplace update tradeblocks-skills`, then `/plugin update tradeblocks@tradeblocks-skills`. Restart Claude Code to load the new plugin.

For a retained capture, rerun `verify` with the same `--strategy` if one was chosen, then import the rebuilt CSV as a new block. Rerun `combine` for a comparison. Updating alone does not repair previously imported blocks. If the raw capture is gone, capture again or import OO's own CSV export.

## 4.0.1

Released with [TradeBlocks 4.6.1](https://github.com/tradeblocks-org/tradeblocks/blob/master/releases/v4.6.1.md). Thanks to Amy in the Discord for the report and the TSLA repro.

### Fixed

- **`oo-capture` keeps each trade's underlying.** In 4.0.0, `oo-capture` read OO's per-trade `underlying` but never wrote it to `tradelog.csv`. TradeBlocks reads a trade's ticker from an `Underlying` column. Without one, it assumed SPX and said nothing, so a captured TSLA or GLD backtest or portfolio was imported as SPX. P/L, trade counts and strategies were right, but everything joined to market data was matched against SPX: VIX, regime, enrichment, and the market fields used in filter analysis.

  `tradelog.csv` (from `verify` and `combine`) now ends with an `Underlying` column holding OO's per-trade `underlying`. A trade whose OO `underlying` is missing or blank is refused with `INVALID_TRADE`.

### Who is affected

Anyone who imported a 4.0.0 capture of a non-SPX backtest or portfolio. SPX captures were matched to the correct market data and need no repair.

### Repairing an existing capture

Updating the plugin or TradeBlocks does not fix a block that was already imported. Repair each affected capture:

1. Update this plugin to 4.0.1, and TradeBlocks to 4.6.1 or later.
2. Run `verify` again on the saved capture, with the same `--strategy` if you chose one. A 4.0.0 capture keeps OO's raw responses, so this rebuilds `tradelog.csv` with the `Underlying` column.
3. Import the new `tradelog.csv` as a new block, then delete the old one.

If the capture was deleted, capture the backtest or portfolio again.

### TradeBlocks server compatibility

TradeBlocks 4.0.0 and later already read the `Underlying` column. Use 4.6.1 or later: when a trade has no ticker, its market-joined tools warn that they assumed SPX, which flags any old block you have not repaired yet.

## 4.0.0

Released with [TradeBlocks 4.0.0](https://github.com/tradeblocks-org/tradeblocks/blob/master/releases/v4.0.0.md) and Option Omega's MCP server. The plugin version now follows TradeBlocks' major version. Existing installs pinned to 1.0.0 update to this release.

### Option Omega

TradeBlocks never calls Option Omega. Install both MCP servers, TradeBlocks and OO's, in Claude Code, then install this plugin.

- **`oo-capture` (new).** `/tradeblocks:oo-capture` saves OO's responses for a saved OO backtest, saved portfolio or run to disk exactly as OO returned them, verifies them, writes `tradelog.csv` and `dailylog.csv` from them, and imports both into one TradeBlocks block. Verification requires complete paging in one fixed sort and OO's headline trade count and net profit to the cent. For a portfolio, every member's count and net profit must match OO's `strategyResults`. The block holds the trade log and OO's marked daily equity curve (the whole book for a portfolio). A run whose OO headline reports no date range has no curve: it is imported with its verified trades only, and the capture says the marked curve is missing. Trades are named so a captured block matches the live reporting log, and portfolio trades are labelled by member. OO's own `profitPercentage` becomes the trade's `P/L %`, and the `Legs` cell is OO's own leg text. Captures are kept under `${XDG_DATA_HOME:-~/.local/share}/tradeblocks/oo-captures/` until you remove them with the skill's `list`/`delete` commands. `stop` survives an interrupted call.
- **`is-this-optimum-real` (new).** Tests an OO optimizer winner against a stable-region centre. It captures each scratch run separately and combines the verified trades under distinct strategies in one trade-only block for a paired best-minus-centre test.
- **Supported.** Claude Code only, with TradeBlocks running locally over stdio. Capture runs through the plugin's `PostToolUse` hook and `scripts/oo-capture.mjs`, so a manually copied skill folder cannot capture. Capture is not supported with TradeBlocks' Docker image or HTTP mode, or in other clients.
- **Fallback.** Everywhere else, export the trade log and optionally the daily log as CSV from OO and import both with one TradeBlocks `import_csv` call using `dailyLogPath`.
- **Verified against OO staging.** The capture reads OO's 2026-09-29 trade-log table (`tradeColumns` plus `trades` rows) by column name, and refuses an unrecognised or missing column by name. It was verified against OO's staging MCP server with a saved backtest of 191 trades, a saved portfolio of 237 trades with three members, and a scratch run of 24 trades. It has not been re-verified against OO's production MCP server.

### TradeBlocks server compatibility

Use TradeBlocks 4.0.0 or later. With an older server:

- `import_csv` has no `dailyLogPath`, so a capture imports trades only and says OO's marked curve is missing. The skills check the running server's schema before using that option.
- OO's `P/L %` is ignored and recomputed.

### Other changes

- The `market-data` skill and the README name only registered TradeBlocks tools.
- Every reference points at `tradeblocks-org/tradeblocks-skills`, and the README says the TradeBlocks MCP server is installed separately.
- CI validates the plugin and marketplace manifests, every listed skill, relative Markdown links and the tests on every pull request and push to `main`.
