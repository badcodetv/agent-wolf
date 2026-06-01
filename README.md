# hypothesis-bot

The active focus of agent-wolf. Multi-market paper-only hypothesis-tracking advisor for a trusted team.

> **Status:** 2026-05-09 — research phase complete + KISS pass applied. Design synthesized in [`docs/overview.md`](docs/overview.md); rationale for what got cut in [`docs/research/09-kiss-architecture-decision.md`](docs/research/09-kiss-architecture-decision.md). Code begins after the open questions in §Open questions are resolved.

## Goal

Given a user thesis like *"gold will increase in price because China is converting their dollars to gold,"* the system:

1. Turns the loose statement into a detailed, falsifiable spec via a guided LLM interview backed by deep web research.
2. Begins gathering social and market data on a configurable schedule. The first capture is unbounded; later captures are time-gated to the most recent window.
3. Tracks confirmation/invalidation strength over the lifetime of the hypothesis, separating *mechanism evidence* from *price outcome* so a thesis can be "right" even when the price moves against it short-term.
4. Surfaces a verdict — and the underlying evidence — to the owner and any collaborators.

## Recommended stack (chosen)

- **Frontend:** React 18 + Vite + MUI + TanStack Query + TipTap (mirrors Platinum).
- **Backend:** Go 1.25 + Fiber v3 + River queue + zerolog + Cobra (mirrors Platinum).
- **Database:** Postgres on **Supabase free** — pgvector + tsvector + TimescaleDB **all in one DB**. Neon as fallback.
- **Auth:** **Supabase Auth** + Google OAuth, allowlist via `app_metadata.role` (operator/editor/viewer). Same vendor as the DB; ~30-LOC HS256 verifier in Go.
- **LLM:** Claude Code CLI on Max, **single operator OAuth token** baked into the goworker container. Teammates draft and view; only the operator triggers LLM workflows.
- **Web search:** Claude Code native `WebSearch` / `WebFetch` (free under Max session budget).
- **Embeddings:** OpenAI `text-embedding-3-small` @ 512 dims (~$0.10/mo); sentence-transformers as the strict-$0 fallback.
- **Deploy v1:** Docker Compose on a single VM — three services (`goapi`, `goworker`, optional `postgres`).

The single most important takeaway from the research: **after the KISS pass we copy the Platinum migrations + Fiber server-struct + Cobra patterns, but skip the per-session-sandbox + scoped-JWT-callback + SSE-streaming + phase-orchestrator stack.** The goworker exec's `claude -p` directly, parses the final JSON, and writes to Postgres. See [`docs/research/09-kiss-architecture-decision.md`](docs/research/09-kiss-architecture-decision.md) for the rationale.

## Read next

- [`docs/overview.md`](docs/overview.md) — single document that synthesizes everything below into a buildable design with a recommended build order.
- [`docs/research/`](docs/research/) — nine citation-heavy briefs (1-prior-art, 2-time-series, 3-Platinum-survey, 4-market-data, 5-social-signals, 6-storage, 7-Claude-Code-orchestration, 8-Supabase-auth, 9-KISS-decision).

## Open questions before code

See `docs/overview.md` §Open questions. Headlines:

1. Storage host commit — Supabase (Auth + DB + Timescale in one) vs. Neon (better DX, no Timescale).
2. Embedding model — OpenAI 3-small (pay-per-token but trivial) or local sentence-transformers (strictly $0)?
3. Frontend router — React Router 7 (lean) or copy Platinum's router5?
4. Operator-only LLM access — hard (only operator can create) or soft (anyone drafts; operator runs LLM)?
5. Routines API or River cron — depends on hypothesis count.

---

**Out of scope for v1:** live trade execution, position sizing, risk engine, auto-rebalancing. These are deferred until we trust the hypothesis machine.
