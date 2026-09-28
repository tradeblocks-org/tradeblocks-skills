---
name: oo-capture
description: Capture a saved Option Omega backtest or run's complete trade log into a verified TradeBlocks block. Use when a user asks to bring or import an OO backtest into TradeBlocks.
compatibility: Claude Code plugin hook, Option Omega MCP server and separately installed local TradeBlocks MCP server; Node.js required.
---

# Capture an OO trade log

This workflow saves the source's headline response and every trade-log page as raw JSON on the user's computer, then creates a trade-only CSV. It does not save an equity curve: TradeBlocks trade-realized analysis is not OO's marked-equity drawdown. Never echo or manually transcribe OO trade numbers into another tool argument. This plugin does not install either MCP server. In other clients use OO's CSV export and TradeBlocks `import_csv`.

## 1. Consent and start

Tell the user: "I will save the OO headline/settings, every raw trade-log page and its tool arguments, any capture failures, and a verified CSV under your local `${XDG_DATA_HOME:-~/.local/share}/tradeblocks/oo-captures/` directory. Files remain there until you delete this capture. An imported TradeBlocks block is separate and requires its own deletion. Open trades are reported from OO but are not invented as closes." Only then run:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/oo-capture.mjs" start "${CLAUDE_SESSION_ID}"
```

Keep the returned capture ID. A capture is armed only for this Claude session, and a matching `PostToolUse` hook records OO reads only until stop. If start fails, do not call OO under the claim that capture is active.

## 2. Read the source and page it

For a saved backtest call OO's `get_saved_backtest` with `savedBacktestId`; for a run call `get_backtest_results` with `runId`. These contain the headline trade count, net `profit` and `numberOfOpenTrades`. The saved backtest also has settings. Use exactly the same ID key and value in every subsequent `get_trade_log` call. Never use a portfolio ID. Call `get_trade_log` with `sortBy: "opened"`, `direction: "asc"`, `limit: 100`, `offset: 0` and the single source ID; do not set `outcome`, `reasonClosed`, or `strategyIds`. Repeat at the returned `nextOffset`, using the identical source/sort/limit, until `nextOffset` is `null`. Do not infer completion from a result preview or one page. Watch each hook's confirmation or named failure; a failure means stop and do not import.

## 3. Stop and verify BEFORE import

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/oo-capture.mjs" stop "${CLAUDE_SESSION_ID}"
node "${CLAUDE_SKILL_DIR}/../../scripts/oo-capture.mjs" verify <capture-id>
```

Stop even if OO errors or a call is interrupted; if verification refuses, report its named failure and do not import. `verify` requires precisely one identity-bound headline, unfiltered pages with contiguous offsets from zero, fixed sort, stable total, a terminal page, and OO-matching non-ignored count and net profit to the cent. It writes `tradelog.csv` only after those checks pass. Saved-file failures, malformed dates/amounts, duplicate or missing pages all refuse publication. The CSV represents OO `profit` as `net_includes_fees` (fees are recorded but never deducted again); premiums/leg prices are dollars per one contract and whole-dollar premiums have `.00` decimal precision.

## 4. Import and read the block

Only after `verify` succeeds, call the *separately installed local* TradeBlocks MCP `import_csv` with the **returned exact `csvPath`**, a fresh user-facing `blockName`, `csvType: "tradelog"`, `plBasis: "net_includes_fees"`. Do not retype any values in the CSV. An import receipt alone is not proof of the parsed block: use `get_block_info` for parsed count and `run_sql` against `trades.trade_data` for `COUNT(*)`, `SUM(pl)`, `pl_basis` and `premium` for the returned block ID; compare count/net profit and a whole-dollar per-contract premium with verification and OO. If a check disagrees, tell the user and do not claim reconciliation. Run an existing TradeBlocks analysis such as `get_statistics` on that block, but distinguish trade-realized measures from unavailable OO marked-equity metrics.

Report the verified economic trades imported, ignored rows, OO's open-at-end trades (not in the log), count/profit reconciliation, CSV/raw JSON directory and new block ID. Do not label any TradeBlocks recomputed drawdown, Sharpe or ratios as OO's own figures.

## See and remove saved captures

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/oo-capture.mjs" list
node "${CLAUDE_SKILL_DIR}/../../scripts/oo-capture.mjs" delete <capture-id>
```

Deletion refuses while the capture is armed; stop first. Removing a capture deletes its raw responses, manifest, failures, verification and generated CSV. It does **not** remove a separately imported TradeBlocks block; use TradeBlocks' normal delete-block action for that. Do not delete without the user's request.
