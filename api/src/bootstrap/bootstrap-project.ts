/**
 * The idempotent `wolf` project bootstrap (W12).
 *
 * design/2026-08-20-agent-wolf.md, ticket W12: this module creates EXACTLY
 * four atoms in the `wolf` Bob project, and a second run against an
 * already-bootstrapped project must issue no create/PUT call at all:
 *
 *   1. Project settings: `base_image`, `attention_channel` (explicitly
 *      empty), `mcp_config` (the `wolf` MCP server entry).
 *   2. Worker `interviewer`, prompt = prompts/interviewer.md verbatim,
 *      enabled.
 *   3. Worker `critic`, prompt = prompts/critic.md verbatim, enabled.
 *   4. One worker-mode schedule for `critic`.
 *
 * Per-hypothesis atoms (researcher workers, per-hypothesis schedules,
 * datasets) are W9's, at go-live, and never appear here.
 *
 * **Idempotency.** Project settings, worker and schedule state are all read
 * back through `BobClient` before any write — `getProjectSettings`,
 * `getWorker`, `listSchedules` — exactly as the ticket's Depends-on note
 * requires. Worker reads used to be the one exception: W2's route list was
 * exhaustive and closed at 22 routes and had no `GET /agent/workers/{name}`
 * (only `PUT` and `DELETE` were wrapped), even though Bob's HTTP API
 * serves that route (`go/httpapi/workers.go:77`). This module worked around
 * it with a narrowly-scoped raw `fetch`. W2b (owner ruling R91) added
 * `client.getWorker(name)` as the client's twenty-third route — the raw
 * fetch is gone and this module now goes through `BobClient` exclusively,
 * with a 404 from `getWorker` (kind `not_found`) read as "does not exist
 * yet".
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, type Logger } from "../logger.js";
import { WolfError } from "../errors.js";
import { createBobClient, type BobClient } from "../bob/client.js";
import type { ProjectSettings, PutProjectSettingsParams } from "../bob/types.js";
import { loadConfig } from "../config.js";

export const WOLF_MCP_HEADER_NAME = "X-Wolf-Mcp-Token";
// The bare, whole-value ${VAR} reference — never "Bearer ${WOLF_MCP_TOKEN}".
// go/agentdb/sessions.go's envRefPattern (^\$\{[A-Za-z_][A-Za-z0-9_]*\}$)
// accepts only exactly this form; anything else fails MCPServerConfig.Validate
// and the bootstrap's PUT to /agent/project-settings would 4xx.
export const WOLF_MCP_TOKEN_REF = "${WOLF_MCP_TOKEN}";

export type WriteOutcome = "unchanged" | "created" | "updated";

export interface BootstrapProjectResult {
  projectSettings: "unchanged" | "updated";
  interviewer: WriteOutcome;
  critic: WriteOutcome;
  criticSchedule: "unchanged" | "created";
}

export interface BootstrapProjectOptions {
  /** Bob's base URL, from wolf-api's own vantage point (shares DinD's netns: `http://localhost:8099` in the compose stack). */
  baseUrl: string;
  /** The `wolf` project's API key (`WOLF_API_KEY`). */
  apiKey: string;
  /** The resolved MCP URL to write into the project's `mcp_config` — W1's boot-resolved `config.mcpUrl`, never re-derived here. */
  wolfMcpUrl: string;
  /** `WOLF_BASE_IMAGE` (already defaulted by `loadConfig`). */
  wolfBaseImage: string;
  /** `WOLF_CRITIC_CRON` (already defaulted and shape-validated by `loadConfig`). */
  criticCron: string;
  /** `prompts/interviewer.md`, read verbatim. */
  interviewerPrompt: string;
  /** `prompts/critic.md`, read verbatim. */
  criticPrompt: string;
  logger?: Logger;
  /** Injectable so a test can assert `client.ts` is what performs every read and write, without constructing its own. Defaults to `createBobClient({ baseUrl, apiKey })`. */
  client?: BobClient;
}

/**
 * Reads one worker's current `systemPrompt` and `enabled` fields via
 * `client.getWorker`, or `undefined` if it does not exist yet (a `not_found`
 * `WolfError` — the expected first-run answer, not an outage). Any other
 * `WolfError` kind (e.g. `unavailable`) propagates, since the bootstrap has
 * no basis for treating a live upstream failure as "worker absent".
 */
async function readWorker(
  client: BobClient,
  name: string,
): Promise<{ systemPrompt: string; enabled: boolean } | undefined> {
  try {
    const worker = await client.getWorker(name);
    return { systemPrompt: worker.systemPrompt, enabled: worker.enabled };
  } catch (err) {
    if (err instanceof WolfError && err.kind === "not_found") return undefined;
    throw err;
  }
}

/** Structural equality for the plain JSON objects this module compares (`mcp_config`, `attention_channel`). No cycles, no `Map`/`Set` — this only ever sees data that round-tripped through Bob's JSON wire format. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

function desiredMcpConfig(wolfMcpUrl: string): Record<string, unknown> {
  return {
    wolf: {
      url: wolfMcpUrl,
      headers: { [WOLF_MCP_HEADER_NAME]: WOLF_MCP_TOKEN_REF },
    },
  };
}

/**
 * Read-merge-write against `GET`/`PUT /agent/project-settings`. `PUT` is a
 * whole-object replace (`go/agentdb/project_settings.go:136-160`), so every
 * field the caller does not intend to change is copied from `current`
 * verbatim — a bare PUT of only the three fields this ticket cares about
 * would silently clear `system_prompt` and every other setting.
 */
async function ensureProjectSettings(
  client: BobClient,
  wolfBaseImage: string,
  mcpConfig: Record<string, unknown>,
): Promise<"unchanged" | "updated"> {
  const current: ProjectSettings = await client.getProjectSettings();

  // `attention_channel` is DELIBERATELY EMPTY, and must stay that way. Do not
  // "fix" this by inventing a URL.
  //
  // Bob's only channel kind is an OUTBOUND WEBHOOK: `{"kind": "webhook",
  // "url": "https://…"}`, POSTed to by agentd when a worker calls
  // `request_human_attention` (go/cmd/agentd/attention.go:57-103 — it requires
  // an http(s) URL and rejects anything else). Wolf exposes no such receiver:
  // its API (api/src/app.ts) mounts no inbound webhook route, and adding one
  // would be an unauthenticated write surface pointed at the board.
  //
  // Wolf's notification surface is the board itself: W10's poller reads
  // `GET /agent/attention-requests` on its own tick and moves the hypothesis to
  // `challenged`. Pull, not push — so there is nothing here to configure, and a
  // non-empty value would make agentd POST at a URL that does not exist.
  const attentionChannel: Record<string, unknown> = {};
  const alreadyCorrect =
    current.baseImage === wolfBaseImage &&
    deepEqual(current.attentionChannel, attentionChannel) &&
    deepEqual(current.mcpConfig, mcpConfig);

  if (alreadyCorrect) return "unchanged";

  const next: PutProjectSettingsParams = {
    baseImage: wolfBaseImage,
    systemPrompt: current.systemPrompt,
    mcpConfig,
    attentionChannel,
    maxConcurrentJobs: current.maxConcurrentJobs,
    dailyTokensSoft: current.dailyTokensSoft,
    dailyTokensHard: current.dailyTokensHard,
    briefingMaxBytes: current.briefingMaxBytes,
    snapshotTtlDays: current.snapshotTtlDays,
    rationale:
      "wolf bootstrap: base_image / attention_channel / mcp_config for the wolf MCP server " +
      "(design/2026-08-20-agent-wolf.md, W12)",
  };
  await client.putProjectSettings(next);
  return "updated";
}

async function ensureWorker(
  client: BobClient,
  name: string,
  systemPrompt: string,
): Promise<WriteOutcome> {
  const existing = await readWorker(client, name);
  if (existing && existing.systemPrompt === systemPrompt && existing.enabled === true) {
    return "unchanged";
  }
  await client.putWorker(name, {
    systemPrompt,
    enabled: true,
    rationale: `wolf bootstrap: ${existing ? "correct" : "create"} the ${name} worker's prompt (design/2026-08-20-agent-wolf.md, W12)`,
  });
  return existing ? "updated" : "created";
}

async function ensureCriticSchedule(
  client: BobClient,
  criticCron: string,
): Promise<"unchanged" | "created"> {
  const schedules = await client.listSchedules();
  const existing = schedules.find((s) => s.worker === "critic");
  if (existing) return "unchanged";

  await client.createSchedule({
    worker: "critic",
    cron: criticCron,
    rationale: "wolf bootstrap: weekly critic run over per-hypothesis researcher prompts (design/2026-08-20-agent-wolf.md, W12)",
  });
  return "created";
}

/**
 * Runs the bootstrap. Every write is preceded by a read that determines
 * whether the write is actually needed — see this module's header comment.
 * A second call against an already-bootstrapped project issues only reads.
 */
export async function bootstrapProject(
  options: BootstrapProjectOptions,
): Promise<BootstrapProjectResult> {
  const client = options.client ?? createBobClient({ baseUrl: options.baseUrl, apiKey: options.apiKey });
  const logger = options.logger;

  const mcpConfig = desiredMcpConfig(options.wolfMcpUrl);

  const projectSettings = await ensureProjectSettings(client, options.wolfBaseImage, mcpConfig);
  logger?.info({ result: projectSettings }, "wolf bootstrap: project settings");

  const interviewer = await ensureWorker(client, "interviewer", options.interviewerPrompt);
  logger?.info({ result: interviewer }, "wolf bootstrap: interviewer worker");

  const critic = await ensureWorker(client, "critic", options.criticPrompt);
  logger?.info({ result: critic }, "wolf bootstrap: critic worker");

  const criticSchedule = await ensureCriticSchedule(client, options.criticCron);
  logger?.info({ result: criticSchedule }, "wolf bootstrap: critic schedule");

  return { projectSettings, interviewer, critic, criticSchedule };
}

// ── The env/file-reading entrypoint, for scripts/bootstrap-project.ts ────
//
// Everything above this line is pure(ish) and dependency-injected, and is
// what bootstrap-project.test.ts exercises. This function is the one place
// that touches process.env and the filesystem, so scripts/bootstrap-project.ts
// can stay a two-line wrapper.
//
// `BOB_BASE_URL` and `WOLF_API_KEY` are read directly from process.env
// here, NOT through api/src/config.ts's `WolfConfig`. This ticket's Files
// line restricts config.ts to two variables (`WOLF_BASE_IMAGE`,
// `WOLF_CRITIC_CRON`) — the file-ownership table serialises config.ts
// across many tickets, and adding a Bob base URL / API key pair to its
// typed schema is not this ticket's to make. `WOLF_MCP_URL` and
// `WOLF_BASE_IMAGE`/`WOLF_CRITIC_CRON` DO come from `loadConfig()`, since
// they already live there (the first was W1's, the latter two are this
// ticket's own addition just above).

const DEFAULT_BOB_BASE_URL = "http://localhost:8099";

function readPromptFile(relativePathFromRepoRoot: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // api/src/bootstrap -> api/src -> api -> repo root
  const repoRoot = join(here, "..", "..", "..");
  return readFileSync(join(repoRoot, relativePathFromRepoRoot), "utf8");
}

/**
 * Reads `WOLF_API_KEY`, `BOB_BASE_URL` and (via `loadConfig()`)
 * `WOLF_MCP_URL`/`WOLF_BASE_IMAGE`/`WOLF_CRITIC_CRON` from `process.env`,
 * the four prompt files from disk, and runs `bootstrapProject`. This is
 * what `scripts/bootstrap-project.ts` calls; it is not itself unit-tested
 * (`bootstrap-project.test.ts` drives `bootstrapProject` directly with
 * injected options) — see the ticket's TDD note: "no for … the loader
 * script", which this thin env/file-reading shell is grouped with.
 */
export async function runBootstrapFromEnv(): Promise<BootstrapProjectResult> {
  const apiKey = process.env.WOLF_API_KEY;
  if (!apiKey) {
    throw WolfError.misconfigured(
      "WOLF_API_KEY",
      "WOLF_API_KEY must be set to run the wolf project bootstrap " +
        "(the same project API key wolf-api itself uses to call Bob)",
    );
  }
  const baseUrl = process.env.BOB_BASE_URL?.trim() || DEFAULT_BOB_BASE_URL;

  const config = loadConfig();
  const logger = createLogger(config);

  const interviewerPrompt = readPromptFile(join("prompts", "interviewer.md"));
  const criticPrompt = readPromptFile(join("prompts", "critic.md"));

  const result = await bootstrapProject({
    baseUrl,
    apiKey,
    wolfMcpUrl: config.mcpUrl,
    wolfBaseImage: config.wolfBaseImage,
    criticCron: config.criticCron,
    interviewerPrompt,
    criticPrompt,
    logger,
  });

  logger.info({ result }, "wolf bootstrap: complete");
  return result;
}
