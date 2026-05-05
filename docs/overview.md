# agent-wolf — Research Synthesis

*Date: 2026-05-05. Status: pre-implementation. This document distills the seven research briefs in `docs/research/` into actionable design recommendations and surfaces the open questions that need to be resolved before code begins.*

---

## TL;DR

- **Architecture:** Orchestrator/Worker (Claude Code subagents) + hypothesis-as-experiment + deterministic Python risk engine. **LLMs synthesize and propose; code validates, sizes, and executes.** Pattern from FinMem / TradingAgents / FINCON.
- **Venues for MVP:** Hyperliquid (perps + spot) + Jupiter (Solana spot, including memecoin routes). Add a venue later only if it's earning its keep.
- **Signal stack starter:** Hyperliquid info API + Lookonchain + Nansen Pro ($49/mo) + Polymarket + DexScreener/Helius free tiers + Anthropic web search inside the loop. ~$49/mo.
- **TA core:** 200d MA regime gate, ATR vol-targeting, time-series momentum, perps funding-rate z-score, spot-vs-perp CVD divergence. Quarter-Kelly sizing. Anti-Martingale per hypothesis.
- **Safety stack:** Process-isolated risk engine, per-hypothesis sub-accounts, file-flag kill switch, idempotent orders, shadow mode from day one.
- **Critical blocker:** **Running Claude Code CLI on a Max subscription as a 24/7 autonomous trading agent likely sits outside Anthropic's intended use of the Max plan.** The user must clarify this with Anthropic *before* building Phase 3 (live trading). See §6.

---

## 1. Architecture

The convergent design across published trading agents (FinMem, TradingAgents, FinCon) and Anthropic's own multi-agent guidance points at one shape: **Orchestrator/Worker + Hypothesis-as-Experiment + Deterministic Risk Layer**.

```
Orchestrator (lead Claude Code session)
  │
  ├── Researcher subagent (parallel web/on-chain scans, fresh context)
  ├── Analyst subagent    (interprets price action, funding, flows)
  ├── Critic/Risk subagent (debates the proposed hypothesis;
  │                         must produce explicit invalidation criteria)
  ├── Executor (deterministic Python — NOT an LLM)
  │     ├── RiskEngine: hard caps, kill switch, idempotency
  │     └── Broker: Hyperliquid / Jupiter adapters
  └── Reflector subagent  (post-mortem; writes to episodic + semantic memory)

External state (NOT in conversation context):
  - working_state.json    (open hypotheses, positions, budgets remaining)
  - episodes/*.jsonl      (full hypothesis trajectories — append-only)
  - beliefs.vector_db     (CVRF-style distilled lessons)
```

### Why this shape

1. Maps cleanly onto Claude Code's existing subagent primitive — no AutoGen/CrewAI dependency required for MVP.
2. Subagents have isolated context windows, so the orchestrator can run for days without context rot.
3. The hypothesis schema (below) is the contract between LLM and code — every trade structurally identical, queryable post-hoc.
4. The risk engine sits *outside the LLM* in a separate process. LLMs cannot rationalize their way past process isolation. This is the #1 lesson from TradeTrap.
5. Reflector + vector memory provides FinMem/FinCon-style learning without committing to either framework.
6. Debate is *scoped* — only the Critic challenges before commit, avoiding TradingAgents' token blow-up.

### Hypothesis schema (the contract)

```json
{
  "thesis": "<one-sentence falsifiable claim>",
  "signals": ["<observable triggers>"],
  "invalidation": ["<observable disconfirmers>"],
  "capital_USD": <bounded>,
  "time_window_hours": <bounded>,
  "abort": { "drawdown_pct": ..., "max_position_USD": ..., "hard_deadline": ... },
  "success": { "target_return_pct": ..., "partial_TP_levels": [...] },
  "prior_confidence": 0..1,
  "related_priors": ["<vector-store IDs>"]
}
```

This is what the orchestrator hands to the executor. Pin it in `CLAUDE.md` once the project starts.

### Division of labor (LLM vs code)

| Layer | Owner | Why |
|---|---|---|
| Signal/feature computation | **Code** | Deterministic, auditable, no hallucination |
| Regime classification | **Code** (HMM or rules) | LLMs are bad at numeric thresholds |
| Hypothesis generation | **LLM** | Synthesis is the killer app |
| Trade proposal (asset, direction, thesis, invalidation) | **LLM** with structured output | Forces falsifiable commitments |
| Validation gate | **Code** | Hard rules, no negotiation |
| Position sizing | **Code** (vol-target × 0.25 Kelly cap) | Math, not narrative |
| Order execution | **Code** | Speed + precision |
| Post-trade review / scoring | **LLM-as-judge** | Good at narrative attribution; feeds memory |

**Avoid letting the LLM be the final-call trader with no code gate.** Every paper that tried it got burned by hallucinated numbers, wrong tickers, and sizing errors.

---

## 2. Venues

**MVP set: Hyperliquid + Jupiter. No exceptions until they earn it.**

### Hyperliquid — primary venue

- Mature official Python SDK ([hyperliquid-python-sdk](https://github.com/hyperliquid-dex/hyperliquid-python-sdk), MIT)
- **Agent-wallet primitive** — non-withdrawable signing key purpose-built for autonomous agents. This is the right security boundary
- ~100+ perp markets, gas-free, sub-second finality, fees scale to free for top-tier makers
- Bonus: an existing MCP server ([hyperliquid-mcp](https://github.com/edkdev/hyperliquid-mcp)) wraps the SDK and plugs into Claude Code as a tool
- **Caveat:** US/Ontario/sanctioned-region geofence. If the operator is in any of these jurisdictions, this is a *legal/operational* blocker that needs resolution before code matters

### Jupiter — secondary, for spot/memecoin

- Single API gets ~80% of Solana DEX liquidity (Raydium, Meteora, Orca, etc.)
- Ultra Swap API is gasless, RPC-less, MEV-protected — far simpler than direct Raydium SDK use
- Limit + DCA APIs let the agent express multi-day hypotheses without holding open orders client-side
- Memecoin venues become reachable as Jupiter routes — no separate adapter per launchpad

### Defer / skip for now
- dYdX v4 (Cosmos signing tax, perps-only, narrower asset set)
- GMX v2 (would duplicate Hyperliquid's perp coverage with worse latency)
- Drift / Vertex (good fallbacks; revisit if Solana perps become a thesis target)
- BullX / Photon (closed-source UIs, not agent-targets)
- Direct memecoin sniper tooling (different ecosystem; multi-day horizons make it irrelevant)

**Architecture note:** build venue-agnostic position/order abstractions from day one. The two adapters share enough surface that this pays off the moment a third is added.

---

## 3. Signals

**Recommended starter stack — about $49/mo total:**

1. **Hyperliquid info API** (free) — funding rates, OI delta, liquidation cascades. Native to the trading venue, leading indicator for unwinds. **Non-negotiable.**
2. **Lookonchain feed + Nansen Pro** ($49/mo annual) — smart-money is the only social-flavored signal with consistent edge. Lookonchain is the free narrative layer; Nansen is the queryable backbone.
3. **Grok API with X Search tool** ($150/mo free credits via xAI's data-sharing program) — the cheapest legitimate path to X sentiment in 2026. Skip raw X API.
4. **Polymarket Gamma API** (free, public) — macro/event probabilities (Fed, ETF, regulatory) reprice faster than news. Genuine leading indicator at multi-day horizons.
5. **DexScreener + Helius free tier** (free) — Solana memecoin discovery and EVM pair scanning.

**Pattern:** free public APIs for market data, one paid on-chain intelligence subscription, and use Grok/Anthropic LLMs as the search/sentiment layer rather than buying raw social firehoses.

Skip until the agent demonstrates edge: LunarCrush, direct X API, Birdeye paid, Dune paid tiers, CoinGecko paid.

---

## 4. Technical Analysis & Sizing

**Five indicators, no more (academically robust):**

1. 200-day MA + slope — regime gate
2. ATR(14) — vol-target sizing input
3. 12-month time-series momentum z-score — primary directional signal (Moskowitz/Pedersen 2012)
4. Perps funding-rate z-score (cross-sectional) — crowding fade signal
5. Spot-vs-perp CVD divergence — entry timing / exhaustion

**Sizing rule:**
```
per_trade_size = min(
  vol_target / (ATR × price),
  0.25 × kelly_estimate,
  0.05 × equity
)
```

**Per-hypothesis budget:** 10–20% of capital, **anti-Martingale** — compound only on realized PnL, hard-stop at -25% of allocated budget. Never average down on a losing hypothesis.

**Library:** `pandas-ta-classic` (the actively maintained fork) is the recommended default. Add TA-Lib only if a specific indicator demands it.

---

## 5. Risk & Paper Trading

**Three modes, all required:**

1. **Shadow** (live data, no orders) — agent runs against real-time feeds; orders go to a logger and simulated ledger.
2. **Replay** (historical data, simulated clock) — for regression testing prompt changes. Agent must not see future bars.
3. **Live paper** (testnet) — Hyperliquid testnet works with full perps API. Solana devnet is too thin for DEX flow; for Solana, simulate against mainnet quotes without signing.

**Boundary:**
```
Agent (LLM)
    │
    ▼
ExecutionGateway   ← agent's only interface
    │
RiskEngine          ← shared, identical in paper and live
    │
    ├── PaperBroker    (shadow / replay)
    └── LiveBroker     (Hyperliquid / Jupiter)
```

The agent imports only `ExecutionGateway`. Mode is selected by config (`WOLF_MODE=shadow|testnet|live`). Agent code is byte-identical across modes — non-negotiable for paper-vs-live comparison to be valid.

**Hard limits in code (the agent cannot bypass):**
- Per-trade max loss (stop attached at submission)
- Per-day max drawdown (halt new entries)
- Total drawdown circuit breaker (-15% peak-to-trough → freeze)
- Position size cap per asset / hypothesis cluster / venue
- Leverage cap (3–5x agent ceiling, despite HL allowing 50x)
- Per-hour notional throughput cap (runaway-loop guard)
- Idempotency keys on every order
- File-flag kill switch checked every loop tick

**Per-hypothesis sub-accounts:** treat each active hypothesis as its own sub-portfolio with its own NAV, risk budget, and ledger. Clean attribution, kill bad hypotheses without touching others.

**Promotion criteria:**
- Phase 0 (replay): bug-fixing only
- Phase 1 (shadow on live data): 60 days minimum AND ≥50 trades
- Phase 2 (testnet): 30 days
- Phase 3 ($200–500 mainnet): hard caps everywhere; shadow runs in parallel for fill reconciliation
- Phase 4 (scale): only on out-of-sample Sharpe > 1.0 over ≥100 trades

---

## 6. Infrastructure — the open question

**The user's plan to run Claude Code CLI under the Anthropic Max subscription, in a Docker container, as a 24/7 autonomous trading agent, has a critical wrinkle.** Quoting the [Claude Code authentication docs](https://code.claude.com/docs/en/authentication.md) and [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview.md):

> "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."

Combined with:
- The Agent SDK requires `ANTHROPIC_API_KEY` (per-token billing — what the user wants to avoid)
- `claude --bare` cannot use Max OAuth credentials
- Max-plan rate limits for headless usage are not publicly documented
- No first-party examples exist of `claude` running as a long-lived autonomous daemon

**Practical implications:**

1. **Phase 1 (build / paper):** Claude Code CLI on Max is fine — the user invokes the agent interactively, which is normal Claude Code usage.
2. **Phase 2 (extended unattended paper):** Get explicit AUP clarification from Anthropic in writing before running an unattended `claude` daemon for days. Until then, prefer scheduled `/loop`-style invocations the user has explicitly enrolled.
3. **Phase 3 (live capital):** If Anthropic does not bless 24/7 autonomous Max usage, the architecture must change. Options:
   - **Accept per-token API** for the trading-execution agent and budget it (Opus 4.7 token cost per hypothesis is small relative to capital deployed; this is the cleanest legal posture).
   - **Bedrock / Vertex AI** for subscription-shaped pricing on Claude models.
   - **Hybrid:** Claude Code + Max for *interactive design and signal research* (normal usage); a separate, non-LLM execution service for live trading.

**Action required from user:** Decide whether to (a) contact Anthropic for AUP clarification before any phase-3 work, (b) accept the per-token API constraint for live trading, or (c) defer the autonomy question by keeping a human in the loop indefinitely.

---

## 7. Prior Art to Actually Study (Top 5)

1. **[TradingAgents](https://github.com/TauricResearch/TradingAgents)** (Apache-2.0, 61k stars, Python/LangGraph) — closest match to our multi-agent design; steal the role topology, debate loop, and reflection mechanism.
2. **[hyperliquid-python-sdk](https://github.com/hyperliquid-dex/hyperliquid-python-sdk) + [hyperliquid-mcp](https://github.com/edkdev/hyperliquid-mcp)** (MIT) — execution layer. The MCP wrapper plugs straight into Claude Code as a tool.
3. **[FinMem](https://github.com/pipiku915/FinMem-LLM-StockTrading)** — only prior art designed for *multi-day-horizon* LLM trading. Borrow the layered-memory module wholesale.
4. **[elizaOS plugin-solana](https://github.com/elizaos-plugins/plugin-solana)** (MIT) — lift the Jupiter swap, token validation, and position-sizing code; ignore the rest of Eliza.
5. **[Olas trader](https://github.com/valory-xyz/trader)** (Apache-2.0) — different domain (prediction markets) but the most mature published "fully autonomous, accountable" agent service architecture.

**Honorable mentions:** Hummingbot Gateway (DEX abstraction layer), NautilusTrader (event model), AI Trading Agent on Hyperliquid (single-file reference impl).

**Hard skips:** Freqtrade (GPL + CEX-only), QuantConnect Lean (wrong stack), Virtuals Protocol (tokenization, not trading), TradingGoose (use upstream).

**Cautionary tale:** the [PromptMink supply-chain attack](https://www.reversinglabs.com/blog/claude-promptmink-malware-crypto) (Feb 2026) compromised an open-source autonomous crypto trading project via a Claude-coauthored commit pulling a malicious npm dep. Lock dependencies, pin hashes, treat any "borrowed" trading repo as untrusted until audited.

---

## 8. Open Questions for the User

These need decisions before implementation:

1. **AUP for Max-subscription autonomy** — willing to contact Anthropic, accept a per-token fallback, or keep a human in the loop? (See §6.)
2. **Geographic/legal posture re Hyperliquid** — is the operator in a geo-blocked jurisdiction (US, Ontario, sanctioned regions)? If yes, this needs resolving before Hyperliquid is the primary venue.
3. **Wallet custody model** — single hot wallet, or per-hypothesis sub-accounts via Hyperliquid agent-wallets, or Safe multisig à la Olas? Recommend agent-wallets for simplicity in MVP.
4. **Repo language** — Python is the consensus across all prior art (TradingAgents, FinMem, Hyperliquid SDK). Confirm.
5. **Where the agent runs** — your own server / VPS / Docker on a managed cloud? Affects auth-credential handling.
6. **Budget for paid signals** — confirm ~$49/mo (Nansen) is acceptable for the MVP signal stack, or stay $0 until edge is proven.
7. **Notification/control surface** — Telegram bot, Slack, web dashboard, file-only? Affects how Phase 1 reviews work.
8. **First hypothesis class** — perps trend-following, perps funding-rate carry, spot momentum, or memecoin narrative? Pick one to bias the MVP build.

---

## 9. Suggested Build Order (when implementation begins)

1. **`claude-md` + repo scaffold** with hypothesis schema and risk-engine interfaces.
2. **Hyperliquid adapter** (read-only first: positions, market data, funding, OI).
3. **RiskEngine** with hard limits + idempotency, property-tested with `hypothesis`.
4. **PaperBroker** — simulated fills; agent-facing `ExecutionGateway` interface.
5. **Indicator pipeline** in deterministic Python (pandas-ta-classic).
6. **Orchestrator prompt** + Researcher / Analyst / Critic subagent prompts.
7. **Episodic JSONL logging** of every prompt, response, tool call, and outcome.
8. **First hypothesis end-to-end in shadow mode** — does it generate a structured trade and route it through the risk gate cleanly?
9. **Reflector subagent + vector belief store** — light up after ~20 hypotheses worth of data.
10. **Hyperliquid testnet** + reconciliation harness against shadow.
11. *(After AUP question is resolved)* Live trading scaffold.

---

## 10. Where to Read More

| Topic | Brief |
|---|---|
| DEX comparison, Hyperliquid + Jupiter detail | `docs/research/01-dex-landscape.md` |
| Open-source projects to borrow / skip | `docs/research/02-prior-art.md` |
| Multi-agent architectures, hypothesis pattern, pitfalls | `docs/research/03-agentic-architectures.md` |
| Pricing and access for every signal source | `docs/research/04-signal-sources.md` |
| Indicators, sizing, regime detection, LLM-vs-code | `docs/research/05-ta-and-quant.md` |
| Backtest frameworks, paper modes, risk controls, evaluation | `docs/research/06-risk-and-paper-trading.md` |
| Claude Code authentication, AUP risk, alternatives | `docs/research/07-claude-code-infra.md` |
