# Platinum Stack Survey

> Source repo: `/home/kai/projects/bayesprice/Platinum` (a "web app template" in the user's words; in practice a mature multi-service product). Read enough of `CLAUDE.md`, `AGENTS.md`, `docs/agent.md`, `docs/backend-architecture.md`, `frontend/package.json`, and `go.mod` to map the stack. Did not exhaust the codebase — this is a navigation sketch for hypothesis-bot to mirror, not a full audit.

## Top-level structure

Monorepo. Services live side-by-side at the root:

```
goapi/         Go API + worker (entry: goapi/main.go)
agent/         TS Fastify sandbox running Claude Agent SDK
orchestrator/  TS Fastify lifecycle manager + API-key proxy
frontend/      React 18 + Vite SPA
carbon/        C# .NET WebAPI (cross-tabulation engine)
office-addin/  TS (Excel/Word add-in)
e2e/           Playwright tests
dind/          Docker-in-Docker container with baked sandbox image
nginx/, Caddyfile  reverse proxy
docs/          architecture docs
scripts/       JS workflow + admin scripts
stack          tmux-based dev script (root)
```

Build/run pattern: `./stack build && ./stack start` (tmux + Docker Compose). Multi-env via `ENV=staging|production` + `ROUTER_PORT` env vars; staging and production can run side-by-side on the same host.

## Go backend (`goapi/`)

- **Go 1.25.0**
- **Fiber v3** (`gofiber/fiber/v3 v3.0.0-rc.2`) — web framework
- **River queue** (`riverqueue/river v0.23.1` + `riverpgxv5`) — Postgres-backed Go-native job queue. Worker runs as a separate container (`goworker`)
- **PostgreSQL 12.13** via **pgx v5** (`jackc/pgx/v5 v5.7.5`)
- **GORM v1.30** + **goqu/v9** — ORM + SQL builder, used together
- **golang-jwt/jwt v5** — JWT signing/verification
- **Cobra** — CLI subcommands (entry: `goapi/main.go`, subcommands like `goapi janitor batch-test export`)
- **zerolog** — logging
- **envconfig** + **godotenv** — config
- **typescriptify-golang-structs** — auto-generates TS types from Go structs into `frontend/src/types/gotypes.ts`
- **sashabaranov/go-openai** — OpenAI client (used by autocoder, theme AI)
- **Azure SDK** (azcore, azidentity, azblob, armstorage) — heavy use of Azure blob storage; "customer = storage account, job = container"

Folder layout (`goapi/`):

```
main.go                         entry point
cmd/                            Cobra subcommands (e.g. cmd/pt/ for the pt CLI binary)
pkg/server/                     HTTP server, routes, middleware (server.go is the setup)
pkg/store/                      DB layer; store.Store interface; goapi/pkg/store/store.go
pkg/store/migrations/           handwritten Go migrations 000NNN_description.go,
                                registered in all.go — never reordered, never modified
pkg/types/                      Go types (mirrored to TS)
pkg/config/                     envconfig
pkg/jobqueue/                   River setup, job handlers
pkg/controller/                 Holds Azure client, exposed via AzureClient()
pkg/azurestorage/               Global Azure blob client
pkg/autocoder/, pkg/chat/, pkg/executivereports/, pkg/themeai/, pkg/tsapi/
pkg/workflows/                  Workflow + prompt registry (the source of truth for agent flows)
pkg/workflows/prompts/system/   System prompts (agent.md, agent-search.md)
pkg/workflows/prompts/skills/   Inlined skills (research.md, carbon-syntax.md, ...)
```

The server struct `PlatinumAPIServer` holds all dependencies (store, jobqueue, carbonclient, AzureClient, etc.); handlers reach them via the receiver. Migrations run automatically on startup.

## Frontend (`frontend/`)

- **React 18.3** (with React Compiler RC)
- **Vite 5** + **TypeScript 5.9**
- **MUI v6** + `@emotion/*` — UI library
- **TanStack Query 5** — server state (`@tanstack/react-query`)
- **router5** with a custom wrapper at `frontend/src/router.tsx` (NOT React Router)
- **TipTap 3** — rich text editor (`@tiptap/*`)
- **DnD Kit** — drag/drop
- **echarts** + **recharts** — charts
- **react-window** + `@tanstack/react-virtual` — virtualization
- Convention: **no `useEffect`s** — manual coordination (per CLAUDE.md). `yarn tsc` must be clean before commit.
- Routes live at `frontend/src/routes.tsx`; canonical pages e.g. `AgentChatPage.tsx`, `AgentArtifactsPage.tsx`. All agent routes use `requireUser` and `hideJobSelect: true`.

## Auth

**Custom JWT, not Firebase.** Username + password to `POST /api/v1/user/login` returns `{token}`. Tokens valid 24h. Frontend stores session in an `AccountContext` + `sessionStorage`. Every `/api/v1/*` request carries `Authorization: Bearer <jwt>`. The `requireAuthMiddleware` middleware in Go gates protected routes.

For LLM-sandbox sessions, GoAPI mints a **scoped JWT** with claims `{email, customer, job, session_id, scope:"agent"}` (HS256, 24h) — that's the one the sandbox uses to call back to GoAPI.

## API contract

REST under `/api/v1/*`. **TypeScript types are auto-generated from Go structs** via `tkrajina/typescriptify-golang-structs` → `frontend/src/types/gotypes.ts`. Single source of truth for types lives in Go. This is one of the most important conventions to copy.

## Agent system — the load-bearing part for hypothesis-bot

Platinum already implements the orchestrator/sandbox/CLI pattern hypothesis-bot wants. From `docs/agent.md`:

```
Frontend ── SSE ──▶ Caddy ──▶ GoAPI :8091 (auth, persistence)
                                    │
                                    ▼
                    Orchestrator :3002 (Fastify, DAG + phase exec, container lifecycle)
                              │ ╲
                              │  └── API-key proxy :3080 (Anthropic shim)
                              ▼
                    Sandbox :3010 (per-session Docker container)
                       │
                       ├── Claude Agent SDK (TS) running query() loop
                       ├── pt CLI (Go binary baked in) — Bash-tool wrapper for GoAPI calls
                       ├── MCP UI tools (render_table, render_chart, ask_user, …)
                       └── Python 3 + pandas/numpy/matplotlib/scikit-learn/statsmodels…
```

Concrete patterns worth lifting:

- **Per-session sandbox containers** with two-tier idle reaping (suspend after 5 min, destroy after 24 hr). Tracking state survives orchestrator restart via `platinum.orchestrator=true` Docker label.
- **API-key proxy** so sandboxes never hold real keys: `ANTHROPIC_BASE_URL` points at `:3080`, the orchestrator injects the real key, forwards SSE through.
- **Phase-based interactive workflows** with `SummaryPrompt` per phase, template substitution `{{persona}} {{customer}} {{job}} {{results.nodeId}}`, conversation history reset on phase advance — this is exactly the spec-generation interview shape hypothesis-bot needs.
- **DAG executor** (Kahn's algorithm, parallel dispatch, downstream nodes auto-`skipped` on failure) — useful later for non-interactive analysis pipelines.
- **Skills inlined into system prompts** via `{{skill:name}}` placeholders resolved at GoAPI startup. Skills live in `goapi/pkg/workflows/prompts/skills/*.md`.
- **Workflow definitions are Go-owned** (`pkg/workflows/registry.go`), sent to orchestrator at session creation. Recovery: workflow re-stored from message payload after orchestrator restart.
- **`pt` CLI baked into sandbox** — single Go binary replaces 20+ MCP tool definitions, cuts prompt overhead by ~68%. The agent uses `Bash` to call `pt` instead of MCP for data ops.
- **DB schema:** `agent_sessions`, `agent_artifacts`, `agent_messages` — the messages table has a `content_tsv` TSVECTOR column with GIN index, maintained by an INSERT/UPDATE trigger, for full-text search.
- **SSE event taxonomy** is fully specified (`message_start`, `tool_use_start`, `activity_update`, `ask_user`, `artifact_registered`, etc.) with 100-event buffering for reconnect replay.

## Deployment

Single Azure VM (`azureuser@4.234.10.64`) running **Docker Compose** with multi-env via env vars. **Not Kubernetes.** Caddy reverse proxy in front. SSH-deploy: `ssh && git pull && docker compose -p $ENV up -d`. Multi-stage Dockerfile builds every service from one file (Go image, pt-build-env, sandbox-base, sandbox-final-build, orchestrator stages).

Hot reload in dev: frontend, goapi, goworker, carbon all hot reload via volume mounts and `tsx watch` / `dotnet watch`. Sandbox hot-reloads through a DinD bind-mount chain when `SANDBOX_DEV_MODE=true`.

## Observability

`zerolog` for application logs. No Prometheus/Sentry/OTEL visible in `go.mod` — Azure provides infra metrics; app-level observability is logs only.

---

## What to copy

1. **`goapi/` folder layout** — `main.go` + `cmd/` (Cobra) + `pkg/server` + `pkg/store` + `pkg/store/migrations/000NNN_description.go` + `pkg/types` + `pkg/config` + `pkg/jobqueue` + `pkg/workflows`.
2. **Fiber v3** for HTTP, **River** for jobs, **pgx v5 + GORM** for DB, **zerolog** for logs, **envconfig + godotenv** for config, **Cobra** for subcommands.
3. **Handwritten Go migrations** in `pkg/store/migrations/` with `all.go` registry; never reorder, never modify a migration that ran in prod.
4. **`typescriptify-golang-structs`** to mirror Go → TS types — single source of truth.
5. **Server struct holding all deps** (store, jobqueue, etc.) — `HypothesisAPIServer` mirroring `PlatinumAPIServer`.
6. **Workflow registry pattern** in Go (`pkg/workflows/registry.go` + `prompts/system/*.md` + `prompts/skills/*.md` with `{{skill:name}}` inlining).
7. **Phase-based interactive workflow shape** with `SummaryPrompt` per phase + template substitution — directly maps to the spec-generation interview.
8. **Per-session sandbox container** orchestrated by a Fastify (or Go) lifecycle service; suspend/destroy idle reaping; Docker label-based recovery.
9. **`pt`-style Go CLI baked into the sandbox** — for hypothesis-bot this becomes a `wolf` binary the LLM uses via `Bash` to call back to the API (search hypotheses, write evidence, fetch market data) instead of registering many MCP tools.
10. **`agent_messages` TSVECTOR + GIN trigger** pattern for full-text search over evidence/notes.
11. **SSE event taxonomy + 100-event buffering** for the chat/interview UI.
12. **Frontend stack** — React 18 + Vite + MUI v6 + TanStack Query + TipTap (for rich hypothesis editing). Keep `typescriptify` codegen.
13. **Multi-stage Dockerfile + Docker Compose multi-env** for deployment.

## What's missing or needs adding

1. **Supabase Auth + Google OAuth** — Platinum uses custom username/password JWT. The user wants Google login on the same vendor as the DB. The `requireAuthMiddleware` shape stays; the verifier swaps to a ~30-LOC Supabase HS256 verifier. *(research thread; see `08-supabase-auth-multiuser.md`)*
2. **LLM container swap: Claude Agent SDK → Claude Code CLI on Max** — Platinum's sandbox runs `query()` from `@anthropic-ai/claude-agent-sdk` against Azure Foundry (per-token paid). Hypothesis-bot must run the **Claude Code CLI binary** authenticated via `CLAUDE_CODE_OAUTH_TOKEN`. The orchestrator → sandbox → CLI shape stays; the API-key proxy is simpler (mount the OAuth token directly, no per-request shim). The Claude Code CLI's tool model differs from the Agent SDK's MCP servers — the `pt`/`wolf` Bash-tool pattern still works because Claude Code natively supports Bash. *(research thread)*
3. **Web-search tool for the LLM** — Platinum's agents work on *internal* Platinum survey data via `pt`. Hypothesis-bot's agent must research the **open web**. Need a search tool plugged into the CLI: Tavily / Exa / Brave free tiers (per `05-social-signals-free.md`).
4. **Vector store for research notes / news / social posts** — Platinum has `pt search` but it indexes Platinum-domain artifacts, not arbitrary text. Need either **pgvector on the existing Postgres** (cleanest, no new service) or a separate vector DB. *(research thread)*
5. **Time-series store for daily market and signal data** — Postgres + TimescaleDB extension is the natural mirror given the existing stack; no Platinum precedent. *(research thread)*
6. **Per-hypothesis daily tick scheduler** — River queue is in place, but Platinum's jobs are user-triggered, not recurring per-record. Need a daily cron that scans active hypotheses and enqueues a tick job per hypothesis with the hypothesis's own cadence (daily/weekly). River supports periodic jobs natively.
7. **Kubernetes deployment manifests** — Platinum is single-VM Docker Compose; hypothesis-bot may target k8s. Defer this until the v1 stack is stable; co-deploying via Docker Compose on the same VM is the lowest-friction path to first running end-to-end.
8. **Replace `router5` with React Router?** — router5 is Platinum's choice and works, but it's idiosyncratic. For a fresh repo where there's no existing pages library, React Router 7 is the more searchable default. Surface as a deliberate choice; don't copy router5 reflexively.

---

## 2026-05-09 epilogue: KISS divergences from Platinum

After completing the survey we ran a deliberate KISS pass on the inherited design (see [`09-kiss-architecture-decision.md`](09-kiss-architecture-decision.md)). The list above stays accurate as a *what's available* inventory, but for hypothesis-bot v1 we deliberately **do not copy** the following from Platinum:

- **Per-session sandbox containers** (item 8 above). The goworker exec's the `claude` binary directly with per-job `CLAUDE_CONFIG_DIR=/tmp/wolf-${JobID}` instead of spawning a Docker container per session. No suspend/destroy reaper, no `wolf.*` labels, no Docker SDK in Go.
- **`wolf` Go CLI baked into the sandbox** (item 9). With no sandbox, there are no callbacks; the worker writes to its own DB. Skills/MCP/baked-in tooling all defer to v1.1+.
- **API-key proxy at `:3080`.** The operator's `CLAUDE_CODE_OAUTH_TOKEN` is the credential and it lives directly on the goworker. No proxy.
- **SSE event taxonomy + 100-event reconnect buffer** (item 11). The frontend polls `GET /api/v1/hypotheses/:id` for status; LLM jobs return final JSON, not a stream of events.
- **Phase orchestrator with `SummaryPrompt` + history reset** (item 7). Each `claude -p` invocation is a fresh process; multi-phase work (research → questions → finalize) is sequential job dispatch in River, not a stateful in-process orchestrator.
- **DAG executor (Kahn's algorithm).** No analytic pipelines in v1; revisit when we want non-interactive multi-step analyses.

What we **do** copy is items 1–6, 10, 12, 13: folder layout, framework versions, handwritten Go migrations, `typescriptify-golang-structs`, server-struct dependency holding, workflow-as-rendered-prompt registry (without the orchestrator), `agent_messages`-style TSVECTOR + GIN pattern (renamed `evidence_items`), the React + Vite + MUI + TanStack Query + TipTap frontend, and multi-stage Dockerfile + Compose multi-env. The skipped items are reintroducible piece-by-piece if hypothesis-bot grows into them — see §Revisit triggers in `09-kiss-architecture-decision.md`.
