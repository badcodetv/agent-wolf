# hypothesis-bot

The active focus of agent-wolf. Multi-market paper-only hypothesis-tracking advisor for a trusted team.

> **Status:** 2026-05-06 — research phase complete. Design synthesized in [`docs/overview.md`](docs/overview.md). Code begins after the open questions in §Open questions are resolved.

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
- **Auth:** Firebase Auth + Google OAuth, allowlist via `team_member: true` custom claim.
- **LLM:** Claude Code CLI on Max, **one OAuth token per user**, in stateless per-session sandbox containers.
- **Web search:** Claude Code native `WebSearch` / `WebFetch` (free under Max session budget).
- **Embeddings:** OpenAI `text-embedding-3-small` @ 512 dims (~$0.10/mo); sentence-transformers as the strict-$0 fallback.
- **Deploy v1:** Docker Compose on a single VM (k8s later).

The single most important takeaway from the research: **Platinum already implements the orchestrator + per-session sandbox + phase-based interview pattern hypothesis-bot needs.** We mirror it. The two divergences are Firebase Auth (not custom JWT) and Claude Code CLI on Max (not Claude Agent SDK on Azure Foundry). The orchestrator can fold into `goapi` as a Go package; the API-key proxy disappears.

## Read next

- [`docs/overview.md`](docs/overview.md) — single document that synthesizes everything below into a buildable design with a recommended build order.
- [`docs/research/`](docs/research/) — eight citation-heavy briefs (1-prior-art, 2-time-series, 3-Platinum-survey, 4-market-data, 5-social-signals, 6-storage, 7-Claude-Code-orchestration, 8-Firebase-Go).

## Open questions before code

See `docs/overview.md` §Open questions. Headlines:

1. Whose Max token pays for shared hypotheses (lean: acting user)?
2. Sandbox host — same VM as goapi (lean) or DinD pod?
3. Routines API or River cron — depends on hypothesis count.
4. Embedding model — OpenAI 3-small (pay-per-token but trivial) or local sentence-transformers (strictly $0)?
5. Frontend router — React Router 7 (lean) or copy Platinum's router5?

---

**Out of scope for v1:** live trade execution, position sizing, risk engine, auto-rebalancing. These are deferred until we trust the hypothesis machine.
