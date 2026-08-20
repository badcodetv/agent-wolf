# hypothesis-bot — Design Synthesis

> Distilled from the eight research briefs in `docs/research/`. Read those for the citations and the deeper detail; this file is the version of the design you can act on. **Updated 2026-05-09 with the KISS pass — see [`09-kiss-architecture-decision.md`](research/09-kiss-architecture-decision.md) for what got cut and why.**

## TL;DR

A multi-asset paper-only **hypothesis-tracking advisor** for a trusted team of 3–5 users. A user states a thesis (*"gold rises because China is rebalancing reserves"*), an LLM-assisted form-based interview turns it into a falsifiable structured spec, then a daily scheduled tick gathers free market + social/news data and updates a Bayesian confirmation score over the hypothesis's lifetime. No live trading.

**Recommended stack (chosen, not a survey):**

| Layer | Choice | Why | Brief |
|---|---|---|---|
| Frontend | React 18 + Vite + MUI + TanStack Query + TipTap | Mirrors Platinum | [`03`](research/03-platinum-stack-survey.md) |
| Backend | Go 1.25 + Fiber v3 + River queue + zerolog + Cobra | Mirrors Platinum | [`03`](research/03-platinum-stack-survey.md) |
| Database | **Postgres on Supabase free** — pgvector + tsvector + TimescaleDB **all in one DB** | Only $0 host that bundles Timescale + pgvector + Auth | [`06`](research/06-storage-architecture.md) |
| Auth | **Supabase Auth** (Google OAuth) — same vendor as the DB | One vendor; ~30 LOC JWT verifier in Go | [`08`](research/08-supabase-auth-multiuser.md) |
| LLM | Claude Code CLI on Max, **single operator OAuth token** baked into the goworker container | $0 incremental Anthropic spend; AUP-aligned single-beneficiary model | [`07`](research/07-claude-code-orchestration.md) |
| Web search | Claude Code native `WebSearch` + `WebFetch` | Free under Max session budget | [`07`](research/07-claude-code-orchestration.md) |
| Embeddings | OpenAI `text-embedding-3-small` @ 512 dims | ~$0.10/mo at our volume — effectively free; sentence-transformers is the strict-$0 fallback | [`06`](research/06-storage-architecture.md) |
| Type sharing | `typescriptify-golang-structs` Go → TS codegen | Mirrors Platinum's single-source-of-truth pattern | [`03`](research/03-platinum-stack-survey.md) |
| Deploy v1 | Docker Compose on a single VM — three services (`goapi`, `goworker`, optional `postgres`) | Lowest friction; mirrors Platinum; K8s later | [`03`](research/03-platinum-stack-survey.md) |

**Key shape after the KISS pass:** the goworker container holds the only `CLAUDE_CODE_OAUTH_TOKEN` and exec's the upstream `claude` binary as a subprocess. **No per-session sandbox containers. No scoped-JWT callbacks. No SSE.** Each LLM run is a fresh `claude -p` invocation that returns final JSON; the worker parses it and writes to Postgres directly. The whole orchestration layer collapses to "fork, wait, parse."

---

## Architecture

```
                Supabase Auth (Google OAuth)
                         ▲
                         │ ID token
              ┌──────────┴───────────┐
              │  React + Vite + MUI  │  ← polls for status; no SSE
              └──────────┬───────────┘
                         │ Bearer ID token
                         ▼
        ┌──────────────────────────────────┐
        │  goapi (Fiber v3, Go 1.25)       │
        │   • REST /api/v1/*               │
        │   • Verifies Supabase JWT        │
        │   • Inserts River jobs           │
        └──────────────┬───────────────────┘
                       │
                       ▼
        ┌──────────────────────────────────┐
        │  goworker (River + claude binary)│
        │   • Daily tick cron @ 06:00 UTC  │
        │   • exec `claude -p ...` per     │
        │     due hypothesis (max 4 par.)  │
        │   • parses --output-format json  │
        │   • writes evidence + scores     │
        │  ENV: CLAUDE_CODE_OAUTH_TOKEN    │
        │  read-only root; tmpfs workspace │
        └──────────────┬───────────────────┘
                       │
                       ▼
                 Supabase Postgres
                 (pgvector + tsvector + Timescale)
```

Three containers in `docker-compose.yml`. One external auth/DB host (Supabase). The goworker is the only place the Anthropic OAuth token lives.

---

## Hypothesis lifecycle

1. **Draft.** Any teammate posts a free-form thesis via the React UI. `POST /api/v1/hypotheses` creates a `hypotheses` row with `status='draft'`. Drafts are not picked up by the daily tick.
2. **Operator runs spec-gen.** The operator (single-LLM-token holder) opens a draft and clicks **Run spec-generation**. goapi enqueues a `SpecGenJob` for the goworker. The job runs **three sequential `claude -p` invocations**:
   - **Research** — `claude -p "<research prompt>"` with `--allowedTools "WebSearch,WebFetch,Read"`. Output: a research-notes JSON artifact (key facts, base rates, related markets, recent catalysts).
   - **Question generation** — `claude -p "<questions prompt>"` taking the research artifact + thesis as input. Output: a JSON array of 5–10 interview questions covering the AsPredicted-8 + Tetlock-derived 11 fields ([`01`](research/01-prior-art-hypothesis-machines.md)).
   - Status flips to `awaiting_answers`. Frontend renders the questions as a single form.
3. **Operator answers the form** in one shot, submits. `POST /api/v1/hypotheses/:id/spec-answers`.
4. **Spec finalize.** A second `SpecFinalizeJob` runs `claude -p "<finalize prompt>"` taking research + questions + answers. Output: the canonical structured spec (JSON shape below). Status flips to `tracking` and the first evidence sweep is scheduled.
5. **First evidence sweep.** Unbounded historical pull: market data back to the relevant baseline, news + social as far as free vendors allow. Embeddings + initial scoring run inside the same `claude -p` envelope or a follow-on `FirstSweepJob`.
6. **Daily tick.** River cron at **06:00 UTC** (dodges Anthropic's 5–11 AM PT peak-hour throttle window per [`07`](research/07-claude-code-orchestration.md)) scans `hypotheses WHERE status='tracking' AND next_tick_at <= NOW()` and enqueues a tick job per due hypothesis. Idempotency via `UNIQUE(hypothesis_id, scheduled_for)` on `tick_runs`. Each tick job:
   - goworker exec's `claude -p "<tick prompt>"` with `--allowedTools "WebSearch,WebFetch,Read"`, `--output-format json`, `--max-turns 10`, and a per-job `CLAUDE_CONFIG_DIR=/tmp/wolf-tick-${JOB_ID}`.
   - Pulls yesterday's market data for tracked instruments (via the prompt's research instructions; the LLM uses WebFetch against yfinance/FRED/etc.).
   - Pulls last-24h news/social via GDELT theme queries, Reddit, EDGAR, central-bank RSS.
   - Returns a final JSON containing: per-evidence-item `{source, url, text, llm_verdict: supporting|refuting|neutral, confidence}`, plus a tick-level summary.
   - goworker parses the JSON, **embeds** each evidence item (OpenAI 3-small @ 512 dims), inserts into `evidence_items`, then runs **Beta-Binomial conjugate update** + **BOCPD** + **SPRT** in Go (Python sidecar for BOCPD, per [`02`](research/02-time-series-methods.md)).
   - Updates `next_tick_at`.
7. **View.** Any teammate (operator/editor/viewer) logs in and sees: current score, evidence timeline, mechanism-vs-outcome breakdown, change-point flags, calibration history. **No notifications**; pull-only. Frontend polls `GET /api/v1/hypotheses/:id` every 2s while a job is in-flight (status ∈ `researching | awaiting_answers | finalizing | ticking`); idle otherwise.
8. **Close.** The operator marks `confirmed | rejected | inconclusive`. Closed hypotheses become learning artifacts the next spec-generation interview can cite.

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
000001_users.go               supabase_uid PK, email, display_name, role enum
                              (operator|editor|viewer)
000002_hypotheses.go          owner FK, JSON spec, status (draft|researching|
                              awaiting_answers|finalizing|tracking|closed),
                              schedule_cadence, alpha, beta, next_tick_at
000003_hypothesis_            (hypothesis_id, user_id, role enum) — owner/editor/viewer
  collaborators.go            (kept distinct from users.role: per-hypothesis access)
000004_evidence_items.go      hypothesis_id, source, raw_text, embedding VECTOR(512),
                              text_tsv TSVECTOR, llm_verdict, indexes: HNSW + GIN
000005_market_observations.go (symbol, ts) hypertable, ohlcv, BRIN index on ts
000006_hypothesis_scores.go   per (hypothesis_id, tick_at): alpha, beta, mechanism_p,
                              outcome_p, blended_score, regime_flag, brier_lag1
000007_tick_runs.go           UNIQUE(hypothesis_id, scheduled_for) — idempotency
```

No `claude_oauth_token_encrypted` column — the operator's token lives in the goworker's env var, not in the DB.

---

## Spec generation — three `claude -p` invocations, one form

```go
// goapi/pkg/jobqueue/specgen.go (excerpt — pseudo)
func (w *SpecGenWorker) Work(ctx context.Context, j *river.Job[SpecGenArgs]) error {
    h, _ := w.store.GetHypothesis(ctx, j.Args.HypothesisID)

    // Phase 1: deep research
    research, err := w.claude.RunPrompt(ctx, ClaudeArgs{
        Prompt:       w.prompts.Render("specgen/research.md", map[string]any{"thesis": h.Thesis}),
        AllowedTools: []string{"WebSearch", "WebFetch", "Read"},
        OutputFormat: "json",
        MaxTurns:     15,
    })
    if err != nil { return err }
    w.store.SetHypothesisStatus(ctx, h.ID, "researching", research)

    // Phase 2: generate interview questions
    questions, err := w.claude.RunPrompt(ctx, ClaudeArgs{
        Prompt:       w.prompts.Render("specgen/questions.md", map[string]any{"thesis": h.Thesis, "research": research}),
        AllowedTools: []string{"Read"},
        OutputFormat: "json",
        MaxTurns:     3,
    })
    if err != nil { return err }
    w.store.SetHypothesisStatus(ctx, h.ID, "awaiting_answers", questions)
    return nil
    // → operator answers via the form; SpecFinalizeJob runs phase 3.
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

> Anthropic's **April 4, 2026** policy update made the rule "**one human, one subscription, one beneficiary**." Pro/Max **cannot** power third-party agentic tools. In-house apps that drive the unmodified `claude` binary are fine *if* the human consuming the LLM session is the subscription holder.

Conformance recipe (single-operator model):
1. **One operator, one Max OAuth token.** `CLAUDE_CODE_OAUTH_TOKEN` is set as an env var on the goworker container; nothing in the DB.
2. **Only the operator triggers LLM workflows.** Teammates can draft hypotheses (text + form fields) and read all results, but cannot directly cause `claude` to run. Drafts queue for the operator's `Run spec-generation` action.
3. **Reports are derivative content.** Score timelines, evidence rows, and rendered summaries that other teammates view in the UI are not "agent sessions" — they are output the operator generated and shared, the same way a Claude Pro user generates an article and publishes it.
4. **Goworker exec's the unmodified upstream `claude` binary** — no rebuilds, no spoofed clients (Anthropic ships cryptographic client attestation now).
5. Stay paper-only and in-app.
6. Prefer the **Routines API** (15 scheduled runs/day on Max, blessed by Anthropic) for ≤15 active hypotheses; fall back to River-driven CLI invocations beyond that.
7. Pin `claude-code` to **v2.1.99** until the v2.1.100+ token-inflation regression is fixed.

This framing — operator as sole "beneficiary" — is our reading; if the AUP language tightens to cover derivative-output sharing, revisit.

---

## Suggested build order

1. **Skeleton.** Repo scaffold mirroring Platinum's `goapi/` + `frontend/` + `Dockerfile` + `docker-compose.yml`. Wire Supabase JWT verifier ([`08`](research/08-supabase-auth-multiuser.md)). One end-to-end happy path: log in via Google, hit `/api/v1/me`, see the user row.
2. **Hypothesis CRUD + roles.** `users` (with `role` enum) + `hypotheses` (with `status='draft'`) + `hypothesis_collaborators` migrations + REST handlers. List / create / view / share. Operator-vs-editor-vs-viewer gating in middleware. **No LLM yet.**
3. **Single-operator tick worker.** `goworker` container with `claude` binary + `CLAUDE_CODE_OAUTH_TOKEN` env var. River cron + tick handler that exec's `claude -p`, parses JSON output, writes evidence. First passing test: enqueue a tick for a fixed hypothesis, see evidence rows + a score row land in the DB.
4. **Form-based spec interview.** Three-prompt `SpecGenJob` + `SpecFinalizeJob`. React form that renders the questions and submits answers. End-to-end: draft → run spec-gen → answer form → see finalized spec → first evidence sweep.
5. **View / dashboard.** Score timeline, evidence list, mechanism-vs-outcome panel, change-point flags, calibration history. Polling-based status indicator while jobs are in-flight.
6. **First real hypothesis.** Pick one (the *gold + China* worked example is the obvious candidate). Run for 30 days. Iterate prompts, evidence sources, scoring weights.

---

## Open questions

1. **Storage host commit.** Supabase (Auth + Postgres + pgvector + Timescale in one) vs. Neon (better DX, no Timescale, no Auth). KISS pass strengthens Supabase because consolidating Auth into the same vendor is now a real saving. Lean: Supabase, accept the auto-pause and ping it.
2. **Embedding model.** OpenAI `text-embedding-3-small` (~$0.10/mo, pay-per-token) vs. local `bge-small-en-v1.5` (strict $0). Decision needed.
3. **Frontend router.** React Router 7 (lean) vs. router5 (mirror Platinum). For a fresh repo, lean React Router.
4. **Operator-only LLM access — hard or soft?** Hard = only operator can even create hypothesis records. Soft = any teammate drafts (`status='draft'`); operator runs LLM. Lean: soft (matches "I can forward reports" framing).
5. **Hooks-based mid-flight evidence extraction — v1 or v1.1?** All-at-end JSON parsing is simplest; PostToolUse-hook → `evidence.jsonl` is the next-simplest if we want the UI to show evidence as it streams in. Lean: v1 = all-at-end.
6. **Spec mutability.** Once finalized, can the operator edit the spec? Lean: yes, with versioned history. Confirms with user.
7. **First hypothesis.** What's the inaugural test thesis? Gold/China is the worked example throughout the briefs but is the user's call.

---

## Read next

- [`research/09-kiss-architecture-decision.md`](research/09-kiss-architecture-decision.md) — what we cut from the original design and why (single-page).
- [`research/01-prior-art-hypothesis-machines.md`](research/01-prior-art-hypothesis-machines.md) — what to lift from Bridgewater / AlphaSense / Metaculus / Tetlock / Halawi for spec generation.
- [`research/02-time-series-methods.md`](research/02-time-series-methods.md) — Bayesian update, BOCPD, SPRT, mechanism-vs-outcome decomposition.
- [`research/03-platinum-stack-survey.md`](research/03-platinum-stack-survey.md) — what to copy from Platinum and what to skip (epilogue notes the KISS divergences).
- [`research/04-market-data-free.md`](research/04-market-data-free.md) — $0 market data vendor stack.
- [`research/05-social-signals-free.md`](research/05-social-signals-free.md) — $0 social/news/web vendor stack.
- [`research/06-storage-architecture.md`](research/06-storage-architecture.md) — Postgres-everywhere on Supabase, full DDL.
- [`research/07-claude-code-orchestration.md`](research/07-claude-code-orchestration.md) — Claude Code CLI on Max, single-operator AUP recipe, River cron, exec-and-parse pattern.
- [`research/08-supabase-auth-multiuser.md`](research/08-supabase-auth-multiuser.md) — Supabase Auth + Fiber middleware + collaboration model.
