# Changelog

## 4.0.0

Released with [TradeBlocks 4.0.0](https://github.com/tradeblocks-org/tradeblocks/blob/master/releases/v4.0.0.md) and Option Omega's MCP server. The plugin version now follows TradeBlocks' major version. Existing installs pinned to 1.0.0 update to this release.

### Option Omega

TradeBlocks never calls Option Omega. Install both MCP servers, TradeBlocks and OO's, in Claude Code, then install this plugin.

- **`oo-capture` (new).** `/tradeblocks:oo-capture` saves a saved OO backtest, saved portfolio or run to disk exactly as OO returned it, verifies it, and imports it into one TradeBlocks block. Verification requires complete paging in one fixed sort and OO's headline trade count and net profit to the cent. For a portfolio, every member's count and net profit must match OO's `strategyResults`. The block holds the trade log and OO's marked daily equity curve (the whole book for a portfolio). Trades are named so a captured block matches the live reporting log, and portfolio trades are labelled by member. OO's own `profitPercentage` becomes the trade's `P/L %`, and the `Legs` cell is OO's own leg text. Captures are kept under `${XDG_DATA_HOME:-~/.local/share}/tradeblocks/oo-captures/` until you remove them with the skill's `list`/`delete` commands. `stop` survives an interrupted call.
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
