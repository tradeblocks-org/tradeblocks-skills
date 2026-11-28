# Is this backtest Lambo or Lada? — how a session goes

A triage of an SPX options strategy (**continue**, **reject** or **unclear**) on your own costs.

**Needs:** the official Option Omega MCP connector, the TradeBlocks MCP (local), oo-capture, and a shell for the skill's Node scripts.

A session takes two turns, plus one when the description leaves a core value open:

1. **You:** "Read description.md for the strategy I'd like to test with lambo." For example, a strategy from my uncle Tom: 0DTE SPX, six entries a day, put and call spreads for $1.00–1.75 credit, 50–60 wide, stop at 1x loss per side, held to stop or expiry, January 2023 to September 2025. Text from a link or a saved Option Omega backtest works too.

2. **The skill** first stops on this description: it gives only ranges for the credit and the width and a count without times, so the skill asks for one credit (or delta), one width and the entry times and runs nothing. You answer, e.g. "credit 1.50, width 55, entries 11:00 to 14:45 every 45 minutes", and the skill continues with your numbers: it builds the rule sheet, the settings and the run request, shows the strategy as built in Option Omega's settings-summary layout (so you can compare it with the saved backtest there), names the N backtests (from your Option Omega daily limit; at most 5 extra, two of them the stop neighbours when the strategy has a stop) and asks for your ok to both. Then it runs, saves and captures each one with `oo-capture`, imports them into one TradeBlocks block, runs the checks, and gives the verdict with a short summary. You never fill in JSON by hand.

**On the first run**, the setup asks for your cost source, or offers a labelled example to confirm.

Details:
- [SKILL.md](SKILL.md): workflow and checks.
- [references/runs.md](references/runs.md): runs, capture, one block.
- [references/from-description.md](references/from-description.md): from a description to the settings.

## Acknowledgements

Thanks to Wizzy (autcumscutoautinscuto on Discord), whose #LamboOrLada triage is a cousin of this skill, for the feedback that shaped it: the naive baseline as the gate (C4), a translation-confidence cap on the verdict (C1), thresholds fixed in a file before Version 1, crude slippage and stop sensitivity inside the triage (C7, C9), the death modes start date (C8), return basis, the pre-2022 expiry calendar (C3) and liquidity at size (listed as not tested), a verdict log for later recalibration, and starting small.
