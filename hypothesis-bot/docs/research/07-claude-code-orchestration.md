# Claude Code CLI Orchestration for hypothesis-bot

> Companion to `03-platinum-stack-survey.md`. Where the Platinum survey said "swap the inner LLM SDK," this brief specifies *exactly how*. Reads on top of `../active-trading-bot/docs/research/07-claude-code-infra.md` (call it **brief 07-active**) — most of brief 07-active still applies; only the deltas under **paper-only, trusted-team scope** and the **April 2026 usage-policy update** are reworked here.

## TL;DR

Run hypothesis-bot's LLM brain on Claude Code CLI authenticated via `CLAUDE_CODE_OAUTH_TOKEN` from a 1-year `claude setup-token` issuance, in per-session Docker sandboxes orchestrated by Go (River queue + sandbox lifecycle service mirroring Platinum). Keep `--bare` off; mount `~/.claude/` read-only **and** inject the env var. Use Claude Code's native `WebSearch`/`WebFetch` as the default research tools — they are billed against Max's session budget, not separate API credit. For the **trusted-team paper-only** scope (3-5 users, in-app only, no live trades, no public re-sale of Claude tokens, no third-party harness spoofing), this is materially less risky than the active-trading-bot scope. **Verdict at the bottom.**

---

## 1. Authentication in 2026

`claude setup-token` still produces a 1-year `CLAUDE_CODE_OAUTH_TOKEN` and is still the supported headless-container path under Pro/Max. Token output is `{accessToken, refreshToken, expiresAt}`; the env var is the access token. Confirmed working with Claude Code v2.0.10+ ([Authentication docs](https://code.claude.com/docs/en/authentication), [Recovery walkthrough](https://dev.to/anicca_301094325e/how-to-recover-claude-code-oauth-token-in-30-seconds-1hd)).

**What changed in 2026:**

1. **April 4, 2026 usage-policy update.** Anthropic now explicitly disallows using Pro/Max subscriptions to power *third-party agentic tools* — the rule of thumb circulating is "**one human, one subscription, one beneficiary**" ([Anthropic update](https://www.anthropic.com/news/updating-our-usage-policy), [TechCrunch](https://techcrunch.com/2026/04/04/anthropic-says-claude-code-subscribers-will-need-to-pay-extra-for-openclaw-support/), [VentureBeat](https://venturebeat.com/technology/anthropic-cuts-off-the-ability-to-use-claude-subscriptions-with-openclaw-and)). The policy targets *harnesses that re-sell or re-distribute* Claude tokens to third parties (OpenClaw, OpenCode) and tools that **spoof the official client** to bypass per-token billing.
2. **Cryptographic client attestation.** Claude Code now ships with a compile-time `NATIVE_CLIENT_ATTESTATION` flag — the binary signs requests so the server can distinguish official clients from rebuilt forks ([Claude Code source-leak analysis](https://alex000kim.com/posts/2026-03-31-claude-code-source-leak/), [VentureBeat coverage](https://venturebeat.com/technology/anthropic-cracks-down-on-unauthorized-claude-usage-by-third-party-harnesses)). **Practical implication:** ship the unmodified upstream `claude` binary inside the sandbox. Do not call internal endpoints from your own Go code. Driving the official binary via `os/exec` with a Max OAuth token is the supported, attested path.
3. **Peak-hour throttling.** As of March 28, 2026, Max plans throttle weekdays 5-11 AM Pacific ([SitePoint rate-limits explainer](https://www.sitepoint.com/claude-code-rate-limits-explained/), [Northflank](https://northflank.com/blog/claude-rate-limits-claude-code-pricing-cost)). Schedule daily ticks **outside** that window (06:00 UTC = 23:00 PT prior day = safe).
4. **Token-inflation regression.** Claude Code v2.1.100+ silently inflates token consumption ~40%; v2.1.126 (May 1) did not fix it ([GitHub issue 38335](https://github.com/anthropics/claude-code/issues/38335)). Pin to a known-good version inside the sandbox image and re-test on bumps.
5. **Routines API (April 14, 2026).** Anthropic shipped first-party scheduled-run support: `/schedule` from the CLI, or `claude.ai/code/routines`. Max gets **15 routines/day** ([Routines docs](https://code.claude.com/docs/en/web-scheduled-tasks), [introducing-routines blog](https://claude.com/blog/introducing-routines-in-claude-code)). This is now Anthropic's blessed pattern for daily ticks — but the cap (15/day) is the binding constraint if hypothesis-bot scales past ~15 active hypotheses. For ≤15 hypotheses, **prefer Routines over a custom scheduler**; for more, fall back to River-driven `claude -p` invocations from the sandbox.

---

## 2. Headless invocation from Go

Canonical `os/exec` wrapper. `--output-format stream-json` is the supported NDJSON output as of 2026 ([headless docs](https://code.claude.com/docs/en/headless), [stream-json deep dive](https://backgroundclaude.com/blog/stream-json)). `--input-format stream-json` exists but is undocumented ([issue #24594](https://github.com/anthropics/claude-code/issues/24594)) — use it only if the orchestrator-side state machine is locked down.

```go
// pkg/sandbox/runner.go
type ClaudeEvent struct {
    Type    string          `json:"type"`        // "message_start", "content_block_delta", "tool_use", "result", ...
    Subtype string          `json:"subtype,omitempty"`
    Message json.RawMessage `json:"message,omitempty"`
    Delta   json.RawMessage `json:"delta,omitempty"`
}

func (r *Runner) RunPrompt(ctx context.Context, prompt string, allowedTools []string,
                           onEvent func(ClaudeEvent)) error {
    args := []string{
        "-p", prompt,
        "--output-format", "stream-json",
        "--verbose",                              // required for stream-json
        "--allowedTools", strings.Join(allowedTools, ","),
        "--max-turns", "30",
    }
    cmd := exec.CommandContext(ctx, "claude", args...)
    cmd.Env = append(os.Environ(),
        "CLAUDE_CODE_OAUTH_TOKEN="+r.oauthToken,
        "CLAUDE_CONFIG_DIR=/run/claude/"+r.sessionID,  // see §3 concurrency
    )
    stdout, _ := cmd.StdoutPipe()
    stderrBuf := &bytes.Buffer{}
    cmd.Stderr = stderrBuf
    if err := cmd.Start(); err != nil { return err }

    scanner := bufio.NewScanner(stdout)
    scanner.Buffer(make([]byte, 1<<20), 8<<20) // events can be large
    for scanner.Scan() {
        var ev ClaudeEvent
        if err := json.Unmarshal(scanner.Bytes(), &ev); err != nil { continue }
        onEvent(ev)
    }
    if err := cmd.Wait(); err != nil {
        return fmt.Errorf("claude exit: %w; stderr=%s", err, stderrBuf.String())
    }
    return scanner.Err()
}
```

Key points:
- `--verbose` is required when `--output-format stream-json` is used in `-p` mode (CLI rejects it otherwise).
- `exec.CommandContext` propagates timeout/cancel; the orchestrator's idle reaper just cancels the context.
- `bufio.Scanner` with a 1-8 MB buffer handles long content blocks.
- Exit codes: 0 success, 1 generic error, 2 auth error, 137 OOM, ~`SIGTERM` from context cancellation. Map these in the worker so River can decide retry policy.
- `--allowedTools` is the safety perimeter. Default for hypothesis-bot research phase: `Read,Write,Edit,Bash,WebSearch,WebFetch,Glob,Grep`.

**Bare mode.** Confirmed unchanged from brief 07-active: `--bare` skips OAuth/keychain reads. Tracked at [issue #39069](https://github.com/anthropics/claude-code/issues/39069); a feature request for "preserve OAuth, skip context" lives at [issue #38022](https://github.com/anthropics/claude-code/issues/38022) but is unresolved as of May 2026. **Do not use `--bare` with `CLAUDE_CODE_OAUTH_TOKEN`** — use the full mode and pre-populate `CLAUDE_CONFIG_DIR` instead (next section).

---

## 3. Per-session sandbox containers

Mirror Platinum's `sandbox-manager.ts` lifecycle (5-min suspend, 24-hr destroy, `platinum.orchestrator=true` Docker label for restart recovery) but rewrite in Go inside `goapi/pkg/sandbox/` using the Docker SDK. The labels become `wolf.orchestrator=true` and `wolf.session_id=<uuid>`.

**Container shape:**

```dockerfile
# sandbox image: Dockerfile.sandbox
FROM node:22-bookworm-slim
RUN npm install -g @anthropic-ai/claude-code@2.1.99   # pin pre-inflation regression
RUN apt-get update && apt-get install -y python3 python3-pip jq curl
COPY wolf /usr/local/bin/wolf                          # Go binary, like Platinum's pt
COPY skills/ /opt/skills/
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

**Run invocation (Go):**

```go
hostConfig := &container.HostConfig{
    Resources: container.Resources{
        Memory:    512 * 1024 * 1024,  // 512 MiB
        NanoCPUs:  1_000_000_000,       // 1 CPU
        PidsLimit: int64Ptr(256),
    },
    Binds: []string{
        "/var/wolf/sessions/" + sid + "/workspace:/workspace:rw",
        "/var/wolf/claude-templates/.claude:/seed/.claude:ro",  // see below
    },
    NetworkMode: "wolf-egress",   // egress-only network with allowlist
}
cfg := &container.Config{
    Image: "wolf-sandbox:" + imageTag,
    Env: []string{
        "CLAUDE_CODE_OAUTH_TOKEN=" + oauthToken,
        "CLAUDE_CONFIG_DIR=/run/claude/" + sid,    // per-container dir
        "WOLF_API_BASE=http://orchestrator:8092",  // for wolf CLI callbacks
        "WOLF_SESSION_JWT=" + scopedJWT,           // 24h scoped {session_id, scope:"agent"}
    },
    Labels: map[string]string{
        "wolf.orchestrator": "true",
        "wolf.session_id":   sid,
        "wolf.hypothesis_id": hypID,
    },
}
```

**Bind-mount vs. env-only.** In 2026 the cleaner pattern is **env-only `CLAUDE_CODE_OAUTH_TOKEN` + per-container `CLAUDE_CONFIG_DIR`** (no bind-mount of the host's `~/.claude/`). The seed-and-copy pattern (read-only `/seed/.claude` cloned into the writable `CLAUDE_CONFIG_DIR` at entrypoint) lets each container start from a known-good config (settings.json, allowedTools defaults, MCP wiring) without sharing mutable state across sessions and without risking the host's credentials file. ([Multi-account guide](https://medium.com/@buwanekasumanasekara/setting-up-multiple-claude-code-accounts-on-your-local-machine-f8769a36d1b1), [parallel-sessions guide](https://www.codeagentswarm.com/en/guides/run-multiple-claude-code-sessions)). The OAuth env var is sufficient for *authentication*; the config dir is needed for *settings/skills/MCP* and for avoiding the kernel-panic-class concurrency bug at [issue #45880](https://github.com/anthropics/claude-code/issues/45880).

**Concurrency.** `CLAUDE_CONFIG_DIR` per container is **still the recommendation**, doubly important now because that issue documents `N×M` MCP-process explosion when sessions share a config dir. Cap concurrent sandboxes at e.g. 8 (Max 5x) or 20 (Max 20x) — well below the kernel-panic threshold of 15 sessions × 34 MCP servers.

**Workspace artifacts.** Each session gets `/workspace`, a host-bind-mounted dir. The `wolf` Go CLI (baked into the sandbox, mirroring Platinum's `pt`) does the extraction at session-end:

- `wolf evidence put --hypothesis-id=H --kind=research-note <file>` → POST to `/api/v1/agent/evidence` with the scoped JWT. Body lands in **Postgres** (`agent_artifacts.content_bytea` + `content_tsv` GIN index, mirroring Platinum's `agent_messages` pattern). This is the right answer for the v1 single-VM Docker Compose deploy — Postgres LOB is fine for ≤10 MB artifacts and zero new infrastructure. **Defer S3/MinIO** until artifacts get large (charts, datasets), then switch to a content-addressed-storage column (`content_sha256` + `s3_key`).
- For the on-cluster K8s future: MinIO sidecar with the same callback signature; `wolf` only needs the env-var swap.

---

## 4. Web-search wiring

**Native tools first.** Claude Code's `WebSearch` and `WebFetch` are billed against the Max session budget — not as separate API credit — when authenticated via `CLAUDE_CODE_OAUTH_TOKEN` ([Mikhail Shilkov's deep dive](https://mikhail.io/2025/10/claude-code-web-tools/), [Claude Code WebSearch tool docs](https://www.developersdigest.tech/guides/websearch-tool)). Both work out of the box with `--allowedTools "WebSearch,WebFetch,..."`. There are intermittent rate-limit issues on subscription-auth WebSearch ([issue #27074](https://github.com/anthropics/claude-code/issues/27074)) but they recover within minutes.

**Recommendation:** wire WebSearch + WebFetch as the default research tools and skip a third-party search API for v1. This means **zero incremental Anthropic spend** *and* **zero new vendor**.

**Fallback shim** for when the native search rate-limits or for evidence requiring a permanent provenance pin (Tavily's `published_date` field is more reliable than WebFetch's at-query-time scraping). Wire **Tavily** as the default fallback (1k searches/mo free, LLM-tuned snippets, [Tavily/LangChain integration](https://websearchapi.ai/blog/tavily-alternatives), [Exa vs Tavily](https://exa.ai/versus/tavily)). Bash-callable script in the sandbox:

```bash
#!/usr/bin/env bash
# /opt/skills/web-search-fallback.sh — invoked by Claude via Bash when WebSearch is rate-limited
# usage: web-search-fallback.sh "query"
set -euo pipefail
curl -sS https://api.tavily.com/search \
  -H "Content-Type: application/json" \
  -d "{\"api_key\":\"${TAVILY_API_KEY}\",\"query\":$(jq -Rn --arg q "$1" '$q'),\"max_results\":8,\"include_answer\":true}" \
  | jq '{answer, results: [.results[] | {title,url,content,published_date,score}]}'
```

The orchestrator injects `TAVILY_API_KEY` only into containers running for hypotheses where the user explicitly opted into the fallback (cheaper than always-on; preserves the 1k/mo Tavily quota for real escalations).

---

## 5. Worker-queue triggering

River 0.23 has first-class periodic jobs ([periodic jobs docs](https://riverqueue.com/docs/periodic-jobs), [unique jobs docs](https://riverqueue.com/docs/unique-jobs)) and that's the canonical home for the daily tick.

```go
// pkg/jobqueue/periodic.go
periodicJobs := []*river.PeriodicJob{
    river.NewPeriodicJob(
        river.PeriodicInterval(24*time.Hour),
        func() (river.JobArgs, *river.InsertOpts) {
            return DailyTickScanArgs{}, &river.InsertOpts{
                Queue: "scheduler",
                UniqueOpts: river.UniqueOpts{
                    ByPeriod: 24 * time.Hour,
                    ByArgs:   true,
                },
            }
        },
        &river.PeriodicJobOpts{RunOnStart: false},
    ),
}
client, _ := river.NewClient(riverpgxv5.New(pool), &river.Config{
    Queues:       map[string]river.QueueConfig{"scheduler": {MaxWorkers: 1}, "tick": {MaxWorkers: 8}},
    PeriodicJobs: periodicJobs,
    Workers:      workers,
})
```

The cron-shaped scanner job:

```go
// DailyTickScanWorker scans hypotheses due for a tick and fans out tick jobs.
func (w *DailyTickScanWorker) Work(ctx context.Context, j *river.Job[DailyTickScanArgs]) error {
    rows, err := w.store.HypothesesDueForTick(ctx, time.Now().UTC())
    if err != nil { return err }
    for _, h := range rows {
        _, err := w.client.Insert(ctx, TickArgs{HypothesisID: h.ID, ScheduledFor: h.DueAt}, &river.InsertOpts{
            Queue: "tick",
            UniqueOpts: river.UniqueOpts{
                ByArgs:   true,                  // dedupe by (hypothesis_id, scheduled_for)
                ByPeriod: 23 * time.Hour,        // accidental double-fire window
                ByState:  []rivertype.JobState{rivertype.JobStateAvailable, rivertype.JobStateRunning, rivertype.JobStateRetryable, rivertype.JobStateScheduled},
            },
        })
        if err != nil { /* log + continue */ }
    }
    return nil
}
```

The tick worker:

```go
func (w *TickWorker) Work(ctx context.Context, j *river.Job[TickArgs]) error {
    // 1. Idempotency: insert tick_run row with UNIQUE(hypothesis_id, scheduled_for); skip if exists.
    runID, fresh, err := w.store.CreateOrFindTickRun(ctx, j.Args.HypothesisID, j.Args.ScheduledFor)
    if err != nil { return err }
    if !fresh && w.store.TickRunCompleted(ctx, runID) { return nil }  // already done

    // 2. Spawn or reuse a sandbox.
    sb, err := w.sandboxes.AcquireForHypothesis(ctx, j.Args.HypothesisID)
    if err != nil { return err }
    defer sb.MarkIdle()

    // 3. Run the tick prompt; capture stream-json events; let the wolf CLI write evidence rows.
    runner := sb.Runner(w.oauthToken)
    err = runner.RunPrompt(ctx, w.workflows.RenderTickPrompt(j.Args.HypothesisID),
        []string{"WebSearch","WebFetch","Bash","Read"},
        func(ev ClaudeEvent) { w.captureMessage(runID, ev) })
    if err != nil {
        w.store.MarkTickRunFailed(ctx, runID, err.Error())
        return err
    }

    // 4. Update next due_at from the hypothesis cadence.
    return w.store.AdvanceHypothesisSchedule(ctx, j.Args.HypothesisID)
}
```

**Idempotency layers:**
1. River's `UniqueOpts{ByArgs, ByPeriod}` keeps duplicates out of the queue.
2. The `tick_runs` table has `UNIQUE(hypothesis_id, scheduled_for)` — so even if a worker retries after a partial failure, it finds the existing run and resumes/short-circuits.
3. Each `agent_messages` insert keys on `(tick_run_id, sequence_no)` — so re-runs append idempotently.
4. The `wolf evidence put` callback uses the sandbox's scoped JWT plus an `Idempotency-Key` header (UUID-v7 per evidence batch) — server dedupes on `(session_id, idempotency_key)`.

**Restart safety:** River persists jobs in Postgres; a worker SIGKILL leaves the job in `running` state until the heartbeat times out, at which point River retries. The tick-run row makes the *side effect* idempotent, not just the queue insert.

---

## 6. Spec-generation interview flow

Mirror Platinum's `pkg/workflows/registry.go` and `prompts/system/*.md` shape. The `WorkflowDefinition`/`NodeDefinition` types with `SystemPrompt`, `Tools`, `MaxTurns`, **`SummaryPrompt`** are perfect for the hypothesis-bot interview — they give exactly the "phase advance with history reset and a one-line bridge" shape the spec-gen flow needs.

```go
// goapi/pkg/workflows/registry.go (excerpt)
var hypothesisSpecGen = WorkflowDefinition{
    ID:          "hypothesis_spec_gen",
    Name:        "Hypothesis spec generation",
    Description: "Three-phase interactive interview that turns a loose thesis into a finalized JSON spec.",
    Nodes: []NodeDefinition{
        {
            ID:           "research",
            Name:         "Deep research",
            Type:         "agent",
            SystemPrompt: buildPrompt("agent-research", phaseResearchPrompt), // resolves {{skill:web-research}}
            Tools:        []string{"WebSearch","WebFetch","Bash","Read","Write"},
            MaxTurns:     20,
            SummaryPrompt: "Summarize the strongest 5-7 evidence items, the apparent edge, and 2-3 risks. " +
                          "End with: 'Ready to refine the spec — what cadence, what asset universe, and what early-kill criteria do you have in mind?'",
        },
        {
            ID:           "interview",
            Name:         "Spec interview",
            Type:         "agent",
            SystemPrompt: buildPrompt("agent-interview", phaseInterviewPrompt),
            Tools:        []string{"Read","Write"},  // no web; just refine
            MaxTurns:     15,
            SummaryPrompt: "Confirm the user's final answers for: cadence, asset universe, signals, kill criteria, " +
                          "evaluation horizon. Then say: 'Finalizing the spec.'",
        },
        {
            ID:           "finalize",
            Name:         "Finalize spec",
            Type:         "agent",
            SystemPrompt: buildPrompt("agent-finalize", phaseFinalizePrompt),
            Tools:        []string{"Bash"},  // just calls `wolf hypothesis finalize`
            MaxTurns:     3,
        },
    },
    Edges: []Edge{
        {From: "research", To: "interview"},
        {From: "interview", To: "finalize"},
    },
    Assistant: true,
}
```

Template substitution `{{persona}} {{user}} {{hypothesis_id}} {{results.research}}` works the same way — `buildPrompt` resolves `{{skill:web-research}}`, `{{skill:hypothesis-grammar}}`, etc. against the embedded skills map. History reset on phase advance is handled by the orchestrator: `phase-orchestrator.ts`-equivalent in Go drops the conversation, re-renders the next phase's `SystemPrompt` with results from prior phases, and starts a fresh `claude -p` invocation.

For a Go-only port, keep the workflow file co-located: `goapi/pkg/workflows/hypothesis.go` with `//go:embed prompts/hypothesis/research.md` etc. Don't switch to YAML — Platinum's experience is that Go-typed workflows give compile-time safety on `Tools` and `Edges`.

---

## 7. AUP posture for paper-only trusted-team scope

Brief 07-active flagged the active-trading-bot scope as **AUP-tense**. Re-evaluating for hypothesis-bot's announced scope (paper-only, no live trades, 3-5 trusted team users, in-app only, not a public product):

**Materially less risky? Yes.** Three concrete reasons:

1. **No third-party harness.** hypothesis-bot drives the *unmodified upstream `claude` binary* via `os/exec`. No spoofed headers, no rebuilt Bun binary, no cryptographic-attestation evasion. The April 2026 policy (one human / one subscription / one beneficiary) targets harnesses that *redistribute* tokens to non-subscribers ([andrew.ooo guide](https://andrew.ooo/answers/claude-subscriptions-third-party-tools-april-2026/)). 3-5 trusted teammates each running the app on the *single subscription owner's* token is on the borderline — see below.
2. **No live capital, no public product.** brief 07-active's worst case (account suspension while live capital is at risk) goes away. A paper-only hypothesis tracker that gets throttled is a Tuesday afternoon problem, not a financial incident.
3. **Routines is a blessed pattern.** Anthropic explicitly shipped Routines for "scheduled overnight runs" against the same usage budget. Even if hypothesis-bot eventually exceeds 15 routines/day and falls back to River-driven invocations, the *pattern* (scheduled, prompt-templated, persists results) is now first-party-supported.

**Remaining risk: the trusted-team detail.** Strict reading of "one human, one subscription, one beneficiary" says even sharing an in-house tool with 3-5 teammates on one Max plan is a violation. Mitigations, in increasing order of cleanliness:

- (Cheapest) **Each user brings their own Max token.** The app stores per-user `CLAUDE_CODE_OAUTH_TOKEN` and the orchestrator picks the token of the user who triggered the action. For *user-initiated* spec-gen runs this is unambiguously compliant. For *daily ticks*, charge the tick to the hypothesis owner's token (each hypothesis has a creator_user_id).
- (Cleanest) **Switch the daily tick to first-party Routines** for the first 15 active hypotheses. Routines runs explicitly count against the owner's plan, on Anthropic's infra, with their blessing.
- (Belt and suspenders) **Human-in-the-loop confirmation step** for tick jobs that produce evidence with `confidence_delta > threshold`. Push to in-app notification; require a tap to "accept evidence" before it lands in the score. This sidesteps the "fully autonomous" framing entirely.

---

## 8. Recommended architecture

```
                                                ┌──────────────────────────┐
   Browser (React 18 + Vite + MUI v6)           │  Anthropic               │
       │                                        │  - Claude Code CLI infra  │
       │   SSE for chat + activity              │  - Routines API           │
       ▼                                        └──────────▲────────────────┘
   Caddy reverse proxy                                     │ HTTPS w/
       │                                                   │ CLAUDE_CODE_OAUTH_TOKEN
       ▼                                                   │
   GoAPI :8091  (Fiber v3 + Cobra)                         │
   ├── auth: Firebase Admin SDK token verify               │
   ├── HTTP: hypotheses, evidence, score, agent SSE        │
   ├── SSE: 100-event buffer for reconnect replay          │
   ├── store: pgx v5 + GORM + goqu (Postgres + pgvector +  │
   │          TimescaleDB, all on one PG instance)          │
   ├── jobqueue: River 0.23 (periodic + tick + extract)    │
   └── orchestrator (in-process, *not* a separate service):│
       ├── sandbox lifecycle (Go + Docker SDK)             │
       ├── per-session Docker container w/ wolf.* labels   │
       ├── 5-min suspend / 24-hr destroy reaper            │
       ├── scoped JWT minter (HS256, 24h, scope:"agent")   │
       └── workflow engine (phase orchestrator + history   │
           reset, mirroring Platinum's TS code in Go)      │
                                                           │
   GoWorker container (River workers)                       │
   ├── DailyTickScanWorker (06:00 UTC, periodic)            │
   ├── TickWorker (per hypothesis)                          │
   ├── EvidenceExtractWorker (artifact→storage)             │
   └── shares the same orchestrator package                 │
                                                           │
   ────── Per-session Docker container ──────────────────  │
   wolf-sandbox image (512 MB / 1 CPU / pids 256):          │
   ├── claude (pinned v2.1.99, official binary)             │
   ├── wolf Go CLI (Bash-callable; replaces 20+ MCP tools)  │
   ├── Python 3 + pandas/numpy/matplotlib (for evidence     │
   │   notebooks if Bash/Python phase ever lands)            │
   ├── /workspace (host bind-mount, rw)                     │
   ├── /run/claude/<sid> (CLAUDE_CONFIG_DIR, seeded ro      │
   │   from /seed/.claude at entrypoint then writable)       │
   └── env: CLAUDE_CODE_OAUTH_TOKEN, WOLF_API_BASE,         │
            WOLF_SESSION_JWT, optional TAVILY_API_KEY       │
```

**What goes away from Platinum's design:**
- API-key proxy (`:3080`). The Claude Agent SDK needed an Anthropic-shim proxy so the sandbox never held real keys; with `CLAUDE_CODE_OAUTH_TOKEN` injected as an env var, the OAuth token *is* the credential and the sandbox already needs it. **Simpler.**
- Separate Fastify orchestrator service. With Go available everywhere and the Docker SDK well-supported, fold the orchestrator into goapi as a package (`pkg/sandbox` + `pkg/workflows`). One less language, one less service, same architecture.

**What stays:**
- Per-session container lifecycle (suspend/destroy/labels for restart recovery).
- Scoped JWT for sandbox→GoAPI callbacks (24h, claims `{user, hypothesis_id, session_id, scope:"agent"}`).
- SSE event taxonomy (`message_start`, `tool_use_start`, `activity_update`, `ask_user`, `artifact_registered`, …) with 100-event buffer.
- `pt`-style baked-in Go CLI (`wolf`) — Claude Code natively supports `Bash`, so the same trick (one CLI, many subcommands, low prompt overhead) works. ~68% prompt-tokens saved per Platinum's measurement; same gain expected.
- Phase orchestrator with `SummaryPrompt`, `MaxTurns`, history reset on phase advance.
- Workflow registry in Go with `//go:embed` prompts and `{{skill:name}}` resolution.

**What's new:**
- `WebSearch`/`WebFetch` as default Claude Code tools (no separate vendor for v1).
- River periodic `DailyTickScanWorker` + `TickWorker` (no precedent in Platinum — Platinum's jobs are user-triggered).
- `tick_runs` table + `Idempotency-Key` discipline on the `wolf evidence put` callback.
- Per-user OAuth token on the user record (cleanest AUP path) — `users.claude_oauth_token_encrypted` column, AES-GCM-sealed with a service-level key.
- Optional Routines escape hatch for the first 15 active hypotheses: the orchestrator can register a Routine per hypothesis instead of a River tick, charging to the user's plan.

---

## Verdict

**Yes — for trusted-team paper-only scope in 2026, hypothesis-bot's LLM brain can run on Claude Code CLI + Max, at $0 incremental Anthropic spend, provided three rules hold:**

1. **Don't spoof the client.** Drive the unmodified upstream `claude` binary via `os/exec` with `CLAUDE_CODE_OAUTH_TOKEN`. Never call internal endpoints from custom code, never re-implement the wire protocol, never strip the `NATIVE_CLIENT_ATTESTATION` header.
2. **Charge tokens to the user who benefits.** Each hypothesis owner brings their own Max token; the orchestrator picks the right token per request. This sidesteps the "one human, one subscription" rule cleanly. (For ≤15 active hypotheses total, prefer first-party Routines and skip the per-user-token machinery entirely.)
3. **Stay paper-only and stay in-app.** No live trades, no public product, no token re-distribution. If any of these change, revisit AUP — the active-trading-bot brief still applies and you'll likely need to budget for per-token API.

The architecture is a clean port of Platinum: replace the Claude Agent SDK + Azure Foundry shim with `claude -p --output-format stream-json`, fold the orchestrator into goapi (Go everywhere), keep everything else (lifecycle, SSE, scoped JWTs, phase orchestrator, `wolf` baked-in CLI). The new pieces (River periodic ticks, idempotent tick-run rows, native WebSearch wiring) are small and well-scoped.

The one binding constraint is the **March/April 2026 rate-limit tightening + token-inflation regression**: pin `claude` to v2.1.99 inside the sandbox, schedule daily ticks at 06:00 UTC (outside the 5-11 AM PT throttling window), and instrument the orchestrator to surface session-budget metrics so a regression-class issue is caught at the dashboard, not at the hypothesis level.

---

## Sources

- [Claude Code authentication docs](https://code.claude.com/docs/en/authentication)
- [Claude Code headless docs](https://code.claude.com/docs/en/headless)
- [Anthropic usage-policy update](https://www.anthropic.com/news/updating-our-usage-policy)
- [TechCrunch: Claude Code subscribers must pay extra for OpenClaw (Apr 4 2026)](https://techcrunch.com/2026/04/04/anthropic-says-claude-code-subscribers-will-need-to-pay-extra-for-openclaw-support/)
- [VentureBeat: Anthropic cracks down on third-party harnesses](https://venturebeat.com/technology/anthropic-cracks-down-on-unauthorized-claude-usage-by-third-party-harnesses)
- [Andrew.ooo: Claude subscriptions-third-party-tools (Apr 2026)](https://andrew.ooo/answers/claude-subscriptions-third-party-tools-april-2026/)
- [Claude Code source-leak analysis (cryptographic attestation)](https://alex000kim.com/posts/2026-03-31-claude-code-source-leak/)
- [Claude Code Routines docs](https://code.claude.com/docs/en/web-scheduled-tasks)
- [Anthropic blog: introducing routines in Claude Code](https://claude.com/blog/introducing-routines-in-claude-code)
- [SitePoint: Claude Code rate limits 2026](https://www.sitepoint.com/claude-code-rate-limits-explained/)
- [GitHub: Max plan session limits exhausted abnormally fast (#38335)](https://github.com/anthropics/claude-code/issues/38335)
- [GitHub: --bare skips OAuth/keychain (#39069)](https://github.com/anthropics/claude-code/issues/39069)
- [GitHub: --bare preserve OAuth feature request (#38022)](https://github.com/anthropics/claude-code/issues/38022)
- [GitHub: --input-format stream-json undocumented (#24594)](https://github.com/anthropics/claude-code/issues/24594)
- [GitHub: concurrent sessions × MCP processes kernel panic (#45880)](https://github.com/anthropics/claude-code/issues/45880)
- [GitHub: WebSearch rate limit on subscription auth (#27074)](https://github.com/anthropics/claude-code/issues/27074)
- [Background Claude: stream-json deep dive](https://backgroundclaude.com/blog/stream-json)
- [Mikhail Shilkov: Claude Code web tools](https://mikhail.io/2025/10/claude-code-web-tools/)
- [Code Agent Swarm: parallel Claude Code sessions](https://www.codeagentswarm.com/en/guides/run-multiple-claude-code-sessions)
- [Multi-account guide (CLAUDE_CONFIG_DIR)](https://medium.com/@buwanekasumanasekara/setting-up-multiple-claude-code-accounts-on-your-local-machine-f8769a36d1b1)
- [River queue: periodic jobs](https://riverqueue.com/docs/periodic-jobs)
- [River queue: unique jobs](https://riverqueue.com/docs/unique-jobs)
- [Tavily vs Exa vs Brave (2026)](https://websearchapi.ai/blog/tavily-alternatives)
- [Exa vs Tavily comparison](https://exa.ai/versus/tavily)
