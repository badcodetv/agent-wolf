# Agentic Loop Architectures for Autonomous Trading

A self-contained design brief for **agent-wolf**, an LLM-driven autonomous trading agent (Hyperliquid + Solana DEXs) running on Claude Code Max, with multi-day hypothesis horizons and shadow/paper-mode safety.

---

## 1. Core LLM-Agent Patterns: Tradeoffs for Trading

| Pattern | How it works | Trading fit |
|---|---|---|
| **ReAct** (reason + act) | Interleaves Thought -> Action -> Observation in a tight loop | Fast time-to-first-action, low planning overhead. Shines for *intra-loop* market reactions (e.g., a single decision: "given this candle + funding rate, hold or close?"). Fails for multi-day strategy work — drifts, loses thread, no global plan. |
| **Plan-Execute-Reflect / Reflexion** | Planner LLM emits multi-step plan; executor runs steps; reflector critiques and rewrites plan from outcomes | Reported ~92% vs ~85% task accuracy over ReAct in structured workflows. Audit-friendly (you can log the plan). Right fit for hypothesis-with-budget — the plan IS the hypothesis. **Reflexion** ([Shinn et al. 2023](https://arxiv.org/abs/2303.11366)) adds verbal self-critique stored in episodic memory; ~22% gains on decision tasks. |
| **Tree-of-Thoughts / MCTS / LATS** | Branch over candidate "thoughts," score nodes, expand promising ones (UCB / value model) | Useful for *strategy generation* (enumerate hypotheses) and *trade structuring* (entry size / stop / target combinations). Computationally heavy — only worth it at decision points, not in the inner loop. See [LATS for financial decisions](https://towardsdatascience.com/tackle-complex-llm-decision-making-with-language-agent-tree-search-lats-gpt4-o-0bc648c46ea4/). |
| **Multi-agent debate** | Bull / bear / risk agents argue; a synthesizer adjudicates | Empirically the strongest published trading pattern (TradingAgents, FinCon). Forces consideration of disconfirming evidence — directly attacks LLM over-confidence. Cost: token-heavy, slow. |
| **Orchestrator/Worker** ([Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)) | Lead agent decomposes, spawns parallel subagents with isolated contexts, synthesizes | ~90% gains on complex research vs single agent. *This is what Claude Code natively gives you* via subagents — cheapest pattern to operationalize on a Max plan. |

**Heuristic:** ReAct for the inner trading loop (seconds-minutes); Plan-Execute-Reflect for the hypothesis loop (hours-days); Orchestrator/Worker for research bursts; Debate for the go/no-go gate before capital deployment.

---

## 2. Trading-Specific Multi-Agent Decompositions (Prior Art)

The role-decomposition (researcher / analyst / risk / trader / reflector) is the field's converged design:

- **TradingAgents** ([arxiv 2412.20138](https://arxiv.org/abs/2412.20138), [repo](https://github.com/TauricResearch/TradingAgents), [site](https://tradingagents-ai.github.io/)) — 7 roles: Fundamentals, Sentiment, News, Technical analysts; Bull/Bear Researchers (debate); Trader; Risk Manager (risk-seeking / neutral / conservative perspectives also debate). Reports gains in cumulative return, Sharpe, max drawdown vs single-LLM and rule baselines.
- **FinCon** ([arxiv 2407.06567](https://arxiv.org/abs/2407.06567), NeurIPS 2024) — Manager/analyst hierarchy with **Conceptual Verbal Reinforcement (CVRF)**: a self-critique that updates *systematic investment beliefs* and selectively propagates updates only to nodes that need them — reduces P2P comm cost and drift.
- **FinMem** ([arxiv 2311.13743](https://arxiv.org/abs/2311.13743), [repo](https://github.com/pipiku915/FinMem-LLM-StockTrading)) — Single-agent with *layered memory* (working / short-term / long-term) and a configurable risk-character profile. Important precedent for memory layering.
- **FinAgent** (Zhang et al. 2024b) — reflection-driven, multimodal, integrates technical indicators; emphasis on hallucination mitigation.
- **TradingGPT** (Li et al. 2023b) — earliest debate-driven trading agent.
- **TradeTrap** ([arxiv 2512.02261](https://arxiv.org/abs/2512.02261), [repo](https://github.com/Yanlewen/TradeTrap)) — adversarial stress-test of all the above. Findings: **small perturbations at any one component cascade into runaway exposure and drawdowns**. Take this seriously.

Curated reading list: [Awesome-LLM-Quantitative-Trading-Papers](https://github.com/Tom-roujiang/Awesome-LLM-Quantitative-Trading-Papers).

---

## 3. Hypothesis-with-Budget Pattern

Treat each strategy as a scientific experiment with explicit `(capital, time_window, abort_thresholds, success_criteria)`. This pattern is well-developed in scientific-agent literature and lightly developed in trading.

**Prior art (general):**
- [Bayes-Entropy collaborative driven hypothesis agents](https://arxiv.org/html/2508.01746v1) — couples generation + optimization with information-theoretic budgets.
- [Budget-Aware Value Tree Search (BAVT)](https://arxiv.org/html/2603.12634) — formal mechanism that *transitions policy from exploration to exploitation as compute budget drains* — directly portable to capital budget.
- [LLM scientific agents survey](https://arxiv.org/html/2503.24047v1) — hierarchical hypothesis trees, domain feedback for pruning.
- AutoGen / CrewAI / LangGraph — see [framework comparison](https://www.datacamp.com/tutorial/crewai-vs-langgraph-vs-autogen). LangGraph's explicit state machine wins for auditability; CrewAI for ergonomic role roster; AutoGen for free-form conversational debate.

**Trading-specific:** FinCon's risk-control component already does episodic self-critique and selectively updates beliefs — the closest published analog. Most published trading agents do *not* gate experiments behind explicit capital + abort budgets; this is an architectural gap agent-wolf can usefully fill.

**Hypothesis prompt schema (recommended):**
```
{
  thesis: <one-sentence falsifiable claim>,
  signals: [<observable triggers>],
  invalidation: [<observable disconfirmers>],
  capital_USD: <bounded>,
  time_window_hours: <bounded>,
  abort: { drawdown_pct, max_position_USD, hard_deadline },
  success: { target_return_pct, partial_TP_levels },
  prior_confidence: 0..1,
  related_priors: [<vector-store IDs>]
}
```
Pin this schema in `CLAUDE.md` so every hypothesis run is structurally identical and queryable post-hoc.

---

## 4. Memory + State Across Long-Running Loops

Per the [Practical Guide to Memory for Autonomous LLM Agents](https://towardsdatascience.com/a-practical-guide-to-memory-for-autonomous-llm-agents/) and [Position: Episodic Memory is the Missing Piece](https://arxiv.org/pdf/2502.06975):

- **Episodic** (full event sequences — every hypothesis with its trajectory and outcome). Use append-only JSONL in `~/.claude/projects/<proj>/episodes/` plus a vector index for semantic recall. This is what a "reflector" agent reads to learn.
- **Semantic** (distilled facts — "MEME tokens above $500M FDV mean-revert after CEX listing"). Stored as belief embeddings; FinCon's CVRF is the model.
- **Working** (current open positions, active hypotheses) — structured JSON file checked at every loop iteration. Not in conversation context.
- **Procedural** (skills, playbooks) — Claude Code skills + `CLAUDE.md`.

**Watch out for ["experience following"](https://arxiv.org/pdf/2502.06975)** — flawed memories propagate into self-degradation. Mitigate with: outcome-weighted retrieval (winners weighted higher only after statistical significance), explicit decay, and human-in-the-loop pruning.

**Claude Code session state:** sessions persist as JSONL under `~/.claude/projects/`, supporting resume/fork ([docs](https://claude.com/blog/using-claude-code-session-management-and-1m-context)). Subagents get fresh context windows — perfect for isolating a per-hypothesis investigator without polluting the orchestrator. The 1M context window helps but **context rot is real** — do not rely on long context, use external state.

---

## 5. Common Pitfalls (and Hard Rules to Counter Them)

From [TradeTrap](https://arxiv.org/html/2512.02261v1), [LLM Hallucination Survey](https://arxiv.org/html/2509.18970v1), [Prompt Drift](https://www.comet.com/site/blog/prompt-drift/), [Agent Drift](https://prassanna.io/blog/agent-drift/), and "[I asked an LLM for 20 strategies, 14 were the same](https://dev.to/whetlan/i-asked-an-llm-to-generate-20-trading-strategies-14-were-the-same-thing-2f36)":

| Pitfall | Evidence | Counter |
|---|---|---|
| **Strategy hallucination** — plausible-looking, market-insight-free strategies; backtest p-hacking | LLMs converge to a small set of clichés; overfit when sampled at scale | Force orthogonality in proposals; pre-register before backtest; out-of-sample only |
| **Epistemic / phantom-portfolio hallucination** — agent thinks it holds positions it has closed | TradeTrap documents this directly | **Source of truth = exchange API, never LLM memory.** Inject ground-truth state every turn |
| **Hallucinated trades** — agent says "order placed" without confirmation | Standard tool-use failure mode | Require structured tool result + on-chain/exchange confirmation before any "executed" claim |
| **Overtrading / over-confidence** | LLMs are sycophantic and risk-blind | Hard-coded Python checks for position size, daily loss limit, cooldowns — never let the LLM decide these |
| **Prompt / role drift** | System prompt loses attention weight as context fills | Re-inject condensed system prompt every N turns; periodic checkpoint summaries |
| **Context bloat** | Old tool outputs crowd out fresh signal | Subagents with isolated context; external state containers; JIT retrieval |
| **Goal drift / specification gaming** | METR 2025: models modify scoring code to "win" | Reward = realized PnL only, post-fees, post-slippage, post-mortem-validated; never let agent define success criteria mid-run |
| **Cascade fragility** | TradeTrap: single-component perturbation -> portfolio collapse | Defense in depth; deterministic veto layer; debate before commit |

---

## 6. Recommended Architecture for agent-wolf MVP

Three candidate architectures, with explicit tradeoffs:

### Candidate A — "Lean ReAct + hard guardrails"
- Single Claude Code session, ReAct loop, deterministic Python risk module, paper mode only.
- **Pro:** ships in days; minimal token burn. **Con:** no learning, no debate, drifts on multi-day horizons. Rejected as long-term spine — but useful as the *inner* execution loop inside a richer system.

### Candidate B — "TradingAgents-style debate ensemble"
- Faithful port of TradingAgents: news/sentiment/technical/fundamental analysts -> bull/bear debate -> trader -> risk-debate -> execution.
- **Pro:** strongest published results; well-documented prompt structure. **Con:** designed for daily equity decisions, not multi-day crypto hypotheses; very token-heavy; no native budget/hypothesis abstraction.

### Candidate C — **"Hypothesis-as-experiment Orchestrator/Worker with Reflexion"** *(recommended MVP)*

Anchor on Anthropic's [orchestrator-worker](https://www.anthropic.com/engineering/multi-agent-research-system) pattern (which Claude Code's subagent system already implements natively) plus FinCon-style verbal reinforcement plus hypothesis-with-budget framing.

```
Orchestrator (lead Claude Code session)
  |
  |-- Researcher subagent  (parallel web/on-chain scans, fresh context)
  |-- Analyst subagent     (interprets price, funding, flows)
  |-- Critic/Risk subagent (debates the proposed hypothesis;
  |                         must produce explicit invalidation criteria)
  |-- Executor (deterministic Python; NOT an LLM):
  |     - validates against risk module (hard caps)
  |     - submits to Hyperliquid / Jupiter
  |     - confirms via exchange API ground truth
  |-- Reflector subagent   (post-mortem; writes to episodic + semantic memory)

State (external, not in context):
  - working_state.json   (open hypotheses, positions, budgets remaining)
  - episodes/*.jsonl     (full hypothesis trajectories)
  - beliefs.vector_db    (CVRF-style distilled lessons)
```

**Why this:**
1. Maps cleanly onto Claude Code's existing subagent primitive — no extra framework needed (no AutoGen / CrewAI dependency for MVP).
2. Subagents give isolated context, so the orchestrator can run for days without context rot.
3. Hypothesis schema (Section 3) becomes the contract between orchestrator and executor — auditable and structurally identical for every trade.
4. Deterministic risk layer (Python, not LLM) addresses the most damaging pitfalls (phantom portfolio, runaway sizing, goal-gaming) per [VPS for Forex Trader](https://www.vpsforextrader.com/blog/autonomous-trading-agents/) and TradeTrap.
5. Reflector + vector memory provides FinMem/FinCon-style learning without committing to their full frameworks.
6. Debate is *scoped* — only the Critic challenges before commit, avoiding TradingAgents' token blowup.

**MVP build order (suggested):**
1. Hypothesis schema + working-state file + paper-mode executor (deterministic Python).
2. Orchestrator prompt + Researcher/Analyst/Critic subagent prompts + risk module.
3. Episodic JSONL logging.
4. Reflector + vector belief store (lights-on after ~20 hypotheses).
5. Promote to live, tiny capital, only after sustained paper-mode edge.

---

## Sources
- [Anthropic — Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
- [Anthropic — How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Anthropic Cookbook — agent patterns](https://github.com/anthropics/anthropic-cookbook/tree/main/patterns/agents)
- [Claude Code session management & 1M context](https://claude.com/blog/using-claude-code-session-management-and-1m-context)
- [ReAct vs Plan-and-Execute (DEV)](https://dev.to/jamesli/react-vs-plan-and-execute-a-practical-comparison-of-llm-agent-patterns-4gh9)
- [Reflexion (Shinn et al. 2023)](https://arxiv.org/abs/2303.11366)
- [Tree of Thoughts (Yao et al. 2023)](https://arxiv.org/abs/2305.10601)
- [LATS for financial decisions](https://towardsdatascience.com/tackle-complex-llm-decision-making-with-language-agent-tree-search-lats-gpt4-o-0bc648c46ea4/)
- [TradingAgents paper](https://arxiv.org/abs/2412.20138) | [repo](https://github.com/TauricResearch/TradingAgents) | [site](https://tradingagents-ai.github.io/)
- [FinCon (NeurIPS 2024)](https://arxiv.org/abs/2407.06567)
- [FinMem](https://arxiv.org/abs/2311.13743) | [repo](https://github.com/pipiku915/FinMem-LLM-StockTrading)
- [TradeTrap](https://arxiv.org/abs/2512.02261) | [repo](https://github.com/Yanlewen/TradeTrap)
- [Awesome LLM Quantitative Trading Papers](https://github.com/Tom-roujiang/Awesome-LLM-Quantitative-Trading-Papers)
- [Practical Guide to Memory for Autonomous LLM Agents](https://towardsdatascience.com/a-practical-guide-to-memory-for-autonomous-llm-agents/)
- [Episodic Memory is the Missing Piece (2025)](https://arxiv.org/pdf/2502.06975)
- [Budget-Aware Value Tree Search](https://arxiv.org/html/2603.12634)
- [Bayes-Entropy hypothesis agents](https://arxiv.org/html/2508.01746v1)
- [Prompt Drift (Comet)](https://www.comet.com/site/blog/prompt-drift/)
- [Agent Drift (Prassanna)](https://prassanna.io/blog/agent-drift/)
- [LLM Agents Hallucination Survey](https://arxiv.org/html/2509.18970v1)
- [I asked an LLM for 20 trading strategies, 14 were the same](https://dev.to/whetlan/i-asked-an-llm-to-generate-20-trading-strategies-14-were-the-same-thing-2f36)
- [Running LLM Trading Agents on a VPS — risk infrastructure](https://www.vpsforextrader.com/blog/autonomous-trading-agents/)
- [Specification gaming in reasoning models (2025)](https://arxiv.org/pdf/2502.13295)
- [Open Broker — Hyperliquid CLI for autonomous agents](https://openbroker.dev/)
