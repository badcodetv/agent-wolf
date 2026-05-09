# Claude Code CLI Orchestration for hypothesis-bot

> Companion to `03-platinum-stack-survey.md`. Where the Platinum survey said "swap the inner LLM SDK," this brief specifies *exactly how*. **Updated 2026-05-09 with the KISS pass — see [`09-kiss-architecture-decision.md`](09-kiss-architecture-decision.md). The old per-session-sandbox + scoped-JWT-callback architecture is removed.** What remains: the operator's Claude Code CLI exec'd directly from the goworker container, parsed at the end-of-run.

## TL;DR

Run hypothesis-bot's LLM brain on Claude Code CLI authenticated via a single operator's `CLAUDE_CODE_OAUTH_TOKEN` (1-year `claude setup-token` issuance). The token lives as an env var on the **goworker** container; the goworker exec's the unmodified upstream `claude` binary as a subprocess via `os/exec`, captures `--output-format json`, and writes the parsed result directly to Postgres. No per-session sandbox container, no callback JWT, no SSE, no orchestrator service. Daily ticks fire from River's periodic-job machinery at 06:00 UTC and are bounded by `--allowedTools "WebSearch,WebFetch,Read"` plus a read-only-root container with a tmpfs `/workspace`. **Verdict at the bottom.**

---

## 1. Authentication in 2026

`claude setup-token` produces a 1-year `CLAUDE_CODE_OAUTH_TOKEN` and is the supported headless-container path under Pro/Max. Token output is `{accessToken, refreshToken, expiresAt}`; the env var is the access token. Confirmed working with Claude Code v2.0.10+ ([Authentication docs](https://code.claude.com/docs/en/authentication), [Recovery walkthrough](https://dev.to/anicca_301094325e/how-to-recover-claude-code-oauth-token-in-30-seconds-1hd)).

**What changed in 2026:**

1. **April 4, 2026 usage-policy update.** Anthropic now explicitly disallows using Pro/Max subscriptions to power *third-party agentic tools* — the rule of thumb circulating is "**one human, one subscription, one beneficiary**" ([Anthropic update](https://www.anthropic.com/news/updating-our-usage-policy), [TechCrunch](https://techcrunch.com/2026/04/04/anthropic-says-claude-code-subscribers-will-need-to-pay-extra-for-openclaw-support/), [VentureBeat](https://venturebeat.com/technology/anthropic-cuts-off-the-ability-to-use-claude-subscriptions-with-openclaw-and)). The policy targets *harnesses that re-sell or re-distribute* Claude tokens to third parties (OpenClaw, OpenCode) and tools that **spoof the official client** to bypass per-token billing. **See §6 below for our single-operator interpretation.**
2. **Cryptographic client attestation.** Claude Code now ships with a compile-time `NATIVE_CLIENT_ATTESTATION` flag — the binary signs requests so the server can distinguish official clients from rebuilt forks ([Claude Code source-leak analysis](https://alex000kim.com/posts/2026-03-31-claude-code-source-leak/), [VentureBeat coverage](https://venturebeat.com/technology/anthropic-cracks-down-on-unauthorized-claude-usage-by-third-party-harnesses)). **Practical implication:** ship the unmodified upstream `claude` binary inside the goworker. Do not call internal endpoints from Go code. Driving the official binary via `os/exec` with a Max OAuth token is the supported, attested path.
3. **Peak-hour throttling.** As of March 28, 2026, Max plans throttle weekdays 5-11 AM Pacific ([SitePoint rate-limits explainer](https://www.sitepoint.com/claude-code-rate-limits-explained/), [Northflank](https://northflank.com/blog/claude-rate-limits-claude-code-pricing-cost)). Schedule daily ticks **outside** that window (06:00 UTC = 23:00 PT prior day = safe).
4. **Token-inflation regression.** Claude Code v2.1.100+ silently inflates token consumption ~40%; v2.1.126 (May 1) did not fix it ([GitHub issue 38335](https://github.com/anthropics/claude-code/issues/38335)). Pin to a known-good version inside the goworker image and re-test on bumps.
5. **Routines API (April 14, 2026).** Anthropic shipped first-party scheduled-run support: `/schedule` from the CLI, or `claude.ai/code/routines`. Max gets **15 routines/day** ([Routines docs](https://code.claude.com/docs/en/web-scheduled-tasks), [introducing-routines blog](https://claude.com/blog/introducing-routines-in-claude-code)). For ≤15 hypotheses, **prefer Routines over a custom scheduler**; for more, fall back to River-driven `claude -p` invocations from the goworker.

---

## 2. Headless invocation from Go

Canonical `os/exec` wrapper. **`--output-format json` is the right choice for our case** — we don't need streaming UI, just the final result ([headless docs](https://code.claude.com/docs/en/headless), [stream-json deep dive](https://backgroundclaude.com/blog/stream-json)). `--output-format stream-json` is the alternative if we ever want PostToolUse hook output to land mid-flight (see §4).

```go
// pkg/claude/runner.go
type Args struct {
    Prompt       string
    AllowedTools []string
    OutputFormat string  // "json" (default) or "stream-json"
    MaxTurns     int
    JobID        string  // for CLAUDE_CONFIG_DIR isolation
}

type FinalResult struct {
    Type    string          `json:"type"`     // "result"
    Subtype string          `json:"subtype"`  // "success" | "error_max_turns" | …
    Result  json.RawMessage `json:"result"`   // the model's final structured output
    Usage   struct {
        InputTokens  int `json:"input_tokens"`
        OutputTokens int `json:"output_tokens"`
    } `json:"usage"`
}

func (r *Runner) RunPrompt(ctx context.Context, a Args) (*FinalResult, error) {
    args := []string{
        "-p", a.Prompt,
        "--output-format", "json",
        "--allowedTools", strings.Join(a.AllowedTools, ","),
        "--max-turns", strconv.Itoa(a.MaxTurns),
        "--setting-source", "project",
    }
    cmd := exec.CommandContext(ctx, "claude", args...)
    cmd.Env = append(os.Environ(),
        "CLAUDE_CODE_OAUTH_TOKEN="+r.oauthToken,                 // operator's token
        "CLAUDE_CONFIG_DIR=/tmp/wolf-"+a.JobID,                  // per-job isolation
    )
    out, err := cmd.Output()
    if err != nil {
        return nil, fmt.Errorf("claude exit: %w; stderr=%s", err, cmd.Stderr)
    }
    var fr FinalResult
    if err := json.Unmarshal(out, &fr); err != nil {
        return nil, fmt.Errorf("parse claude json: %w; raw=%s", err, out)
    }
    return &fr, nil
}
```

Key points:
- `exec.CommandContext` propagates timeout/cancel; the worker's job context just cancels.
- `--output-format json` returns one JSON object at the end — much simpler to parse than `stream-json`. Use it unless we need mid-flight events.
- Exit codes: 0 success, 1 generic error, 2 auth error, 137 OOM, ~`SIGTERM` from context cancellation. River's retry policy handles 1/137; 2 should page (operator token expired).
- `--allowedTools` is the safety perimeter. Default for hypothesis-bot tick: `WebSearch,WebFetch,Read`. **No `Bash`, no `Write`, no `Edit`** — the LLM can read its working directory and the open web; it cannot mutate the filesystem or shell out. If we later need notebook-style analysis we add `Bash` with a wrapped allowlist script.
- `CLAUDE_CONFIG_DIR=/tmp/wolf-${JobID}` per invocation prevents the kernel-panic-class concurrency bug at [issue #45880](https://github.com/anthropics/claude-code/issues/45880) when multiple ticks run in parallel. `defer os.RemoveAll(...)` cleans up.
- **Bare mode.** `--bare` skips OAuth/keychain reads and is incompatible with `CLAUDE_CODE_OAUTH_TOKEN`. Don't use it. ([issue #39069](https://github.com/anthropics/claude-code/issues/39069))

---

## 3. Goworker container shape

```dockerfile
# goworker.Dockerfile
FROM node:22-bookworm-slim
RUN npm install -g @anthropic-ai/claude-code@2.1.99   # pin pre-inflation regression
RUN apt-get update && apt-get install -y python3 python3-pip jq curl ca-certificates
COPY goworker /usr/local/bin/goworker
COPY prompts/ /opt/prompts/
COPY scripts/ /opt/scripts/
ENTRYPOINT ["/usr/local/bin/goworker"]
```

Compose snippet:

```yaml
# docker-compose.yml (excerpt)
services:
  goworker:
    image: hypothesis-bot/goworker:latest
    read_only: true
    tmpfs:
      - /tmp:size=512M
      - /workspace:size=512M
    environment:
      DATABASE_URL: ${DATABASE_URL}
      CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN}   # operator's only
      OPENAI_API_KEY: ${OPENAI_API_KEY}                      # for embeddings
    cap_drop: [ALL]
    deploy:
      resources:
        limits: { cpus: "2.0", memory: 2G }
```

**Concurrency.** Cap concurrent ticks at 4 via River's `MaxWorkers`. Each gets its own `CLAUDE_CONFIG_DIR`. Well below kernel-panic threshold and well below Max's session budget at 06:00 UTC.

**Workspace.** `/workspace` is tmpfs; if we adopt the PostToolUse-hook evidence pattern (§4), the hook writes to `/workspace/${JobID}/evidence.jsonl` and Go reads it after exit. Files vanish on container restart, which is the correct semantics for ephemeral run state.

**No bind-mount of host's `~/.claude`.** Each job's `CLAUDE_CONFIG_DIR` is a fresh tmpfs dir. Settings/skills/MCP wiring (if we ever add MCP) live under `/opt/prompts/.claude/` baked into the image and cloned into the per-job dir at job start.

---

## 4. Web-search wiring

**Native tools first.** Claude Code's `WebSearch` and `WebFetch` are billed against the Max session budget — not as separate API credit — when authenticated via `CLAUDE_CODE_OAUTH_TOKEN` ([Mikhail Shilkov's deep dive](https://mikhail.io/2025/10/claude-code-web-tools/), [Claude Code WebSearch tool docs](https://www.developersdigest.tech/guides/websearch-tool)). Both work out of the box with `--allowedTools "WebSearch,WebFetch,..."`. There are intermittent rate-limit issues on subscription-auth WebSearch ([issue #27074](https://github.com/anthropics/claude-code/issues/27074)) but they recover within minutes.

**Recommendation:** wire `WebSearch` + `WebFetch` as the default research tools and skip a third-party search API for v1. Zero incremental Anthropic spend, zero new vendor.

**Optional fallback shim.** If we want a permanent provenance pin (Tavily's `published_date` is more reliable than WebFetch's at-query-time scraping) or want to handle WebSearch rate-limits gracefully, expose a `web_search_tavily.sh` script in `/opt/scripts/` and add `Bash` to `--allowedTools` for that hypothesis. Defer until we hit the limit.

**Mid-flight evidence via PostToolUse hook (optional, v1.1).** If we want evidence to land in the DB as the LLM finds it (rather than in a single batch at the end), use a Claude Code `PostToolUse` hook configured in `/opt/prompts/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "WebFetch|WebSearch",
      "hooks": [{ "type": "command",
                  "command": "/opt/scripts/log-evidence.sh ${TOOL_OUTPUT_PATH}" }]
    }]
  }
}
```

The hook writes one JSON line per tool result to `/workspace/${JobID}/evidence.jsonl`. Goworker reads the file when the subprocess exits. **For v1 we skip this** and just parse the final result JSON; it's simpler.

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
    Queues: map[string]river.QueueConfig{
        "scheduler": {MaxWorkers: 1},
        "tick":      {MaxWorkers: 4},  // concurrency cap
        "specgen":   {MaxWorkers: 2},
    },
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
                ByArgs:   true,
                ByPeriod: 23 * time.Hour,
                ByState:  []rivertype.JobState{rivertype.JobStateAvailable, rivertype.JobStateRunning, rivertype.JobStateRetryable, rivertype.JobStateScheduled},
            },
        })
        if err != nil { /* log + continue */ }
    }
    return nil
}
```

The tick worker — note how short it is without sandbox lifecycle:

```go
func (w *TickWorker) Work(ctx context.Context, j *river.Job[TickArgs]) error {
    // 1. Idempotency: insert tick_run row with UNIQUE(hypothesis_id, scheduled_for); skip if done.
    runID, fresh, err := w.store.CreateOrFindTickRun(ctx, j.Args.HypothesisID, j.Args.ScheduledFor)
    if err != nil { return err }
    if !fresh && w.store.TickRunCompleted(ctx, runID) { return nil }

    // 2. Render the prompt for this hypothesis.
    h, _ := w.store.GetHypothesis(ctx, j.Args.HypothesisID)
    prompt := w.prompts.Render("tick.md", map[string]any{"hypothesis": h, "since": h.LastTickAt})

    // 3. Exec claude. No sandbox container; this runs in the goworker process.
    res, err := w.claude.RunPrompt(ctx, claude.Args{
        Prompt:       prompt,
        AllowedTools: []string{"WebSearch", "WebFetch", "Read"},
        OutputFormat: "json",
        MaxTurns:     10,
        JobID:        runID.String(),
    })
    if err != nil {
        w.store.MarkTickRunFailed(ctx, runID, err.Error())
        return err
    }

    // 4. Parse the structured result, embed evidence, run the Bayesian update.
    var tick TickResult
    if err := json.Unmarshal(res.Result, &tick); err != nil { return err }
    if err := w.processTick(ctx, h, runID, &tick); err != nil { return err }

    // 5. Update next due_at.
    return w.store.AdvanceHypothesisSchedule(ctx, j.Args.HypothesisID)
}
```

**Idempotency layers:**
1. River's `UniqueOpts{ByArgs, ByPeriod}` keeps duplicates out of the queue.
2. `tick_runs` has `UNIQUE(hypothesis_id, scheduled_for)` — re-runs short-circuit.
3. `evidence_items` has `UNIQUE(source, source_id)` — re-runs upsert idempotently.

**Restart safety:** River persists jobs in Postgres; a SIGKILL leaves the job in `running` until the heartbeat times out, at which point River retries. The tick-run row makes the *side effect* idempotent.

---

## 6. AUP posture for single-operator paper-only scope

Re-evaluating for hypothesis-bot's announced scope (paper-only, no live trades, 3-5 trusted-team users with **a single subscription owner running the LLM**, in-app only, not a public product):

**Materially less risky than the active-trading-bot design? Yes.** Three concrete reasons:

1. **One human consuming Claude.** The operator is the only person whose actions cause `claude -p` to run. Other teammates can draft hypotheses (text + form fields, no LLM) and read results (markdown reports, score timelines, evidence rows). Reading a report is not "consuming an agent session" any more than reading a Claude-drafted blog post is. The April 2026 "one human, one subscription, one beneficiary" rule was framed against *third-party agentic harnesses* that re-distribute Claude tokens to non-subscribers driving live agent sessions ([andrew.ooo guide](https://andrew.ooo/answers/claude-subscriptions-third-party-tools-april-2026/)). The single-operator model is plainly outside that fact pattern.
2. **No spoofed client.** hypothesis-bot drives the *unmodified upstream `claude` binary* via `os/exec`. No rebuilt Bun binary, no cryptographic-attestation evasion, no internal endpoints called from Go.
3. **No live capital, no public product.** A paper-only hypothesis tracker that gets throttled is a Tuesday afternoon problem, not a financial incident.

**Caveat: this is our reading.** If Anthropic clarifies the AUP to cover derivative-output sharing (e.g. "any read of LLM-generated content by a non-subscriber counts as beneficiary status"), we revisit — likely by gating teammate read-access behind individual subscriptions, or by adopting Anthropic's Routines feature explicitly under the operator's account.

**Operational mitigations that make the framing tighter:**

- Operator-only `Run spec-generation` and `Run tick now` actions in the UI; gated by `users.role='operator'` server-side.
- All `claude -p` invocations log the operator's user_id in `tick_runs.triggered_by_user_id` for audit.
- Daily ticks are timer-driven (River cron) and attribute to the operator; teammates cannot synthesize a tick out-of-band.

---

## 7. Recommended architecture

```
   Browser (React 18 + Vite + MUI v6)
       │
       │  Polling for job status (no SSE)
       ▼
   GoAPI :8091  (Fiber v3 + Cobra)
   ├── auth: Supabase JWT verify (HS256, ~30 LOC)
   ├── HTTP: hypotheses, evidence, scores, drafts
   ├── store: pgx v5 + GORM + goqu (Postgres + pgvector +
   │          TimescaleDB, all on one Supabase instance)
   └── jobqueue: River 0.23 (periodic + tick + specgen)

   GoWorker container (River workers + claude binary)
   ├── DailyTickScanWorker (06:00 UTC, periodic)
   ├── TickWorker (per hypothesis, max 4 parallel)
   │   └── exec claude -p ... --output-format json
   ├── SpecGenWorker / SpecFinalizeWorker (operator-triggered)
   │   └── exec claude -p ... --output-format json
   ├── EvidenceEmbedWorker (OpenAI embeddings)
   ├── ENV: CLAUDE_CODE_OAUTH_TOKEN (operator's)
   ├── Image: claude@2.1.99 + Python 3 + jq
   └── Hardening: read_only root, tmpfs /workspace + /tmp,
                  cap_drop ALL
```

**What goes away vs. Platinum's design:**
- API-key proxy (`:3080`) — `CLAUDE_CODE_OAUTH_TOKEN` is the credential; the goworker holds it directly.
- Separate Fastify orchestrator service — collapsed into goworker.
- Per-session sandbox containers spawned by Docker SDK — a single goworker container runs the binary; per-job isolation is `CLAUDE_CONFIG_DIR=/tmp/wolf-${JobID}`.
- Sandbox lifecycle (suspend/destroy/labels) — no per-session sandbox to manage.
- Scoped HS256 JWT for sandbox→GoAPI callbacks — no callbacks (the worker writes to its own DB).
- `wolf` Go CLI baked into a sandbox image — no callbacks means no callback CLI.
- SSE event taxonomy + 100-event reconnect buffer — frontend polls.
- Phase orchestrator with history reset — each `claude -p` is a fresh process.

**What stays:**
- River queue + Postgres-backed periodic jobs.
- Workflow-as-rendered-prompt pattern: prompts in `goapi/pkg/workflows/prompts/*.md` rendered with `text/template`. Just no DAG executor.
- `pt`-style admin Cobra subcommands (`goapi admin set-role <email>`, `goapi admin set-operator <email>`).
- Multi-stage Dockerfile + Docker Compose.

**What's new:**
- `--allowedTools` allowlist as the primary safety perimeter (no Bash by default).
- `tick_runs` table + idempotency discipline.
- Single `CLAUDE_CODE_OAUTH_TOKEN` env var on goworker (not per-user).
- Optional Routines escape hatch for the first 15 active hypotheses.

---

## Verdict

**Yes — for trusted-team paper-only scope in 2026 with a single operator, hypothesis-bot's LLM brain runs on Claude Code CLI + Max at $0 incremental Anthropic spend, provided three rules hold:**

1. **Don't spoof the client.** Drive the unmodified upstream `claude` binary via `os/exec` with `CLAUDE_CODE_OAUTH_TOKEN`. Never call internal endpoints from custom code, never re-implement the wire protocol.
2. **One operator triggers all LLM runs.** Teammates draft + view; the operator runs spec-gen and the daily tick is timer-driven against the operator's token. Reports the teammates view are derivative output, not agent sessions.
3. **Stay paper-only and stay in-app.** No live trades, no public product, no token re-distribution. If any of these change, revisit AUP.

The architecture is a lean port of Platinum: replace the Claude Agent SDK + Azure Foundry shim with `claude -p --output-format json`, fold the orchestrator + sandbox lifecycle into "the goworker exec's the binary," keep River + the migration system + the workflow-as-prompt pattern. The deleted pieces (sandbox containers, scoped JWT callbacks, SSE buffer, phase orchestrator, `wolf` CLI) all served real Platinum needs that hypothesis-bot doesn't have at v1 scale.

The binding operational constraints are the **March/April 2026 rate-limit tightening + token-inflation regression**: pin `claude` to v2.1.99 inside the goworker, schedule daily ticks at 06:00 UTC (outside the 5-11 AM PT throttling window), and instrument the worker to surface session-budget metrics so a regression-class issue is caught at the dashboard, not at the hypothesis level.

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
- [GitHub: concurrent sessions × MCP processes kernel panic (#45880)](https://github.com/anthropics/claude-code/issues/45880)
- [GitHub: WebSearch rate limit on subscription auth (#27074)](https://github.com/anthropics/claude-code/issues/27074)
- [Background Claude: stream-json deep dive](https://backgroundclaude.com/blog/stream-json)
- [Mikhail Shilkov: Claude Code web tools](https://mikhail.io/2025/10/claude-code-web-tools/)
- [River queue: periodic jobs](https://riverqueue.com/docs/periodic-jobs)
- [River queue: unique jobs](https://riverqueue.com/docs/unique-jobs)
