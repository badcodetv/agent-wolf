# Claude Code as a Long-Running Autonomous Agent — Infrastructure Brief

**This is the most consequential brief in the set. The user's plan to use the Anthropic Max subscription via the Claude Code CLI as the LLM brain of a 24/7 autonomous trading agent runs into real problems. Read this before committing to architecture.**

## Verdict: Partially Viable with Significant Caveats

Based on official Anthropic documentation, Claude Code CLI + Max subscription + long-running Docker agents is **technically possible but architecturally misaligned with product design intent**.

---

## 1. Authentication for Headless Docker

**The Core Issue: No Long-Lived Credential Export.**

Claude Code authentication for Max plans works via OAuth to subscription accounts ([authentication docs](https://code.claude.com/docs/en/authentication.md)).

- **Storage**: Credentials stored in `~/.claude/.credentials.json` (encrypted on macOS Keychain, plaintext mode 0600 on Linux/Windows)
- **Renewal**: OAuth tokens require browser-based login initially via `claude` command
- **Docker-mountable**: Yes — you can read-only bind-mount `~/.claude/` into containers
- **Long-lived token option**: `claude setup-token` generates a **1-year OAuth token** ([docs](https://code.claude.com/docs/en/authentication.md#generate-a-long-lived-token)) exported as `CLAUDE_CODE_OAUTH_TOKEN` environment variable

**Critical Gap**: While `claude setup-token` generates a long-lived token, the documentation explicitly states:
> "This token authenticates with your Claude subscription and requires a Pro, Max, Team, or Enterprise plan. It is scoped to inference only and cannot establish Remote Control sessions."

This works for Docker. However:
- Token is still OAuth-based (not a permanent credential)
- Expiry handling unclear (1-year window means manual renewal annually)
- Not designed for 24/7 autonomous operation

**Agent SDK Authentication**: The Agent SDK (TypeScript/Python) requires **direct API key authentication** ([SDK overview](https://code.claude.com/docs/en/agent-sdk/overview.md)):
> "Get an API key from the Console, then set it as an environment variable: `export ANTHROPIC_API_KEY=your-api-key`"

**This is the per-token API key the user explicitly wants to avoid.** The SDK does not support Max-plan OAuth directly — it requires Console API keys, which are billed per-token.

---

## 2. Headless Invocation Modes

Claude Code supports non-interactive operation via:

**CLI with `-p` (print) flag**:
```bash
claude -p "prompt" --output-format json --allowedTools "Read,Edit,Bash"
```

**Bare mode** (`--bare` flag):
- Skips hooks, skills, plugins, MCP server discovery
- Intended for CI/scripted repeatability
- **Requires explicit auth**: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` environment variable
- **Cannot use `--bare` with Max plan OAuth** — bare mode skips OAuth credential reads ([headless docs](https://code.claude.com/docs/en/headless.md#start-faster-with-bare-mode))

**Result**: To run `claude` headless in Docker with Max subscription, you cannot use `--bare`. You must:
1. Mount `~/.claude/` with credentials
2. Omit `--bare`
3. Accept full context loading (hooks, skills, MCP servers, CLAUDE.md)

This adds startup latency and complexity for what you want to be deterministic.

---

## 3. Rate Limits & Acceptable Use Policy

**Information Gap**: Anthropic's public documentation does **not publish Max plan rate limits** for headless usage (attempted fetch of platform.claude.com rate-limits endpoint returned 404). Per Anthropic's status page and historical public statements:

- **Claude API (per-token)**: Clear rate limits published (tokens/min, requests/min)
- **Max plan (subscription)**: Limits exist but are opaque; customer-tier-specific and not publicly disclosed

**Autonomous Trading Agent AUP Risk**: Both [authentication docs](https://code.claude.com/docs/en/authentication.md) and [agent-sdk overview](https://code.claude.com/docs/en/agent-sdk/overview.md) include this critical note:

> "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."

**Interpretation**: Using Claude Code / Agent SDK as a **fully autonomous trading agent** (no human-in-the-loop) likely violates terms. Anthropic's full acceptable use policy would need to be consulted, but the note suggests:
- Automated agents must be pre-approved
- Max plan is a consumer/professional subscription, not designed for 24/7 autonomous production systems
- Risk: Account suspension for violating terms

---

## 4. Hooks & Safety Gating

Claude Code supports PreToolUse/PostToolUse hooks ([hooks guide](https://code.claude.com/docs/en/hooks-guide.md), [Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/overview.md)). You can gate trade execution:

```python
async def validate_trade(input_data, tool_use_id, context):
    if "dangerous_trade" in str(input_data):
        return {"blocked": True}
    return {}
```

**But**: Hooks are best-effort safety mechanisms, not guaranteed blockers. For production trading, this is insufficient as the *primary* safety layer — you need a separate process-isolated risk engine (see brief #6).

---

## 5. Docker Patterns

**Mounting credentials**:
```bash
docker run -v ~/.claude:/root/.claude:ro my-agent:latest
```

**Persistent session state**: Claude Code sessions are stored in `~/.claude/` and `~/.claude/storage/`. Bind-mount both to preserve context across container restarts.

**Multi-instance concurrency**: Possible but risks session conflicts. Recommend separate `CLAUDE_CONFIG_DIR` per container instance via environment variable.

---

## 6. Critical Gaps & Missing Prior Art

Extensive search of Claude Code docs reveals:

- **No examples of 24/7 autonomous agents** in published documentation
- **No guidance on production deployment** beyond CI/CD (GitHub Actions, GitLab CI)
- **No published case studies** of `claude` or Agent SDK used as a daemon/service
- Agent SDK examples are prototype-grade (bug fixes, code review) not production trading systems

This strongly suggests the design is **not intended for this use case**.

---

## Architectural Verdict

### If you proceed with Claude Code CLI + Max:

1. **Use `claude setup-token` + `CLAUDE_CODE_OAUTH_TOKEN`** to authenticate in Docker
2. **Run in non-bare mode** (accept slower startup; mount `~/.claude/`)
3. **Implement your own approval layer** (hooks are insufficient — process-isolated risk engine)
4. **Contact Anthropic for AUP pre-approval** before deploying autonomous trading. **Do this before building.**
5. **Monitor for token expiry** (1-year lifecycle; no auto-renewal documented)
6. **Plan rate-limit strategy** (limits not published; risk of surprise throttling)
7. **Consider `/loop` or Routines API** for scheduling instead of custom long-running daemon

### Alternatives (if user constraints will accept them):

**Option A — Claude Agent SDK + API keys** (violates "no per-token API")
- Designed for production
- Clear rate limits
- Long-lived API keys
- Per-token billing rather than subscription

**Option B — Claude for Teams + dedicated infrastructure**
- Includes SDK
- Centralized billing (still subscription-flavored)
- SSO/compliance

**Option C — Bedrock / Vertex AI with Claude**
- Use Claude Opus / Sonnet via AWS Bedrock or GCP Vertex
- Reserved capacity or on-demand pricing
- Bedrock/Vertex manage credentials and scaling

**Option D — Hybrid**
- Use Claude Code locally (under Max) for *interactive design and signal research*
- Use a separate, smaller-scope deterministic execution service for live trading
- Trade hypotheses generated by Claude Code; execution by a non-LLM service

---

## Recommendation

**Do not put a Claude Code CLI process at the center of a fully autonomous 24/7 production trading loop without first contacting Anthropic for AUP clarification.**

For agent-wolf specifically:
1. **Phase 1 (build / paper):** Claude Code CLI on Max is fine. Build the agent as a process the user invokes; let it run hypothesis loops in shadow mode while a human is at the keyboard part of the time. This is normal Claude Code usage.
2. **Phase 2 (extended unattended paper):** Get explicit AUP clarification from Anthropic in writing before running an unattended `claude` daemon for days at a time. Until you have that, prefer `/loop`-style scheduled invocations the user has explicitly enrolled, which fall under normal subscription usage patterns.
3. **Phase 3 (live capital):** If Anthropic does not bless 24/7 autonomous Max usage, accept the per-token API constraint as a cost of doing business — Opus 4.7 token cost per hypothesis is small relative to capital deployed, and the safety/legal posture is much cleaner. Alternatively go Bedrock/Vertex for subscription-shaped pricing.

The user's exact constraint ("no per-token API key, only Max") is in tension with Anthropic's product positioning of *autonomous* agents. Surface this to the user *before* writing code; it changes the architecture.

---

## Key Sources
- [Claude Code authentication](https://code.claude.com/docs/en/authentication.md)
- [Claude Code headless mode](https://code.claude.com/docs/en/headless.md)
- [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview.md)
- [Hooks guide](https://code.claude.com/docs/en/hooks-guide.md)
- [Claude Code overview](https://code.claude.com/docs/en/overview.md)
