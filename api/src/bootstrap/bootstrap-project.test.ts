import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MockAgent,
  setGlobalDispatcher,
  getGlobalDispatcher,
  type Dispatcher,
  type Interceptable,
} from "undici";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrapProject,
  WOLF_MCP_HEADER_NAME,
  WOLF_MCP_TOKEN_REF,
  type BootstrapProjectOptions,
} from "./bootstrap-project.js";

// design/2026-08-20-agent-wolf.md, tickets W12 and W2b. Every test drives
// bootstrapProject through undici's MockAgent (§ "Pinned technology
// choices": no live network in any unit test) exactly the way
// src/orange/client.test.ts drives createOrangeClient — bootstrapProject
// uses that same client internally for every read and write, including
// `GET /agent/workers/{name}` via `client.getWorker` (W2b's twenty-third
// route; the raw `fetch` workaround documented in earlier revisions of
// bootstrap-project.ts is gone).

const BASE_URL = "http://orange.test:8099";
const API_KEY = "wolf-bootstrap-test-key";
const WOLF_MCP_URL = "http://172.17.0.1:8100/mcp";
const WOLF_BASE_IMAGE = "agent-wolf:dev";
const CRITIC_CRON = "0 4 * * 1";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
function prompt(name: string): string {
  return readFileSync(join(repoRoot, "prompts", name), "utf8");
}
// W2b: the raw `fetch` this module used to make for GET /agent/workers/{name}
// is gone — every Orange call now goes through OrangeClient.
describe("bootstrap-project.ts contains no raw fetch( call (W2b)", () => {
  it("its source has no fetch( call", () => {
    const src = readFileSync(join(here, "bootstrap-project.ts"), "utf8");
    expect(src.includes("fetch(")).toBe(false);
  });
});

const INTERVIEWER_PROMPT = prompt("interviewer.md");
const CRITIC_PROMPT = prompt("critic.md");
const RESEARCHER_PREAMBLE = prompt("researcher-preamble.md");
const RESEARCHER_METHOD = prompt("researcher-method.md");

let mockAgent: MockAgent;
let pool: Interceptable;
let originalDispatcher: Dispatcher;
let calls: { method: string; path: string; body?: string }[];

beforeEach(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  pool = mockAgent.get(BASE_URL);
  calls = [];
});

afterEach(async () => {
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
});

/** Registers a one-shot reply and records the call (method, path, body) once it fires. */
function intercept(method: string, path: string, status: number, data: unknown): void {
  pool.intercept({ method, path }).reply((opts) => {
    const body = typeof opts.body === "string" ? opts.body : undefined;
    calls.push({ method, path, body });
    return { statusCode: status, data: data as never };
  });
}

function bodyOf(method: string, path: string): Record<string, unknown> {
  const call = calls.find((c) => c.method === method && c.path === path);
  if (!call?.body) throw new Error(`no captured body for ${method} ${path}`);
  return JSON.parse(call.body) as Record<string, unknown>;
}

function writeCalls(): { method: string; path: string }[] {
  return calls
    .filter((c) => c.method === "PUT" || c.method === "POST")
    .map((c) => ({ method: c.method, path: c.path }));
}

function options(overrides: Partial<BootstrapProjectOptions> = {}): BootstrapProjectOptions {
  return {
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    wolfMcpUrl: WOLF_MCP_URL,
    wolfBaseImage: WOLF_BASE_IMAGE,
    criticCron: CRITIC_CRON,
    interviewerPrompt: INTERVIEWER_PROMPT,
    criticPrompt: CRITIC_PROMPT,
    ...overrides,
  };
}

function projectSettingsBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: "wolf",
    base_image: "",
    system_prompt: "a pre-existing, unrelated system prompt that must survive",
    mcp_config: {},
    attention_channel: {},
    max_concurrent_jobs: 5,
    daily_tokens_soft: 100000,
    daily_tokens_hard: 200000,
    briefing_max_bytes: 8192,
    snapshot_ttl_days: 30,
    updated_at: 1700000000,
    ...overrides,
  };
}

const DESIRED_MCP_CONFIG = {
  wolf: { url: WOLF_MCP_URL, headers: { [WOLF_MCP_HEADER_NAME]: WOLF_MCP_TOKEN_REF } },
};

function workerBody(systemPrompt: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: "wolf",
    name: "x",
    description: "",
    system_prompt: systemPrompt,
    mcp_config: {},
    image: "",
    max_instances: 1,
    enabled: true,
    frozen: false,
    created_at: 1700000000,
    updated_at: 1700000000,
    ...overrides,
  };
}

/** Registers the full "fresh project" read+write sequence and returns nothing — callers just call bootstrapProject afterwards. */
function mockFreshProject(): void {
  intercept("GET", "/agent/project-settings", 200, projectSettingsBody());
  intercept("PUT", "/agent/project-settings", 200, projectSettingsBody({
    base_image: WOLF_BASE_IMAGE,
    mcp_config: DESIRED_MCP_CONFIG,
    attention_channel: {},
    updated_at: 1700000001,
  }));
  intercept("GET", "/agent/workers/interviewer", 404, { error: "worker not found" });
  intercept("PUT", "/agent/workers/interviewer", 200, workerBody(INTERVIEWER_PROMPT, { name: "interviewer" }));
  intercept("GET", "/agent/workers/critic", 404, { error: "worker not found" });
  intercept("PUT", "/agent/workers/critic", 200, workerBody(CRITIC_PROMPT, { name: "critic" }));
  intercept("GET", "/agent/schedules", 200, { schedules: [] });
  intercept("POST", "/agent/schedules", 201, {
    id: "sch-1",
    project: "wolf",
    worker: "critic",
    cron: CRITIC_CRON,
    input: "",
    enabled: true,
    created_at: 1700000000,
    updated_at: 1700000000,
  });
}

describe("bootstrapProject — fresh project", () => {
  it("creates exactly the four pinned atoms and reports each as created/updated", async () => {
    mockFreshProject();
    const result = await bootstrapProject(options());
    expect(result).toEqual({
      projectSettings: "updated",
      interviewer: "created",
      critic: "created",
      criticSchedule: "created",
    });
  });

  it("writes base_image, and the wolf mcp_config entry with the resolved URL and bare token reference", async () => {
    mockFreshProject();
    await bootstrapProject(options());
    const body = bodyOf("PUT", "/agent/project-settings");
    expect(body.base_image).toBe(WOLF_BASE_IMAGE);
    expect(body.mcp_config).toEqual(DESIRED_MCP_CONFIG);
  });

  it("writes attention_channel as explicitly empty ({})", async () => {
    mockFreshProject();
    await bootstrapProject(options());
    const body = bodyOf("PUT", "/agent/project-settings");
    expect(body.attention_channel).toEqual({});
  });

  it("the mcp_config header value is a whole-value ${VAR} reference — Orange's envRefPattern, no Bearer prefix, no partial interpolation", async () => {
    mockFreshProject();
    await bootstrapProject(options());
    const body = bodyOf("PUT", "/agent/project-settings");
    const mcpConfig = body.mcp_config as { wolf: { headers: Record<string, string> } };
    const headerValue = mcpConfig.wolf.headers[WOLF_MCP_HEADER_NAME];
    expect(headerValue).toBe("${WOLF_MCP_TOKEN}");
    // go/agentdb/sessions.go's envRefPattern.
    expect(headerValue).toMatch(/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/);
    expect(headerValue).not.toContain("Bearer");
  });

  it("read-merge-write: a pre-existing unrelated field (system_prompt) survives the PUT", async () => {
    mockFreshProject();
    await bootstrapProject(options());
    const body = bodyOf("PUT", "/agent/project-settings");
    expect(body.system_prompt).toBe("a pre-existing, unrelated system prompt that must survive");
  });

  it("read-merge-write: every other numeric field also survives untouched", async () => {
    mockFreshProject();
    await bootstrapProject(options());
    const body = bodyOf("PUT", "/agent/project-settings");
    expect(body.max_concurrent_jobs).toBe(5);
    expect(body.daily_tokens_soft).toBe(100000);
    expect(body.daily_tokens_hard).toBe(200000);
    expect(body.briefing_max_bytes).toBe(8192);
    expect(body.snapshot_ttl_days).toBe(30);
  });

  it("writes the interviewer worker's prompt verbatim from prompts/interviewer.md, enabled", async () => {
    mockFreshProject();
    await bootstrapProject(options());
    const body = bodyOf("PUT", "/agent/workers/interviewer");
    expect(body.system_prompt).toBe(INTERVIEWER_PROMPT);
    expect(body.enabled).toBe(true);
  });

  it("writes the critic worker's prompt verbatim from prompts/critic.md, enabled", async () => {
    mockFreshProject();
    await bootstrapProject(options());
    const body = bodyOf("PUT", "/agent/workers/critic");
    expect(body.system_prompt).toBe(CRITIC_PROMPT);
    expect(body.enabled).toBe(true);
  });

  it("creates a worker-mode schedule for critic with the default 5-field cron", async () => {
    mockFreshProject();
    await bootstrapProject(options());
    const body = bodyOf("POST", "/agent/schedules");
    expect(body.worker).toBe("critic");
    expect(body.cron).toBe("0 4 * * 1");
  });

  it("honours an overridden WOLF_CRITIC_CRON", async () => {
    intercept("GET", "/agent/project-settings", 200, projectSettingsBody({
      base_image: WOLF_BASE_IMAGE,
      mcp_config: DESIRED_MCP_CONFIG,
      attention_channel: {},
    }));
    intercept("GET", "/agent/workers/interviewer", 200, workerBody(INTERVIEWER_PROMPT));
    intercept("GET", "/agent/workers/critic", 200, workerBody(CRITIC_PROMPT));
    intercept("GET", "/agent/schedules", 200, { schedules: [] });
    intercept("POST", "/agent/schedules", 201, {
      id: "sch-1",
      project: "wolf",
      worker: "critic",
      cron: "30 5 * * 3",
      input: "",
      enabled: true,
    });
    await bootstrapProject(options({ criticCron: "30 5 * * 3" }));
    expect(bodyOf("POST", "/agent/schedules").cron).toBe("30 5 * * 3");
  });

  it("does not create a per-hypothesis atom of any kind", async () => {
    mockFreshProject();
    await bootstrapProject(options());
    // The only worker/schedule paths hit are the two project-level workers
    // and the one critic schedule — nothing named after a hypothesis id.
    for (const c of calls) {
      expect(c.path).not.toMatch(/researcher-/);
    }
  });
});

describe("bootstrapProject — idempotency (a second run is a true no-op)", () => {
  it("issues zero create/PUT calls when everything already matches", async () => {
    // Round 1: bootstrap a fresh project.
    mockFreshProject();
    await bootstrapProject(options());
    calls = [];

    // Round 2: only GET interceptors are registered — no PUT or POST at
    // all. If bootstrapProject attempted one, undici would reject the
    // unmatched dispatch and the awaited call would throw.
    intercept("GET", "/agent/project-settings", 200, projectSettingsBody({
      base_image: WOLF_BASE_IMAGE,
      mcp_config: DESIRED_MCP_CONFIG,
      attention_channel: {},
    }));
    intercept("GET", "/agent/workers/interviewer", 200, workerBody(INTERVIEWER_PROMPT));
    intercept("GET", "/agent/workers/critic", 200, workerBody(CRITIC_PROMPT));
    intercept("GET", "/agent/schedules", 200, {
      schedules: [
        {
          id: "sch-1",
          project: "wolf",
          worker: "critic",
          cron: CRITIC_CRON,
          input: "",
          enabled: true,
          created_at: 1700000000,
          updated_at: 1700000000,
        },
      ],
    });

    const result = await bootstrapProject(options());

    expect(result).toEqual({
      projectSettings: "unchanged",
      interviewer: "unchanged",
      critic: "unchanged",
      criticSchedule: "unchanged",
    });
    expect(writeCalls()).toEqual([]);
  });
});

describe("bootstrapProject — updates an existing, drifted worker", () => {
  it("PUTs the interviewer worker when its stored prompt does not match prompts/interviewer.md, and reports 'updated'", async () => {
    intercept("GET", "/agent/project-settings", 200, projectSettingsBody({
      base_image: WOLF_BASE_IMAGE,
      mcp_config: DESIRED_MCP_CONFIG,
      attention_channel: {},
    }));
    intercept("GET", "/agent/workers/interviewer", 200, workerBody("an old, stale prompt"));
    intercept("PUT", "/agent/workers/interviewer", 200, workerBody(INTERVIEWER_PROMPT, { name: "interviewer" }));
    intercept("GET", "/agent/workers/critic", 200, workerBody(CRITIC_PROMPT));
    intercept("GET", "/agent/schedules", 200, {
      schedules: [{ id: "sch-1", project: "wolf", worker: "critic", cron: CRITIC_CRON, input: "", enabled: true }],
    });

    const result = await bootstrapProject(options());
    expect(result.interviewer).toBe("updated");
    expect(bodyOf("PUT", "/agent/workers/interviewer").system_prompt).toBe(INTERVIEWER_PROMPT);
  });

  it("PUTs a worker that exists but is disabled, and reports 'updated'", async () => {
    intercept("GET", "/agent/project-settings", 200, projectSettingsBody({
      base_image: WOLF_BASE_IMAGE,
      mcp_config: DESIRED_MCP_CONFIG,
      attention_channel: {},
    }));
    intercept("GET", "/agent/workers/interviewer", 200, workerBody(INTERVIEWER_PROMPT, { enabled: false }));
    intercept("PUT", "/agent/workers/interviewer", 200, workerBody(INTERVIEWER_PROMPT, { name: "interviewer" }));
    intercept("GET", "/agent/workers/critic", 200, workerBody(CRITIC_PROMPT));
    intercept("GET", "/agent/schedules", 200, {
      schedules: [{ id: "sch-1", project: "wolf", worker: "critic", cron: CRITIC_CRON, input: "", enabled: true }],
    });

    const result = await bootstrapProject(options());
    expect(result.interviewer).toBe("updated");
    expect(bodyOf("PUT", "/agent/workers/interviewer").enabled).toBe(true);
  });
});

describe("bootstrapProject — the pinned MCP constants", () => {
  it("WOLF_MCP_HEADER_NAME is the exact bare header X-Wolf-Mcp-Token", () => {
    expect(WOLF_MCP_HEADER_NAME).toBe("X-Wolf-Mcp-Token");
  });

  it("WOLF_MCP_TOKEN_REF is the exact bare whole-value reference ${WOLF_MCP_TOKEN}", () => {
    expect(WOLF_MCP_TOKEN_REF).toBe("${WOLF_MCP_TOKEN}");
  });
});

// ── The prompt-contract test (ticket W12's own acceptance criterion) ─────
describe("prompt contract — the literals every other ticket depends on", () => {
  it("{{LOCKED_SPEC_JSON}} occurs exactly once in the preamble and nowhere in the method body", () => {
    const occurrences = RESEARCHER_PREAMBLE.split("{{LOCKED_SPEC_JSON}}").length - 1;
    expect(occurrences).toBe(1);
    expect(RESEARCHER_METHOD.includes("{{LOCKED_SPEC_JSON}}")).toBe(false);
  });

  it("<!-- WOLF:METHOD-BODY --> occurs in the preamble and in critic.md", () => {
    expect(RESEARCHER_PREAMBLE.includes("<!-- WOLF:METHOD-BODY -->")).toBe(true);
    expect(CRITIC_PROMPT.includes("<!-- WOLF:METHOD-BODY -->")).toBe(true);
  });

  it("the preamble ends with the marker line, so preamble + method concatenates to one correct document", () => {
    expect(RESEARCHER_PREAMBLE.trimEnd().endsWith("<!-- WOLF:METHOD-BODY -->")).toBe(true);
  });

  it("the method body contains no marker line of its own", () => {
    expect(RESEARCHER_METHOD.includes("<!-- WOLF:METHOD-BODY -->")).toBe(false);
  });

  // The preamble MENTIONS the marker in prose (inside backticks) while
  // explaining what it is, so the literal appears more than once as a
  // SUBSTRING. The boundary is the literal LINE, and only a line-anchored
  // split is safe: a splitter using indexOf/split on the bare substring would
  // cut at the prose mention and silently make most of the locked preamble
  // "mutable". This pins the property W9's splitter relies on.
  it("<!-- WOLF:METHOD-BODY --> occurs exactly once in the preamble as a whole line", () => {
    const markerLines = RESEARCHER_PREAMBLE.split("\n").filter(
      (line) => line.trim() === "<!-- WOLF:METHOD-BODY -->",
    );
    expect(markerLines).toHaveLength(1);
  });

  it("timestamp,value occurs in the preamble", () => {
    expect(RESEARCHER_PREAMBLE.includes("timestamp,value")).toBe(true);
  });

  it("mcp__wolf__series_search and mcp__wolf__series_fetch occur in the method body", () => {
    expect(RESEARCHER_METHOD.includes("mcp__wolf__series_search")).toBe(true);
    expect(RESEARCHER_METHOD.includes("mcp__wolf__series_fetch")).toBe(true);
  });

  it("hypothesis-spec-candidate occurs in interviewer.md", () => {
    expect(INTERVIEWER_PROMPT.includes("hypothesis-spec-candidate")).toBe(true);
  });

  it("interviewer.md names mcp__ui__ask_user, the tool that renders a question card", () => {
    // Without this instruction the interviewer asks in prose — typically
    // four questions in one message, which a person answers partially or
    // not at all. The card is built into Orange's chat UI and available to
    // every session by default; the ONLY thing that was missing was the
    // prompt telling the model to use it. The exact name matters: Orange's
    // reducer only looks for the question-card marker on a tool whose name
    // contains `ask_user` (agent-orange web/src/agentEventReducer.ts:243).
    expect(INTERVIEWER_PROMPT.includes("mcp__ui__ask_user")).toBe(true);
  });

  it("interviewer.md tells the model to ask ONE question and then stop", () => {
    // The half of the instruction that is easy to lose in an edit. The
    // answer arrives as a NEW user message, so a second card in the same
    // turn gets one answer, and prose after the card buries it.
    expect(/ask ONE question/i.test(INTERVIEWER_PROMPT)).toBe(true);
  });

  it("researcher-preamble.md forbids ask_user — nobody is watching a daily tick", () => {
    expect(RESEARCHER_PREAMBLE.includes("ask_user")).toBe(true);
  });
});
