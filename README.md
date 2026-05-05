# agent-wolf

An LLM-driven autonomous trading agent for decentralized exchanges — primary venue Hyperliquid, secondary Jupiter (Solana spot, including memecoin routes).

> **Status:** pre-implementation. The current contents of this repo are a research distillation. Code begins after the open questions in [`docs/overview.md`](docs/overview.md#8-open-questions-for-the-user) are resolved.

## What it is

A continuous loop that:

1. **Researches** — pulls signals from Hyperliquid funding/OI, on-chain smart-money flows, X sentiment (via Grok), Polymarket macro, news, and DEX-pair data.
2. **Hypothesizes** — generates falsifiable trade hypotheses with explicit invalidation criteria, capital budget, time window, and abort thresholds.
3. **Debates** — a Critic/Risk subagent attacks each hypothesis before commit.
4. **Executes** — through a deterministic Python risk engine that can veto LLM proposals (the LLM never has the final say on size or risk).
5. **Reflects** — every closed hypothesis becomes an episode in a vector store the next loop iteration can learn from.

The agent is bounded: each hypothesis runs fully autonomously inside a phase the user has explicitly enrolled (capital cap, time window, drawdown abort, kill-switch file flag). It runs in **shadow mode** (live data, simulated fills) before any capital is exposed.

## Design at a glance

```
Orchestrator (Claude Code)
  │
  ├── Researcher subagent     ← fresh context, parallel scans
  ├── Analyst subagent        ← interprets price/funding/flows
  ├── Critic/Risk subagent    ← debates hypotheses pre-commit
  ├── Executor (Python)       ← RiskEngine + Hyperliquid/Jupiter brokers
  └── Reflector subagent      ← post-mortem to memory

External state:
  working_state.json   episodes/*.jsonl   beliefs.vector_db
```

LLMs synthesize and propose. Code validates, sizes, and executes. Pattern from [TradingAgents](https://github.com/TauricResearch/TradingAgents), [FinMem](https://github.com/pipiku915/FinMem-LLM-StockTrading), [FinCon](https://arxiv.org/abs/2407.06567), and Anthropic's [orchestrator/worker](https://www.anthropic.com/engineering/multi-agent-research-system) writeup.

## What's in this repo

```
docs/
  overview.md              ← synthesis + recommendations + open questions (read first)
  research/
    01-dex-landscape.md
    02-prior-art.md
    03-agentic-architectures.md
    04-signal-sources.md
    05-ta-and-quant.md
    06-risk-and-paper-trading.md
    07-claude-code-infra.md
```

[`docs/overview.md`](docs/overview.md) is the single document that synthesizes everything below. The seven research briefs are each self-contained and citation-heavy.

## Open question that gates implementation

Running the Claude Code CLI on an Anthropic Max subscription as the LLM brain of a 24/7 autonomous trading agent is in tension with Anthropic's published guidance on automated agents. This needs clarification with Anthropic *before* live trading. Details and alternatives in [`docs/research/07-claude-code-infra.md`](docs/research/07-claude-code-infra.md) and [`docs/overview.md` §6](docs/overview.md#6-infrastructure--the-open-question).
