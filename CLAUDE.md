# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Claude Code plugin providing guided analysis skills for Option Omega backtests and options trading portfolios. Requires the [TradeBlocks](https://github.com/davidromeo/tradeblocks) MCP server to be running separately. Distributed via the Agent Skills marketplace.

## Architecture

```
.claude-plugin/       Plugin metadata (plugin.json, marketplace.json)
skills/               8 skill directories, each with SKILL.md + references/
```

**Skills are workflow choreographers, not implementations.** Each SKILL.md describes a multi-step analysis workflow that invokes MCP tools in sequence. The actual logic lives in the TradeBlocks MCP server (50+ tools for trade queries, simulations, and analysis), which users install separately.

**Reference files are interpretation guides.** Each `references/*.md` explains how to read analysis results — thresholds, tables, domain-specific nuance. Skills link to them contextually, not as prerequisites.

## Setup

No build step — skills are static markdown. The TradeBlocks MCP server must be installed and running separately.

## CI

`.github/workflows/ci.yml` runs the `validate` job on every pull request to `main` and every push to `main`; branch protection requires it, up to date with `main`. It validates the plugin and marketplace manifests (`claude plugin validate --strict .`), validates every skill `marketplace.json` lists against the Agent Skills specification (`agentskills validate` from `skills-ref`), fails on relative Markdown links to missing files (`.github/scripts/check-links.mjs`), and runs `npm test` when `package.json` declares it.

## Skill Structure

Every skill follows this pattern in its SKILL.md:

```yaml
---
name: skill-id
description: one-liner + trigger conditions
compatibility: MCP server requirements
metadata: author, version
---
```

Followed by: Prerequisites → Process (numbered steps with specific MCP tool calls) → Interpretation Reference → Related Skills.

## Plugin Distribution

- `.claude-plugin/plugin.json` — name, version, author for the plugin itself
- `.claude-plugin/marketplace.json` — lists all skills, sets `strict: true`, defines marketplace entry
- Install path: `/plugin marketplace add davidromeo/tradeblocks-skills` then `/plugin install tradeblocks@tradeblocks-skills`

## Domain Concepts

- **Blocks** — named strategy containers in the DuckDB database. Most tools require a `blockId` from `list_blocks`.
- **Strategy profiles** — persistent metadata about a strategy's structure, entry filters, and expected regimes. Created by `profile_strategy`, consumed by analysis skills.
- **Curve-fit detection** — a first-class concern, especially in DC analysis. Multiple steps dedicated to identifying overfitting via walk-forward efficiency, parameter sensitivity, and out-of-sample degradation.
- **Tail correlation** — portfolio/risk skills distinguish normal vs tail correlation (Kendall's tau, joint tail dependence) because trading returns violate Gaussian assumptions.
