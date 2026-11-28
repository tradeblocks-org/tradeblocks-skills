# Runs: Option Omega, capture, one block

You run the backtests yourself through the official Option Omega MCP connector, after the user's ok, capture each with `oo-capture` and import them into one TradeBlocks block. The user never fills in JSON.

The author settings are input (step 1 of SKILL.md); `author.settings.json` is that input with at most the intra-minute change the run request lists and, for a description that states no amount, starting funds $500,000 (marked assumed in strategy-as-built.md).

## 1. Run, save and capture each settings file

For each `<role>.settings.json`, the author included, one at a time; its label is `--author-label` for the author, `runs[].label` in `run-request.json` for the others:
1. `run_backtest` with the file's content unchanged as `parameters`. If Option Omega refuses the file, stop and report the file and the message; never patch it.
2. Poll `get_backtest_status` until the run is complete.
3. `save_backtest` as a **new** backtest named exactly as the label.
4. Capture the run with `oo-capture` (its steps 1–3, source = the run id, at once: a run id expires about an hour after the run), with `verify <capture-id> --strategy "<label>"`. Load it as a skill (`/tradeblocks:oo-capture` or the Skill tool), never by reading its SKILL.md: Claude Code fills in `${CLAUDE_SESSION_ID}` in its commands only for a loaded skill. If `start` still reports `SESSION_ID`, stop and tell the user; never guess the id. Keep the capture id and the returned `csvPath`. Do not import it on its own. A named failure stops the triage for that run; tell the user.

## 2. One block, check, plugin-result.json

1. **One file.** Join the N `tradelog.csv` files (each `csvPath`) under one header line into `<run folder>/runs.csv`; the headers are equal and each file's `Strategy` column is already its label.
2. **One block.** Call `import_csv` once with that file's path as the TradeBlocks server sees it, a new block name for this triage, `csvType: "tradelog"`, `plBasis: "net_includes_fees"`, and no `dailyLogPath` (the file holds alternative runs, not one account). The server reads the file itself, so it must be in a folder the server can read: a server in a container sees only its mounted folders, under the path inside the container. On "File not found", look up the server's mounts, copy `runs.csv` unchanged into a mounted folder and pass its path inside the container; never paste the file's content. The same holds for any `csvPath` from `oo-capture`: it is a path on your computer.
3. **Check.** Run the `runSizes` query (SKILL.md step 4) once; its `trades` per strategy is the check, and step 4 reuses its result.
   - A label that is not in `run-request.json` stops here; tell the user.
   - A run-request label without trades is named to the user; that run did not arrive.
4. **plugin-result.json.** Write `<run folder>/plugin-result.json` ([../templates/plugin-result.json](../templates/plugin-result.json)):
   - `block_id`: from the import;
   - one entry per run that arrived, with its `label` from `run-request.json`;
   - `capture_id`: the run's `oo-capture` capture id (its identity in the verdict log; an Option Omega run id expires).

Then continue with step 4. A run that did not arrive is left out of `plugin-result.json`; its check is not run.
