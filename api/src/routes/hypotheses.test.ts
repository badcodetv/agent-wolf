import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import cookieParser from "cookie-parser";
import express, { type Request, type Response } from "express";
import {
  MockAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
  type Interceptable,
} from "undici";

import { createErrorHandler } from "../app.js";
import { loadConfig, type WolfConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { createOrangeClient } from "../orange/client.js";
import { setSessionCookie } from "../auth/session.js";
import {
  SESSION_NAME_PATTERN,
  createHypothesisStore,
  slugifyOwner,
} from "../hypothesis/store.js";
import { createHypothesesRouter } from "./hypotheses.js";

// design/2026-08-20-agent-wolf.md, W8's acceptance criteria. Test names are
// prefixed `hypotheses_`.
//
// Orange is mocked with undici's MockAgent (the pinned mechanism). Two kinds
// of body appear below:
//
//  - **Captured** — `../hypothesis/__fixtures__/*.json`, recorded verbatim from
//    a running O11 build for W5 (see that directory's README). The tamper
//    pass-through test is graded against those, because only Orange can say
//    what `retracted_by` really contains.
//  - **Synthetic** — every body built by `memoryRow`/`page` below. They are
//    hand-built and are NOT presented as recordings: no `kind=evaluation` row
//    exists in any capture, because nothing writes one until W10.

const ORANGE = "http://orange.test:4100";
const API_KEY = "wolf-project-api-key-for-tests";
const SECRET = "session-secret-for-tests-0123456789abcdef";
const OWNER = "kai@badcode.dev";

function fixture(name: string): string {
  return readFileSync(new URL(`../hypothesis/__fixtures__/${name}`, import.meta.url), "utf8");
}

// ── Synthetic bodies ────────────────────────────────────────────────────

interface RowOverrides {
  id?: string;
  labels?: Record<string, string>;
  snippet?: string;
  createdByWorker?: string;
  createdBySession?: string;
  createdAtMs?: number;
  retractedBy?: unknown[];
}

function memoryRow(overrides: RowOverrides = {}): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: overrides.id ?? "mem-1",
    labels: overrides.labels ?? {},
    snippet: overrides.snippet ?? "",
    score: 0,
    created_by_worker: overrides.createdByWorker ?? "",
    created_by_session: overrides.createdBySession ?? "",
    created_at: overrides.createdAtMs ?? 1787334047000,
  };
  if (overrides.retractedBy !== undefined) row["retracted_by"] = overrides.retractedBy;
  return row;
}

function page(rows: Record<string, unknown>[]): string {
  return JSON.stringify({ memories: rows });
}

function sessionRow(name: string, id = `sess-${name}`): Record<string, unknown> {
  return {
    id,
    name,
    worker: "interviewer",
    status: "running",
    created_at: 1787334311,
    updated_at: 1787334313,
  };
}

function stateRow(id: string, status: string, title: string, at = 1787334047000): Record<string, unknown> {
  return memoryRow({
    id: `state-${id}`,
    labels: { kind: "hypothesis", name: id, status, owner: slugifyOwner(OWNER) },
    snippet: `${title}\n\nthe thesis`,
    createdAtMs: at,
  });
}

function evaluationRow(id: string, line: string): Record<string, unknown> {
  return memoryRow({
    id: `eval-${id}`,
    labels: { kind: "evaluation", name: id },
    snippet: `${line}\n{"support_score":-0.42}`,
  });
}

// ── The stub Orange ─────────────────────────────────────────────────────

interface Recorded {
  method: string;
  path: string;
  body: string;
}

interface Answer {
  status: number;
  body: string;
}

interface StubConfig {
  sessions?: Record<string, unknown>[];
  /** `latest_per=name` + `selector=kind=hypothesis`. */
  board?: string;
  /** `latest_per=name` + `selector=kind=evaluation`. */
  evaluations?: string;
  /** Per-kind, per-name reads, keyed `<kind>:<id>`. */
  details?: Record<string, string>;
  /** `GET /agent/memories/{id}`. */
  memoriesById?: Record<string, string>;
  /** `POST /agent/session`. Default: Orange's real asynchronous answer. */
  createSession?: Answer;
  /** Successive answers to `GET /agent/sessions/by-name/…`; the last repeats. */
  byName?: Answer[];
  attention?: string;
  schedules?: string;
}

const EMPTY = '{"memories":[]}';

class Stub {
  readonly requests: Recorded[] = [];
  private byNameCalls = 0;

  constructor(
    private readonly pool: Interceptable,
    private readonly config: StubConfig,
  ) {}

  get latestPerRequests(): Recorded[] {
    return this.requests.filter((r) => r.path.includes("latest_per="));
  }
  get appendRequests(): Recorded[] {
    return this.requests.filter((r) => r.method === "POST" && r.path === "/agent/memories");
  }
  get createSessionRequests(): Recorded[] {
    return this.requests.filter((r) => r.method === "POST" && r.path === "/agent/session");
  }

  install(): void {
    for (const method of ["GET", "POST"]) {
      this.pool
        .intercept({ method, path: () => true })
        .reply((opts) => {
          const path = String(opts.path);
          const body = typeof opts.body === "string" ? opts.body : "";
          this.requests.push({ method, path, body });
          const answer = this.route(method, new URL(path, ORANGE));
          return {
            statusCode: answer.status,
            data: answer.body as never,
            responseOptions: { headers: { "content-type": "application/json" } },
          };
        })
        .persist();
    }
  }

  private route(method: string, url: URL): Answer {
    const path = url.pathname;
    if (method === "POST" && path === "/agent/session") {
      return (
        this.config.createSession ?? {
          status: 200,
          body: JSON.stringify({ id: "sess-new", status: "creating", workflowId: "sess-new" }),
        }
      );
    }
    if (path.startsWith("/agent/sessions/by-name/")) {
      const answers = this.config.byName ?? [
        { status: 200, body: JSON.stringify({ id: "sess-new", name: "", status: "running" }) },
      ];
      const answer = answers[Math.min(this.byNameCalls, answers.length - 1)];
      this.byNameCalls += 1;
      return answer ?? { status: 500, body: "no answer configured" };
    }
    if (path === "/agent/sessions") {
      const rows = this.config.sessions ?? [];
      const limit = Number(url.searchParams.get("limit") ?? "200");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      return { status: 200, body: JSON.stringify(rows.slice(offset, offset + limit)) };
    }
    if (method === "POST" && path === "/agent/memories") {
      return {
        status: 201,
        body: JSON.stringify({
          id: `appended-${this.appendRequests.length}`,
          labels: {},
          content: "",
          created_by_worker: "",
          created_by_session: "",
          created_at: 1787334047842,
        }),
      };
    }
    if (path === "/agent/memories/current") {
      return { status: 404, body: "not routed in this stub" };
    }
    if (path.startsWith("/agent/memories/")) {
      const id = decodeURIComponent(path.slice("/agent/memories/".length));
      const found = this.config.memoriesById?.[id];
      return found === undefined
        ? { status: 404, body: "memory not found" }
        : { status: 200, body: found };
    }
    if (path === "/agent/memories") {
      const selector = url.searchParams.get("selector") ?? "";
      if (url.searchParams.get("latest_per") !== null) {
        if (selector.startsWith("kind=evaluation")) {
          return { status: 200, body: this.config.evaluations ?? EMPTY };
        }
        return { status: 200, body: this.config.board ?? EMPTY };
      }
      const match = /kind=([a-z-]+),name=([0-9a-f]{8})/.exec(selector);
      const key = match === null ? "" : `${match[1]}:${match[2]}`;
      return { status: 200, body: this.config.details?.[key] ?? EMPTY };
    }
    if (path === "/agent/attention-requests") {
      return { status: 200, body: this.config.attention ?? '{"attention_requests":[]}' };
    }
    if (path === "/agent/schedules") {
      return { status: 200, body: this.config.schedules ?? '{"schedules":[]}' };
    }
    return { status: 404, body: `unrouted in the stub: ${path}` };
  }
}

// ── Harness ─────────────────────────────────────────────────────────────

let mockAgent: MockAgent;
let pool: Interceptable;
let originalDispatcher: Dispatcher;
let close: (() => void) | undefined;

beforeEach(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  mockAgent.enableNetConnect((host) => host.startsWith("127.0.0.1") || host.startsWith("localhost"));
  setGlobalDispatcher(mockAgent);
  pool = mockAgent.get(ORANGE);
});

afterEach(async () => {
  close?.();
  close = undefined;
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
});

function config(): WolfConfig {
  return loadConfig(
    {
      WOLF_SESSION_SECRET: SECRET,
      WOLF_ALLOWED_EMAILS: OWNER,
      WOLF_API_KEY: API_KEY,
      ORANGE_BASE_URL: ORANGE,
      NODE_ENV: "test",
    },
    { readRouteTable: () => undefined },
  );
}

interface Harness {
  base: string;
  stub: Stub;
  cookie: string;
}

async function harness(stubConfig: StubConfig): Promise<Harness> {
  const stub = new Stub(pool, stubConfig);
  stub.install();
  const cfg = config();
  const logger = createLogger({ logLevel: "silent" });
  const client = createOrangeClient({ baseUrl: cfg.orangeBaseUrl, apiKey: cfg.orangeApiKey, logger });
  // ONE store, exactly as createApp builds it: the transition mutex is per
  // INSTANCE, so a router that built its own would stop serialising.
  const store = createHypothesisStore({ client, logger });

  const app = express();
  app.use(express.json());
  app.use(cookieParser(cfg.sessionSecret));
  app.post("/test-sign-in", (_req: Request, res: Response) => {
    setSessionCookie(res, OWNER, cfg);
    res.status(200).end();
  });
  app.use(
    createHypothesesRouter({
      store,
      client,
      logger,
      // The create poll must not take real seconds in a unit test.
      sessionPollIntervalMs: 1,
      sessionPollTimeoutMs: 40,
    }),
  );
  app.use(createErrorHandler(logger));

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  close = () => server.close();
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const signIn = await fetch(`${base}/test-sign-in`, { method: "POST" });
  const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { base, stub, cookie };
}

async function get(h: Harness, path: string, withCookie = true): Promise<{ status: number; json: any }> {
  const res = await fetch(`${h.base}${path}`, {
    headers: withCookie ? { cookie: h.cookie } : {},
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function post(
  h: Harness,
  path: string,
  body: unknown,
  withCookie = true,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${h.base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withCookie ? { cookie: h.cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

// ── GET /api/hypotheses ─────────────────────────────────────────────────

describe("hypotheses_board", () => {
  const ids = [
    "1a1a1a1a", "2b2b2b2b", "3c3c3c3c", "4d4d4d4d", "5e5e5e5e", "6f6f6f6f",
    "70707070", "81818181", "92929292", "a3a3a3a3", "b4b4b4b4", "c5c5c5c5",
  ];

  function twelve(): StubConfig {
    return {
      sessions: ids.map((id) => sessionRow(`hyp-${id}`)),
      board: page(ids.map((id, i) => stateRow(id, "live", `Hypothesis ${i}`, 1787334047000 + i))),
      evaluations: page(
        ids.map((id) =>
          evaluationRow(id, "score=-0.42 tripped=1 holding=3 indeterminate=0 evaluated=2026-08-20T06:05:00Z"),
        ),
      ),
    };
  }

  it("hypotheses_board: issues exactly TWO latest_per requests for twelve hypotheses", async () => {
    const h = await harness(twelve());
    const res = await get(h, "/api/hypotheses");

    expect(res.status).toBe(200);
    expect(res.json).toHaveLength(12);
    // O(1) in the hypothesis count. W22 raises this to three when it adds the
    // headline read; nothing writes a kind=report memory before W21.
    expect(h.stub.latestPerRequests).toHaveLength(2);
    const paths = h.stub.latestPerRequests.map((r) => r.path).sort();
    expect(paths[0]).toContain("selector=kind%3Devaluation");
    expect(paths[0]).toContain("latest_per=name");
    expect(paths[1]).toContain("selector=kind%3Dhypothesis");
    expect(paths[1]).toContain("latest_per=name");
    // Load-bearing on the state read: without it a hostile retraction rolls the
    // board back to the previous status silently (R90).
    expect(paths[1]).toContain("include_retracted=1");
  });

  it("hypotheses_board: renders support_score and the conditions summary from the evaluation line", async () => {
    const h = await harness(twelve());
    const res = await get(h, "/api/hypotheses");

    const row = res.json.find((r: any) => r.id === "1a1a1a1a");
    expect(row.support_score).toBe(-0.42);
    expect(row.conditions_summary).toEqual({
      tripped: 1,
      holding: 3,
      indeterminate: 0,
      evaluated_at_ms: Date.parse("2026-08-20T06:05:00Z"),
    });
    expect(row.status).toBe("live");
    expect(row.owner).toBe(slugifyOwner(OWNER));
    expect(typeof row.updated_at_ms).toBe("number");
  });

  it("hypotheses_board: an evaluation line that does not parse yields support_score null and no summary, and never throws", async () => {
    const stub = twelve();
    stub.evaluations = page([
      evaluationRow("1a1a1a1a", "score=-0.42 tripped=1 evaluated=2026-08-20T06:05:00Z"), // missing keys
      evaluationRow("2b2b2b2b", "this is not a summary line at all"),
      evaluationRow(
        "3c3c3c3c",
        // Unrecognised tokens are IGNORED, not rejected: W10 must be able to
        // extend the line without breaking the board.
        "score=0.5 tripped=0 holding=2 indeterminate=1 evaluated=2026-08-20T06:05:00Z horizon_days_left=12",
      ),
    ]);
    const h = await harness(stub);
    const res = await get(h, "/api/hypotheses");

    const byId = Object.fromEntries(res.json.map((r: any) => [r.id, r]));
    expect(byId["1a1a1a1a"].support_score).toBeNull();
    expect(byId["1a1a1a1a"].conditions_summary).toBeNull();
    expect(byId["2b2b2b2b"].support_score).toBeNull();
    expect(byId["3c3c3c3c"].support_score).toBe(0.5);
    expect(byId["3c3c3c3c"].conditions_summary.indeterminate).toBe(1);
  });

  it("hypotheses_board: an UNTRUSTED evaluation row cannot set a score", async () => {
    const stub = twelve();
    stub.evaluations = page([
      {
        ...evaluationRow("1a1a1a1a", "score=1 tripped=0 holding=1 indeterminate=0 evaluated=2026-08-20T06:05:00Z"),
        created_by_session: "sess-hostile",
      },
    ]);
    const h = await harness(stub);
    const res = await get(h, "/api/hypotheses");
    const row = res.json.find((r: any) => r.id === "1a1a1a1a");
    expect(row.support_score).toBeNull();
  });

  it("hypotheses_board: a hypothesis in the session index with no state row is an ANOMALY, never dropped", async () => {
    const h = await harness({
      sessions: [sessionRow("hyp-1a1a1a1a"), sessionRow("hyp-2b2b2b2b")],
      board: page([stateRow("1a1a1a1a", "draft", "Only one has state")]),
    });
    const res = await get(h, "/api/hypotheses");

    expect(res.json).toHaveLength(2);
    const missing = res.json.find((r: any) => r.id === "2b2b2b2b");
    expect(missing.status).toBeNull();
    expect(missing.title).toBeNull();
    expect(missing.support_score).toBeNull();
  });

  it("hypotheses_board: passes W5's tamper array through unmodified (captured Orange bodies)", async () => {
    const sessions = ["hyp-1a2b3c4d", "hyp-2b3c4d5e", "hyp-3c4d5e6f", "hyp-4d5e6f70"].map((n) =>
      sessionRow(n),
    );
    const h = await harness({
      sessions,
      board: fixture("board-latest-per-include-retracted.json"),
      details: {
        "hypothesis:1a2b3c4d": fixture("detail-1a2b3c4d-include-retracted.json"),
        "hypothesis:2b3c4d5e": fixture("detail-2b3c4d5e-include-retracted.json"),
        "hypothesis:3c4d5e6f": fixture("detail-3c4d5e6f-include-retracted.json"),
        "hypothesis:4d5e6f70": fixture("detail-4d5e6f70-include-retracted.json"),
      },
    });
    const res = await get(h, "/api/hypotheses");

    const tampered = res.json.filter((r: any) => r.tamper !== undefined);
    expect(tampered.length).toBeGreaterThan(0);
    for (const row of tampered) {
      for (const t of row.tamper) {
        // The pinned shape, exactly (§ "Shared shapes"): a bare string could
        // not tell a forged row from a hostile retraction, and X1 asserts on
        // the two attacks separately.
        expect(["forged_row", "hostile_retraction", "cross_hypothesis_write"]).toContain(t.reason);
        expect(Object.keys(t).sort()).toEqual(
          ["memory_id", "reason", "written_by_session", "written_by_worker"].sort(),
        );
      }
    }
  });

  it("hypotheses_board: with no cookie it is 401, not a board", async () => {
    const h = await harness(twelve());
    const res = await get(h, "/api/hypotheses", false);
    expect(res.status).toBe(401);
    expect(res.json.kind).toBe("forbidden");
  });

  it("hypotheses_board: nothing it emits or queries with ever contains hyp-hyp-", async () => {
    const h = await harness(twelve());
    const res = await get(h, "/api/hypotheses");
    for (const request of h.stub.requests) {
      expect(request.path).not.toContain("hyp-hyp-");
      expect(request.body).not.toContain("hyp-hyp-");
    }
    expect(JSON.stringify(res.json)).not.toContain("hyp-hyp-");
  });
});

// ── POST /api/hypotheses ────────────────────────────────────────────────

describe("hypotheses_create", () => {
  it("hypotheses_create: answers 201 { id }, creates hyp-<id> with the interviewer, then appends the draft memory", async () => {
    const h = await harness({});
    const res = await post(h, "/api/hypotheses", { title: "Copper is the new oil" });

    expect(res.status).toBe(201);
    expect(res.json.id).toMatch(/^[0-9a-f]{8}$/);

    // The `hyp-` prefix is added exactly once, on the session name.
    const createBody = JSON.parse(h.stub.createSessionRequests[0]?.body ?? "{}");
    expect(createBody.name).toMatch(SESSION_NAME_PATTERN);
    expect(createBody.name).toBe(`hyp-${res.json.id}`);
    expect(createBody.worker).toBe("interviewer");

    // The state row: bare id in `name`, `draft`, owner SLUG (the full address
    // is illegal as a label value and lives in the content).
    expect(h.stub.appendRequests).toHaveLength(1);
    const appended = JSON.parse(h.stub.appendRequests[0]?.body ?? "{}");
    expect(appended.labels).toEqual({
      kind: "hypothesis",
      name: res.json.id,
      status: "draft",
      owner: slugifyOwner(OWNER),
    });
    expect(appended.content.split("\n")[0]).toBe("Copper is the new oil");
    expect(appended.content).toContain(OWNER);
    // The body carries NO provenance keys — O7 rejects those 400.
    expect(appended.created_by_worker).toBeUndefined();
    expect(appended.created_by_session).toBeUndefined();
  });

  it("hypotheses_create: polls the by-name route until the status leaves creating", async () => {
    const h = await harness({
      byName: [
        { status: 200, body: JSON.stringify({ id: "s1", status: "creating" }) },
        { status: 200, body: JSON.stringify({ id: "s1", status: "creating" }) },
        { status: 200, body: JSON.stringify({ id: "s1", status: "running" }) },
      ],
    });
    const res = await post(h, "/api/hypotheses", { title: "Patience" });
    expect(res.status).toBe(201);
    const polls = h.stub.requests.filter((r) => r.path.startsWith("/agent/sessions/by-name/"));
    expect(polls).toHaveLength(3);
    expect(h.stub.appendRequests).toHaveLength(1);
  });

  it("hypotheses_create: no cookie is 401 and creates nothing", async () => {
    const h = await harness({});
    const res = await post(h, "/api/hypotheses", { title: "nope" }, false);
    expect(res.status).toBe(401);
    expect(h.stub.createSessionRequests).toHaveLength(0);
  });

  it("hypotheses_create: an empty title is 400 invalid and creates nothing", async () => {
    const h = await harness({});
    const res = await post(h, "/api/hypotheses", { title: "   " });
    expect(res.status).toBe(400);
    expect(res.json.kind).toBe("invalid");
    expect(h.stub.createSessionRequests).toHaveLength(0);
  });

  // The five enumerated create-failure surfaces, each mapped — and NOT ONE of
  // them may leave a hypothesis memory behind.
  const failures: {
    name: string;
    stub: StubConfig;
    status: number;
    kind: string;
    messageContains?: string;
  }[] = [
    {
      name: "409 session name already taken → conflict",
      stub: { createSession: { status: 409, body: "session name already taken\n" } },
      status: 409,
      kind: "conflict",
    },
    {
      name: '404 no worker "interviewer" → misconfigured naming the bootstrap',
      stub: { createSession: { status: 404, body: 'no worker "interviewer" in this project\n' } },
      status: 500,
      kind: "misconfigured",
      messageContains: "scripts/bootstrap-project.ts",
    },
    {
      name: '409 worker "interviewer" is disabled → conflict',
      stub: { createSession: { status: 409, body: 'worker "interviewer" is disabled\n' } },
      status: 409,
      kind: "conflict",
    },
    {
      name: "501 session names are not configured → misconfigured",
      stub: {
        createSession: { status: 501, body: "session names are not configured on this host\n" },
      },
      status: 501,
      kind: "misconfigured",
    },
    {
      name: "403 no project in token → misconfigured naming WOLF_API_KEY",
      stub: { createSession: { status: 403, body: "no project in token\n" } },
      status: 500,
      kind: "misconfigured",
      messageContains: "WOLF_API_KEY",
    },
    {
      name: 'a polled status:"error" → unavailable 503 with create_error verbatim',
      stub: {
        byName: [
          {
            status: 200,
            body: JSON.stringify({
              id: "s1",
              status: "error",
              create_error: "host port pool is exhausted",
            }),
          },
        ],
      },
      status: 503,
      kind: "unavailable",
      messageContains: "host port pool is exhausted",
    },
  ];

  for (const failure of failures) {
    it(`hypotheses_create: ${failure.name}, and appends NO memory`, async () => {
      const h = await harness(failure.stub);
      const res = await post(h, "/api/hypotheses", { title: "Doomed" });

      expect(res.status).toBe(failure.status);
      expect(res.json.kind).toBe(failure.kind);
      if (failure.messageContains !== undefined) {
        expect(res.json.message).toContain(failure.messageContains);
      }
      // The trusted `kind=hypothesis, status=draft` memory is appended ONLY
      // after the poll succeeds: an id in the memory bus with no session
      // behind it is an anomaly nobody created.
      expect(h.stub.appendRequests).toHaveLength(0);
    });
  }

  it("hypotheses_create: Orange refusing on the port pool is `unavailable` with the upstream string intact, not `forbidden`", async () => {
    const h = await harness({
      createSession: { status: 403, body: "host port pool is exhausted\n" },
    });
    const res = await post(h, "/api/hypotheses", { title: "No ports" });

    expect(res.status).toBe(503);
    expect(res.json.kind).toBe("unavailable");
    // Operational and actionable: deleting a finished session frees a port, so
    // the retryable kind is right here (owner decision B7).
    expect(res.json.message).toContain("host port pool is exhausted");
    expect(h.stub.appendRequests).toHaveLength(0);
  });

  it("hypotheses_create: a session stuck in `creating` times out as unavailable, leaving no memory", async () => {
    const h = await harness({
      byName: [{ status: 200, body: JSON.stringify({ id: "s1", status: "creating" }) }],
    });
    const res = await post(h, "/api/hypotheses", { title: "Stuck" });

    expect(res.status).toBe(503);
    expect(res.json.kind).toBe("unavailable");
    expect(h.stub.appendRequests).toHaveLength(0);
  });
});

// ── GET /api/hypotheses/:id ─────────────────────────────────────────────

describe("hypotheses_detail", () => {
  const ID = "1a1a1a1a";
  const SESSION_ID = "sess-hyp-1a1a1a1a";

  function specJson(): string {
    return fixture("worked-spec.json");
  }

  function baseStub(): StubConfig {
    return {
      sessions: [sessionRow(`hyp-${ID}`, SESSION_ID)],
      board: page([stateRow(ID, "draft", "Copper is the new oil")]),
      details: { [`hypothesis:${ID}`]: page([stateRow(ID, "draft", "Copper is the new oil")]) },
    };
  }

  it("hypotheses_detail: a draft returns its CANDIDATE spec, labelled as such, with W3's validation", async () => {
    const stub = baseStub();
    stub.details![`hypothesis-spec-candidate:${ID}`] = page([
      memoryRow({
        id: "cand-1",
        labels: { kind: "hypothesis-spec-candidate", name: ID },
        snippet: "proposed spec",
        createdBySession: SESSION_ID, // untrusted by construction — an interview wrote it
      }),
    ]);
    stub.memoriesById = {
      "cand-1": JSON.stringify({
        id: "cand-1",
        labels: { kind: "hypothesis-spec-candidate", name: ID },
        content: `a summary line\n${specJson()}`,
        created_by_worker: "",
        created_by_session: SESSION_ID,
        created_at: 1787334047000,
      }),
    };
    const h = await harness(stub);
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.status).toBe(200);
    expect(res.json.spec_source).toBe("hypothesis-spec-candidate");
    expect(res.json.spec.thesis).toBeTypeOf("string");
    // W13's Go Live button needs the blocking reasons BEFORE the click; W9's
    // 422 only exists after it.
    expect(res.json.spec_validation).toEqual({ valid: true, errors: [] });
    // No locked spec ⇒ no dataset names yet.
    expect(res.json.atoms.datasets).toEqual([]);
    expect(res.json.atoms.worker).toBe(`researcher-${ID}`);
    expect(res.json.atoms.schedule_id).toBeNull();
    expect(res.json.atoms.session_id).toBe(SESSION_ID);
  });

  it("hypotheses_detail: a locked spec wins over a candidate, and names the datasets", async () => {
    const stub = baseStub();
    stub.details![`hypothesis-spec:${ID}`] = page([
      memoryRow({
        id: "spec-1",
        labels: { kind: "hypothesis-spec", name: ID, status: "locked" },
        snippet: "{",
      }),
    ]);
    stub.details![`hypothesis-spec-candidate:${ID}`] = page([
      memoryRow({ id: "cand-1", labels: { kind: "hypothesis-spec-candidate", name: ID }, createdBySession: SESSION_ID }),
    ]);
    stub.memoriesById = {
      "spec-1": JSON.stringify({
        id: "spec-1",
        labels: { kind: "hypothesis-spec", name: ID, status: "locked" },
        content: specJson(),
        created_by_worker: "",
        created_by_session: "",
        created_at: 1787334047000,
      }),
    };
    stub.schedules = JSON.stringify({
      schedules: [
        { id: "sched-1", project: "wolf", worker: `researcher-${ID}`, cron: "0 6 * * *", input: "", enabled: true },
        { id: "sched-2", project: "wolf", worker: "critic", cron: "0 4 * * 1", input: "", enabled: true },
      ],
    });
    const h = await harness(stub);
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.json.spec_source).toBe("hypothesis-spec");
    const spec = JSON.parse(specJson()) as { metrics: { slug: string }[] };
    expect(res.json.atoms.datasets).toEqual(spec.metrics.map((m) => `${ID}-${m.slug}`));
    expect(res.json.atoms.schedule_id).toBe("sched-1");
  });

  it("hypotheses_detail: a spec-shaped memory written INSIDE a container is not accepted as the locked spec", async () => {
    const stub = baseStub();
    stub.details![`hypothesis-spec:${ID}`] = page([
      memoryRow({
        id: "forged-spec",
        labels: { kind: "hypothesis-spec", name: ID, status: "locked" },
        createdByWorker: `researcher-${ID}`,
      }),
    ]);
    const h = await harness(stub);
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.json.spec).toBeNull();
    expect(res.json.spec_source).toBeNull();
    expect(res.json.spec_validation.valid).toBe(false);
  });

  it("hypotheses_detail: notes and amendments come back as untrusted evidence carrying their writer", async () => {
    const stub = baseStub();
    stub.details![`research-note:${ID}`] = page([
      memoryRow({
        id: "note-1",
        labels: { kind: "research-note", name: ID },
        snippet: "copper closed at 4.21",
        createdByWorker: `researcher-${ID}`,
      }),
    ]);
    stub.details![`spec-amendment:${ID}`] = page([
      memoryRow({
        id: "amend-1",
        labels: { kind: "spec-amendment", name: ID, status: "proposed" },
        snippet: "widen the flat band",
        createdBySession: SESSION_ID,
      }),
    ]);
    const h = await harness(stub);
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.json.notes).toHaveLength(1);
    expect(res.json.notes[0].created_by_worker).toBe(`researcher-${ID}`);
    expect(res.json.amendments).toHaveLength(1);
    expect(res.json.amendments[0].status).toBe("proposed");
    expect(res.json.amendments[0].created_by_session).toBe(SESSION_ID);
  });

  it("hypotheses_detail: attention requests are attributed by worker OR by session, and nothing else is", async () => {
    const stub = baseStub();
    stub.attention = JSON.stringify({
      attention_requests: [
        { id: "ar-1", session_id: SESSION_ID, worker: "", message: "which basket?", created_at: 1787334311, expires_at: 1787334911 },
        { id: "ar-2", session_id: "other-session", worker: `researcher-${ID}`, message: "provider outage", created_at: 1787334312, expires_at: 1787334912 },
        { id: "ar-3", session_id: "other-session", worker: "researcher-99999999", message: "not mine", created_at: 1787334313, expires_at: 1787334913 },
      ],
    });
    const h = await harness(stub);
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.json.attention_requests.map((a: any) => a.id)).toEqual(["ar-1", "ar-2"]);
    // Unix SECONDS on that row — hence the field name.
    expect(res.json.attention_requests[0].created_at_sec).toBe(1787334311);
  });

  it("hypotheses_detail: returns the trusted evaluation snapshot and the trusted verdict, in full", async () => {
    const stub = baseStub();
    stub.board = page([stateRow(ID, "confirmed", "Copper is the new oil")]);
    stub.details![`hypothesis:${ID}`] = page([stateRow(ID, "confirmed", "Copper is the new oil")]);
    stub.details![`evaluation:${ID}`] = page([
      memoryRow({ id: "eval-1", labels: { kind: "evaluation", name: ID }, snippet: "score=0.5 …" }),
    ]);
    stub.details![`verdict:${ID}`] = page([
      memoryRow({
        id: "verdict-1",
        labels: { kind: "verdict", name: ID, status: "confirmed" },
        snippet: "the thesis held",
        createdAtMs: 1787334048000,
      }),
    ]);
    stub.memoriesById = {
      "eval-1": JSON.stringify({
        id: "eval-1",
        labels: { kind: "evaluation", name: ID },
        // Line 1 is the summary; the rest is the full snapshot (§ "Memory kinds").
        content:
          'score=0.5 tripped=0 holding=2 indeterminate=0 evaluated=2026-08-20T06:05:00Z\n' +
          '{"evaluated_at_ms":1787334047000,"support_score":0.5,"conditions":[],"metrics":[]}',
        created_by_worker: "",
        created_by_session: "",
        created_at: 1787334047000,
      }),
      "verdict-1": JSON.stringify({
        id: "verdict-1",
        labels: { kind: "verdict", name: ID, status: "confirmed" },
        content: "the thesis held\n\ndecided by kai@badcode.dev",
        created_by_worker: "",
        created_by_session: "",
        created_at: 1787334048000,
      }),
    };
    const h = await harness(stub);
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.json.evaluation).toEqual({
      evaluated_at_ms: 1787334047000,
      support_score: 0.5,
      conditions: [],
      metrics: [],
    });
    expect(res.json.verdict.status).toBe("confirmed");
    expect(res.json.verdict.content).toContain("decided by kai@badcode.dev");
    expect(res.json.verdict.created_at_ms).toBe(1787334048000);
    expect(res.json.hypothesis.status).toBe("confirmed");
    // Every key the criterion names is present, and none is silently dropped.
    expect(Object.keys(res.json).sort()).toEqual(
      [
        "amendments",
        "atoms",
        "attention_requests",
        "evaluation",
        "hypothesis",
        "notes",
        "spec",
        "spec_source",
        "spec_validation",
        "verdict",
      ].sort(),
    );
  });

  it("hypotheses_detail: a verdict written INSIDE a container is not returned as the verdict", async () => {
    const stub = baseStub();
    stub.details![`verdict:${ID}`] = page([
      memoryRow({
        id: "forged-verdict",
        labels: { kind: "verdict", name: ID, status: "confirmed" },
        createdBySession: SESSION_ID,
      }),
    ]);
    const h = await harness(stub);
    const res = await get(h, `/api/hypotheses/${ID}`);
    expect(res.json.verdict).toBeNull();
  });

  it("hypotheses_detail: an id with no session is 404, and a malformed id is 400", async () => {
    const h = await harness(baseStub());
    expect((await get(h, "/api/hypotheses/deadbeef")).status).toBe(404);

    const malformed = await get(h, `/api/hypotheses/hyp-${ID}`);
    expect(malformed.status).toBe(400);
    expect(malformed.json.kind).toBe("invalid");
  });

  it("hypotheses_detail: with no cookie it is 401", async () => {
    const h = await harness(baseStub());
    const res = await get(h, `/api/hypotheses/${ID}`, false);
    expect(res.status).toBe(401);
  });

  it("hypotheses_detail: never queries with a doubled hyp- prefix", async () => {
    const h = await harness(baseStub());
    await get(h, `/api/hypotheses/${ID}`);
    for (const request of h.stub.requests) {
      expect(request.path).not.toContain("hyp-hyp-");
    }
  });
});
