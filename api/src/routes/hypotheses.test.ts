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
import { createBobClient } from "../bob/client.js";
import { setSessionCookie } from "../auth/session.js";
import {
  SESSION_NAME_PATTERN,
  createHypothesisStore,
  slugifyOwner,
  type SessionLookup,
  type Tamper,
} from "../hypothesis/store.js";
import {
  ATTENTION_TIERS,
  attentionRequestNames,
  attentionTierFor,
  createHypothesesRouter,
  mergeTamper,
  type AttentionInputs,
  type AttentionTier,
  seedMessage,
} from "./hypotheses.js";
import type { ReportComposeStats } from "./report.js";

// design/2026-08-20-agent-wolf.md, W8's acceptance criteria. Test names are
// prefixed `hypotheses_`.
//
// Bob is mocked with undici's MockAgent (the pinned mechanism). Two kinds
// of body appear below:
//
//  - **Captured** — `../hypothesis/__fixtures__/*.json`, recorded verbatim from
//    a running O11 build for W5 (see that directory's README). The tamper
//    pass-through test is graded against those, because only Bob can say
//    what `retracted_by` really contains.
//  - **Synthetic** — every body built by `memoryRow`/`page` below. They are
//    hand-built and are NOT presented as recordings: no `kind=evaluation` row
//    exists in any capture, because nothing writes one until W10.

const BOB = "http://bob.test:4100";
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

/**
 * A `kind=report` row. Provenance is NEVER empty — a researcher inside a
 * container is what writes one — so the id embeds the writer, which is what
 * lets a tamper assertion name the offending row as a literal.
 */
function reportRow(
  id: string,
  headline: string,
  worker: string,
  session: string,
): Record<string, unknown> {
  return memoryRow({
    id: `rep-${id}-${worker}`,
    labels: { kind: "report", name: id },
    snippet: `${headline}\n{"headline":"<p>x</p>"}`,
    createdByWorker: worker,
    createdBySession: session,
  });
}

// ── The stub Bob ─────────────────────────────────────────────────────

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
  /** `POST /agent/session/{id}/message` — the interview seed. */
  sendMessage?: Answer;
  /**
   * `GET /agent/session/{id}/status`, one answer per call — so a test can make
   * the turn appear on the Nth poll and prove the create route waited.
   */
  status?: Answer[];
  /** `latest_per=name` + `selector=kind=hypothesis`. */
  board?: string;
  /** `latest_per=name` + `selector=kind=evaluation`. */
  evaluations?: string;
  /**
   * `latest_per=name` + `selector=kind=report` — the board's THIRD read (W22).
   *
   * ⚠️ It needs its own slot, and not for tidiness. Until W22 this stub
   * dispatched `latest_per` as "starts with kind=evaluation, else the board
   * body", so a `kind=report` board read would have been answered with the
   * `kind=hypothesis` rows and a headline test could have passed against
   * entirely the wrong query (R180).
   */
  reportsLatest?: string;
  /** Per-kind, per-name reads, keyed `<kind>:<id>`. */
  details?: Record<string, string>;
  /** `GET /agent/memories/{id}`. */
  memoriesById?: Record<string, string>;
  /** Status codes `GET /agent/memories/{id}` answers with instead of a body — an UPSTREAM failure, not a parse failure. */
  failMemoryById?: Record<string, number>;
  /** `POST /agent/session`. Default: Bob's real asynchronous answer. */
  createSession?: Answer;
  /** Successive answers to `GET /agent/sessions/by-name/…`; the last repeats. */
  byName?: Answer[];
  attention?: string;
  /** A status code `GET /agent/attention-requests` answers with instead of a body. */
  failAttention?: number;
  schedules?: string;
}

const EMPTY = '{"memories":[]}';

/**
 * `limit` and `include_retracted` on a per-name memory read, HONOURED rather
 * than ignored (W22, R180). Bob applies its not-retracted filter unless
 * the flag is set, and it does so BEFORE any reduction — a stub that ignores
 * the flag lets a read drop it and stay green while production hands back an
 * older row.
 */
function applyListParams(body: string, url: URL): string {
  const parsed = JSON.parse(body) as { memories?: Record<string, unknown>[] };
  let rows = parsed.memories ?? [];
  if (url.searchParams.get("include_retracted") !== "1") {
    rows = rows.filter((row) => {
      const retractions = row["retracted_by"];
      return !Array.isArray(retractions) || retractions.length === 0;
    });
  }
  const limit = Number(url.searchParams.get("limit") ?? "50");
  return JSON.stringify({ memories: rows.slice(0, limit) });
}

class Stub {
  readonly requests: Recorded[] = [];
  private byNameCalls = 0;
  private statusCalls = 0;

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
  get statusRequests(): Recorded[] {
    return this.requests.filter(
      (r) => r.method === "GET" && /^\/agent\/session\/[^/]+\/status$/.test(r.path),
    );
  }

  get messageRequests(): Recorded[] {
    return this.requests.filter(
      (r) => r.method === "POST" && /^\/agent\/session\/[^/]+\/message$/.test(r.path),
    );
  }

  get createSessionRequests(): Recorded[] {
    return this.requests.filter((r) => r.method === "POST" && r.path === "/agent/session");
  }

  install(): void {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      this.pool
        .intercept({ method, path: () => true })
        .reply((opts) => {
          const path = String(opts.path);
          const body = typeof opts.body === "string" ? opts.body : "";
          this.requests.push({ method, path, body });
          const answer = this.route(method, new URL(path, BOB));
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
      // `?user_email=*` is load-bearing against the real Bob (an API key's
      // synthetic email matches no session row), so it is honoured here
      // rather than ignored — W22, R180.
      if (url.searchParams.get("user_email") !== "*") return { status: 200, body: "[]" };
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
      const failure = this.config.failMemoryById?.[id];
      if (failure !== undefined) return { status: failure, body: "bob is having a bad day" };
      const found = this.config.memoriesById?.[id];
      return found === undefined
        ? { status: 404, body: "memory not found" }
        : { status: 200, body: found };
    }
    if (path === "/agent/memories") {
      const selector = url.searchParams.get("selector") ?? "";
      // The selector's OWN `kind=` term, never a prefix test: "kind=report"
      // is a prefix of "kind=report-template", and answering one query with
      // the other's body is how a wrong selector passes.
      const kind = selector
        .split(",")
        .find((term) => term.startsWith("kind="))
        ?.slice("kind=".length);
      if (url.searchParams.get("latest_per") !== null) {
        if (kind === "evaluation") {
          return { status: 200, body: this.config.evaluations ?? EMPTY };
        }
        if (kind === "report") {
          // Honest about `include_retracted`: Bob answers the flagged and
          // unflagged forms DIFFERENTLY, so a read that drops the flag gets
          // the empty page and its test fails loudly.
          return url.searchParams.get("include_retracted") === "1"
            ? { status: 200, body: this.config.reportsLatest ?? EMPTY }
            : { status: 200, body: EMPTY };
        }
        return { status: 200, body: this.config.board ?? EMPTY };
      }
      const match = /kind=([a-z-]+),name=([0-9a-f]{8})/.exec(selector);
      const key = match === null ? "" : `${match[1]}:${match[2]}`;
      return { status: 200, body: applyListParams(this.config.details?.[key] ?? EMPTY, url) };
    }
    if (path === "/agent/attention-requests") {
      if (this.config.failAttention !== undefined) {
        return { status: this.config.failAttention, body: "bob is having a bad day" };
      }
      const parsed = JSON.parse(this.config.attention ?? '{"attention_requests":[]}') as {
        attention_requests?: Record<string, unknown>[];
      };
      let rows = parsed.attention_requests ?? [];
      // `state=open` is honoured rather than ignored (R180): Bob filters
      // answered and timed-out rows out server-side, so a caller that drops
      // the parameter gets MORE rows than it asked for — and a test asserting
      // "only open requests reach the board" would be decoration against a
      // stub that returned everything either way.
      if (url.searchParams.get("state") === "open") {
        // ⚠️ `?? 0` is what makes this filter backward-compatible with the
        // fixtures written before it, and that is worth stating rather than
        // leaving to be rediscovered: the pre-existing `hypotheses_detail`
        // attention fixture omits `answered_at` and `timed_out_at` entirely
        // on all three of its rows, so a strict filter would drop all three
        // and redden a W8 test for a reason unrelated to the code under test.
        //
        // It makes this fake MORE PERMISSIVE than Bob — but only for a
        // hand-written fixture, never for a shape Bob can produce: both
        // fields are NON-POINTER on the Go side (`go/agentdb/attention.go`
        // :54-58), so the real wire always carries them.
        //
        // The two-clause rule is Bob's own, verified rather than guessed:
        // `SessionAwaitsHuman` queries `answered_at = 0 AND timed_out_at = 0`
        // (`go/agentdb/attention.go:278`), and `expires_at` is deliberately
        // NOT part of it — "ExpiresAt 0 means no deadline ... a request
        // without one simply waits" (`:51-52`). Do not add an expiry clause
        // here "for realism": it would make the fake STRICTER than Bob,
        // which is the one direction a fake is never wrong in by accident.
        rows = rows.filter(
          (row) => Number(row["answered_at"] ?? 0) === 0 && Number(row["timed_out_at"] ?? 0) === 0,
        );
      }
      return { status: 200, body: JSON.stringify({ attention_requests: rows }) };
    }
    if (path === "/agent/schedules") {
      return { status: 200, body: this.config.schedules ?? '{"schedules":[]}' };
    }
    // 🔴 `GET /agent/session/{id}/status` — the probe the create route waits on.
    //
    // Until this branch existed the stub 404'd it, the client threw, and the
    // create route took its "could not confirm; answering anyway" escape
    // hatch. Every create test passed WITHOUT EVER EXERCISING THE WAIT that
    // exists to close the race. That is the permissive-fake failure this
    // project's log is full of: the test suite was green on a code path it
    // never entered.
    if (method === "GET" && /^\/agent\/session\/[^/]+\/status$/.test(path)) {
      const answers = this.config.status ?? [
        { status: 200, body: JSON.stringify({ activeQuery: { queryId: "q-1" } }) },
      ];
      const answer = answers[Math.min(this.statusCalls, answers.length - 1)];
      this.statusCalls += 1;
      return answer ?? { status: 500, body: "no status answer configured" };
    }
    // The interview seed. Answered 200 with an SSE-shaped body: the client
    // reads it to completion, which is what lets the turn finish (a cancelled
    // body cancels the turn), so a stub that 404s here would make every create
    // test log a seed failure and prove nothing about the seed.
    if (method === "POST" && /^\/agent\/session\/[^/]+\/message$/.test(path)) {
      return this.config.sendMessage ?? { status: 200, body: "event: done\ndata: {}\n\n" };
    }
    return { status: 404, body: `unrouted in the stub: ${path}` };
  }
}

/**
 * Every PER-NAME memory read the board made — `GET /agent/memories` with a
 * `name=` term in the selector and no `latest_per`. That is the shape W22's
 * forgery follow-up uses and the shape a naive per-hypothesis projection
 * would use, so counting it by NAME is what keeps the budget honest.
 */
function perNameSelectors(stub: Stub): string[] {
  return stub.requests
    .filter((r) => r.path.startsWith("/agent/memories?") && !r.path.includes("latest_per="))
    .map((r) => new URL(r.path, BOB).searchParams.get("selector") ?? "");
}
/** Every `GET /agent/memories/{id}` — the FULL-CONTENT read drift would need. */
function fullContentReads(stub: Stub): string[] {
  return stub.requests
    .filter((r) => r.method === "GET" && /^\/agent\/memories\/[^?]/.test(r.path))
    .map((r) => r.path);
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
  pool = mockAgent.get(BOB);
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
      BOB_BASE_URL: BOB,
      NODE_ENV: "test",
    },
    { readRouteTable: () => undefined },
  );
}

/**
 * Wait until the fire-and-forget interview seed has reached the stub.
 *
 * Polls rather than sleeps: a fixed sleep is either flaky or slow, and this
 * resolves on the first tick where the request exists. It THROWS on timeout
 * instead of returning quietly — a helper that gives up silently would turn
 * "the seed never fired" into a passing test with an empty array.
 */
async function waitForMessage(h: Harness, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (h.stub.messageRequests.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the interview seed never reached the stub");
}

interface Harness {
  base: string;
  stub: Stub;
  cookie: string;
  /** Every `composeReportStats` call the router made, when one was injected. */
  statsCalls: { id: string; sessions?: SessionLookup }[];
}

/**
 * W22's optional wiring. `app.ts` passes W21's real `composeReportStats`; a
 * router built without one must degrade honestly rather than invent a number,
 * and BOTH halves of that are graded below.
 */
interface HarnessOptions {
  composeReportStats?: (
    id: string,
    options?: { sessions?: SessionLookup },
  ) => Promise<ReportComposeStats | null>;
}

async function harness(stubConfig: StubConfig, opts: HarnessOptions = {}): Promise<Harness> {
  const stub = new Stub(pool, stubConfig);
  stub.install();
  const statsCalls: { id: string; sessions?: SessionLookup }[] = [];
  const cfg = config();
  const logger = createLogger({ logLevel: "silent" });
  const client = createBobClient({ baseUrl: cfg.bobBaseUrl, apiKey: cfg.bobApiKey, logger });
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
      // W9's four human routes need WOLF_SCHEDULE_CRON and
      // WOLF_TEARDOWN_DRAIN_SECONDS. Passing the config builds the REAL
      // provisioner, so a 401 below proves that nothing was written rather
      // than that a fake was not called.
      config: cfg,
      // The create poll must not take real seconds in a unit test.
      sessionPollIntervalMs: 1,
      sessionPollTimeoutMs: 40,
      // Same reason, for the wait on the seeded turn being registered.
      seedPollIntervalMs: 1,
      seedRegisterTimeoutMs: 40,
      ...(opts.composeReportStats === undefined
        ? {}
        : {
            composeReportStats: async (id: string, options?: { sessions?: SessionLookup }) => {
              statsCalls.push({ id, ...(options?.sessions === undefined ? {} : { sessions: options.sessions }) });
              return opts.composeReportStats!(id, options);
            },
          }),
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
  return { base, stub, cookie, statsCalls };
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

// ── The fake's own behaviour (R180) ─────────────────────────────────────
//
// 🔴 A fake is load-bearing test infrastructure that no mutation can reach: a
// mutation of FIXTURE code dies nowhere, because mutation testing's whole
// mechanism is "change the code, watch a test fail" and a fake has no test
// above it to fail. The prescription is to TEST THE FAKE'S OWN BEHAVIOUR,
// driven through the real client — so a fixture regression fails here, on its
// own, rather than silently re-converting a downstream defence into
// decoration.
//
// Without this, exactly one board case observed the `state=open` filter, and
// it observed it incidentally: rewrite that case and the fake could quietly
// revert to permissive with nothing red.

describe("stub_attention_requests", () => {
  const ANSWERED = {
    id: "ar-answered", session_id: "sess-a", worker: "interviewer", message: "already dealt with",
    created_at: 1787334311, expires_at: 1787334911, answered_at: 1787334400, timed_out_at: 0,
  };
  const TIMED_OUT = {
    id: "ar-timed-out", session_id: "sess-b", worker: "interviewer", message: "nobody answered",
    created_at: 1787334311, expires_at: 1787334911, answered_at: 0, timed_out_at: 1787334500,
  };
  const OPEN = {
    id: "ar-open", session_id: "sess-c", worker: "interviewer", message: "which basket?",
    created_at: 1787334311, expires_at: 1787334911, answered_at: 0, timed_out_at: 0,
  };

  function client(): ReturnType<typeof createBobClient> {
    const stub = new Stub(pool, {
      attention: JSON.stringify({ attention_requests: [ANSWERED, TIMED_OUT, OPEN] }),
    });
    stub.install();
    return createBobClient({
      baseUrl: BOB,
      apiKey: API_KEY,
      logger: createLogger({ logLevel: "silent" }),
    });
  }

  it("stub_attention_requests: with state=open the fake hides an ANSWERED request", async () => {
    const rows = await client().listAttentionRequests({ state: "open" });
    // Levelled against its TIMED-OUT twin below (R222 — this round's own
    // sweep): the twin names the row it expects gone, and so does this one.
    expect(rows.map((r) => r.id)).not.toContain("ar-answered");
    expect(rows.map((r) => r.id)).toEqual(["ar-open"]);
  });

  it("stub_attention_requests: with state=open the fake hides a TIMED-OUT request", async () => {
    // The twin of the case above, on the other of Bob's two closing
    // conditions — asserted the same way, so neither half is the thin one.
    const rows = await client().listAttentionRequests({ state: "open" });
    expect(rows.map((r) => r.id)).not.toContain("ar-timed-out");
    expect(rows.map((r) => r.id)).toEqual(["ar-open"]);
  });

  it("stub_attention_requests: WITHOUT the parameter the fake returns all three", async () => {
    // 🔴 The half that makes the two above mean something. A fake that
    // returned one row whatever it was asked would satisfy them both; only
    // the unfiltered call proves the parameter is what did the work.
    const rows = await client().listAttentionRequests();
    expect(rows.map((r) => r.id)).toEqual(["ar-answered", "ar-timed-out", "ar-open"]);
  });

  it("stub_attention_requests: an EXPIRED but unanswered request is still OPEN, as Bob defines it", async () => {
    // Bob's `open` is `answered_at = 0 AND timed_out_at = 0` and nothing
    // else (`go/agentdb/attention.go:278`); `expires_at` is not a clause,
    // because a request without a deadline "simply waits" (`:51-52`). Pinned
    // so nobody adds an expiry filter to the fake "for realism" and makes it
    // STRICTER than the thing it stands in for.
    const stub = new Stub(pool, {
      attention: JSON.stringify({
        attention_requests: [
          { id: "ar-expired", session_id: "sess-e", worker: "interviewer", message: "long overdue", created_at: 1, expires_at: 2, answered_at: 0, timed_out_at: 0 },
        ],
      }),
    });
    stub.install();
    const rows = await createBobClient({
      baseUrl: BOB, apiKey: API_KEY, logger: createLogger({ logLevel: "silent" }),
    }).listAttentionRequests({ state: "open" });
    expect(rows.map((r) => r.id)).toEqual(["ar-expired"]);
  });

  it("stub_attention_requests: a row omitting answered_at/timed_out_at is treated as OPEN", async () => {
    // The backward-compatibility branch, pinned rather than left implicit —
    // the pre-existing detail fixture's rows have neither field. On the real
    // wire both are non-pointer and always present, so this leniency can only
    // ever affect a hand-written fixture.
    const stub = new Stub(pool, {
      attention: JSON.stringify({
        attention_requests: [
          { id: "ar-legacy", session_id: "sess-d", worker: "interviewer", message: "no state fields", created_at: 1787334311, expires_at: 1787334911 },
        ],
      }),
    });
    stub.install();
    const rows = await createBobClient({
      baseUrl: BOB, apiKey: API_KEY, logger: createLogger({ logLevel: "silent" }),
    }).listAttentionRequests({ state: "open" });
    expect(rows.map((r) => r.id)).toEqual(["ar-legacy"]);
  });
});

// ── The attention model (W27) ───────────────────────────────────────────
//
// The tier table is pinned in `design/2026-08-24-agent-wolf-ui.md` § 4. Every
// rule and every boundary has a row here, INCLUDING `draft` — which the
// ticket's own fixture vocabulary never named, and which is not terminal, so
// draft rows do reach the board (R163).
//
// 🔴 The tier literals below are written out, never read through
// `ATTENTION_TIERS` or through the function under test: an assertion that
// travels with the bug is not an assertion (R133).

describe("hypotheses_attention_tier", () => {
  function inputs(overrides: Partial<AttentionInputs> = {}): AttentionInputs {
    // A healthy `live` row: nothing raised, nothing stale, a report that said
    // something. Every case below is this, plus exactly one thing.
    return { status: "live", headline: "the basket held", ...overrides };
  }

  const cases: {
    what: string;
    row: AttentionInputs;
    requested: boolean;
    tier: AttentionTier;
    why: string;
  }[] = [
    {
      what: "a challenged row",
      row: inputs({ status: "challenged" }),
      requested: false,
      tier: "needs_human",
      why: "rule 1, first clause: a tripped condition is the moment the product exists for",
    },
    {
      what: "a row with only tamper",
      row: inputs({
        tamper: [
          {
            reason: "forged_row",
            written_by_worker: "researcher-99999999",
            written_by_session: "sess-hostile",
            memory_id: "mem-7f3a",
          },
        ],
      }),
      requested: false,
      tier: "needs_human",
      why: "rule 1, second clause: an attack on the record is not something to watch",
    },
    {
      what: "a row with only an attention request",
      row: inputs(),
      requested: true,
      tier: "needs_human",
      why: "rule 1, third clause: the agent asked a person a question",
    },
    {
      what: "a live row with headline === null",
      row: inputs({ headline: null }),
      requested: false,
      tier: "watch",
      why: "the cheap board-level proxy for 'the report layer is not working' (§ 4 point 4)",
    },
    {
      what: 'a live row whose headline is ""',
      row: inputs({ headline: "" }),
      requested: false,
      tier: "holding",
      why: '"" is a report that said nothing on line 1, which is NOT the absence of a report',
    },
    {
      what: "a live row with an attention count",
      row: inputs({ attention_count: 1 }),
      requested: false,
      tier: "watch",
      why: "a condition has been indeterminate three ticks running",
    },
    {
      what: "a live row with a stale count",
      row: inputs({ stale_count: 2 }),
      requested: false,
      tier: "watch",
      why: "evidence stopped arriving; nothing has tripped yet",
    },
    {
      what: "a live row whose counts are explicit ZEROS",
      row: inputs({ attention_count: 0, stale_count: 0 }),
      requested: false,
      tier: "holding",
      why: "the boundary: the rule is `> 0`, and a zero is a reading of nothing raised",
    },
    {
      what: "a healthy live row",
      row: inputs(),
      requested: false,
      tier: "holding",
      why: "nothing matched: everything else falls through to HOLDING",
    },
    {
      what: "a DRAFT row",
      row: inputs({ status: "draft", headline: null }),
      requested: false,
      tier: "in_interview",
      why: "🔴 draft is NOT terminal, so it reaches the board — and WATCH is live-only, so a draft with no report is an interview, not a problem",
    },
    {
      what: "a DRAFT row with tamper",
      row: inputs({
        status: "draft",
        tamper: [
          {
            reason: "hostile_retraction",
            written_by_worker: "researcher-99999999",
            written_by_session: "sess-hostile",
            memory_id: "mem-9c1b",
          },
        ],
      }),
      requested: false,
      tier: "needs_human",
      why: "rule 1 is tested before rule 3: an attack outranks the interview it happened during",
    },
    {
      what: "a DRAFT row with an open attention request",
      row: inputs({ status: "draft" }),
      requested: true,
      tier: "needs_human",
      why: "the same ordering, on the other clause of rule 1: an interview that asked a person a question is waiting on that person",
    },
    {
      what: "a CONFIRMED row",
      row: inputs({ status: "confirmed" }),
      requested: false,
      tier: "holding",
      why: "terminal rows are filtered off the board CLIENT-SIDE by W13; this side does not filter, so they tier as 'everything else'",
    },
    {
      what: "a row with NO trusted state row at all",
      row: inputs({ status: null, headline: null }),
      requested: false,
      tier: "holding",
      why: "null status matches no rule; the anomaly it carries is normally tamper, which rule 1 catches first",
    },
  ];

  for (const c of cases) {
    it(`hypotheses_attention_tier: ${c.what} → ${c.tier} (${c.why})`, () => {
      expect(attentionTierFor(c.row, c.requested)).toBe(c.tier);
    });
  }

  it("hypotheses_attention_tier: the four tiers are exactly these, in this order", () => {
    // The wire vocabulary W13's fixtures already consume. Renaming one
    // silently makes every board row render as unclassified.
    expect(ATTENTION_TIERS).toEqual(["needs_human", "watch", "in_interview", "holding"]);
  });

  it("hypotheses_attention_tier: every case above lands on one of the four, and every tier is exercised", () => {
    // Guards the table itself: a rule added without a case, or a case whose
    // expected tier is a typo, both show up here.
    const produced = new Set(cases.map((c) => attentionTierFor(c.row, c.requested)));
    expect([...produced].sort()).toEqual(["holding", "in_interview", "needs_human", "watch"]);
  });
});

describe("hypotheses_attention_names", () => {
  const ID = "1a1a1a1a";
  const SESSION_ID = "sess-hyp-1a1a1a1a";

  it("hypotheses_attention_names: a request names a hypothesis by its RESEARCHER worker", () => {
    expect(
      attentionRequestNames({ worker: `researcher-${ID}`, sessionId: "sess-tick" }, ID, SESSION_ID),
    ).toBe(true);
  });

  it("hypotheses_attention_names: a request names a hypothesis by its hyp- SESSION id", () => {
    // The interviewer clause: an interview's ask carries `worker: ""` and only
    // the session id can attribute it.
    expect(attentionRequestNames({ worker: "", sessionId: SESSION_ID }, ID, SESSION_ID)).toBe(true);
  });

  it("hypotheses_attention_names: another hypothesis's researcher does NOT name this one", () => {
    expect(
      attentionRequestNames({ worker: "researcher-99999999", sessionId: "sess-other" }, ID, SESSION_ID),
    ).toBe(false);
  });

  it("hypotheses_attention_names: a hypothesis whose session id Wolf never resolved absorbs nothing", () => {
    // ⚠️ Honest label, after a mutation proved the point: deleting the
    // `sessionId !== null` guard does NOT change this answer, because a
    // string is never `===` null in the first place. The guard is TYPE
    // narrowing, not a behavioural defence — this test pins the behaviour
    // (an unresolved hypothesis matches nothing) and no mutation of that one
    // clause can break it.
    expect(attentionRequestNames({ worker: "interviewer", sessionId: "" }, ID, null)).toBe(false);
    expect(attentionRequestNames({ worker: "interviewer", sessionId: "sess-anything" }, ID, null)).toBe(false);
  });
});

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

  it("hypotheses_board: issues exactly THREE latest_per requests for twelve hypotheses", async () => {
    const h = await harness(twelve());
    const res = await get(h, "/api/hypotheses");

    expect(res.status).toBe(200);
    expect(res.json).toHaveLength(12);
    // O(1) in the hypothesis count: state, evaluations, reports. Twelve
    // hypotheses cost the same three reads as one. (W27 adds ONE project-wide
    // attention read on top; it is not a `latest_per` request and is not
    // this ticket's — UI design § 4 point 3.)
    expect(h.stub.latestPerRequests).toHaveLength(3);
    const paths = h.stub.latestPerRequests.map((r) => r.path).sort();
    expect(paths[0]).toContain("selector=kind%3Devaluation");
    expect(paths[0]).toContain("latest_per=name");
    expect(paths[1]).toContain("selector=kind%3Dhypothesis");
    expect(paths[1]).toContain("latest_per=name");
    // Load-bearing on the state read: without it a hostile retraction rolls the
    // board back to the previous status silently (R90).
    expect(paths[1]).toContain("include_retracted=1");
    expect(paths[2]).toContain("selector=kind%3Dreport&");
    expect(paths[2]).toContain("latest_per=name");
    // And on the report read, for exactly the same reason.
    expect(paths[2]).toContain("include_retracted=1");
  });

  // ── W27: the request budget, restated ─────────────────────────────────

  it("hypotheses_board: twelve hypotheses cost THREE latest_per requests, ONE attention read, and no per-name read", async () => {
    const h = await harness(twelve());
    const res = await get(h, "/api/hypotheses");

    expect(res.status).toBe(200);
    expect(res.json).toHaveLength(12);
    // 🔴 Counted as `latest_per` requests SPECIFICALLY, never as a total.
    // W22 issues one further PER-NAME read for every hypothesis whose newest
    // `kind=report` row is a forgery, and that read sends no `latestPer` — so
    // a total-request assertion here would break the moment anything is
    // attacked, and would have hidden this budget rather than pinned it
    // (R187).
    expect(h.stub.latestPerRequests).toHaveLength(3);
    // Exactly ONE project-wide attention read, whatever the hypothesis count.
    const attentionReads = h.stub.requests.filter((r) => r.path.startsWith("/agent/attention-requests"));
    expect(attentionReads).toHaveLength(1);
    expect(attentionReads[0]!.path).toContain("state=open");
    // And nothing attacked, so no per-name memory read at all.
    expect(perNameSelectors(h.stub)).toEqual([]);
  });

  it("hypotheses_board: the per-name reads are one per ATTACKED hypothesis, and nothing else grows with the count", async () => {
    // The honest statement of the budget: `3 + 1 + O(attacked)`, and the
    // attacker chooses the last term. Two forged newest reports here, twelve
    // hypotheses, two follow-ups.
    const victims = [ids[1]!, ids[2]!];
    const attacker = ids[0]!;
    const stub = twelve();
    stub.details = {};
    stub.reportsLatest = page(
      victims.map((v) => reportRow(v, "sell everything", `researcher-${attacker}`, `sess-hyp-${attacker}`)),
    );
    for (const v of victims) {
      stub.details[`report:${v}`] = page([
        reportRow(v, "sell everything", `researcher-${attacker}`, `sess-hyp-${attacker}`),
        reportRow(v, `${v} is fine`, `researcher-${v}`, "sess-tick"),
      ]);
    }
    const h = await harness(stub);
    const res = await get(h, "/api/hypotheses");

    expect(h.stub.latestPerRequests).toHaveLength(3);
    const attentionReads = h.stub.requests.filter((r) => r.path.startsWith("/agent/attention-requests"));
    expect(attentionReads).toHaveLength(1);
    expect(attentionReads[0]!.path).toContain("state=open");
    // 🔴 Exactly the attacked two — named, not counted, so the same row twice
    // could not satisfy it.
    expect(perNameSelectors(h.stub).sort()).toEqual(
      [`kind=report,name=${victims[0]}`, `kind=report,name=${victims[1]}`].sort(),
    );
    const byId = new Map<string, any>(res.json.map((r: any) => [r.id, r]));
    expect(byId.get(victims[0]!)!.headline).toBe(`${victims[0]} is fine`);
    expect(byId.get(victims[1]!)!.headline).toBe(`${victims[1]} is fine`);
  });

  it("hypotheses_board: issues NO per-hypothesis read for report drift", async () => {
    // Drift compares a template's structure hash against a report's slot ids
    // and needs TWO full-content reads per hypothesis. It is deliberately not
    // a board signal (§ 4 point 4). This asserts the absence by NAME: no
    // `kind=report-template` read of any shape, and no `GET
    // /agent/memories/{id}` full-content read at all.
    const stub = twelve();
    stub.reportsLatest = page(
      ids.map((id) => reportRow(id, `${id} headline`, `researcher-${id}`, "sess-tick")),
    );
    const h = await harness(stub);
    const res = await get(h, "/api/hypotheses");

    expect(res.json).toHaveLength(12);
    expect(h.stub.requests.filter((r) => r.path.includes("report-template"))).toEqual([]);
    expect(fullContentReads(h.stub)).toEqual([]);
    // The proxy that replaces it costs nothing and is on every row.
    expect(res.json.every((r: any) => typeof r.headline === "string")).toBe(true);
  });

  // ── W27: the projections ──────────────────────────────────────────────

  it("hypotheses_board: every row carries restated_from, so /archive CAN stop paying a detail read per terminal row", async () => {
    const stub = twelve();
    stub.board = page([
      { ...stateRow(ids[0]!, "live", "A restatement"), labels: { kind: "hypothesis", name: ids[0]!, status: "live", owner: slugifyOwner(OWNER), restated_from: "deadbeef" } },
      ...ids.slice(1).map((id, i) => stateRow(id, "live", `Hypothesis ${i + 1}`, 1787334047000 + i)),
    ]);
    const h = await harness(stub);
    const res = await get(h, "/api/hypotheses");

    const byId = new Map<string, any>(res.json.map((r: any) => [r.id, r]));
    expect(byId.get(ids[0]!)!.restated_from).toBe("deadbeef");
    // Absent is null, not undefined: the key is on every row, so the archive
    // never has to ask whether the server is old enough to serve it.
    expect(byId.get(ids[1]!)!.restated_from).toBeNull();
    expect(res.json.every((r: any) => "restated_from" in r)).toBe(true);
  });

  it("hypotheses_board: attention_count and stale_count come off the evaluation line, and ABSENT STAYS ABSENT", async () => {
    const stub = twelve();
    stub.evaluations = page([
      evaluationRow(ids[0]!, "score=-0.42 tripped=0 holding=3 indeterminate=1 evaluated=2026-08-20T06:05:00Z attention=2 stale=1"),
      // The line every evaluation memory written before W27 carries.
      evaluationRow(ids[1]!, "score=-0.42 tripped=0 holding=3 indeterminate=0 evaluated=2026-08-20T06:05:00Z"),
      evaluationRow(ids[2]!, "score=-0.42 tripped=0 holding=3 indeterminate=0 evaluated=2026-08-20T06:05:00Z attention=0"),
    ]);
    const h = await harness(stub);
    const res = await get(h, "/api/hypotheses");

    const byId = new Map<string, any>(res.json.map((r: any) => [r.id, r]));
    expect(byId.get(ids[0]!)!.attention_count).toBe(2);
    expect(byId.get(ids[0]!)!.stale_count).toBe(1);
    // 🔴 The pre-W27 memory: NEITHER key on the wire. `toBeUndefined()` alone
    // would also pass against `attention_count: 0`, so the key set is what is
    // asserted — a zero renders as no chip, so defaulting would be invisible.
    expect("attention_count" in byId.get(ids[1]!)!).toBe(false);
    expect("stale_count" in byId.get(ids[1]!)!).toBe(false);
    // And a zero the poller actually wrote survives as a zero.
    expect(byId.get(ids[2]!)!.attention_count).toBe(0);
    expect("stale_count" in byId.get(ids[2]!)!).toBe(false);
    // A hypothesis with no evaluation row at all: neither key either.
    expect("attention_count" in byId.get(ids[3]!)!).toBe(false);
  });

  it("hypotheses_board: attention_tier is computed server-side, and an OPEN attention request moves one row to needs_human", async () => {
    const stub = twelve();
    stub.evaluations = page([
      evaluationRow(ids[0]!, "score=-0.42 tripped=0 holding=3 indeterminate=1 evaluated=2026-08-20T06:05:00Z attention=2"),
      evaluationRow(ids[1]!, "score=0.10 tripped=0 holding=3 indeterminate=0 evaluated=2026-08-20T06:05:00Z stale=1"),
    ]);
    // Every row except the first three gets a headline, so `headline === null`
    // does not smear WATCH across the whole board.
    stub.reportsLatest = page(
      ids.map((id) => reportRow(id, `${id} headline`, `researcher-${id}`, "sess-tick")),
    );
    stub.attention = JSON.stringify({
      attention_requests: [
        { id: "ar-1", session_id: `sess-hyp-${ids[4]}`, worker: "interviewer", message: "which basket?", created_at: 1787334311, expires_at: 1787334911, answered_at: 0, timed_out_at: 0 },
        // ANSWERED — Bob's `state=open` filter drops it, and so must the board.
        { id: "ar-2", session_id: `sess-hyp-${ids[5]}`, worker: "interviewer", message: "already dealt with", created_at: 1787334312, expires_at: 1787334912, answered_at: 1787334400, timed_out_at: 0 },
      ],
    });
    const h = await harness(stub);
    const res = await get(h, "/api/hypotheses");

    const byId = new Map<string, any>(res.json.map((r: any) => [r.id, r]));
    // Each tier asserted BESIDE the signal that produced it — the sibling
    // shape the headline case below carries. Without this a row could be
    // WATCH for the wrong reason and the assertion would not notice (R198).
    expect(byId.get(ids[0]!)!.attention_count).toBe(2);
    expect(byId.get(ids[0]!)!.attention_tier).toBe("watch");
    expect(byId.get(ids[1]!)!.stale_count).toBe(1);
    expect("attention_count" in byId.get(ids[1]!)!).toBe(false);
    expect(byId.get(ids[1]!)!.attention_tier).toBe("watch");
    expect("attention_count" in byId.get(ids[2]!)!).toBe(false);
    expect("stale_count" in byId.get(ids[2]!)!).toBe(false);
    expect(byId.get(ids[2]!)!.attention_tier).toBe("holding");
    // The open request, by SESSION — the interviewer clause.
    // (see below for the `headline === null` proxy, on its own case)
    expect(byId.get(ids[4]!)!.attention_tier).toBe("needs_human");
    // The answered one changes nothing.
    expect(byId.get(ids[5]!)!.attention_tier).toBe("holding");
  });

  it("hypotheses_board: a LIVE row with no report at all is WATCH, and one whose report said nothing is not", async () => {
    // The cheap board-level proxy for "the report layer is not working"
    // (§ 4 point 4) — end to end, because the tier table alone cannot show
    // that `headline` reaches the rule from the report read. `""` and `null`
    // are different facts and only one of them is a problem.
    const stub = twelve();
    stub.reportsLatest = page([
      reportRow(ids[0]!, "", `researcher-${ids[0]}`, "sess-tick"),
      ...ids.slice(2).map((id) => reportRow(id, `${id} headline`, `researcher-${id}`, "sess-tick")),
    ]);
    const h = await harness(stub);
    const res = await get(h, "/api/hypotheses");

    const byId = new Map<string, any>(res.json.map((r: any) => [r.id, r]));
    // No `kind=report` row at all → headline null → WATCH.
    expect(byId.get(ids[1]!)!.headline).toBeNull();
    expect(byId.get(ids[1]!)!.attention_tier).toBe("watch");
    // A report that said nothing on line 1 → "" → HOLDING.
    expect(byId.get(ids[0]!)!.headline).toBe("");
    expect(byId.get(ids[0]!)!.attention_tier).toBe("holding");
    // And a healthy one is holding too, so WATCH is not the default.
    expect(byId.get(ids[2]!)!.attention_tier).toBe("holding");
  });

  it("hypotheses_board: a CHALLENGED row and a TAMPERED row are both needs_human, and a DRAFT row is in_interview", async () => {
    const stub = twelve();
    stub.details = {};
    stub.board = page([
      stateRow(ids[0]!, "challenged", "Challenged"),
      stateRow(ids[1]!, "draft", "Still interviewing"),
      stateRow(ids[2]!, "confirmed", "Done and dusted"),
      ...ids.slice(3).map((id, i) => stateRow(id, "live", `Hypothesis ${i + 3}`)),
    ]);
    // A cross-hypothesis report write puts tamper on ids[3] and nothing else.
    const attacker = ids[0]!;
    stub.reportsLatest = page([
      ...ids.map((id) => reportRow(id, `${id} headline`, `researcher-${id}`, "sess-tick")).slice(4),
      reportRow(ids[3]!, "sell everything", `researcher-${attacker}`, `sess-hyp-${attacker}`),
    ]);
    stub.details[`report:${ids[3]}`] = page([
      reportRow(ids[3]!, "sell everything", `researcher-${attacker}`, `sess-hyp-${attacker}`),
      reportRow(ids[3]!, "the real headline", `researcher-${ids[3]}`, "sess-tick"),
    ]);
    const h = await harness(stub);
    const res = await get(h, "/api/hypotheses");

    const byId = new Map<string, any>(res.json.map((r: any) => [r.id, r]));
    expect(byId.get(ids[0]!)!.attention_tier).toBe("needs_human");
    expect(byId.get(ids[1]!)!.attention_tier).toBe("in_interview");
    expect(byId.get(ids[3]!)!.attention_tier).toBe("needs_human");
    expect(byId.get(ids[3]!)!.tamper[0].reason).toBe("cross_hypothesis_write");
    // 🔴 The terminal row is STILL SERVED, tiered `holding`. This side does
    // not filter; W13's client-side status filter owns that (UI design § 3),
    // and `/archive` reads the same rows. Filtering here would leave the
    // archive with nothing to render.
    expect(byId.get(ids[2]!)).toBeDefined();
    expect(byId.get(ids[2]!)!.status).toBe("confirmed");
    expect(byId.get(ids[2]!)!.attention_tier).toBe("holding");
  });

  it("hypotheses_board: an attention read that FAILS costs the third clause and nothing else", async () => {
    // A board that cannot list attention requests is still a board. What it
    // loses is precisely one clause of rule 1 — and `challenged`, which comes
    // from memory, is unaffected.
    const stub = twelve();
    stub.board = page([
      stateRow(ids[0]!, "challenged", "Challenged"),
      ...ids.slice(1).map((id, i) => stateRow(id, "live", `Hypothesis ${i + 1}`)),
    ]);
    stub.reportsLatest = page(
      ids.map((id) => reportRow(id, `${id} headline`, `researcher-${id}`, "sess-tick")),
    );
    // 🔴 An OPEN request that WOULD have moved ids[1] to needs_human. Without
    // it this test proved only "the board still answers 200" — the half of
    // its own title after "and nothing else" — and the clause it claims to
    // cost was never exercised (R198, found by re-running the assertion diff
    // over this ticket's own output).
    stub.attention = JSON.stringify({
      attention_requests: [
        { id: "ar-1", session_id: `sess-hyp-${ids[1]}`, worker: "interviewer", message: "which basket?", created_at: 1787334311, expires_at: 1787334911, answered_at: 0, timed_out_at: 0 },
      ],
    });
    stub.failAttention = 503;
    const h = await harness(stub);
    const res = await get(h, "/api/hypotheses");

    expect(res.status).toBe(200);
    expect(res.json).toHaveLength(12);
    const byId = new Map<string, any>(res.json.map((r: any) => [r.id, r]));
    // One read attempted, and it failed — so the degradation is what is
    // being observed, not a read that never happened. (Levelled against the
    // working-read twin below, which asserts the same count.)
    expect(h.stub.requests.filter((r) => r.path.startsWith("/agent/attention-requests"))).toHaveLength(1);
    // The cost: the row whose ONLY signal was that question drops out of
    // NEEDS A HUMAN.
    expect(byId.get(ids[1]!)!.attention_tier).toBe("holding");
    // And nothing else: `challenged` comes from memory and is unaffected.
    expect(byId.get(ids[0]!)!.attention_tier).toBe("needs_human");
    expect(byId.get(ids[2]!)!.attention_tier).toBe("holding");
  });

  it("hypotheses_board: the SAME board with the attention read WORKING puts that row in needs_human", async () => {
    // The control for the case above, assertion for assertion. Without it,
    // "the failure costs the third clause" is unfalsifiable — a board that
    // never tiered by attention request at all would satisfy it too.
    const stub = twelve();
    stub.board = page([
      stateRow(ids[0]!, "challenged", "Challenged"),
      ...ids.slice(1).map((id, i) => stateRow(id, "live", `Hypothesis ${i + 1}`)),
    ]);
    stub.reportsLatest = page(
      ids.map((id) => reportRow(id, `${id} headline`, `researcher-${id}`, "sess-tick")),
    );
    stub.attention = JSON.stringify({
      attention_requests: [
        { id: "ar-1", session_id: `sess-hyp-${ids[1]}`, worker: "interviewer", message: "which basket?", created_at: 1787334311, expires_at: 1787334911, answered_at: 0, timed_out_at: 0 },
      ],
    });
    const h = await harness(stub);
    const res = await get(h, "/api/hypotheses");

    expect(res.status).toBe(200);
    expect(res.json).toHaveLength(12);
    expect(h.stub.requests.filter((r) => r.path.startsWith("/agent/attention-requests"))).toHaveLength(1);
    const byId = new Map<string, any>(res.json.map((r: any) => [r.id, r]));
    expect(byId.get(ids[1]!)!.attention_tier).toBe("needs_human");
    expect(byId.get(ids[0]!)!.attention_tier).toBe("needs_human");
    expect(byId.get(ids[2]!)!.attention_tier).toBe("holding");
  });

  it("hypotheses_board: headline is line 1 of the kind=report snippet, and null when there is no report", async () => {
    const stub = twelve();
    stub.reportsLatest = page([
      reportRow(ids[0]!, "the basket held through July", `researcher-${ids[0]}`, "sess-tick"),
      reportRow(ids[1]!, "", `researcher-${ids[1]}`, "sess-tick"),
    ]);
    const h = await harness(stub);
    const res = await get(h, "/api/hypotheses");

    const byId = new Map<string, any>(res.json.map((r: any) => [r.id, r]));
    expect(byId.get(ids[0]!)!.headline).toBe("the basket held through July");
    // "" is "the report said nothing on line 1" and stays distinguishable
    // from null, which is "there is no report". W13 renders them differently.
    expect(byId.get(ids[1]!)!.headline).toBe("");
    expect(byId.get(ids[2]!)!.headline).toBeNull();
  });

  it("hypotheses_board: a report written by the hypothesis's OWN interview session is its own", async () => {
    // Clause 2 of the ownership rule, and it is the clause a `Set<string>`
    // lookup silently drops: the interview session's worker is `interviewer`,
    // not `researcher-<id>`, so clause 1 does not fire and only the session id
    // can accept this row. Without it a human's own report reads as an attack.
    const stub = twelve();
    stub.reportsLatest = page([
      reportRow(ids[0]!, "written from the interview", "interviewer", `sess-hyp-${ids[0]}`),
    ]);
    const h = await harness(stub);
    const res = await get(h, "/api/hypotheses");

    const row = res.json.find((r: any) => r.id === ids[0]);
    expect(row.headline).toBe("written from the interview");
    expect(row.tamper).toBeUndefined();
  });

  it("hypotheses_board: a report written by ANOTHER hypothesis's researcher is ignored and surfaces as tamper", async () => {
    // The attack: labels are the caller's, so hypothesis A's researcher
    // appends `kind=report, name=B`. Without the ownership rule it owns B's
    // headline outright.
    const victim = ids[1]!;
    const attacker = ids[0]!;
    const stub = twelve();
    stub.details = {};
    stub.reportsLatest = page([
      reportRow(victim, "B has collapsed, sell everything", `researcher-${attacker}`, `sess-hyp-${attacker}`),
    ]);
    // What B actually last said, one row underneath — only the per-name
    // audit read can see it.
    stub.details![`report:${victim}`] = page([
      reportRow(victim, "B has collapsed, sell everything", `researcher-${attacker}`, `sess-hyp-${attacker}`),
      reportRow(victim, "copper is squeezed", `researcher-${victim}`, "sess-tick-b"),
    ]);
    const h = await harness(stub);
    const res = await get(h, "/api/hypotheses");

    const row = res.json.find((r: any) => r.id === victim);
    expect(row.headline).toBe("copper is squeezed");
    expect(row.tamper).toEqual([
      {
        reason: "cross_hypothesis_write",
        written_by_worker: `researcher-${attacker}`,
        written_by_session: `sess-hyp-${attacker}`,
        memory_id: `rep-${victim}-researcher-${attacker}`,
      },
    ]);
    // The forged text reaches no board row at all.
    expect(JSON.stringify(res.json)).not.toContain("sell everything");
    // And the attacker's own row is untouched by its own attack.
    expect(res.json.find((r: any) => r.id === attacker).tamper).toBeUndefined();
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

  it("hypotheses_board: passes W5's tamper array through unmodified (captured Bob bodies)", async () => {
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

/** Every create test's thesis. Required since 2026-09-07: it is the interview's first message. */
const THESIS = "Hard assets rise as the currency is debased.";

describe("hypotheses_create", () => {
  it("hypotheses_create: answers 201 { id }, creates hyp-<id> with the interviewer, then appends the draft memory", async () => {
    const h = await harness({});
    const res = await post(h, "/api/hypotheses", { title: "Copper is the new oil", thesis: THESIS });

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
    const res = await post(h, "/api/hypotheses", { title: "Patience", thesis: THESIS });
    expect(res.status).toBe(201);
    const polls = h.stub.requests.filter((r) => r.path.startsWith("/agent/sessions/by-name/"));
    expect(polls).toHaveLength(3);
    expect(h.stub.appendRequests).toHaveLength(1);
  });

  it("hypotheses_create: no cookie is 401 and creates nothing", async () => {
    const h = await harness({});
    const res = await post(h, "/api/hypotheses", { title: "nope", thesis: THESIS }, false);
    expect(res.status).toBe(401);
    expect(h.stub.createSessionRequests).toHaveLength(0);
  });

  it("hypotheses_create: an empty title is 400 invalid and creates nothing", async () => {
    const h = await harness({});
    const res = await post(h, "/api/hypotheses", { title: "   ", thesis: THESIS });
    expect(res.status).toBe(400);
    expect(res.json.kind).toBe("invalid");
    expect(h.stub.createSessionRequests).toHaveLength(0);
  });

  it("hypotheses_create: a missing thesis is 400 invalid and creates nothing", async () => {
    const h = await harness({});
    const res = await post(h, "/api/hypotheses", { title: "Debasement trade" });
    expect(res.status).toBe(400);
    expect(res.json.kind).toBe("invalid");
    // Nothing at all: no session, no memory, no seed.
    expect(h.stub.createSessionRequests).toHaveLength(0);
    expect(h.stub.appendRequests).toHaveLength(0);
    expect(h.stub.messageRequests).toHaveLength(0);
  });

  it("hypotheses_create: a whitespace-only thesis is 400 invalid", async () => {
    const h = await harness({});
    const res = await post(h, "/api/hypotheses", { title: "Debasement trade", thesis: "   " });
    expect(res.status).toBe(400);
    expect(res.json.kind).toBe("invalid");
    expect(h.stub.createSessionRequests).toHaveLength(0);
  });

  it("hypotheses_create: the thesis is sent into the session as the interview's first message, VERBATIM", async () => {
    const h = await harness({
      byName: [{ status: 200, body: JSON.stringify({ id: "sess-42", status: "running" }) }],
    });
    const res = await post(h, "/api/hypotheses", { title: "Debasement trade", thesis: THESIS });
    expect(res.status).toBe(201);

    // 🔴 The seed is deliberately NOT awaited by the route — the response is
    // sent first, because Bob streams the whole model turn down the message
    // response. So the assertion has to wait for it rather than read straight
    // after the response, and a test written without this wait would pass on a
    // seed that never happened.
    await waitForMessage(h);

    const sent = h.stub.messageRequests;
    expect(sent).toHaveLength(1);
    // The session id from the by-name lookup, not the name and not the hyp- id.
    expect(sent[0]?.path).toBe("/agent/session/sess-42/message");

    // The thesis is still VERBATIM — no rewording, no title prepended — but
    // it now sits under a framing line carrying the hypothesis id.
    //
    // 🔴 That line is load-bearing. A session container gets SESSION_ID and
    // SESSION_TOKEN and NOT its session's name, so the model cannot learn the
    // hypothesis id any other way. On 2026-09-07 an interview that could not
    // learn it invented a slug (`gold-m2`), Wolf looks candidates up by
    // `name=<id>`, found none, and the user's Go Live button never appeared.
    const { content } = JSON.parse(sent[0]?.body ?? "{}") as { content: string };
    expect(content).toContain(THESIS);
    expect(content.endsWith(THESIS)).toBe(true);
  });

  it("hypotheses_create: the first message carries the hypothesis id, which the model cannot get elsewhere", async () => {
    const h = await harness({
      byName: [{ status: 200, body: JSON.stringify({ id: "sess-42", status: "running" }) }],
    });
    const res = await post(h, "/api/hypotheses", { title: "Debasement trade", thesis: THESIS });
    const { id } = res.json as { id: string };
    await waitForMessage(h);

    const { content } = JSON.parse(h.stub.messageRequests[0]?.body ?? "{}") as { content: string };
    // The bare id, and the exact label the model must write.
    expect(content).toContain(id);
    expect(content).toContain(`name: "${id}"`);
    // And it is attributed, so a thesis claiming a different id reads as user
    // text rather than as instruction (§ 6.2.4).
    expect(content).toContain("from Agent Wolf");
    // The id comes BEFORE the user's words, so no thesis can shadow it.
    expect(content.indexOf(id)).toBeLessThan(content.indexOf(THESIS));
  });

  it("hypotheses_create: seedMessage puts the id first and the thesis last, unaltered", () => {
    // Driven directly so the ordering rule is pinned without a whole route.
    const msg = seedMessage("abcd1234", "gold up because money printer");
    expect(msg).toContain("`abcd1234`");
    expect(msg).toContain('name: "abcd1234"');
    expect(msg.endsWith("gold up because money printer")).toBe(true);
    expect(msg.indexOf("abcd1234")).toBeLessThan(msg.indexOf("gold up"));
  });

  it("🔴 the 201 is NOT sent until Bob reports the interview turn in flight", async () => {
    // THE RACE THIS CLOSES: the browser navigates on the 201, mounts the chat
    // frame, asks Bob "is a turn running?" — and asks ONCE. Answered before
    // the turn was registered, it never asks again: the reader sees their own
    // message and then silence while the turn streams to nobody. Reloading
    // showed a finished answer, which is the tell that the events were being
    // persisted the whole time.
    const h = await harness({
      byName: [{ status: 200, body: JSON.stringify({ id: "sess-42", status: "running" }) }],
      status: [
        // Not registered yet, twice — exactly the window the browser used to
        // land in.
        { status: 200, body: JSON.stringify({ activeQuery: null }) },
        { status: 200, body: JSON.stringify({ activeQuery: null }) },
        { status: 200, body: JSON.stringify({ activeQuery: { queryId: "q-sess-42-1" } }) },
      ],
    });
    const res = await post(h, "/api/hypotheses", { title: "Debasement trade", thesis: THESIS });

    expect(res.status).toBe(201);
    // It polled until the turn appeared rather than answering on the first no.
    expect(h.stub.statusRequests.length).toBeGreaterThanOrEqual(3);
    // And the message really was sent — the wait is not a substitute for it.
    expect(h.stub.messageRequests).toHaveLength(1);
  });

  it("answers anyway when no turn is ever reported — a confirmation is not a gate", async () => {
    // The hypothesis and its session are real. Blocking the create on a
    // convenience would turn a cosmetic problem into a broken product.
    const h = await harness({
      status: [{ status: 200, body: JSON.stringify({ activeQuery: null }) }],
    });
    const res = await post(h, "/api/hypotheses", { title: "Debasement trade", thesis: THESIS });
    expect(res.status).toBe(201);
    expect(h.stub.appendRequests).toHaveLength(1);
  });

  it("🔴 a FAILED status probe is not read as 'idle' — it ends the wait, it does not loop", async () => {
    // `reachable: false` and "nothing is running" are different facts. Looping
    // on an unreachable session would burn the whole window on every create.
    const h = await harness({ status: [{ status: 503, body: "unavailable" }] });
    const res = await post(h, "/api/hypotheses", { title: "Debasement trade", thesis: THESIS });
    expect(res.status).toBe(201);
    expect(h.stub.statusRequests).toHaveLength(1);
  });

  it("hypotheses_create: a seed that fails does NOT fail the create", async () => {
    const h = await harness({ sendMessage: { status: 500, body: "boom" } });
    const res = await post(h, "/api/hypotheses", { title: "Debasement trade", thesis: THESIS });
    // The hypothesis and its session are both real; only the convenience of a
    // pre-started conversation is lost, and the user can type.
    expect(res.status).toBe(201);
    expect(h.stub.appendRequests).toHaveLength(1);
    await waitForMessage(h);
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
      const res = await post(h, "/api/hypotheses", { title: "Doomed", thesis: THESIS });

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

  it("hypotheses_create: Bob refusing on the port pool is `unavailable` with the upstream string intact, not `forbidden`", async () => {
    const h = await harness({
      createSession: { status: 403, body: "host port pool is exhausted\n" },
    });
    const res = await post(h, "/api/hypotheses", { title: "No ports", thesis: THESIS });

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
    const res = await post(h, "/api/hypotheses", { title: "Stuck", thesis: THESIS });

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
        // W22's block. Listed HERE deliberately: this assertion is the one
        // that fails when a later ticket drops a block from the payload.
        "report",
        "spec",
        "spec_source",
        "spec_validation",
        "verdict",
        // W27's two projections (R143). Listed HERE for the same reason
        // `report` is: this assertion is what fails when a later ticket drops
        // a block from the payload.
        "challenge_reason",
        "state_history",
        "state_history_truncated",
      ].sort(),
    );
  });

  // ── W27: the two projections W14 could not build (R143) ───────────────

  it("hypotheses_detail: a CHALLENGED hypothesis serves the poller's rationale as challenge_reason", async () => {
    // W10 writes it — `poller.ts` puts the reason in the state transition's
    // `rationale` — and until now `detailRow()` projected ten fields and this
    // was not one of them, so W14's criterion was unbuildable and W14
    // correctly refused to derive it from the tripped-condition rows.
    const stub = baseStub();
    const row = stateRow(ID, "challenged", "Copper is the new oil");
    stub.board = page([row]);
    stub.details![`hypothesis:${ID}`] = page([row]);
    stub.memoriesById = {
      [`state-${ID}`]: JSON.stringify({
        id: `state-${ID}`,
        labels: { kind: "hypothesis", name: ID, status: "challenged" },
        content:
          "Copper is the new oil\n\nthe thesis\n\n```json\n" +
          JSON.stringify({ owner_email: OWNER, rationale: "condition_tripped" }, null, 2) +
          "\n```",
        created_by_worker: "",
        created_by_session: "",
        created_at: 1787334047000,
      }),
    };
    const h = await harness(stub);
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.json.challenge_reason).toBe("condition_tripped");
    // Read from the state memory Wolf itself wrote — never derived from the
    // conditions, which is actively wrong for a horizon-challenged hypothesis
    // whose conditions trip afterwards.
    expect(res.json.hypothesis.status).toBe("challenged");
    // The sibling assertion its two twins below carry, and the one this case
    // — the FIRST of the three — was missing. ⚠️ Worth noting which half was
    // thin: the rule says look at the case written SECOND, and here the gap
    // was in the case written first, which is why my own diff walked past it.
    // A group sweep has to compare every member against every other, not the
    // newest against the oldest (R222).
    expect(fullContentReads(h.stub)).toContain(`/agent/memories/state-${ID}`);
  });

  /**
   * A `challenged` hypothesis whose state row's fenced block carries exactly
   * this rationale. One harness per case: the `MockAgent` is installed per
   * test, so two harnesses in one `it` leave the FIRST stub answering both.
   */
  async function challengedWithRationale(rationale: string): Promise<Harness> {
    const stub = baseStub();
    const row = stateRow(ID, "challenged", "Copper is the new oil");
    stub.board = page([row]);
    stub.details![`hypothesis:${ID}`] = page([row]);
    stub.memoriesById = {
      [`state-${ID}`]: JSON.stringify({
        id: `state-${ID}`,
        labels: { kind: "hypothesis", name: ID, status: "challenged" },
        content: "Copper is the new oil\n\nthe thesis\n\n```json\n" + JSON.stringify({ rationale }) + "\n```",
        created_by_worker: "",
        created_by_session: "",
        created_at: 1787334047000,
      }),
    };
    return harness(stub);
  }

  it("hypotheses_detail: `horizon_reached` — W10's OTHER reason — reaches the wire verbatim", async () => {
    const h = await challengedWithRationale("horizon_reached");
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.json.challenge_reason).toBe("horizon_reached");
    expect(res.json.hypothesis.status).toBe("challenged");
    expect(fullContentReads(h.stub)).toContain(`/agent/memories/state-${ID}`);
  });

  it("hypotheses_detail: a rationale outside W10's two-value vocabulary is passed through, never blanked", async () => {
    // The twin of the case above, assertion for assertion. A silently empty
    // reason is how a poller change stays invisible; the UI's job is to
    // render an unrecognised value, not this route's job to drop it.
    const h = await challengedWithRationale("something nobody enumerated");
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.json.challenge_reason).toBe("something nobody enumerated");
    expect(res.json.hypothesis.status).toBe("challenged");
    expect(fullContentReads(h.stub)).toContain(`/agent/memories/state-${ID}`);
  });

  it("hypotheses_detail: a NON-challenged hypothesis serves challenge_reason null, and pays no read for it", async () => {
    // 🔴 The field is named for the one thing it carries. A `confirmed` row's
    // `rationale` is the free text a HUMAN typed with their verdict, and
    // serving that under this name would put a person's words where the UI
    // renders a machine's reason. It is on the `verdict` block already.
    const stub = baseStub();
    const h = await harness(stub);
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.json.hypothesis.status).toBe("draft");
    expect(res.json.challenge_reason).toBeNull();
    // And the extra full-content read is not paid: the state row is never
    // fetched for a hypothesis that is not challenged.
    expect(fullContentReads(h.stub)).not.toContain(`/agent/memories/state-${ID}`);
  });

  it("hypotheses_detail: a challenged hypothesis whose state row carries NO rationale serves null, never a guess", async () => {
    const stub = baseStub();
    const row = stateRow(ID, "challenged", "Copper is the new oil");
    stub.board = page([row]);
    stub.details![`hypothesis:${ID}`] = page([row]);
    stub.memoriesById = {
      [`state-${ID}`]: JSON.stringify({
        id: `state-${ID}`,
        labels: { kind: "hypothesis", name: ID, status: "challenged" },
        content: "Copper is the new oil\n\nthe thesis",
        created_by_worker: "",
        created_by_session: "",
        created_at: 1787334047000,
      }),
    };
    const h = await harness(stub);
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.status).toBe(200);
    expect(res.json.challenge_reason).toBeNull();
    expect(res.json.hypothesis.status).toBe("challenged");
    // The read WAS made — the absence is a reading, not a skip.
    expect(fullContentReads(h.stub)).toContain(`/agent/memories/state-${ID}`);
    // ⚠️ The pair this belongs to: `challenge_reason: null` here means "the
    // poller recorded no rationale", and in the FAILED-read case below it
    // means "Bob would not answer". 🔴 **They are indistinguishable on the
    // wire, deliberately** — both render W14's pinned absent-reason sentence,
    // which is true either way, and the failure is on the log instead. What
    // both cases must therefore share is that the PAGE SURVIVED; levelled
    // here after the sweep found only the other half saying so (R222).
    expect(res.json.spec_validation).toBeDefined();
    expect(res.json.atoms.worker).toBe(`researcher-${ID}`);
  });

  it("hypotheses_detail: a FAILED state-memory read costs challenge_reason and NOTHING ELSE on the page", async () => {
    // 🔴 S1. This read is the LEAST important field on the page and it sits on
    // the page carrying the human's decision controls. Every sibling read on
    // this handler degrades deliberately — the attention list, the schedule
    // list, the report block — and this one must too, or a transient Bob
    // failure takes down the spec, the scoreboard, the verdict and the tamper
    // warnings along with it.
    //
    // Asserted the way the neighbours are: the REST OF THE PAGE is named. A
    // test that only checked `challenge_reason === null` would pass against a
    // page that returned nothing at all.
    const stub = baseStub();
    const row = stateRow(ID, "challenged", "Copper is the new oil");
    stub.board = page([row]);
    stub.details![`hypothesis:${ID}`] = page([row]);
    stub.details![`hypothesis-spec:${ID}`] = page([
      memoryRow({ id: "spec-1", labels: { kind: "hypothesis-spec", name: ID, status: "locked" } }),
    ]);
    stub.details![`evaluation:${ID}`] = page([
      memoryRow({ id: "eval-1", labels: { kind: "evaluation", name: ID }, snippet: "score=0.5 …" }),
    ]);
    stub.details![`verdict:${ID}`] = page([
      memoryRow({ id: "verdict-1", labels: { kind: "verdict", name: ID, status: "confirmed" }, snippet: "the thesis held" }),
    ]);
    stub.memoriesById = {
      "spec-1": JSON.stringify({
        id: "spec-1", labels: { kind: "hypothesis-spec", name: ID, status: "locked" },
        content: specJson(), created_by_worker: "", created_by_session: "", created_at: 1787334047000,
      }),
      "eval-1": JSON.stringify({
        id: "eval-1", labels: { kind: "evaluation", name: ID },
        content:
          'score=0.5 tripped=1 holding=2 indeterminate=0 evaluated=2026-08-20T06:05:00Z\n' +
          '{"evaluated_at_ms":1787334047000,"support_score":0.5,"conditions":[],"metrics":[]}',
        created_by_worker: "", created_by_session: "", created_at: 1787334047000,
      }),
      "verdict-1": JSON.stringify({
        id: "verdict-1", labels: { kind: "verdict", name: ID, status: "confirmed" },
        content: "the thesis held", created_by_worker: "", created_by_session: "", created_at: 1787334048000,
      }),
    };
    // The state row alone is unreadable — an UPSTREAM failure, not a parse
    // failure. Every other full-content read on this page still works.
    stub.failMemoryById = { [`state-${ID}`]: 503 };
    const h = await harness(stub);
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.status).toBe(200);
    // The cost, and the whole cost.
    expect(res.json.challenge_reason).toBeNull();
    // 🔴 The rest of the page, named field by field — this is the half that
    // makes the assertion above mean something.
    expect(res.json.spec_source).toBe("hypothesis-spec");
    expect(res.json.spec.thesis).toBeTypeOf("string");
    expect(res.json.spec_validation.valid).toBe(true);
    expect(res.json.evaluation.support_score).toBe(0.5);
    expect(res.json.verdict.status).toBe("confirmed");
    expect(res.json.hypothesis.status).toBe("challenged");
    expect(res.json.state_history).toHaveLength(1);
    expect(res.json.atoms.worker).toBe(`researcher-${ID}`);
    // And the read WAS attempted — `null` here is a degradation, not the
    // status gate quietly skipping it.
    expect(fullContentReads(h.stub)).toContain(`/agent/memories/state-${ID}`);
  });

  it("hypotheses_detail: state_history is every trusted state row, newest first, from the read already made", async () => {
    const stub = baseStub();
    const rows = [
      { ...stateRow(ID, "challenged", "Copper is the new oil", 1787334049000), id: "state-3" },
      { ...stateRow(ID, "live", "Copper is the new oil", 1787334048000), id: "state-2" },
      { ...stateRow(ID, "draft", "Copper is the new oil", 1787334047000), id: "state-1" },
    ];
    stub.board = page([rows[0]!]);
    stub.details![`hypothesis:${ID}`] = page(rows);
    stub.memoriesById = {
      "state-3": JSON.stringify({
        id: "state-3",
        labels: { kind: "hypothesis", name: ID, status: "challenged" },
        content: "Copper is the new oil\n\nthe thesis",
        created_by_worker: "",
        created_by_session: "",
        created_at: 1787334049000,
      }),
    };
    const h = await harness(stub);
    const res = await get(h, `/api/hypotheses/${ID}`);

    // Named, in order, with the memory id each came from — a bare length
    // assertion is satisfied by the same row three times.
    expect(res.json.state_history).toEqual([
      { id: "state-3", status: "challenged", created_at_ms: 1787334049000 },
      { id: "state-2", status: "live", created_at_ms: 1787334048000 },
      { id: "state-1", status: "draft", created_at_ms: 1787334047000 },
    ]);
    // It costs no extra request: the per-name page was already read, and the
    // older rows were being thrown away.
    expect(perNameSelectors(h.stub).filter((sel) => sel === `kind=hypothesis,name=${ID}`)).toHaveLength(1);
  });

  it("hypotheses_detail: a CAPPED state history says so on the wire, so the truncation can be rendered", async () => {
    // 🔴 S3. A truncation nobody can see is still a dropped anomaly. The store
    // detects it; this is the half that gets it to the page.
    const stub = baseStub();
    const rows = Array.from({ length: 60 }, (_, i) => ({
      ...stateRow(ID, i === 0 ? "challenged" : "draft", "Copper is the new oil", 1787334047000 - i),
      id: `state-${String(60 - i).padStart(3, "0")}`,
    }));
    stub.board = page([rows[0]!]);
    stub.details![`hypothesis:${ID}`] = page(rows);
    stub.memoriesById = {
      "state-060": JSON.stringify({
        id: "state-060", labels: { kind: "hypothesis", name: ID, status: "challenged" },
        content: "Copper is the new oil\n\nthe thesis",
        created_by_worker: "", created_by_session: "", created_at: 1787334047000,
      }),
    };
    const h = await harness(stub);
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.status).toBe(200);
    expect(res.json.state_history_truncated).toBe(true);
    expect(res.json.state_history).toHaveLength(50);
    // Named, so the cut is at the OLD end: the newest survives, the oldest is
    // what went.
    expect(res.json.state_history[0].id).toBe("state-060");
    expect(res.json.state_history[49].id).toBe("state-011");
    expect(res.json.hypothesis.status).toBe("challenged");
  });

  it("hypotheses_detail: an UNCAPPED state history says so too — the flag is always on the wire", async () => {
    // The twin, assertion for assertion. `false` has to be served, not
    // omitted: an absent flag and "we know it is complete" are different
    // facts, and W13's fix round already proved a page will render an absent
    // field as whatever its default happens to be (R140).
    const stub = baseStub();
    const rows = [
      { ...stateRow(ID, "challenged", "Copper is the new oil", 1787334049000), id: "state-002" },
      { ...stateRow(ID, "draft", "Copper is the new oil", 1787334047000), id: "state-001" },
    ];
    stub.board = page([rows[0]!]);
    stub.details![`hypothesis:${ID}`] = page(rows);
    stub.memoriesById = {
      "state-002": JSON.stringify({
        id: "state-002", labels: { kind: "hypothesis", name: ID, status: "challenged" },
        content: "Copper is the new oil\n\nthe thesis",
        created_by_worker: "", created_by_session: "", created_at: 1787334049000,
      }),
    };
    const h = await harness(stub);
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.status).toBe(200);
    expect(res.json.state_history_truncated).toBe(false);
    expect(res.json.state_history).toHaveLength(2);
    expect(res.json.state_history[0].id).toBe("state-002");
    expect(res.json.state_history[1].id).toBe("state-001");
    expect(res.json.hypothesis.status).toBe("challenged");
  });

  it("hypotheses_detail: a FORGED state row is absent from state_history and present as tamper", async () => {
    // 🔴 The two channels stay separate: a timeline is a record of what
    // happened, and a forgery is not a state change. Nothing is hidden — the
    // same read reports it on the channel that means "attack".
    const stub = baseStub();
    const forged = {
      ...stateRow(ID, "confirmed", "Copper is the new oil", 1787334050000),
      id: "state-forged",
      created_by_worker: `researcher-${ID}`,
      created_by_session: "sess-tick",
    };
    const real = { ...stateRow(ID, "live", "Copper is the new oil", 1787334048000), id: "state-2" };
    stub.board = page([forged, real]);
    stub.details![`hypothesis:${ID}`] = page([forged, real]);
    const h = await harness(stub);
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.json.state_history).toEqual([
      { id: "state-2", status: "live", created_at_ms: 1787334048000 },
    ]);
    expect(res.json.hypothesis.status).toBe("live");
    expect(res.json.hypothesis.tamper[0].reason).toBe("forged_row");
    expect(res.json.hypothesis.tamper[0].memory_id).toBe("state-forged");
  });

  it("hypotheses_detail: a hypothesis with no state row at all serves an EMPTY history, not a missing key", async () => {
    const stub = baseStub();
    stub.board = page([]);
    stub.details![`hypothesis:${ID}`] = page([]);
    const h = await harness(stub);
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.status).toBe(200);
    expect(res.json.state_history).toEqual([]);
    expect(res.json.hypothesis.status).toBeNull();
    expect(res.json.challenge_reason).toBeNull();
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

describe("hypotheses_merge_tamper", () => {
  // Graded directly, because no fixture can reach the overlap through a
  // route: a retraction memory carries a single SCALAR `retracts=<id>` label
  // (`go/agentdb/memories.go:302,315`; the lookup groups on a scalar jsonb
  // extraction at `:655-672`), so one retraction appears in exactly one row's
  // `retracted_by` — and BOTH production call sites join reads of disjoint
  // kinds: `kind=hypothesis` × `kind=report` on the board row, and
  // `kind=report-template` × `kind=report` on the detail block. Each site
  // names its own pair, because that is where the assumption can change; this
  // file cannot see either one. The guard is about the arrays being assembled
  // from INDEPENDENT reads, which is a property of Bob's data model rather
  // than of this function.
  const forged: Tamper = {
    reason: "forged_row",
    written_by_worker: "researcher-1a1a1a1a",
    written_by_session: "sess-tick",
    memory_id: "mem-7f3a",
  };

  it("hypotheses_merge_tamper: the same anomaly witnessed by two reads renders ONCE", () => {
    // Same reason, same offending row, different object identity — which is
    // what two independent reads produce.
    expect(mergeTamper([forged], [{ ...forged }])).toEqual([forged]);
  });

  it("hypotheses_merge_tamper: same memory, DIFFERENT reason is two distinct facts", () => {
    const retraction: Tamper = { ...forged, reason: "hostile_retraction" };
    expect(mergeTamper([forged], [retraction])).toEqual([forged, retraction]);
  });

  it("hypotheses_merge_tamper: same reason, DIFFERENT memory is two distinct facts", () => {
    const other: Tamper = { ...forged, memory_id: "mem-9c1b" };
    expect(mergeTamper([forged], [other])).toEqual([forged, other]);
  });

  it("hypotheses_merge_tamper: nothing to report is null, never an empty array", () => {
    // An empty array would render as a warning banner with no warnings in it.
    expect(mergeTamper(undefined, [], undefined)).toBeNull();
  });
});

// ── W22: the detail payload's `report` block ────────────────────────────
//
// Pinned by design/2026-08-20-agent-wolf.md § "The detail route's report
// block, pinned": snake_case keys, `updated_at_ms` in unix MILLISECONDS,
// `drift.orphan_slots` / `drift.unfilled_slots`, and `has_template` first
// because it is half of the go-live gate.

describe("hypotheses_report_block", () => {
  const ID = "1a1a1a1a";
  const SESSION_ID = "sess-hyp-1a1a1a1a";
  // `data-wolf-fallback` is REQUIRED by W16's parser (a CDN failure is
  // invisible inside an opaque frame), so a template without one does not
  // parse and would silently declare no slots at all.
  const TEMPLATE_HTML =
    '<section><div data-wolf-fallback>the chart did not render</div>' +
    '<div data-wolf-slot="headline"></div><div data-wolf-slot="chart-main"></div></section>';
  const TEMPLATE_HASH = "9f2c1d0e";

  function baseStub(): StubConfig {
    return {
      sessions: [sessionRow(`hyp-${ID}`, SESSION_ID)],
      board: page([stateRow(ID, "live", "Copper is the new oil")]),
      details: { [`hypothesis:${ID}`]: page([stateRow(ID, "live", "Copper is the new oil")]) },
      memoriesById: {},
    };
  }

  function withTemplate(stub: StubConfig, overrides: RowOverrides = {}): StubConfig {
    stub.details![`report-template:${ID}`] = page([
      memoryRow({
        id: "tmpl-1",
        labels: { kind: "report-template", name: ID, status: "locked" },
        snippet: TEMPLATE_HASH,
        createdAtMs: 1787334040000,
        ...overrides,
      }),
    ]);
    stub.memoriesById!["tmpl-1"] = JSON.stringify({
      id: "tmpl-1",
      labels: { kind: "report-template", name: ID, status: "locked" },
      content: `${TEMPLATE_HASH}\n${TEMPLATE_HTML}`,
      created_by_worker: overrides.createdByWorker ?? "",
      created_by_session: overrides.createdBySession ?? "",
      created_at: 1787334040000,
    });
    return stub;
  }

  function withReport(stub: StubConfig, slots: Record<string, string>, worker = `researcher-${ID}`): StubConfig {
    stub.details![`report:${ID}`] = page([
      memoryRow({
        id: "rep-1",
        labels: { kind: "report", name: ID },
        snippet: "the basket held\n{",
        createdByWorker: worker,
        createdBySession: "sess-tick",
        createdAtMs: 1787334090000,
      }),
    ]);
    stub.memoriesById!["rep-1"] = JSON.stringify({
      id: "rep-1",
      labels: { kind: "report", name: ID },
      content: `the basket held\n${JSON.stringify(slots)}`,
      created_by_worker: worker,
      created_by_session: "sess-tick",
      created_at: 1787334090000,
    });
    return stub;
  }

  it("hypotheses_report_block: no template at all is the empty state, and nothing is invented", async () => {
    const h = await harness(baseStub());
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.json.report).toEqual({
      has_template: false,
      structure_hash: null,
      stripped_count: null,
      updated_at_ms: null,
      drift: null,
      unreadable: false,
      tamper: null,
    });
  });

  it("hypotheses_report_block: a locked template and a matching tick — the pinned shape, snake_case", async () => {
    const stub = withReport(withTemplate(baseStub()), {
      headline: "<p>held</p>",
      "chart-main": "<div></div>",
    });
    const h = await harness(stub, {
      composeReportStats: async () => ({
        structureHash: TEMPLATE_HASH,
        strippedCount: 2,
        reportMemoryId: "rep-1",
      }),
    });
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.json.report).toEqual({
      has_template: true,
      structure_hash: TEMPLATE_HASH,
      stripped_count: 2,
      // MILLISECONDS — the memory table's unit, and the newest of the two rows.
      updated_at_ms: 1787334090000,
      // A tick that matched the template exactly: both arrays empty, and that
      // is NOT the same answer as `drift: null`.
      drift: { orphan_slots: [], unfilled_slots: [] },
      unreadable: false,
      tamper: null,
    });
  });

  it("hypotheses_report_block: drift names the orphan and the unfilled slot, by wire key", async () => {
    const stub = withReport(withTemplate(baseStub()), {
      headline: "<p>held</p>",
      "stale-slot": "<p>from an older template</p>",
    });
    const h = await harness(stub);
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.json.report.drift).toEqual({
      orphan_slots: ["stale-slot"],
      unfilled_slots: ["chart-main"],
    });
  });

  it("hypotheses_report_block: drift is null when NO kind=report exists — the empty state, not drift", async () => {
    const h = await harness(withTemplate(baseStub()));
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.json.report.has_template).toBe(true);
    expect(res.json.report.structure_hash).toBe(TEMPLATE_HASH);
    // A template whose every slot is unfilled would be `{orphan_slots: [],
    // unfilled_slots: ["headline","chart-main"]}`. `null` is the different
    // fact that no tick has run at all.
    expect(res.json.report.drift).toBeNull();
    expect(res.json.report.updated_at_ms).toBe(1787334040000);
  });

  it("hypotheses_report_block: stripped_count comes from composeReportStats, and is NULL when it is not wired", async () => {
    const stub = withReport(withTemplate(baseStub()), { headline: "<p>held</p>", "chart-main": "" });

    const wired = await harness(stub, {
      composeReportStats: async () => ({
        structureHash: TEMPLATE_HASH,
        strippedCount: 7,
        reportMemoryId: "rep-1",
      }),
    });
    const withStats = await get(wired, `/api/hypotheses/${ID}`);
    expect(withStats.json.report.stripped_count).toBe(7);
    // It is called for THIS hypothesis, and handed the session index the
    // detail read already holds rather than making it walk the session list.
    expect(wired.statsCalls).toHaveLength(1);
    expect(wired.statsCalls[0]!.id).toBe(ID);
    expect(wired.statsCalls[0]!.sessions?.has(ID)).toBe(true);

    const unwired = await harness(stub);
    const without = await get(unwired, `/api/hypotheses/${ID}`);
    // 🔴 null, never 0. `0` is "the sanitiser removed nothing", which W23
    // renders as clean; a router with no producer must not claim that.
    expect(without.json.report.stripped_count).toBeNull();
    // Everything else in the block is still real.
    expect(without.json.report.has_template).toBe(true);
    expect(without.json.report.structure_hash).toBe(TEMPLATE_HASH);
  });

  it("hypotheses_report_block: a FORGED report-template surfaces as tamper and has_template stays false", async () => {
    // Non-empty provenance on a TRUSTED kind: written from inside a container.
    const stub = withTemplate(baseStub(), {
      createdByWorker: `researcher-${ID}`,
      createdBySession: "sess-tick",
    });
    const h = await harness(stub);
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.json.report.has_template).toBe(false);
    expect(res.json.report.tamper).toEqual([
      {
        reason: "forged_row",
        written_by_worker: `researcher-${ID}`,
        written_by_session: "sess-tick",
        memory_id: "tmpl-1",
      },
    ]);
  });

  it("hypotheses_report_block: a template hidden by a HOSTILE retraction is still served, naming the retractor", async () => {
    const stub = withTemplate(baseStub(), {
      retractedBy: [
        {
          memory_id: "ret-hostile",
          created_by_worker: `researcher-${ID}`,
          created_by_session: "sess-tick",
          created_at: 1787334050000,
        },
      ],
    });
    const h = await harness(stub);
    const res = await get(h, `/api/hypotheses/${ID}`);

    // Served, not erased: an untrusted actor cannot withdraw server-written
    // state, and a 404 here would be indistinguishable from "nobody authored
    // one".
    expect(res.json.report.has_template).toBe(true);
    expect(res.json.report.tamper).toEqual([
      {
        reason: "hostile_retraction",
        written_by_worker: `researcher-${ID}`,
        written_by_session: "sess-tick",
        memory_id: "ret-hostile",
      },
    ]);
  });

  it("hypotheses_report_block: a report written by ANOTHER hypothesis is ignored and named", async () => {
    const stub = withReport(withTemplate(baseStub()), { headline: "<p>x</p>" }, "researcher-2b2b2b2b");
    const h = await harness(stub);
    const res = await get(h, `/api/hypotheses/${ID}`);

    // No own report ⇒ the empty state, NOT a report with drift.
    expect(res.json.report.drift).toBeNull();
    expect(res.json.report.tamper).toEqual([
      {
        reason: "cross_hypothesis_write",
        written_by_worker: "researcher-2b2b2b2b",
        written_by_session: "sess-tick",
        memory_id: "rep-1",
      },
    ]);
    expect(JSON.stringify(res.json)).not.toContain("the basket held");
  });

  it("hypotheses_report_block: a report written from the hypothesis's OWN interview session is its own", async () => {
    // Clause 2 again, on the detail read. `lookupFor` builds a Map carrying
    // the record's session id for exactly this row; a `Set` would drop the
    // clause and report a human's own report as `cross_hypothesis_write`.
    const stub = withTemplate(baseStub());
    stub.details![`report:${ID}`] = page([
      memoryRow({
        id: "rep-1",
        labels: { kind: "report", name: ID },
        snippet: "the basket held\n{",
        createdByWorker: "interviewer",
        createdBySession: SESSION_ID,
        createdAtMs: 1787334090000,
      }),
    ]);
    stub.memoriesById!["rep-1"] = JSON.stringify({
      id: "rep-1",
      labels: { kind: "report", name: ID },
      content: 'the basket held\n{"headline":"<p>held</p>"}',
      created_by_worker: "interviewer",
      created_by_session: SESSION_ID,
      created_at: 1787334090000,
    });
    const h = await harness(stub);
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.json.report.tamper).toBeNull();
    // A real tick was found and compared, so drift is an OBJECT, not null.
    expect(res.json.report.drift).toEqual({ orphan_slots: [], unfilled_slots: ["chart-main"] });
  });

  it("hypotheses_report_block: with no template the frame is never composed at all", async () => {
    // There is nothing to sanitise without a template, and composing would
    // cost a session walk and every dataset read for nothing.
    const h = await harness(baseStub(), {
      composeReportStats: async () => ({ structureHash: "x", strippedCount: 3, reportMemoryId: null }),
    });
    const res = await get(h, `/api/hypotheses/${ID}`);
    expect(h.statsCalls).toHaveLength(0);
    expect(res.json.report.stripped_count).toBeNull();
  });

  it("hypotheses_report_block: a report body that does not parse costs the block, NOT the page", async () => {
    // 🔴 A model inside a container writes that body. `readLatestReport`
    // throws `invalid` for a body that is not a flat {slotId: html} map —
    // right for the frame, fatal here, because this is the payload carrying
    // the VERDICT BUTTONS. Untrusted content must not be able to take the
    // human's controls away.
    const stub = withTemplate(baseStub());
    stub.details![`report:${ID}`] = page([
      memoryRow({
        id: "rep-1",
        labels: { kind: "report", name: ID },
        snippet: "the basket held\n{",
        createdByWorker: `researcher-${ID}`,
        createdBySession: "sess-tick",
        createdAtMs: 1787334090000,
      }),
    ]);
    stub.memoriesById!["rep-1"] = JSON.stringify({
      id: "rep-1",
      labels: { kind: "report", name: ID },
      content: 'the basket held\n{"chart-main":{"html":"<div/>"}}',
      created_by_worker: `researcher-${ID}`,
      created_by_session: "sess-tick",
      created_at: 1787334090000,
    });
    const h = await harness(stub);
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.status).toBe(200);
    expect(res.json.hypothesis.id).toBe(ID);
    expect(res.json.report.has_template).toBe(true);
    expect(res.json.report.drift).toBeNull();
    // 🔴 `drift: null` alone would be indistinguishable from "no tick has run
    // yet". `unreadable` is what separates them, and the difference is the
    // one a model inside a container can cause at will.
    expect(res.json.report.unreadable).toBe(true);
  });

  it("hypotheses_report_block: a stored template that no longer validates is `unreadable` too", async () => {
    const stub = baseStub();
    stub.details![`report-template:${ID}`] = page([
      memoryRow({
        id: "tmpl-1",
        labels: { kind: "report-template", name: ID, status: "locked" },
        snippet: "9f2c1d0e",
        createdAtMs: 1787334040000,
      }),
    ]);
    // No `data-wolf-fallback`, which W16's parser requires — the state Wolf
    // reaches when a validator changes under a template it already accepted.
    stub.memoriesById!["tmpl-1"] = JSON.stringify({
      id: "tmpl-1",
      labels: { kind: "report-template", name: ID, status: "locked" },
      content: '9f2c1d0e\n<section><div data-wolf-slot="headline"></div></section>',
      created_by_worker: "",
      created_by_session: "",
      created_at: 1787334040000,
    });
    const h = await harness(stub);
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.status).toBe(200);
    expect(res.json.report.has_template).toBe(true);
    expect(res.json.report.unreadable).toBe(true);
  });

  it("hypotheses_report_block: an UPSTREAM failure on the report read is NOT an unreadable report", async () => {
    // 🔴 The narrowing at the catch. An Bob outage or a bug must
    // propagate: answering 200 with an empty block would tell the operator
    // the report layer is idle while the upstream is down, and W10's poller
    // reads `unavailable` as "retry" and `internal` as "we have a bug" — both
    // of which this would erase.
    const stub = withTemplate(baseStub());
    stub.details![`report:${ID}`] = page([
      memoryRow({
        id: "rep-1",
        labels: { kind: "report", name: ID },
        snippet: "the basket held\n{",
        createdByWorker: `researcher-${ID}`,
        createdBySession: "sess-tick",
        createdAtMs: 1787334090000,
      }),
    ]);
    // `memoriesById` has no `rep-1`, so the full read is a 500 from Bob,
    // not a parse failure.
    stub.failMemoryById = { "rep-1": 500 };
    const h = await harness(stub);
    const res = await get(h, `/api/hypotheses/${ID}`);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.json.kind).not.toBe("invalid");
  });

  it("hypotheses_report_block: both report reads carry include_retracted=1", async () => {
    // Without it Bob filters retracted rows BEFORE the reduction and a
    // hostile retraction silently hands back an older row (R90).
    const h = await harness(withReport(withTemplate(baseStub()), { headline: "<p>x</p>" }));
    await get(h, `/api/hypotheses/${ID}`);
    for (const kind of ["report-template", "report"]) {
      const request = h.stub.requests.find(
        (r) => r.path.includes(`selector=kind%3D${kind}%2Cname%3D${ID}`) && !r.path.includes("latest_per"),
      );
      expect(request, kind).toBeDefined();
      expect(request!.path, kind).toContain("include_retracted=1");
    }
  });
});

// ── The four human routes (W9) ──────────────────────────────────────────
//
// The provisioner's own behaviour — the two orderings, the rollback, the
// drain — is graded in `hypothesis/provision.test.ts`. What is graded HERE is
// the HTTP surface: the guard, the status codes and the body shapes. The
// harness builds the REAL provisioner (it is handed a real `WolfConfig`), so
// "zero memory writes" below is a genuine observation of the wire and not a
// fake that was never called.

describe("hypotheses_human_routes", () => {
  const ID = "1a1a1a1a";
  const SESSION_ID = "sess-hyp-1a1a1a1a";

  /**
   * ⚠️ Every stub here carries a LOCKED REPORT TEMPLATE, and it is not
   * scenery. W22 added the server-side half of the go-live gate: `POST
   * …/go-live` refuses a hypothesis with no `kind=report-template` at 422
   * before the provisioner is reached, so a stub without one never gets as
   * far as the spec errors these tests are about. The refusal itself is
   * graded by its own case below.
   */
  function draftStub(): StubConfig {
    return {
      sessions: [sessionRow(`hyp-${ID}`, SESSION_ID)],
      details: {
        [`hypothesis:${ID}`]: page([stateRow(ID, "draft", "Copper is the new oil")]),
        [`report-template:${ID}`]: page([
          memoryRow({
            id: "tmpl-live",
            labels: { kind: "report-template", name: ID, status: "locked" },
            snippet: "9f2c1d0e",
          }),
        ]),
      },
      memoriesById: {
        "tmpl-live": JSON.stringify({
          id: "tmpl-live",
          labels: { kind: "report-template", name: ID, status: "locked" },
          content: '9f2c1d0e\n<section><div data-wolf-slot="headline"></div></section>',
          created_by_worker: "",
          created_by_session: "",
          created_at: 1787334040000,
        }),
      },
    };
  }

  const ROUTES: { path: string; body: unknown }[] = [
    { path: `/api/hypotheses/${ID}/go-live`, body: {} },
    { path: `/api/hypotheses/${ID}/verdict`, body: { verdict: "confirmed", rationale: "held" } },
    { path: `/api/hypotheses/${ID}/retire`, body: { rationale: "done" } },
    {
      path: `/api/hypotheses/${ID}/amend`,
      body: { amendment_id: "amend-1", decision: "accept", rationale: "regime change" },
    },
  ];

  it("hypotheses_human_routes: all four are 401 with NO cookie, and write zero memories", async () => {
    // Only the human-initiated routes can produce confirmed / invalidated /
    // archived, and this is the gate that makes that true.
    for (const route of ROUTES) {
      const h = await harness(draftStub());
      const res = await post(h, route.path, route.body, false);
      expect(res.status, route.path).toBe(401);
      expect(res.json.kind).toBe("forbidden");
      expect(h.stub.appendRequests, route.path).toHaveLength(0);
    }
  });

  it("hypotheses_human_routes: go-live takes NO body and refuses a hypothesis with no candidate, 422", async () => {
    const h = await harness(draftStub());
    const res = await post(h, `/api/hypotheses/${ID}/go-live`, undefined);

    expect(res.status).toBe(422);
    expect(res.json.kind).toBe("invalid");
    expect(res.json.details.errors).toEqual([{ path: "", message: "no spec proposed yet" }]);
    // Nothing provisioned on that path.
    expect(h.stub.appendRequests).toHaveLength(0);
    expect(h.stub.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
  });

  it("hypotheses_human_routes: go-live returns 422 with EVERY spec error, each carrying its path", async () => {
    const stub = draftStub();
    stub.details![`hypothesis-spec-candidate:${ID}`] = page([
      memoryRow({
        id: "cand-bad",
        labels: { kind: "hypothesis-spec-candidate", name: ID },
        createdBySession: SESSION_ID,
      }),
    ]);
    stub.memoriesById!["cand-bad"] = JSON.stringify({
        id: "cand-bad",
        labels: { kind: "hypothesis-spec-candidate", name: ID },
        content: `a summary\n${JSON.stringify({ thesis: "t", horizon_days: 1, metrics: [], invalidation: [] })}`,
        created_by_worker: "",
        created_by_session: SESSION_ID,
      created_at: 1787334047000,
    });
    const h = await harness(stub);
    const res = await post(h, `/api/hypotheses/${ID}/go-live`, {});

    expect(res.status).toBe(422);
    expect(res.json.details.errors.length).toBeGreaterThan(1);
    for (const error of res.json.details.errors) {
      expect(typeof error.path).toBe("string");
      expect(typeof error.message).toBe("string");
    }
    expect(h.stub.appendRequests).toHaveLength(0);
  });

  it("hypotheses_human_routes: /verdict refuses any verdict outside the two, and an empty rationale, 400", async () => {
    const h = await harness(draftStub());
    for (const body of [
      { verdict: "maybe", rationale: "x" },
      { verdict: "confirmed", rationale: "" },
      { verdict: "confirmed", rationale: "   " },
      { rationale: "x" },
    ]) {
      const res = await post(h, `/api/hypotheses/${ID}/verdict`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json.kind).toBe("invalid");
    }
    expect(h.stub.appendRequests).toHaveLength(0);
  });

  it("hypotheses_human_routes: /amend refuses any decision outside accept|reject, 400", async () => {
    const h = await harness(draftStub());
    for (const body of [
      { amendment_id: "a", decision: "defer", rationale: "x" },
      { amendment_id: "", decision: "accept", rationale: "x" },
      { amendment_id: "a", decision: "accept", rationale: "" },
    ]) {
      const res = await post(h, `/api/hypotheses/${ID}/amend`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(h.stub.appendRequests).toHaveLength(0);
  });

  it("hypotheses_human_routes: /retire refuses an empty rationale, 400", async () => {
    const h = await harness(draftStub());
    expect((await post(h, `/api/hypotheses/${ID}/retire`, {})).status).toBe(400);
    expect((await post(h, `/api/hypotheses/${ID}/retire`, { rationale: " " })).status).toBe(400);
    expect(h.stub.appendRequests).toHaveLength(0);
  });

  it("hypotheses_human_routes: go-live is 422 with path report.has_template when no template is locked", async () => {
    // R45's server-side backstop. W24's button is enabled iff
    // `spec_validation.valid && report.has_template`; this is the race, and
    // 422 maps to `invalid` in § "Shared error taxonomy" — never `internal`.
    const stub = draftStub();
    delete stub.details![`report-template:${ID}`];
    const h = await harness(stub);
    const res = await post(h, `/api/hypotheses/${ID}/go-live`, {});

    expect(res.status).toBe(422);
    expect(res.json.kind).toBe("invalid");
    expect(res.json.details.errors).toEqual([
      {
        path: "report.has_template",
        message:
          "no report template has been locked for this hypothesis — author one before going live",
      },
    ]);
    // Nothing provisioned: no memory written and no worker created.
    expect(h.stub.appendRequests).toHaveLength(0);
    expect(h.stub.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
  });

  it("hypotheses_human_routes: a template FORGED from inside a container does not open the gate", async () => {
    // `has_template` is the same read the detail block reports, so a template
    // that fails the trust rule is not a template here either — otherwise a
    // prompt-injected researcher could unlock its own go-live.
    const stub = draftStub();
    stub.details![`report-template:${ID}`] = page([
      memoryRow({
        id: "tmpl-forged",
        labels: { kind: "report-template", name: ID, status: "locked" },
        snippet: "9f2c1d0e",
        createdByWorker: `researcher-${ID}`,
        createdBySession: "sess-tick",
      }),
    ]);
    const h = await harness(stub);
    const res = await post(h, `/api/hypotheses/${ID}/go-live`, {});

    expect(res.status).toBe(422);
    expect(res.json.details.errors[0].path).toBe("report.has_template");
    expect(h.stub.appendRequests).toHaveLength(0);
  });

  it("hypotheses_human_routes: a malformed id is 400 before anything is read", async () => {
    const h = await harness(draftStub());
    const res = await post(h, `/api/hypotheses/hyp-${ID}/go-live`, {});
    expect(res.status).toBe(400);
    expect(h.stub.requests.filter((r) => r.path.includes("hyp-hyp-"))).toHaveLength(0);
  });
});
