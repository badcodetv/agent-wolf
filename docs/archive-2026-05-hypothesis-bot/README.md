# Archived: hypothesis-bot (2026-05)

This directory holds the **first design** for this repository, code-named
`hypothesis-bot`: a Go + Fiber + Supabase + TimescaleDB + River stack that shelled out to
`claude -p`.

**That design was superseded on 2026-08-20** by a new plan that builds on Agent Bob as the
runtime instead of a bespoke Go/Supabase stack. It was never built past the research and
design-synthesis stage.

This material is kept, not deleted, because the research briefs remain useful background (prior
art, time-series methods, market/social data sources). It should not be used as a build guide —
the technology choices here (Fiber, Supabase, TimescaleDB, River, `claude -p`) are explicitly
**not** what the live plan uses.

The live, authoritative plan is `design/2026-08-20-agent-wolf.md` in the **agent-bob** repo.
Start there.

## Contents

- [`original-README.md`](original-README.md) — the original repo README as it stood before the
  archive.
- [`overview.md`](overview.md) — the synthesized hypothesis-bot design document.
- [`research/`](research/) — nine citation-heavy research briefs (prior art, time-series methods,
  Platinum stack survey, market data, social signals, storage architecture, Claude Code
  orchestration, Supabase auth, and the KISS architecture decision).
