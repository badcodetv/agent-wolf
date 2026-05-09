# hypothesis-bot — Design Synthesis

> Distilled from the eight research briefs in `docs/research/`. Read those for the citations and the deeper detail; this file is the version of the design you can act on.

## TL;DR

A multi-asset paper-only **hypothesis-tracking advisor** for a trusted team of 3–5 users. A user states a thesis (*"gold rises because China is rebalancing reserves"*), an LLM-led interactive interview turns it into a falsifiable structured spec, then a daily scheduled tick gathers free market + social/news data and updates a Bayesian confirmation score over the hypothesis's lifetime. No live trading.

**Recommended stack (chosen, not a survey):**

| Layer | Choice | Why | Brief |
|---|---|---|---|
| Frontend | React 18 + Vite + MUI + TanStack Query + TipTap | Mirrors Platinum | [`03`](research/03-platinum-stack-survey.md) |
| Backend | Go 1.25 + Fiber v3 + River queue + zerolog + Cobra | Mirrors Platinum | [`03`](research/03-platinum-stack-survey.md) |
| Database | **Postgres on Supabase free** — pgvector + tsvector + TimescaleDB **all in one DB** | Only $0 host that bundles Timescale + pgvector + Auth | [`06`](research/06-storage-architecture.md) |
| Auth | Firebase Auth + Google OAuth, allowlist via `team_member: true` custom claim | User wants Google login; Postgres `users` keyed on `firebase_uid` | [`08`](research/08-firebase-go-multiuser.md) |
| LLM | Claude Code CLI on Max, **one OAuth token per user**, baked into stateless sandbox containers | $0 incremental Anthropic spend; AUP-aligned | [`07`](research/07-claude-code-orchestration.md) |
| Web search | Claude Code native `WebSearch` + `WebFetch` | Free under Max session budget | [`07`](research/07-claude-code-orchestration.md) |
| Embeddings | OpenAI `text-embedding-3-small` @ 512 dims | ~$0.10/mo at our volume — effectively free; sentence-transformers is the strict-$0 fallback | [`06`](research/06-storage-architecture.md) |
| Type sharing | `typescriptify-golang-structs` Go → TS codegen | Mirrors Platinum's single-source-of-truth pattern | [`03`](research/03-platinum-stack-survey.md) |
| Deploy v1 | Docker Compose on a single VM | Lowest friction; mirrors Platinum; K8s later | [`03`](research/03-platinum-stack-survey.md) |

**The key insight from the Platinum survey:** Platinum already implements the orchestrator + per-session sandbox + phase-based interview pattern hypothesis-bot needs. We mirror its shape. The two divergences are (a) Firebase Auth instead of custom JWT, and (b) Claude Code CLI on Max instead of Claude Agent SDK on Azure Foundry. The orchestrator can fold into `goapi` as a Go package — the API-key proxy disappears (OAuth tokens mount directly into the sandbox).

---

## Architecture

```
                Firebase Auth (Google OAuth)
                         ▲
                         │ ID token
              ┌──────────┴───────────┐
              │  React + Vite + MUI  │
              └──────────┬───────────┘
                         │ Bearer ID token
                         ▼
        ┌──────────────────────────────────┐
        │  goapi (Fiber v3, Go 1.25)       │
        │   • REST /api/v1/*               │
        │   • Workflow + prompt registry   │
        │   • Sandbox lifecycle (in-Go)    │
        │   • River queue + cron           │
        └──┬────────────────────────┬──────┘
           │                        │
           ▼                        ▼
      Postgres                 Per-session sandbox container
      (Supabase)               ┌──────────────────────────────┐
       • users                 │ claude (Max OAuth, pinned)   │
       • hypotheses            │ wolf CLI (Go, baked in)      │
       • hypothesis_           │ /workspace                   │
         collaborators         └──────────────────────────────┘
       • evidence_items                ▲ scoped HS256 JWT
         (pgvector + tsvector)         │
       • market_observations           ▼
         (TimescaleDB hypertable)  goapi REST callbacks
       • hypothesis_scores
       • tick_runs (idempotency)
```

The orchestrator is **a Go package inside goapi**, not a separate Fastify service — Platinum split them because it predates River's lifecycle ergonomics; we don't need to.

---

## Hypothesis lifecycle

1. **Create.** User posts a free-form thesis. goapi creates a `hypotheses` row with status `drafting`.
2. **Spec generation.** goapi spawns a sandbox container, runs the **3-phase interview workflow**:
   - Phase 1 — *deep web research* (`WebSearch` + `WebFetch`) on the thesis. The LLM gathers context before asking anything.
   - Phase 2 — *interactive interview* (`AskUser` MCP tool, à la Platinum). LLM asks 5–10 questions to lock down signals, invalidation criteria, mechanism chain, horizon.
   - Phase 3 — *finalize* a structured JSON spec (the AsPredicted-8 + Tetlock-derived 11 fields from [`01`](research/01-prior-art-hypothesis-machines.md)).
   
   User reviews + accepts; status moves to `tracking`.
3. **First evidence sweep.** Unbounded historical pull: market data back to the relevant baseline, news + social as far as free vendors allow. Embeddings + initial scoring run.
4. **Daily tick.** River cron at **06:00 UTC** (dodges Anthropic's 5–11 AM PT peak-hour throttle window per [`07`](research/07-claude-code-orchestration.md)) scans `hypotheses WHERE status='tracking' AND next_tick_at <= NOW()` and enqueues a tick job per due hypothesis. Idempotency via `UNIQUE(hypothesis_id, scheduled_for)` on `tick_runs`. Each tick:
   - Spawn (or look up an existing) sandbox container *for the hypothesis owner* (their OAuth token).
   - Pull yesterday's market data for tracked instruments.
   - Pull last-24h news/social via GDELT theme queries, Reddit, EDGAR, central-bank RSS, etc.
   - **LLM-judge** classifies each evidence item as `supporting | refuting | neutral` on the **mechanism**, not just the price.
   - **Beta-Binomial conjugate update** on `(α, β)` per hypothesis ([`02`](research/02-time-series-methods.md)).
   - **BOCPD** on price + score for regime-shift flags.
   - **SPRT** check for clear-cut early termination.
   - **Calibration** (Brier) on the prior tick's prediction.
   - Update `next_tick_at`.
5. **View.** User logs in and sees: current score, evidence timeline, mechanism-vs-outcome breakdown, change-point flags, calibration history. **No notifications**; pull-only.
6. **Close.** User marks `confirmed | rejected | inconclusive`. Closed hypotheses become learning artifacts the next spec-generation interview can cite.

---

## The right-thesis-wrong-price guard

The load-bearing methodological move from [`02`](research/02-time-series-methods.md):

```
score(t) = λ(h) · P(mechanism_supported | evidence_t)
         + (1-λ(h)) · P(price_aligned | observation_t)

  λ(h) = exp(−h/τ),   h = elapsed time since hypothesis start
                        τ = decay constant tied to thesis horizon
```

Short horizon → mechanism evidence dominates (price hasn't had time to react).  
Long horizon → outcome evidence dominates (price *should* have moved by now).

This prevents the "gold dropped 5% so the thesis is dead" failure mode the user explicitly called out.

---

## Data sources ($0 v1)

From [`04`](research/04-market-data-free.md) and [`05`](research/05-social-signals-free.md). Full vendor table in those briefs; here is the daily-tick line-up:

| Stream | Primary | Backup |
|---|---|---|
| US equity EOD | yfinance (Python sidecar) | Stooq, Alpha Vantage |
| Commodities | FRED + EIA + USDA | Yahoo `=F`, World Bank Pink |
| Crypto majors | Binance public, CoinGecko Demo | Kraken, Coinbase |
| Macro / FX | FRED | Frankfurter, IMF, World Bank |
| News (mechanism evidence) | **GDELT 2.0** theme/entity queries | NewsAPI free, Newsdata.io |
| Filings | SEC EDGAR | — |
| Central-bank releases | Federal Reserve / ECB / PBOC RSS | — |
| Reddit | OAuth free 100 qpm | PullPush / Arctic Shift |
| StockTwits | per-symbol free API | — |
| Wikipedia pageviews | Wikimedia Analytics | — |
| HN | Algolia free | — |
| Web search (LLM) | Claude Code native | Tavily 1k/mo + Google CSE 100/day |

**Twitter is not viable at $0 in 2026** — design without it; X Basic at $200/mo is the natural first-upgrade lever.

---

## Storage schema

Drop-in Platinum-style migrations under `goapi/pkg/store/migrations/` (full DDL in [`06`](research/06-storage-architecture.md)):

```
000001_users.go               firebase_uid PK, email, display_name, team_member, oauth_token_encrypted
000002_hypotheses.go          owner FK, JSON spec, status, schedule_cadence, alpha, beta, next_tick_at
000003_hypothesis_            (hypothesis_id, user_id, role enum) — owner/editor/viewer
  collaborators.go
000004_evidence_items.go      hypothesis_id, source, raw_text, embedding VECTOR(512),
                              text_tsv TSVECTOR, llm_verdict, indexes: HNSW + GIN
000005_market_observations.go (symbol, ts) hypertable, ohlcv, BRIN index on ts
000006_hypothesis_scores.go   per (hypothesis_id, tick_at): alpha, beta, mechanism_p,
                              outcome_p, blended_score, regime_flag, brier_lag1
000007_tick_runs.go           UNIQUE(hypothesis_id, scheduled_for) — idempotency
```

---

## Spec-generation interview

Workflow definition copies Platinum's `pkg/workflows/registry.go` shape:

```go
SpecGenerationWorkflow = Workflow{
  ID: "spec-generation",
  Phases: []Phase{
    {ID: "research",  SystemPrompt: researchPrompt,
                      Tools: []string{"WebSearch", "WebFetch"},
                      SummaryPrompt: researchSummary},
    {ID: "interview", SystemPrompt: interviewPrompt,
                      Tools: []string{"AskUser"},
                      SummaryPrompt: interviewSummary},
    {ID: "finalize",  SystemPrompt: finalizePrompt,
                      OutputSchema: HypothesisSpec,
                      SummaryPrompt: finalSummary},
  },
}
```

Spec JSON shape (the Tetlock + AsPredicted hybrid from [`01`](research/01-prior-art-hypothesis-machines.md)):

```jsonc
{
  "thesis":              "<one-sentence falsifiable claim>",
  "mechanism_chain":     ["A causes B", "B observed via X", "X observable in Y"],
  "signals":             [{name, source, threshold}, …],
  "falsifiers":          [{observable, threshold, by_when}, …],
  "horizon_days":        90,
  "catalysts":           [{event, expected_at}, …],
  "risks":               ["…", "…"],
  "base_rate_pct":       30,
  "prior_confidence":    0.55,
  "scoring_rule":        "brier",
  "tracked_instruments": ["GLD", "GC=F", …],
  "evidence_searches":   [{query, sources, frequency}, …]
}
```

---

## AUP posture (the one constraint that determines viability)

From [`07`](research/07-claude-code-orchestration.md):

> Anthropic's **April 4, 2026** policy update made the rule "**one human, one subscription, one beneficiary**." Pro/Max **cannot** power third-party agentic tools. In-house apps that drive the unmodified `claude` binary are fine *if* each user's tokens are charged against their own subscription.

Conformance recipe:
1. **Each user brings their own Max OAuth token** (`CLAUDE_CODE_OAUTH_TOKEN`), stored encrypted on the `users` row.
2. Sandbox containers run **the unmodified upstream `claude` binary** — no rebuilds (Anthropic ships cryptographic client attestation now).
3. Tick jobs run under **the hypothesis owner's** token (the *acting* user, when collaborators write evidence).
4. Stay paper-only and in-app.
5. Prefer the **Routines API** (15 scheduled runs/day on Max, blessed by Anthropic) for ≤15 active hypotheses; fall back to River-driven CLI invocations beyond that.
6. Pin sandbox image to **claude-code v2.1.99** until the v2.1.100+ token-inflation regression is fixed.

This is materially less risky than the active-trading-bot scope — paper-only, trusted team, no third-party redistribution, no live capital.

---

## Suggested build order

1. **Skeleton.** Repo scaffold mirroring Platinum's `goapi/` + `frontend/` + `Dockerfile` + `docker-compose.yml`. Wire Firebase Auth verifier ([`08`](research/08-firebase-go-multiuser.md)). One end-to-end happy path: log in, hit `/api/v1/me`, see the user row.
2. **Hypothesis CRUD.** `users` + `hypotheses` + `hypothesis_collaborators` migrations + REST handlers. List / create / view / share. **No LLM yet.**
3. **Sandbox runtime.** Spawn a stateless `claude` container per session, mount `CLAUDE_CODE_OAUTH_TOKEN`, scoped HS256 JWT for callbacks, baked-in `wolf` Go CLI (Platinum's `pt` analogue). Adapt Platinum's `orchestrator/sandbox-manager.ts` into a Go package inside goapi.
4. **Spec-generation workflow.** Three-phase interview, workflow registry, SSE streaming to the frontend. Reuse Platinum's `AgentChat` + `useAgentSession` shape on the React side.
5. **Daily tick worker.** River cron + tick handler + GDELT/Reddit/Yahoo/FRED ingestion + embeddings + Beta-Binomial update + BOCPD + SPRT. Stats live in a Python sidecar called from Go ([`02`](research/02-time-series-methods.md)).
6. **View / dashboard.** Score timeline, evidence list, mechanism-vs-outcome panel, change-point flags, calibration history.
7. **First real hypothesis.** Pick one (the *gold + China* worked example is the obvious candidate). Run for 30 days. Iterate prompts, evidence sources, scoring weights.

---

## Open questions

1. **Whose Max token pays?** For shared hypotheses, ticks should run under the *acting* user (the hypothesis owner by default; collaborators when they actively interact). Confirms with user.
2. **Sandbox host.** Same VM as goapi (Docker socket mount) for v1, vs. DinD pod for stronger isolation later. Lean: same VM until scale forces it.
3. **Routines API or River cron?** ≤15 hypotheses → Routines (AUP-clean). >15 → River. Architecture supports both.
4. **Storage host.** Supabase or Neon? Supabase wins on Timescale + Auth bundling; Neon wins on no-pause cron stability. Lean Supabase first; revisit if pause behaviour bites the daily tick.
5. **Embedding model.** OpenAI `text-embedding-3-small` is the obvious pick at ~$0.10/mo, but it's pay-per-token API — at odds with the user's stance. Strictly-$0 fallback is sentence-transformers `bge-small-en-v1.5` running locally. Decision needed.
6. **Spec mutability.** Once finalized, can the user edit the spec? Lean: yes, with versioned history. Confirms with user.
7. **First hypothesis.** What's the inaugural test thesis? Gold/China is the worked example throughout the briefs but is the user's call.
8. **Frontend router.** Platinum uses `router5`; the more searchable default in 2026 is **React Router 7**. For a fresh repo with no inherited pages library, lean React Router. Surface as a deliberate choice.

---

## Read next

- [`research/01-prior-art-hypothesis-machines.md`](research/01-prior-art-hypothesis-machines.md) — what to lift from Bridgewater / AlphaSense / Metaculus / Tetlock / Halawi for spec generation.
- [`research/02-time-series-methods.md`](research/02-time-series-methods.md) — Bayesian update, BOCPD, SPRT, mechanism-vs-outcome decomposition.
- [`research/03-platinum-stack-survey.md`](research/03-platinum-stack-survey.md) — what to copy from Platinum and what to swap.
- [`research/04-market-data-free.md`](research/04-market-data-free.md) — $0 market data vendor stack.
- [`research/05-social-signals-free.md`](research/05-social-signals-free.md) — $0 social/news/web vendor stack (Twitter is dead at $0; mechanism evidence comes from GDELT + EDGAR + RSS).
- [`research/06-storage-architecture.md`](research/06-storage-architecture.md) — Postgres-everywhere on Supabase, full DDL.
- [`research/07-claude-code-orchestration.md`](research/07-claude-code-orchestration.md) — Claude Code CLI on Max in containers, AUP recipe, River cron.
- [`research/08-firebase-go-multiuser.md`](research/08-firebase-go-multiuser.md) — Firebase Auth + Fiber middleware + collaboration model.
