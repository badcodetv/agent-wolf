import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher, type Interceptable } from "undici";
import pino from "pino";
import { Writable } from "node:stream";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WolfError } from "../errors.js";
import { createOrangeClient } from "./client.js";

// design/2026-08-20-agent-wolf.md, W2 acceptance criteria. The route list
// (22 of them) is exhaustive and closed — see client.ts's own header
// comment. Every test below drives the client through `undici`'s
// MockAgent: no live network anywhere in this file (§ "Pinned technology
// choices": undici MockAgent, no msw, no nock).

const BASE_URL = "http://orange.test:4100";
const API_KEY = "wolf-test-secret-9f3a7c21";

let mockAgent: MockAgent;
let pool: Interceptable;
let originalDispatcher: Dispatcher;

beforeEach(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  pool = mockAgent.get(BASE_URL);
});

afterEach(async () => {
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
});

function client(logger?: Parameters<typeof createOrangeClient>[0]["logger"]) {
  return createOrangeClient({ baseUrl: BASE_URL, apiKey: API_KEY, logger });
}

/**
 * Registers a mock reply for `method` and captures the request's raw path
 * (pathname + query string, as undici dispatched it) and JSON body, for
 * assertion AFTER the awaited call — never inside the matcher itself,
 * which must stay a plain, non-throwing boolean predicate (undici does not
 * wrap matcher exceptions, so a failed `expect()` inside one surfaces as an
 * opaque dispatch error rather than a normal assertion failure).
 */
interface Captured {
  path?: string;
  body?: string;
}

function intercept(
  method: string,
  status: number,
  data: unknown,
  headers?: Record<string, string>,
): Captured {
  const captured: Captured = {};
  pool
    .intercept({ method, path: (p: string) => { captured.path = p; return true; } })
    .reply((opts) => {
      // opts.body carries whatever fetch handed the dispatcher for a
      // request with a body; GETs/DELETEs-without-rationale have none.
      captured.body = typeof opts.body === "string" ? opts.body : undefined;
      return { statusCode: status, data: data as never, responseOptions: { headers: headers ?? {} } };
    });
  return captured;
}

function pathnameOf(captured: Captured): string {
  return new URL(captured.path ?? "", BASE_URL).pathname;
}

function queryOf(captured: Captured): Record<string, string> {
  return Object.fromEntries(new URL(captured.path ?? "", BASE_URL).searchParams.entries());
}

describe("createOrangeClient reads no environment variable", () => {
  it("client.ts and types.ts contain no `process.env`", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const clientSrc = readFileSync(join(here, "client.ts"), "utf8");
    const typesSrc = readFileSync(join(here, "types.ts"), "utf8");
    expect(clientSrc.includes("process.env")).toBe(false);
    expect(typesSrc.includes("process.env")).toBe(false);
  });
});

// ── The 22 routes, one dedicated test each (plus a few extra per-route cases) ──

describe("sessions", () => {
  it("POST /agent/session — sends name and worker, maps {id,status,workflowId}", async () => {
    const c = intercept("POST", 200, { id: "sess-1", status: "creating", workflowId: "wf-1" });
    const result = await client().createSession({ name: "hyp-1a2b3c4d", worker: "interviewer" });
    expect(pathnameOf(c)).toBe("/agent/session");
    expect(result).toEqual({ id: "sess-1", status: "creating", workflowId: "wf-1" });
  });

  it("GET /agent/sessions/by-name/{name} — maps status/create_error/timestamps", async () => {
    const c = intercept("GET", 200, {
      id: "sess-1",
      name: "hyp-1a2b3c4d",
      customer: "wolf",
      status: "active",
      created_at: 1700000000,
      updated_at: 1700000100,
    });
    const row = await client().getSessionByName("hyp-1a2b3c4d");
    expect(pathnameOf(c)).toBe("/agent/sessions/by-name/hyp-1a2b3c4d");
    expect(row).toEqual({
      id: "sess-1",
      name: "hyp-1a2b3c4d",
      customer: "wolf",
      job: undefined,
      persona: undefined,
      title: undefined,
      status: "active",
      createError: undefined,
      createdAtSec: 1700000000,
      updatedAtSec: 1700000100,
    });
  });

  it("GET /agent/sessions/by-name/{name} — a status:error row surfaces create_error", async () => {
    intercept("GET", 200, {
      id: "sess-2",
      name: "hyp-deadbeef",
      customer: "wolf",
      status: "error",
      create_error: "host port pool is exhausted",
      created_at: 1700000000,
      updated_at: 1700000000,
    });
    const row = await client().getSessionByName("hyp-deadbeef");
    expect(row.status).toBe("error");
    expect(row.createError).toBe("host port pool is exhausted");
  });

  it("DELETE /agent/session/{id} — 204, no body parsed", async () => {
    const c = intercept("DELETE", 204, "");
    await expect(client().deleteSession("sess-1")).resolves.toBeUndefined();
    expect(pathnameOf(c)).toBe("/agent/session/sess-1");
  });

  it("GET /agent/sessions — always sends user_email=*, and &worker= when given", async () => {
    const first = intercept("GET", 200, [{ id: "s1", status: "active", created_at: 1, updated_at: 2 }]);
    const rows = await client().listSessions();
    expect(pathnameOf(first)).toBe("/agent/sessions");
    expect(queryOf(first)).toEqual({ user_email: "*" });
    expect(rows).toEqual([{ id: "s1", name: undefined, worker: undefined, status: "active", createdAtSec: 1, updatedAtSec: 2 }]);

    const second = intercept("GET", 200, []);
    await client().listSessions({ worker: "researcher-1a2b3c4d" });
    expect(queryOf(second)).toEqual({ user_email: "*", worker: "researcher-1a2b3c4d" });
  });

  it("GET /agent/sessions — limit and offset ride the query too", async () => {
    const c = intercept("GET", 200, []);
    await client().listSessions({ limit: 200, offset: 50 });
    expect(queryOf(c)).toEqual({ user_email: "*", limit: "200", offset: "50" });
  });
});

describe("memories", () => {
  it("POST /agent/memories — expects 201, sends no created_by_* fields, maps provenance", async () => {
    const c = intercept("POST", 201, {
      id: "mem-1",
      labels: { kind: "hypothesis", name: "1a2b3c4d" },
      content: "the thesis",
      created_by_worker: "",
      created_by_session: "",
      created_at: 1755600000000,
    });
    const rec = await client().appendMemory({
      labels: { kind: "hypothesis", name: "1a2b3c4d" },
      content: "the thesis",
    });
    expect(pathnameOf(c)).toBe("/agent/memories");
    const body = JSON.parse(c.body ?? "{}");
    expect(Object.keys(body).sort()).toEqual(["content", "labels"]);
    expect(body).not.toHaveProperty("created_by_worker");
    expect(body).not.toHaveProperty("created_by_session");
    expect(rec).toEqual({
      id: "mem-1",
      labels: { kind: "hypothesis", name: "1a2b3c4d" },
      content: "the thesis",
      createdByWorker: "",
      createdBySession: "",
      createdAtMs: 1755600000000,
    });
  });

  it("POST /agent/memories — a 2xx other than 201 is an internal error naming the status", async () => {
    intercept("POST", 200, { id: "mem-1" });
    await expect(client().appendMemory({ labels: {}, content: "x" })).rejects.toMatchObject({
      kind: "internal",
      message: expect.stringContaining("200"),
    });
  });

  it("GET /agent/memories — selector/query/limit/latest_per/since/until; snippet rows carry no content", async () => {
    const c = intercept("GET", 200, {
      memories: [
        {
          id: "mem-1",
          labels: { kind: "hypothesis" },
          snippet: "the thesis, cut short",
          score: 1.2,
          created_by_worker: "researcher-1a2b3c4d",
          created_by_session: "sess-1",
          created_at: 1755600000000,
        },
      ],
    });
    const rows = await client().listMemories({
      selector: "kind=hypothesis",
      query: "thesis",
      limit: 20,
      latestPer: "name",
      since: "7d",
      until: "now",
    });
    expect(pathnameOf(c)).toBe("/agent/memories");
    expect(queryOf(c)).toEqual({
      selector: "kind=hypothesis",
      query: "thesis",
      limit: "20",
      latest_per: "name",
      since: "7d",
      until: "now",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("content");
    expect(rows[0]).toEqual({
      id: "mem-1",
      labels: { kind: "hypothesis" },
      snippet: "the thesis, cut short",
      score: 1.2,
      createdByWorker: "researcher-1a2b3c4d",
      createdBySession: "sess-1",
      createdAtMs: 1755600000000,
    });
  });

  it("GET /agent/memories — include_retracted=1 only when true; surfaces every retraction, newest first", async () => {
    const bare = intercept("GET", 200, { memories: [] });
    await client().listMemories({ selector: "kind=hypothesis" });
    expect(queryOf(bare)).toEqual({ selector: "kind=hypothesis" });

    const flagged = intercept("GET", 200, {
      memories: [
        {
          id: "mem-2",
          labels: {},
          snippet: "s",
          score: 1,
          created_by_worker: "",
          created_by_session: "",
          created_at: 1755600000001,
          retracted_by: [
            { memory_id: "ret-2", created_by_worker: "researcher-1a2b3c4d", created_by_session: "sess-attacker", created_at: 1755600000003 },
            { memory_id: "ret-1", created_by_worker: "interviewer-9f3a7c21", created_by_session: "", created_at: 1755600000002 },
          ],
        },
      ],
    });
    const rows = await client().listMemories({ latestPer: "name", includeRetracted: true });
    expect(queryOf(flagged)).toEqual({ latest_per: "name", include_retracted: "1" });
    expect(rows[0]?.retractedBy).toEqual([
      { memoryId: "ret-2", createdByWorker: "researcher-1a2b3c4d", createdBySession: "sess-attacker", createdAtMs: 1755600000003 },
      { memoryId: "ret-1", createdByWorker: "interviewer-9f3a7c21", createdBySession: "", createdAtMs: 1755600000002 },
    ]);
  });

  it("GET /agent/memories/{id} — full content, not a snippet, for a >600 char body", async () => {
    const longContent = "x".repeat(650);
    const c = intercept("GET", 200, {
      id: "mem-long",
      labels: {},
      content: longContent,
      created_by_worker: "researcher-1a2b3c4d",
      created_by_session: "sess-1",
      created_at: 1700000000000,
    });
    const full = await client().getMemory("mem-long");
    expect(pathnameOf(c)).toBe("/agent/memories/mem-long");
    expect(full.content).toBe(longContent);
    expect(full).not.toHaveProperty("snippet");
    expect(full.createdByWorker).toBe("researcher-1a2b3c4d");
    expect(full.createdBySession).toBe("sess-1");
  });

  it("GET /agent/memories/current?name= — full content, not a snippet, for a >600 char body", async () => {
    const longContent = "y".repeat(700);
    const c = intercept("GET", 200, {
      id: "mem-cur",
      labels: {},
      content: longContent,
      created_by_worker: "interviewer-9f3a7c21",
      created_by_session: "sess-cur-1",
      created_at: 1700000000001,
    });
    const full = await client().getCurrentMemory("hyp-1a2b3c4d");
    expect(pathnameOf(c)).toBe("/agent/memories/current");
    expect(queryOf(c)).toEqual({ name: "hyp-1a2b3c4d" });
    expect(full.content).toBe(longContent);
    expect(full).not.toHaveProperty("snippet");
    expect(full.createdByWorker).toBe("interviewer-9f3a7c21");
    expect(full.createdBySession).toBe("sess-cur-1");
  });
});

describe("datasets", () => {
  it("GET /agent/datasets — selector/limit, {datasets:[...]} envelope, field-for-field metadata", async () => {
    const c = intercept("GET", 200, {
      datasets: [
        {
          id: "ds-1",
          name: "1a2b3c4d-drone-suppliers-basket",
          version: 7,
          labels: { hypothesis: "1a2b3c4d", metric: "drone-suppliers-basket" },
          size_bytes: 40213,
          row_count: 512,
          sha256: "abc123",
          content_type: "text/csv",
          created_by_worker: "",
          created_by_session: "",
          created_at: 1789000000123,
        },
      ],
    });
    const rows = await client().listDatasets({ selector: "hypothesis=1a2b3c4d", limit: 20 });
    expect(pathnameOf(c)).toBe("/agent/datasets");
    expect(queryOf(c)).toEqual({ selector: "hypothesis=1a2b3c4d", limit: "20" });
    expect(rows).toEqual([
      {
        id: "ds-1",
        name: "1a2b3c4d-drone-suppliers-basket",
        version: 7,
        labels: { hypothesis: "1a2b3c4d", metric: "drone-suppliers-basket" },
        sizeBytes: 40213,
        rowCount: 512,
        sha256: "abc123",
        contentType: "text/csv",
        createdByWorker: "",
        createdBySession: "",
        createdAtMs: 1789000000123,
      },
    ]);
  });

  it("GET /agent/datasets — an unexpected envelope is an invalid error, not undefined fields", async () => {
    intercept("GET", 200, { dataset: [] });
    await expect(client().listDatasets()).rejects.toMatchObject({ kind: "invalid" });
  });

  it("GET /agent/datasets/{name} — the bare object, blob_path and project absent", async () => {
    const c = intercept("GET", 200, {
      id: "ds-1",
      name: "1a2b3c4d-drone-suppliers-basket",
      version: 7,
      labels: {},
      size_bytes: 1,
      row_count: 1,
      sha256: "x",
      content_type: "text/csv",
      created_by_worker: "",
      created_by_session: "",
      created_at: 1700000000000,
      blob_path: "should-never-be-serialised",
      project: "wolf",
    });
    const ds = await client().getDataset("1a2b3c4d-drone-suppliers-basket");
    expect(pathnameOf(c)).toBe("/agent/datasets/1a2b3c4d-drone-suppliers-basket");
    expect(ds).not.toHaveProperty("blob_path");
    expect(ds).not.toHaveProperty("blobPath");
    expect(ds).not.toHaveProperty("project");
  });

  it("GET /agent/datasets/{name} — a missing/non-numeric version is an invalid error, never undefined", async () => {
    intercept("GET", 200, { id: "ds-1", name: "x" });
    await expect(client().getDataset("x")).rejects.toMatchObject({ kind: "invalid" });
  });

  it("GET /agent/datasets/{name}/download — raw bytes, version and token as query params", async () => {
    const csv = "timestamp,value\n2026-01-01T00:00:00Z,1.5\n";
    const c = intercept("GET", 200, csv, { "content-type": "text/csv" });
    const dl = await client().downloadDataset("1a2b3c4d-slug", { version: 7, token: "tok-abc" });
    expect(pathnameOf(c)).toBe("/agent/datasets/1a2b3c4d-slug/download");
    expect(queryOf(c)).toEqual({ version: "7", token: "tok-abc" });
    expect(dl.contentType).toBe("text/csv");
    expect(Buffer.from(dl.body).toString("utf8")).toBe(csv);
  });
});

describe("workers", () => {
  it("PUT /agent/workers/{name} — sends the worker body, maps the stored row back", async () => {
    const c = intercept("PUT", 200, {
      project: "wolf",
      name: "researcher-1a2b3c4d",
      description: "",
      system_prompt: "be a researcher",
      mcp_config: { wolf: { url: "http://x" } },
      image: "",
      max_instances: 1,
      enabled: true,
      frozen: false,
      created_at: 1700000000,
      updated_at: 1700000001,
    });
    const worker = await client().putWorker("researcher-1a2b3c4d", {
      systemPrompt: "be a researcher",
      mcpConfig: { wolf: { url: "http://x" } },
      enabled: true,
    });
    expect(pathnameOf(c)).toBe("/agent/workers/researcher-1a2b3c4d");
    const body = JSON.parse(c.body ?? "{}");
    expect(body.system_prompt).toBe("be a researcher");
    expect(body.enabled).toBe(true);
    expect(worker.systemPrompt).toBe("be a researcher");
    expect(worker.createdAtSec).toBe(1700000000);
    expect(worker.updatedAtSec).toBe(1700000001);
  });

  it("DELETE /agent/workers/{name} — rationale rides ?rationale=, 204", async () => {
    const c = intercept("DELETE", 204, "");
    await expect(
      client().deleteWorker("researcher-1a2b3c4d", { rationale: "teardown" }),
    ).resolves.toBeUndefined();
    expect(pathnameOf(c)).toBe("/agent/workers/researcher-1a2b3c4d");
    expect(queryOf(c)).toEqual({ rationale: "teardown" });
  });
});

describe("schedules", () => {
  it("POST /agent/schedules — worker mode, expects 201", async () => {
    const c = intercept("POST", 201, {
      id: "sch-1",
      project: "wolf",
      worker: "researcher-1a2b3c4d",
      cron: "0 6 * * *",
      input: "",
      enabled: true,
      created_at: 1700000000,
      updated_at: 1700000000,
    });
    const sched = await client().createSchedule({ worker: "researcher-1a2b3c4d", cron: "0 6 * * *" });
    expect(pathnameOf(c)).toBe("/agent/schedules");
    const body = JSON.parse(c.body ?? "{}");
    expect(body.worker).toBe("researcher-1a2b3c4d");
    expect(body.cron).toBe("0 6 * * *");
    expect(sched).toMatchObject({ id: "sch-1", worker: "researcher-1a2b3c4d", cron: "0 6 * * *", enabled: true });
  });

  it("POST /agent/schedules — a 2xx other than 201 is an internal error naming the status", async () => {
    intercept("POST", 200, { id: "sch-1" });
    await expect(client().createSchedule({ worker: "w", cron: "* * * * *" })).rejects.toMatchObject({
      kind: "internal",
      message: expect.stringContaining("200"),
    });
  });

  it("GET /agent/schedules — {schedules:[...]} envelope", async () => {
    const c = intercept("GET", 200, {
      schedules: [
        { id: "sch-1", project: "wolf", worker: "w", cron: "* * * * *", input: "", enabled: true, created_at: 1, updated_at: 2 },
      ],
    });
    const rows = await client().listSchedules();
    expect(pathnameOf(c)).toBe("/agent/schedules");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("sch-1");
  });

  it("DELETE /agent/schedules/{id} — rationale rides ?rationale=", async () => {
    const c = intercept("DELETE", 200, { deleted: true });
    await expect(client().deleteSchedule("sch-1", { rationale: "no longer needed" })).resolves.toBeUndefined();
    expect(pathnameOf(c)).toBe("/agent/schedules/sch-1");
    expect(queryOf(c)).toEqual({ rationale: "no longer needed" });
  });
});

describe("deliveries and attention requests", () => {
  it("GET /agent/deliveries — status/limit/offset, {deliveries:[...]} envelope", async () => {
    const c = intercept("GET", 200, {
      deliveries: [
        {
          id: "d1",
          project: "wolf",
          event_id: "",
          subscription_id: "researcher-1a2b3c4d",
          session_id: "s1",
          worker: "researcher-1a2b3c4d",
          schedule_id: "sch-1",
          status: "pending",
          failure_reason: "",
          started_at: 0,
          ended_at: 0,
          created_at: 1700000000,
          updated_at: 1700000000,
        },
      ],
    });
    const rows = await client().listDeliveries({
      eventId: "evt-1",
      subscriptionId: "sub-1",
      status: "pending",
      limit: 50,
      offset: 0,
    });
    expect(pathnameOf(c)).toBe("/agent/deliveries");
    expect(queryOf(c)).toEqual({
      event_id: "evt-1",
      subscription_id: "sub-1",
      status: "pending",
      limit: "50",
      offset: "0",
    });
    expect(rows[0]?.worker).toBe("researcher-1a2b3c4d");
    expect(rows[0]?.status).toBe("pending");
  });

  it("GET /agent/attention-requests — {attention_requests:[...]} envelope", async () => {
    const c = intercept("GET", 200, {
      attention_requests: [
        {
          id: "a1",
          session_id: "s1",
          worker: "researcher-1a2b3c4d",
          message: "need a human",
          created_at: 1700000000,
          expires_at: 1700003600,
          answered_at: 0,
          timed_out_at: 0,
        },
      ],
    });
    const rows = await client().listAttentionRequests({ state: "open", limit: 10 });
    expect(pathnameOf(c)).toBe("/agent/attention-requests");
    expect(queryOf(c)).toEqual({ state: "open", limit: "10" });
    expect(rows[0]).toMatchObject({ id: "a1", sessionId: "s1", worker: "researcher-1a2b3c4d", message: "need a human" });
  });
});

describe("project settings", () => {
  it("GET /agent/project-settings", async () => {
    const c = intercept("GET", 200, {
      project: "wolf",
      base_image: "agent-wolf:dev",
      system_prompt: "",
      mcp_config: { wolf: {} },
      attention_channel: {},
      max_concurrent_jobs: 5,
      daily_tokens_soft: 0,
      daily_tokens_hard: 0,
      briefing_max_bytes: 0,
      snapshot_ttl_days: 0,
      updated_at: 1700000000,
    });
    const settings = await client().getProjectSettings();
    expect(pathnameOf(c)).toBe("/agent/project-settings");
    expect(settings.baseImage).toBe("agent-wolf:dev");
    expect(settings.mcpConfig).toEqual({ wolf: {} });
  });

  it("PUT /agent/project-settings — whole-object write, never a patch", async () => {
    const c = intercept("PUT", 200, {
      project: "wolf",
      base_image: "agent-wolf:dev",
      system_prompt: "",
      mcp_config: {},
      attention_channel: {},
      max_concurrent_jobs: 5,
      daily_tokens_soft: 0,
      daily_tokens_hard: 0,
      briefing_max_bytes: 0,
      snapshot_ttl_days: 0,
      updated_at: 1700000001,
    });
    const settings = await client().putProjectSettings({
      baseImage: "agent-wolf:dev",
      systemPrompt: "",
      mcpConfig: {},
      attentionChannel: {},
      maxConcurrentJobs: 5,
      dailyTokensSoft: 0,
      dailyTokensHard: 0,
      briefingMaxBytes: 0,
      snapshotTtlDays: 0,
      rationale: "bootstrap",
    });
    expect(pathnameOf(c)).toBe("/agent/project-settings");
    const body = JSON.parse(c.body ?? "{}");
    expect(body.base_image).toBe("agent-wolf:dev");
    expect(body.attention_channel).toEqual({});
    expect(body.rationale).toBe("bootstrap");
    expect(settings.updatedAtSec).toBe(1700000001);
  });
});

describe("embed token and google verification", () => {
  it("POST /agent/embed-token — sends no ttl_seconds when omitted", async () => {
    const c = intercept("POST", 200, { token: "tok-xyz", expires_at: 1700000900 });
    const result = await client().createEmbedToken("hyp-1a2b3c4d");
    expect(pathnameOf(c)).toBe("/agent/embed-token");
    const body = JSON.parse(c.body ?? "{}");
    expect(body).toEqual({ session: "hyp-1a2b3c4d" });
    expect(result).toEqual({ token: "tok-xyz", expiresAtSec: 1700000900 });
  });

  it("POST /agent/embed-token — includes ttl_seconds only when explicitly given", async () => {
    const c = intercept("POST", 200, { token: "tok-abc", expires_at: 1700000120 });
    await client().createEmbedToken("hyp-1a2b3c4d", 120);
    const body = JSON.parse(c.body ?? "{}");
    expect(body).toEqual({ session: "hyp-1a2b3c4d", ttl_seconds: 120 });
  });

  it("POST /auth/verify-google — success maps email_verified to emailVerified", async () => {
    const c = intercept("POST", 200, { email: "kai@badcode.dev", email_verified: true });
    const result = await client().verifyGoogle("id-token-abc");
    expect(pathnameOf(c)).toBe("/auth/verify-google");
    const body = JSON.parse(c.body ?? "{}");
    expect(body).toEqual({ credential: "id-token-abc" });
    expect(result).toEqual({ email: "kai@badcode.dev", emailVerified: true });
  });

  it("POST /auth/verify-google — a 404 is misconfigured naming GOOGLE_CLIENT_ID, not not_found (the one documented exception)", async () => {
    intercept("POST", 404, "not mounted");
    await expect(client().verifyGoogle("id-token-abc")).rejects.toMatchObject({
      kind: "misconfigured",
      details: { variable: "GOOGLE_CLIENT_ID" },
      upstreamBody: "not mounted",
    });
  });
});

// ── Error mapping: the fixed table, one row per status ─────────────────────

describe("non-2xx responses become WolfErrors, per the fixed status table", () => {
  it("404 -> not_found", async () => {
    intercept("GET", 404, "no such thing");
    await expect(client().getProjectSettings()).rejects.toMatchObject({
      kind: "not_found",
      status: 404,
      upstreamBody: "no such thing",
    });
  });

  it("410 -> not_found (row exists, blob gone; callers treat it as absent)", async () => {
    intercept("GET", 410, "blob gone");
    await expect(client().getProjectSettings()).rejects.toMatchObject({ kind: "not_found", status: 410 });
  });

  it("409 -> conflict", async () => {
    intercept("GET", 409, "cas mismatch");
    await expect(client().getProjectSettings()).rejects.toMatchObject({ kind: "conflict", status: 409 });
  });

  it("403 -> forbidden (the ordinary case, not the port-pool exception)", async () => {
    intercept("GET", 403, "no project in token");
    await expect(client().getProjectSettings()).rejects.toMatchObject({ kind: "forbidden", status: 403 });
  });

  it("400 -> invalid", async () => {
    intercept("GET", 400, "bad selector");
    await expect(client().getProjectSettings()).rejects.toMatchObject({ kind: "invalid", status: 400 });
  });

  it("422 -> invalid", async () => {
    intercept("GET", 422, "unprocessable");
    await expect(client().getProjectSettings()).rejects.toMatchObject({ kind: "invalid", status: 422 });
  });

  it("501 -> misconfigured, naming DATABASE_URL", async () => {
    intercept("GET", 501, "not configured on this host");
    await expect(client().getProjectSettings()).rejects.toMatchObject({
      kind: "misconfigured",
      status: 501,
      details: { variable: "DATABASE_URL" },
      upstreamBody: "not configured on this host",
    });
  });

  it("500 -> unavailable (the only RETRYABLE kind — comment: this is why a 500 must not land here as internal)", async () => {
    intercept("GET", 500, "internal server error");
    await expect(client().getProjectSettings()).rejects.toMatchObject({ kind: "unavailable", status: 500 });
  });

  it("502 -> unavailable", async () => {
    intercept("GET", 502, "bad gateway");
    await expect(client().getProjectSettings()).rejects.toMatchObject({ kind: "unavailable", status: 502 });
  });

  it("503 -> unavailable", async () => {
    intercept("GET", 503, "service unavailable");
    await expect(client().getProjectSettings()).rejects.toMatchObject({ kind: "unavailable", status: 503 });
  });

  it("504 -> unavailable", async () => {
    intercept("GET", 504, "gateway timeout");
    await expect(client().getProjectSettings()).rejects.toMatchObject({ kind: "unavailable", status: 504 });
  });

  it("an unrecognised status (e.g. 418) -> internal, never unavailable (R39)", async () => {
    intercept("GET", 418, "teapot");
    await expect(client().getProjectSettings()).rejects.toMatchObject({ kind: "internal", status: 418 });
  });

  it("a network error (connection refused) -> unavailable", async () => {
    pool.intercept({ method: "GET", path: () => true }).replyWithError(new Error("ECONNREFUSED"));
    await expect(client().getProjectSettings()).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("POST /agent/session — a 403 naming host port pool exhaustion maps to unavailable, message verbatim", async () => {
    const msg = "host port pool is exhausted — all 100 ports in 20000-20099 are leased to running sessions";
    intercept("POST", 403, msg);
    await expect(
      client().createSession({ name: "hyp-1a2b3c4d", worker: "interviewer" }),
    ).rejects.toMatchObject({ kind: "unavailable", message: msg, upstreamBody: msg });
  });

  it("POST /agent/session — an ordinary 403 maps to forbidden, not unavailable", async () => {
    intercept("POST", 403, "no project in token");
    await expect(
      client().createSession({ name: "hyp-1a2b3c4d", worker: "interviewer" }),
    ).rejects.toMatchObject({ kind: "forbidden" });
  });
});

// ── The API key: exactly two tests, no more and no fewer ───────────────────

describe("the API key reaches only the X-API-Key header", () => {
  it("(a) a WolfError from a failed call, JSON.stringify-ed including upstreamBody and cause, contains no substring of the key", async () => {
    intercept("GET", 500, "internal server error, nothing about any credential here");
    let caught: WolfError | undefined;
    try {
      await client().getProjectSettings();
    } catch (err) {
      caught = err as WolfError;
    }
    expect(caught).toBeInstanceOf(WolfError);
    const serialised = JSON.stringify({
      message: caught?.message,
      kind: caught?.kind,
      status: caught?.status,
      details: caught?.details,
      upstreamBody: caught?.upstreamBody,
      cause: caught?.cause instanceof Error ? caught.cause.message : caught?.cause,
    });
    expect(serialised.includes(API_KEY)).toBe(false);
  });

  it("(b) a pino instance with a capturing destination records one failing and one succeeding call, and no line contains the key", async () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const logger = pino(destination);

    intercept("GET", 200, {
      project: "wolf",
      base_image: "",
      system_prompt: "",
      mcp_config: {},
      attention_channel: {},
      max_concurrent_jobs: 1,
      daily_tokens_soft: 0,
      daily_tokens_hard: 0,
      briefing_max_bytes: 0,
      snapshot_ttl_days: 0,
      updated_at: 1700000000,
    });
    intercept("GET", 500, "boom");

    const c = client(logger);
    await c.getProjectSettings();
    await expect(c.listSchedules()).rejects.toThrow();

    // pino writes are synchronous to the destination we supplied.
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(line.includes(API_KEY)).toBe(false);
    }
  });
});
