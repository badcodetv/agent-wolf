# 09 — KISS architecture decision

> Recorded 2026-05-09. After the original eight research briefs synthesized a buildable design, we ran a deliberate simplification pass on three axes the design had inherited from Platinum without earning. This brief captures *what got cut, why, and when to put it back.*

## Status quo before the pass

The synthesized design (see git history of `overview.md`) called for:

1. **Two auth providers.** Firebase Auth for Google sign-in *and* Supabase Postgres for data. Two SDKs, two consoles, two onboarding flows.
2. **Per-user Anthropic OAuth tokens.** Each teammate's Max OAuth token stored encrypted on the `users` row; tick jobs running under the hypothesis owner's token. A Cobra admin tool to grant + rotate per-user tokens.
3. **Full Platinum-style orchestration.** Per-session Docker containers spawned by Go via the Docker SDK, 5-min suspend / 24-hr destroy reaper, scoped HS256 JWT minted for sandbox→goapi callbacks, baked-in `wolf` Go CLI for evidence-write callbacks, per-container `CLAUDE_CONFIG_DIR` seeding from a read-only template, SSE event buffer (100 events) for reconnect, multi-phase workflow orchestrator with conversation-history reset between phases. Roughly 80% of the engineering surface area.

## User feedback (2026-05-09)

> *the combination of Supabase and firebase for auth - perhaps we only need one of those? Do we even need firebase at all?*
>
> *regarding the Anthropic token usage - I think it's reasonable that we make this a single user system - I can forward reports we generate to the other users… converge the LLM usage onto a single user. Surely the Anthropic license allows reports to be generated and then forwarded to other users and this does not count as a "beneficiary"?*
>
> *the extraction of an entire orchestration service from Platinum might be overkill - we don't need real-time streaming and I think we could simply extract the output of the Claude code binary (possibly using hooks) - what I mean to say is I'm trying to make this stack as simple as possible before things grow.*

## Three simplifications

### 1. One auth, not two — Supabase Auth alone

Supabase ships first-party Google OAuth on the same free tier as the DB. JWTs are HS256 (project secret); the Go verifier is ~30 LOC with no SDK. Custom claims live in `app_metadata` (server-managed). Net effect: drop `firebase.google.com/go/v4`, drop `firebase` from the frontend, swap the verifier. See [`08-supabase-auth-multiuser.md`](08-supabase-auth-multiuser.md).

**Trade-off accepted:** auth + data share a vendor (lock-in). Mitigated because the only Supabase-specific code is the JWT verifier; swap-out is rewriting one Go file.

### 2. Single operator, not five tokens

One subscription owner (the **operator**) holds the only `CLAUDE_CODE_OAUTH_TOKEN`. It lives as an env var on the goworker container, not in the DB. Teammates log in via Supabase Auth, draft hypotheses (text + form fields), and read everything; only the operator triggers LLM workflows.

**AUP framing.** The April 2026 "one human, one subscription, one beneficiary" rule was framed against third-party agentic harnesses (OpenClaw, OpenCode) that re-distribute Claude tokens to non-subscribers driving live agent sessions. Our model has one human consuming Claude (the operator) and others consuming derivative output (markdown reports, score timelines, evidence rows). This is closer to a journalist drafting in Claude and publishing than to multi-tenant agent reselling. We treat the operator as the sole beneficiary and document the framing here so it can be re-checked if Anthropic tightens the AUP language.

**Trade-off accepted:** teammates can't interactively interview the LLM about *their* hypothesis. The operator runs spec-gen on their behalf (or pair-drives). Acceptable for a 3-5-person trusted team.

### 3. No sandbox service; `claude -p` exec from goworker

The goworker container exec's the unmodified upstream `claude` binary as a subprocess via `os/exec`, captures `--output-format json`, parses, writes to Postgres. The whole orchestration layer collapses to "fork, wait, parse." Per-job isolation is `CLAUDE_CONFIG_DIR=/tmp/wolf-${JobID}` (cleaned up on exit). Safety perimeter is `--allowedTools "WebSearch,WebFetch,Read"` plus a read-only-root container with tmpfs `/workspace`. Concurrency capped at 4 via River's `MaxWorkers`.

**Spec-generation interview** becomes three sequential `claude -p` invocations (research → question generation → finalize) with a single React form in between, instead of an interactive `AskUser` MCP loop. **UI status** is polling, not SSE.

**What this deletes:** `pkg/sandbox/` (Docker SDK lifecycle), `pkg/auth/scoped_jwt.go` (no callbacks), the `wolf` Go CLI baked into a sandbox image (no callbacks), SSE event-buffer machinery, the phase orchestrator with history reset (each `claude -p` is a fresh process), the workflow registry as a heavy concept (collapses to a list of named prompt templates rendered with `text/template`), and the two-verifier middleware (only Supabase JWTs, no scoped HS256).

**Trade-off accepted:** if a hallucinated tool call slips past `--allowedTools`, the blast radius is the goworker container (read-only root + tmpfs). No real-time evidence streaming during a tick — evidence appears in batches when each tick completes. PostToolUse hooks remain available as a v1.1 escape hatch if the UX needs incremental updates.

## Revisit triggers — when to put pieces back

Concrete signals that the simpler design has run out of room:

- **Reintroduce per-tick or per-session sandbox containers** if any of: (a) we ever need to add `Bash` or `Write` to `--allowedTools` for notebook-style analysis (then we want strong isolation between the LLM process and the goworker process); (b) concurrent ticks exceed ~15 (kernel-panic threshold from claude-code issue #45880); (c) a tick needs to install per-hypothesis dependencies (e.g. a pyfolio analysis on one but not all).
- **Reintroduce SSE** if any of: (a) typical tick wall-clock exceeds ~3 minutes and users start refreshing repeatedly; (b) we add a chat UX where users converse with the LLM about a single hypothesis; (c) polling load becomes visible in goapi's request logs.
- **Reintroduce per-user OAuth tokens** if any of: (a) Anthropic clarifies the AUP to make derivative-output sharing a beneficiary issue; (b) the team grows past ~5 and any teammate needs to *initiate* LLM workflows on their own; (c) we want per-user tick budgets attributable to individual subscriptions.
- **Reintroduce a phase orchestrator with history reset** if any of: (a) the spec-generation interview needs questions that adapt based on earlier answers within the same conversation; (b) ticks become multi-step DAGs (e.g. "research → analyze → propose evidence → human approves → commit"); (c) we need first-class branching/merging across LLM phases.
- **Reintroduce sandbox→goapi callbacks (and the scoped HS256 JWT)** if any of: (a) we adopt MCP servers for tool registration; (b) we want the LLM to write evidence as it discovers it without waiting for the subprocess to exit; (c) we want the LLM to query goapi for related hypotheses or prior tick results.
- **Reintroduce Firebase Auth (or any second auth provider)** if any of: (a) Supabase Auth has a multi-day outage that breaks login; (b) we add an auth flow Supabase Auth doesn't support natively (e.g. SAML/SSO with a corporate IdP). Even then the mitigation is to swap the verifier, not run two.

## Bottom line

The KISS pass cuts roughly 80% of the engineering surface area while keeping 100% of the *value* — the methodology (Bayesian scoring, mechanism-vs-outcome, free-vendor data stack, Tetlock + AsPredicted-8 spec shape, daily tick discipline) is unchanged. What we deleted served real Platinum needs that hypothesis-bot doesn't have at v1 scale, and each piece is reintroducible piece-by-piece against the revisit triggers above.
