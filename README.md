# agent-wolf

A **hypothesis machine** for markets — turn an idea like *"gold will rise because China is converting reserves to gold"* into a tracked, evidenced thesis whose confirmation strength updates as social and market data arrive.

> **Status:** 2026-05-06 — design phase. Multi-user paper-only MVP. **No actual trades.**

## Two folders

- **[`hypothesis-bot/`](hypothesis-bot/)** — the active focus. Multi-asset (stocks, commodities, crypto, memecoins) paper-only hypothesis-tracking advisor.
- **[`active-trading-bot/`](active-trading-bot/)** — archived prior research from the original crypto-DEX active-trading direction. Useful background on agentic loops, risk engines, and DEX venues, but the project pivoted away from execution-in-the-loop.

## What the hypothesis machine does

1. **Captures** a user thesis (free-form: *"gold up because China FX rebalancing"*).
2. **Specs** it via a guided LLM interview backed by deep web research, producing a structured falsifiable hypothesis with explicit signals + invalidation criteria.
3. **Gathers** social and market data on a configurable schedule — the first capture is unbounded; subsequent captures are time-gated to the most recent window.
4. **Tracks** confirmation strength over time — does the evidence accumulate or erode?
5. **Reports** to the hypothesis owner and any collaborators.

Trade execution is explicitly out of scope for v1. The first job is to find out whether the *hypothesis quality* is reliable; trades come later, if at all.

## Architecture (intended)

```
Firebase (Auth + Firestore)
    │
    ├── Google OAuth login
    └── User accounts + hypothesis records

Go API controller
    │
    ├── Schedules per-hypothesis ticks
    ├── Calls Claude Code container for LLM work
    └── Reads/writes Firestore + vector store + time-series store

Claude Code CLI container (Opus 4.7, Max subscription)
    └── Spec generation, deep web research, scoring, summaries

External data stores (TBD — see open questions)
    ├── Vector store for embedded research notes / social posts
    └── Time-series store for market data captures
```

Containers are stateless; durable state lives in Firebase + the external stores.

## Read next

- [`hypothesis-bot/README.md`](hypothesis-bot/README.md) — current design notes and open questions.
- [`active-trading-bot/docs/overview.md`](active-trading-bot/docs/overview.md) — archived prior research (still useful as background on agentic loops and venue mechanics).
