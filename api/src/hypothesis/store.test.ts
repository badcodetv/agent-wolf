import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MockAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
  type Interceptable,
} from "undici";

import { WolfError } from "../errors.js";
import { createOrangeClient, type OrangeClient } from "../orange/client.js";
import {
  HYPOTHESIS_ID_PATTERN,
  LABEL_VALUE_PATTERN,
  MAX_LABEL_VALUE_LENGTH,
  SESSION_NAME_PATTERN,
  SNIPPET_MAX_CHARS,
  TRUSTED_KINDS,
  TRUSTED_KIND_LIST,
  buildHypothesisContent,
  createHypothesisStore,
  hypothesisIdFromSessionName,
  isTrusted,
  newHypothesisId,
  parseHypothesisContent,
  parseTitleFromSnippet,
  sessionNameForHypothesis,
  slugifyOwner,
  type HypothesisStore,
  type Tamper,
} from "./store.js";

// design/2026-08-20-agent-wolf.md § "The trust model" + W5's acceptance
// criteria. Test names are prefixed `store_` per the ticket.
//
// Every Orange body these tests are graded against is a RECORDED response from
// a running O11 build — see `__fixtures__/README.md` for the commit, the date
// and how each row was written. The retraction cases in particular are
// meaningless against invented JSON: the whole question is what `retracted_by`
// actually contains, and only Orange can answer that.

const BASE_URL = "http://orange.test:4100";
const API_KEY = "wolf-test-secret-9f3a7c21";

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
}

/** A captured `GET /agent/sessions` row. Only the fields Wolf reads are typed. */
interface CapturedSessionRow {
  id: string;
  name?: string;
  worker?: string;
  status: string;
  created_at: number;
  updated_at: number;
  [key: string]: unknown;
}

const SESSION_PAGES: readonly CapturedSessionRow[][] = [
  JSON.parse(fixture("sessions-interviewer-page1.json")) as CapturedSessionRow[],
  JSON.parse(fixture("sessions-interviewer-page2.json")) as CapturedSessionRow[],
  JSON.parse(fixture("sessions-interviewer-page3.json")) as CapturedSessionRow[],
];
/** All six captured interviewer sessions, newest first, exactly as Orange ordered them. */
const ALL_SESSION_ROWS: readonly CapturedSessionRow[] = SESSION_PAGES.flat();

function sessionsNamed(...names: string[]): CapturedSessionRow[] {
  // Real captured rows, selected by name and re-paged by the stub. Nothing is
  // reshaped: these are the objects Orange returned.
  return names.map((name) => {
    const row = ALL_SESSION_ROWS.find((r) => r.name === name);
    if (row === undefined) throw new Error(`no captured session row named ${name}`);
    return row;
  });
}

// ── The stub Orange ─────────────────────────────────────────────────────

interface Recorded {
  method: string;
  path: string;
  body?: string;
}

interface StubConfig {
  sessions?: readonly CapturedSessionRow[];
  /** Raw body for the `latest_per=name` board read. */
  board?: string;
  /** Raw bodies for the per-name follow-up, keyed by bare id. */
  details?: Record<string, string>;
  /** Raw bodies for `GET /agent/memories/{id}`, keyed by memory id. */
  memoriesById?: Record<string, string>;
  /** What `POST /agent/memories` answers with. */
  appendStatus?: number;
}

const EMPTY_MEMORIES = '{"memories":[]}';

class Stub {
  readonly requests: Recorded[] = [];
  constructor(
    private readonly pool: Interceptable,
    private readonly config: StubConfig,
  ) {}

  get memoryRequests(): Recorded[] {
    return this.requests.filter((r) => r.path.startsWith("/agent/memories"));
  }
  get sessionRequests(): Recorded[] {
    return this.requests.filter((r) => r.path.startsWith("/agent/sessions"));
  }
  get appendRequests(): Recorded[] {
    return this.requests.filter((r) => r.method === "POST" && r.path.startsWith("/agent/memories"));
  }

  install(): void {
    for (const method of ["GET", "POST"]) {
      this.pool
        .intercept({ method, path: () => true })
        .reply((opts) => {
          const path = String(opts.path);
          const body = typeof opts.body === "string" ? opts.body : undefined;
          this.requests.push({ method, path, body });
          const url = new URL(path, BASE_URL);
          const answer = this.route(method, url);
          return {
            statusCode: answer.status,
            data: answer.data as never,
            responseOptions: { headers: { "content-type": "application/json" } },
          };
        })
        .persist();
    }
  }

  private route(method: string, url: URL): { status: number; data: unknown } {
    if (method === "POST" && url.pathname === "/agent/memories") {
      const status = this.config.appendStatus ?? 201;
      return {
        status,
        data: JSON.stringify({
          id: `appended-${this.appendRequests.length}`,
          labels: {},
          content: "",
          created_by_worker: "",
          created_by_session: "",
          created_at: 1787334046842,
        }),
      };
    }
    if (url.pathname === "/agent/sessions") {
      const rows = this.config.sessions ?? [];
      const limit = Number(url.searchParams.get("limit") ?? "200");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const worker = url.searchParams.get("worker");
      const filtered = worker === null ? rows : rows.filter((r) => r.worker === worker);
      return { status: 200, data: JSON.stringify(filtered.slice(offset, offset + limit)) };
    }
    if (url.pathname.startsWith("/agent/memories/")) {
      const id = decodeURIComponent(url.pathname.slice("/agent/memories/".length));
      const found = this.config.memoriesById?.[id];
      if (found === undefined) return { status: 404, data: "memory not found" };
      return { status: 200, data: found };
    }
    if (url.pathname === "/agent/memories") {
      if (url.searchParams.get("latest_per") !== null) {
        return { status: 200, data: this.config.board ?? EMPTY_MEMORIES };
      }
      const selector = url.searchParams.get("selector") ?? "";
      const match = /name=([0-9a-f]{8})/.exec(selector);
      const id = match?.[1];
      const found = id === undefined ? undefined : this.config.details?.[id];
      return { status: 200, data: found ?? EMPTY_MEMORIES };
    }
    return { status: 404, data: "unrouted in the stub: " + url.pathname };
  }
}

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

function orange(): OrangeClient {
  return createOrangeClient({ baseUrl: BASE_URL, apiKey: API_KEY });
}

function harness(config: StubConfig): { store: HypothesisStore; stub: Stub } {
  const stub = new Stub(pool, config);
  stub.install();
  return { store: createHypothesisStore({ client: orange() }), stub };
}

/** The four hypotheses the tamper fixtures describe. */
const TAMPERED = {
  board: fixture("board-latest-per.json"),
  details: {
    "1a2b3c4d": fixture("detail-1a2b3c4d-include-retracted.json"),
    "2b3c4d5e": fixture("detail-2b3c4d5e-include-retracted.json"),
    "3c4d5e6f": fixture("detail-3c4d5e6f-include-retracted.json"),
    "4d5e6f70": fixture("detail-4d5e6f70-include-retracted.json"),
  },
  sessions: sessionsNamed("hyp-1a2b3c4d", "hyp-2b3c4d5e", "hyp-3c4d5e6f", "hyp-4d5e6f70"),
};

function tamperOf(record: { tamper?: Tamper[] }, reason: Tamper["reason"]): Tamper[] {
  return (record.tamper ?? []).filter((t) => t.reason === reason);
}

// ── TRUSTED_KINDS ───────────────────────────────────────────────────────

describe("store_trusted_kinds", () => {
  it("store_trusted_kinds: the set is exactly the five ENUMERATED kinds", () => {
    // Enumerated, never counted. An earlier draft of the plan said "the five
    // kinds" while its vocabulary listed six; an executor enumerating the wrong
    // set makes every memory W10's poller writes untrusted, the board silently
    // shows no support_score, and no test in either ticket fails.
    for (const kind of [
      "hypothesis",
      "hypothesis-spec",
      "verdict",
      "evaluation",
      "report-template",
    ]) {
      expect(TRUSTED_KINDS.has(kind)).toBe(true);
    }
    for (const kind of [
      "research-note",
      "spec-amendment",
      "hypothesis-spec-candidate",
      "report-candidate",
      "report",
      "report-amendment",
    ]) {
      expect(TRUSTED_KINDS.has(kind)).toBe(false);
    }
    expect([...TRUSTED_KINDS].sort()).toEqual(
      ["evaluation", "hypothesis", "hypothesis-spec", "report-template", "verdict"].sort(),
    );
  });

  it("store_trusted_kinds: the set is frozen at runtime, not merely readonly at compile time", () => {
    expect(Object.isFrozen(TRUSTED_KIND_LIST)).toBe(true);
    // `Object.freeze` alone does not stop `Set.prototype.add`, so the mutators
    // are shadowed. Without this, any module could quietly widen the trust
    // boundary at import time.
    expect(() => (TRUSTED_KINDS as Set<string>).add("research-note")).toThrow(TypeError);
    expect(TRUSTED_KINDS.has("research-note")).toBe(false);
  });
});

// ── isTrusted ───────────────────────────────────────────────────────────

describe("store_is_trusted", () => {
  const sessions = new Set(["1a2b3c4d"]);
  const trusted = {
    labels: { kind: "hypothesis", name: "1a2b3c4d", status: "live" },
    createdByWorker: "",
    createdBySession: "",
  };

  it("store_is_trusted: all three clauses hold", () => {
    expect(isTrusted(trusted, sessions)).toBe(true);
  });

  it("store_is_trusted: a worker's row fails clause 1", () => {
    expect(isTrusted({ ...trusted, createdByWorker: "researcher-1a2b3c4d" }, sessions)).toBe(false);
  });

  it("store_is_trusted: a session's row fails clause 1", () => {
    expect(isTrusted({ ...trusted, createdBySession: "sess-b31f0c9a" }, sessions)).toBe(false);
  });

  it("store_is_trusted: an untrusted kind fails clause 2", () => {
    for (const kind of ["research-note", "spec-amendment", "report"]) {
      expect(isTrusted({ ...trusted, labels: { ...trusted.labels, kind } }, sessions)).toBe(false);
    }
  });

  it("store_is_trusted: empty provenance and a trusted kind are NOT sufficient — the session clause is the one that cannot be forged", () => {
    // This is the ApplyTopology path (R24): `POST /agent/topologies/apply` is
    // reachable by any API-class credential and writes memory seeds with NO
    // provenance. Clause 3 is what stops such a row becoming state.
    const forgedByTopology = {
      labels: { kind: "hypothesis", name: "deadbeef", status: "confirmed" },
      createdByWorker: "",
      createdBySession: "",
    };
    expect(forgedByTopology.createdByWorker).toBe("");
    expect(TRUSTED_KINDS.has(forgedByTopology.labels.kind)).toBe(true);
    expect(isTrusted(forgedByTopology, sessions)).toBe(false);
  });

  it("store_is_trusted: a row with no name label is never trusted", () => {
    expect(
      isTrusted({ labels: { kind: "hypothesis" }, createdByWorker: "", createdBySession: "" }, sessions),
    ).toBe(false);
  });
});

// ── Ids and the doubled prefix ──────────────────────────────────────────

describe("store_ids", () => {
  it("store_ids: generated ids are bare 8 lowercase hex characters", () => {
    for (let i = 0; i < 200; i += 1) {
      const id = newHypothesisId();
      expect(id).toMatch(HYPOTHESIS_ID_PATTERN);
      expect(id.startsWith("hyp-")).toBe(false);
    }
  });

  it("store_ids: the hyp- prefix is added exactly once, on the session name", () => {
    expect(sessionNameForHypothesis("1a2b3c4d")).toBe("hyp-1a2b3c4d");
    expect(sessionNameForHypothesis("1a2b3c4d")).toMatch(SESSION_NAME_PATTERN);
    expect(hypothesisIdFromSessionName("hyp-1a2b3c4d")).toBe("1a2b3c4d");
    expect(hypothesisIdFromSessionName("settings-chat")).toBeNull();
    expect(hypothesisIdFromSessionName(undefined)).toBeNull();
    expect(hypothesisIdFromSessionName("hyp-hyp-1a2b3c4d")).toBeNull();
  });

  it("store_ids: an already-prefixed id is refused rather than doubled", () => {
    // hyp-hyp-<id> makes the trust rule's session clause never match, and every
    // hypothesis then reads as untrusted with nothing failing anywhere.
    expect(() => sessionNameForHypothesis("hyp-1a2b3c4d")).toThrow(WolfError);
    try {
      sessionNameForHypothesis("hyp-1a2b3c4d");
    } catch (e) {
      expect((e as WolfError).kind).toBe("invalid");
    }
  });

  it("store_ids: no value the store emits or queries with ever matches hyp-hyp-", async () => {
    const { store, stub } = harness({
      ...TAMPERED,
      memoriesById: { "9d253a61-79f6-46b1-ad25-a552761b0a6d": fixture("memory-by-id-1a2b3c4d.json") },
    });
    await store.readBoard();
    await store.readHypothesis("1a2b3c4d");
    await store.appendState({
      id: "1a2b3c4d",
      status: "live",
      title: "The petrodollar is ending because of drone warfare",
      ownerEmail: "kai@badcode.dev",
    });
    await store.transition({ id: "1a2b3c4d", to: "challenged" });
    expect(stub.requests.length).toBeGreaterThan(0);
    for (const request of stub.requests) {
      expect(request.path).not.toContain("hyp-hyp");
      expect(request.body ?? "").not.toContain("hyp-hyp");
      // The memory `name` label and every selector carry the BARE id; the
      // prefix belongs to the session name and to nothing else.
      expect(request.body ?? "").not.toContain('"name":"hyp-');
    }
  });
});

// ── The session index ───────────────────────────────────────────────────

describe("store_session_index", () => {
  it("store_session_index: the three captured pages are walked to exhaustion", async () => {
    const { store, stub } = harness({ sessions: ALL_SESSION_ROWS });
    const index = await store.readSessionIndex({ sessionPageSize: 2 });
    expect([...index.keys()].sort()).toEqual(["1a2b3c4d", "2b3c4d5e", "3c4d5e6f", "4d5e6f70"]);
    // Four pages: three full-or-partial data pages, and the walk stops at the
    // first short one (2, 2, then 1).
    expect(stub.sessionRequests).toHaveLength(3);
    for (const request of stub.sessionRequests) {
      const query = new URL(request.path, BASE_URL).searchParams;
      // Both filters are load-bearing and both are server-side.
      expect(query.get("user_email")).toBe("*");
      expect(query.get("worker")).toBe("interviewer");
    }
  });

  it("store_session_index: settings-chat is in the captured pages and is NOT a hypothesis", async () => {
    expect(ALL_SESSION_ROWS.some((r) => r.name === "settings-chat")).toBe(true);
    const { store } = harness({ sessions: ALL_SESSION_ROWS });
    const index = await store.readSessionIndex({ sessionPageSize: 2 });
    expect(index.has("settings-chat")).toBe(false);
  });

  it("store_session_index: the index carries the Orange session id, for W8's atoms", async () => {
    const { store } = harness({ sessions: ALL_SESSION_ROWS });
    const index = await store.readSessionIndex({ sessionPageSize: 2 });
    const entry = index.get("1a2b3c4d");
    const captured = ALL_SESSION_ROWS.find((r) => r.name === "hyp-1a2b3c4d");
    expect(entry?.sessionId).toBe(captured?.id);
    expect(entry?.sessionName).toBe("hyp-1a2b3c4d");
  });

  it("store_session_index: 120 sessions across three pages all appear in the index", async () => {
    // Scaled up from a captured row — the field shape is Orange's, the volume
    // is not (120 real containers is not a thing a unit test may create).
    const template = ALL_SESSION_ROWS[0];
    if (template === undefined) throw new Error("no captured session rows");
    const many: CapturedSessionRow[] = Array.from({ length: 120 }, (_, i) => ({
      ...template,
      id: `session-${i}`,
      name: `hyp-${i.toString(16).padStart(8, "0")}`,
    }));
    const { store, stub } = harness({ sessions: many });
    const index = await store.readSessionIndex({ sessionPageSize: 50 });
    expect(index.size).toBe(120);
    // 50 + 50 + 20: the short third page is what ends the walk.
    expect(stub.sessionRequests).toHaveLength(3);
    expect(index.has("00000000")).toBe(true);
    expect(index.has("00000077")).toBe(true);
  });

  it("store_session_index: a page exactly the size of the limit costs one extra request", async () => {
    const template = ALL_SESSION_ROWS[0];
    if (template === undefined) throw new Error("no captured session rows");
    const many = Array.from({ length: 4 }, (_, i) => ({
      ...template,
      id: `session-${i}`,
      name: `hyp-${i.toString(16).padStart(8, "0")}`,
    }));
    const { store, stub } = harness({ sessions: many });
    const index = await store.readSessionIndex({ sessionPageSize: 2 });
    expect(index.size).toBe(4);
    expect(stub.sessionRequests).toHaveLength(3);
  });
});

// ── The board's two-step read ───────────────────────────────────────────

describe("store_board", () => {
  it("store_board: the all-trusted case issues exactly ONE memory request", async () => {
    const { store, stub } = harness({
      sessions: sessionsNamed("hyp-1a2b3c4d", "hyp-2b3c4d5e", "hyp-3c4d5e6f"),
      board: fixture("board-all-trusted.json"),
    });
    const records = await store.readBoard();
    expect(records).toHaveLength(3);
    expect(records.every((r) => r.tamper === undefined)).toBe(true);
    expect(records.map((r) => r.status).sort()).toEqual(["challenged", "draft", "live"]);
    // The fast path: one request paints the board however many hypotheses
    // there are. The session index is a separate request and is counted
    // separately.
    expect(stub.memoryRequests).toHaveLength(1);
    const query = new URL(stub.memoryRequests[0]?.path ?? "", BASE_URL).searchParams;
    expect(query.get("selector")).toBe("kind=hypothesis");
    expect(query.get("latest_per")).toBe("name");
    expect(query.get("limit")).toBe("100");
    expect(query.get("include_retracted")).toBeNull();
  });

  it("store_board: the board read carries the title, owner slug and updated_at from the trusted row", async () => {
    const { store } = harness({
      sessions: sessionsNamed("hyp-1a2b3c4d", "hyp-2b3c4d5e", "hyp-3c4d5e6f"),
      board: fixture("board-all-trusted.json"),
    });
    const records = await store.readBoard();
    const live = records.find((r) => r.id === "1a2b3c4d");
    expect(live).toMatchObject({
      id: "1a2b3c4d",
      sessionName: "hyp-1a2b3c4d",
      title: "The petrodollar is ending because of drone warfare",
      titleTruncated: false,
      owner: "kai-at-badcode.dev",
      status: "live",
    });
    expect(live?.updatedAtMs).toBeGreaterThan(1_700_000_000_000);
  });

  it("store_board: a follow-up is issued ONLY for the ids whose newest row is untrusted or missing", async () => {
    const { store, stub } = harness(TAMPERED);
    await store.readBoard();
    const followUps = stub.memoryRequests.filter(
      (r) => new URL(r.path, BASE_URL).searchParams.get("latest_per") === null,
    );
    // 1a2b3c4d's newest row is trusted, so it costs nothing extra. The other
    // three are anomalies: one forged, two that vanished from the default read
    // because they were retracted.
    expect(followUps).toHaveLength(3);
    const ids = followUps
      .map((r) => new URL(r.path, BASE_URL).searchParams.get("selector") ?? "")
      .sort();
    expect(ids).toEqual([
      "kind=hypothesis,name=2b3c4d5e",
      "kind=hypothesis,name=3c4d5e6f",
      "kind=hypothesis,name=4d5e6f70",
    ]);
    for (const request of followUps) {
      const query = new URL(request.path, BASE_URL).searchParams;
      expect(query.get("include_retracted")).toBe("1");
      expect(query.get("limit")).toBe("50");
    }
  });

  it("store_board: a hypothesis in the session index whose state row is missing is an anomaly, never a drop", async () => {
    const { store } = harness({
      sessions: sessionsNamed("hyp-1a2b3c4d", "hyp-2b3c4d5e", "hyp-3c4d5e6f", "hyp-4d5e6f70"),
      board: fixture("board-all-trusted.json"),
      details: {},
    });
    const records = await store.readBoard();
    expect(records.map((r) => r.id).sort()).toEqual([
      "1a2b3c4d",
      "2b3c4d5e",
      "3c4d5e6f",
      "4d5e6f70",
    ]);
    const orphan = records.find((r) => r.id === "4d5e6f70");
    expect(orphan?.status).toBeNull();
    expect(orphan?.sessionName).toBe("hyp-4d5e6f70");
  });

  it("store_board: a kind=hypothesis memory naming no session is ignored, not rendered", async () => {
    // The whole point of the session clause: a container can write any label it
    // likes, including a name for a hypothesis that does not exist.
    const { store } = harness({
      sessions: sessionsNamed("hyp-1a2b3c4d"),
      board: fixture("board-all-trusted.json"),
    });
    const records = await store.readBoard();
    expect(records.map((r) => r.id)).toEqual(["1a2b3c4d"]);
  });
});

// ── Forgery ─────────────────────────────────────────────────────────────

describe("store_forged_row", () => {
  it("store_forged_row: a forged status=confirmed row leaves the status unchanged and raises Tamper", async () => {
    const { store } = harness(TAMPERED);
    const records = await store.readBoard();
    const forged = records.find((r) => r.id === "2b3c4d5e");
    // The recorded board body shows the forged row WINNING latest_per — that is
    // what Orange returns, and why the board cannot be read from latest_per
    // alone.
    expect(fixture("board-latest-per.json")).toContain('"status":"confirmed"');
    expect(forged?.status).toBe("live");
    const tampers = tamperOf(forged ?? {}, "forged_row");
    expect(tampers).toHaveLength(1);
    expect(tampers[0]).toEqual({
      reason: "forged_row",
      written_by_worker: "researcher-2b3c4d5e",
      written_by_session: "sess-b31f0c9a",
      memory_id: "754cf456-20f9-45a0-876e-8a8fa6f7cfe7",
    });
  });

  it("store_forged_row: memory_id names the OFFENDING row, not the trusted one", async () => {
    const { store } = harness(TAMPERED);
    const record = await store.readHypothesis("2b3c4d5e");
    const tampers = tamperOf(record, "forged_row");
    expect(tampers[0]?.memory_id).not.toBe(record.statusMemoryId);
    expect(record.statusMemoryId).toBe("26df4f21-b826-499c-90c3-81e9c7e89988");
  });
});

// ── Retraction: the criterion that matters ──────────────────────────────

describe("store_hostile_retraction", () => {
  it("store_hostile_retraction: the default read makes a retracted hypothesis VANISH — this is the attack", () => {
    // Recorded, not asserted about our own code: four hypotheses existed when
    // `board-latest-per.json` was captured and two came back, because
    // notRetractedSQL hides a row for which ANY memory carries retracts=<id>,
    // never checking who wrote the retraction.
    const board = JSON.parse(fixture("board-latest-per.json")) as {
      memories: Array<{ labels: Record<string, string> }>;
    };
    expect(board.memories.map((m) => m.labels["name"]).sort()).toEqual(["1a2b3c4d", "2b3c4d5e"]);
  });

  it("store_hostile_retraction: a session's retraction of a trusted row does not change the status, and names the retractor", async () => {
    const { store } = harness(TAMPERED);
    const records = await store.readBoard();
    const attacked = records.find((r) => r.id === "3c4d5e6f");
    expect(attacked?.status).toBe("live");
    expect(attacked?.title).toBe("Uranium enrichment capacity is the binding constraint");
    const tampers = tamperOf(attacked ?? {}, "hostile_retraction");
    expect(tampers).toHaveLength(1);
    expect(tampers[0]).toEqual({
      reason: "hostile_retraction",
      written_by_worker: "",
      written_by_session: "sess-77c1e2d5",
      memory_id: "7b5fa4b6-d976-4d3e-b7be-467b3c717c40",
    });
  });

  it("store_hostile_retraction: every Tamper names a non-empty writer and the OFFENDING memory", async () => {
    // The plan's § "Shared shapes" says "exactly one of the two provenance
    // fields is non-empty". That is not what Orange produces, and the recorded
    // fixtures prove it: `caller.SessionID` is always set for anything written
    // from inside a container and `caller.Worker` is set as well whenever the
    // session HAS a worker (`go/cmd/agentd/mcpserver.go:534`) — which is every
    // researcher tick, and every interview session too, since W8 creates those
    // with `worker: "interviewer"`. So the invariant that actually holds, and
    // the one this store enforces, is AT LEAST one.
    const { store } = harness(TAMPERED);
    const records = await store.readBoard();
    let seen = 0;
    for (const record of records) {
      for (const tamper of record.tamper ?? []) {
        seen += 1;
        const nonEmpty = [tamper.written_by_worker, tamper.written_by_session].filter(
          (v) => v !== "",
        );
        expect(nonEmpty.length).toBeGreaterThanOrEqual(1);
        expect(tamper.memory_id).not.toBe("");
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("store_hostile_retraction: a row written by a WORKER session carries both provenance fields", async () => {
    // Recorded evidence for the paragraph above, straight out of the captured
    // body rather than out of this codebase.
    const detail = JSON.parse(fixture("detail-2b3c4d5e-include-retracted.json")) as {
      memories: Array<{ created_by_worker: string; created_by_session: string }>;
    };
    expect(detail.memories[0]?.created_by_worker).toBe("researcher-2b3c4d5e");
    expect(detail.memories[0]?.created_by_session).toBe("sess-b31f0c9a");
  });

  it("store_hostile_retraction: a retraction on top of Wolf's own does NOT resurrect the row (owner decision B5)", async () => {
    // The recorded body is the whole point: `retracted_by` carries BOTH
    // retractions, newest first, and the newest is the hostile one. A reader
    // that looked only at retracted_by[0] would discard it as untrusted and
    // bring back a row Wolf legitimately withdrew.
    const detail = JSON.parse(fixture("detail-4d5e6f70-include-retracted.json")) as {
      memories: Array<{ retracted_by?: Array<{ created_by_worker: string }> }>;
    };
    const retractions = detail.memories[0]?.retracted_by ?? [];
    expect(retractions).toHaveLength(2);
    expect(retractions[0]?.created_by_worker).toBe("researcher-4d5e6f70");
    expect(retractions[1]?.created_by_worker).toBe("");

    const { store } = harness(TAMPERED);
    const record = await store.readHypothesis("4d5e6f70");
    // Retracted, because AT LEAST ONE retraction has empty provenance.
    expect(record.status).toBeNull();
    expect(record.statusMemoryId).toBeNull();
    // …and the hostile retractor is still named.
    const tampers = tamperOf(record, "hostile_retraction");
    expect(tampers).toHaveLength(1);
    expect(tampers[0]?.written_by_worker).toBe("researcher-4d5e6f70");
    expect(tampers[0]?.memory_id).toBe("b56e4328-6923-417c-8345-305166fd8e46");
  });

  it("store_hostile_retraction: a clean history produces no tamper at all", async () => {
    const { store } = harness(TAMPERED);
    const record = await store.readHypothesis("1a2b3c4d");
    expect(record.tamper).toBeUndefined();
    expect(record.status).toBe("live");
  });

  it("store_hostile_retraction: the detail read ALWAYS asks for the audit view", async () => {
    const { store, stub } = harness(TAMPERED);
    await store.readHypothesis("1a2b3c4d");
    const reads = stub.memoryRequests.filter((r) => r.method === "GET");
    expect(reads).toHaveLength(1);
    expect(new URL(reads[0]?.path ?? "", BASE_URL).searchParams.get("include_retracted")).toBe("1");
  });

  it("store_hostile_retraction: an unknown id is not_found, not an empty hypothesis", async () => {
    const { store } = harness(TAMPERED);
    await expect(store.readHypothesis("deadbeef")).rejects.toMatchObject({ kind: "not_found" });
  });
});

// ── Writes ──────────────────────────────────────────────────────────────

describe("store_append", () => {
  it("store_append: the request body carries NO provenance keys", async () => {
    const { store, stub } = harness({ sessions: [] });
    await store.appendState({
      id: "1a2b3c4d",
      status: "draft",
      title: "The petrodollar is ending because of drone warfare",
      thesis: "Buy drone-parts suppliers.",
      ownerEmail: "kai@badcode.dev",
    });
    const append = stub.appendRequests[0];
    expect(append).toBeDefined();
    const body = JSON.parse(append?.body ?? "{}") as Record<string, unknown>;
    // O7 rejects a body containing either key with 400 rather than ignoring it
    // — even when the value is the empty string.
    expect(Object.keys(body)).not.toContain("created_by_worker");
    expect(Object.keys(body)).not.toContain("created_by_session");
    expect(append?.body).not.toContain("created_by");
    expect(body["labels"]).toEqual({
      kind: "hypothesis",
      name: "1a2b3c4d",
      status: "draft",
      owner: "kai-at-badcode.dev",
    });
    expect(String(body["content"]).split("\n")[0]).toBe(
      "The petrodollar is ending because of drone warfare",
    );
    // The full address is in the content, never in a label.
    expect(String(body["content"])).toContain("kai@badcode.dev");
    expect(JSON.stringify(body["labels"])).not.toContain("@");
  });

  it("store_append: anything but 201 from the append route is an error, not a shrug", async () => {
    const { store } = harness({ sessions: [], appendStatus: 200 });
    await expect(
      store.appendState({
        id: "1a2b3c4d",
        status: "draft",
        title: "t",
        ownerEmail: "kai@badcode.dev",
      }),
    ).rejects.toBeInstanceOf(WolfError);
  });

  it("store_append: a restated_from label is carried when given", async () => {
    const { store, stub } = harness({ sessions: [] });
    await store.appendState({
      id: "1a2b3c4d",
      status: "draft",
      title: "t",
      ownerEmail: "kai@badcode.dev",
      restatedFrom: "2b3c4d5e",
    });
    const body = JSON.parse(stub.appendRequests[0]?.body ?? "{}") as {
      labels: Record<string, string>;
    };
    expect(body.labels["restated_from"]).toBe("2b3c4d5e");
  });

  it("store_append: a non-id is refused before anything is written", async () => {
    const { store, stub } = harness({ sessions: [] });
    await expect(
      store.appendState({
        id: "hyp-1a2b3c4d",
        status: "draft",
        title: "t",
        ownerEmail: "kai@badcode.dev",
      }),
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(stub.appendRequests).toHaveLength(0);
  });
});

describe("store_transition", () => {
  const wired = {
    ...TAMPERED,
    memoriesById: { "9d253a61-79f6-46b1-ad25-a552761b0a6d": fixture("memory-by-id-1a2b3c4d.json") },
  };

  it("store_transition: a self-pair writes NOTHING — no POST /agent/memories at all", async () => {
    const { store, stub } = harness(wired);
    const outcome = await store.transition({ id: "1a2b3c4d", to: "live" });
    expect(outcome).toMatchObject({ from: "live", to: "live", changed: false, memoryId: null });
    expect(stub.appendRequests).toHaveLength(0);
  });

  it("store_transition: a legal transition appends exactly one row, carrying the title forward", async () => {
    const { store, stub } = harness(wired);
    const outcome = await store.transition({ id: "1a2b3c4d", to: "challenged" });
    expect(outcome.changed).toBe(true);
    expect(stub.appendRequests).toHaveLength(1);
    const body = JSON.parse(stub.appendRequests[0]?.body ?? "{}") as {
      labels: Record<string, string>;
      content: string;
    };
    expect(body.labels["status"]).toBe("challenged");
    expect(body.labels["name"]).toBe("1a2b3c4d");
    expect(body.content.split("\n")[0]).toBe(
      "The petrodollar is ending because of drone warfare",
    );
    // The owner address survives the round-trip through the recorded full-
    // content body's fenced block.
    expect(body.content).toContain("kai@badcode.dev");
    expect(body.labels["owner"]).toBe("kai-at-badcode.dev");
  });

  it("store_transition: the current state is RE-READ FROM ORANGE before the write", async () => {
    // Not from a value the caller passed in, and not from a cached board: the
    // read that decides the transition is an Orange round-trip issued inside
    // the critical section, immediately before the append.
    const { store, stub } = harness(wired);
    await store.transition({ id: "1a2b3c4d", to: "challenged" });
    const memoryCalls = stub.memoryRequests.map((r) => `${r.method} ${new URL(r.path, BASE_URL).pathname}`);
    const lastRead = memoryCalls.lastIndexOf("GET /agent/memories");
    const write = memoryCalls.indexOf("POST /agent/memories");
    expect(lastRead).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(lastRead);
    // …and that read asked for the audit view, so a hostile retraction cannot
    // hide the state a transition is computed against.
    const searches = stub.memoryRequests.filter(
      (r) => r.method === "GET" && new URL(r.path, BASE_URL).pathname === "/agent/memories",
    );
    expect(searches.length).toBeGreaterThan(0);
    expect(
      searches.every((r) => new URL(r.path, BASE_URL).searchParams.get("include_retracted") === "1"),
    ).toBe(true);
  });

  it("store_transition: an illegal transition throws a conflict naming both states and writes nothing", async () => {
    const { store, stub } = harness(wired);
    await expect(store.transition({ id: "1a2b3c4d", to: "confirmed" })).rejects.toMatchObject({
      kind: "conflict",
    });
    expect(stub.appendRequests).toHaveLength(0);
  });

  it("store_transition: an evaluation snapshot is embedded in the appended row", async () => {
    const { store, stub } = harness(wired);
    await store.transition({
      id: "1a2b3c4d",
      to: "challenged",
      evaluation: {
        evaluated_at_ms: 1787334046842,
        support_score: -0.42,
        conditions: [],
        metrics: [],
      },
      rationale: "condition_tripped",
    });
    const body = JSON.parse(stub.appendRequests[0]?.body ?? "{}") as { content: string };
    expect(body.content).toContain('"support_score": -0.42');
    expect(body.content).toContain("condition_tripped");
  });

  it("store_transition: a hypothesis whose state row was legitimately withdrawn cannot be transitioned", async () => {
    const { store } = harness(wired);
    await expect(store.transition({ id: "4d5e6f70", to: "live" })).rejects.toMatchObject({
      kind: "conflict",
    });
  });
});

// ── The owner slug ──────────────────────────────────────────────────────

describe("store_owner_slug", () => {
  it.each([
    ["kai@badcode.dev", "kai-at-badcode.dev"],
    ["KAI@BadCode.dev", "kai-at-badcode.dev"],
    ["kai+test@gmail.com", "kai-test-at-gmail.com"],
    ["jack@badcode.dev", "jack-at-badcode.dev"],
  ])("store_owner_slug: %s → %s", (email, expected) => {
    expect(slugifyOwner(email)).toBe(expected);
  });

  it("store_owner_slug: the pathological inputs still produce legal labels", () => {
    for (const email of ['"+@-.com"', "+@-.com", "@", "---", "", "@@@", "..."]) {
      const slug = slugifyOwner(email);
      expect(slug).toMatch(LABEL_VALUE_PATTERN);
      expect(slug.length).toBeLessThanOrEqual(MAX_LABEL_VALUE_LENGTH);
    }
  });

  it("store_owner_slug: an input that slugs to nothing falls back to u- plus a SHA-256 prefix", () => {
    // "@" alone is NOT such an input: it slugs to the legal label "at".
    expect(slugifyOwner("@")).toBe("at");
    // These are: every character is stripped, leaving nothing to build on.
    for (const input of ["---", "+++", "", "..."]) {
      const digest = createHash("sha256").update(input.toLowerCase()).digest("hex").slice(0, 8);
      expect(slugifyOwner(input)).toBe(`u-${digest}`);
    }
    // Stable for the same address, and case-insensitive with it.
    expect(slugifyOwner("KAI@BadCode.dev")).toBe(slugifyOwner("kai@badcode.dev"));
  });

  it("store_owner_slug: a very long address is trimmed to 63 characters and still legal", () => {
    const slug = slugifyOwner(`${"a".repeat(200)}@${"b".repeat(200)}.com`);
    expect(slug.length).toBe(MAX_LABEL_VALUE_LENGTH);
    expect(slug).toMatch(LABEL_VALUE_PATTERN);
  });

  it("store_owner_slug: 1000 random strings all produce legal Orange label values", () => {
    // Deterministic PRNG so a failure is reproducible from the seed alone.
    let seed = 0x5eed_1a2b;
    const next = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return Math.abs(seed);
    };
    const alphabet =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 @+._-/\\!#$%&'*=?^`{|}~()[]<>,;:\"éü漢字🙂\t\n";
    for (let i = 0; i < 1000; i += 1) {
      const length = next() % 40;
      let input = "";
      for (let j = 0; j < length; j += 1) {
        input += alphabet[next() % alphabet.length];
      }
      const slug = slugifyOwner(input);
      expect(slug).toMatch(LABEL_VALUE_PATTERN);
      expect(slug.length).toBeLessThanOrEqual(MAX_LABEL_VALUE_LENGTH);
      expect(slug.length).toBeGreaterThan(0);
    }
  });
});

// ── Titles and the 500-CHARACTER snippet ────────────────────────────────

describe("store_title", () => {
  interface CapturedSnippetRow {
    labels: Record<string, string>;
    snippet: string;
  }
  const snippetRows = (
    JSON.parse(fixture("snippet-truncation.json")) as { memories: CapturedSnippetRow[] }
  ).memories;
  const byName = (name: string): CapturedSnippetRow => {
    const row = snippetRows.find((r) => r.labels["name"] === name);
    if (row === undefined) throw new Error(`no captured row named ${name}`);
    return row;
  };

  it("store_title: a title shorter than the snippet parses whole and is not flagged", () => {
    const row = byName("1a2b3c4d");
    expect(row.snippet.length).toBeLessThan(SNIPPET_MAX_CHARS);
    expect(parseTitleFromSnippet(row.snippet)).toEqual({
      title: "The petrodollar is ending because of drone warfare",
      truncated: false,
    });
  });

  it("store_title: a first line longer than 500 characters is the truncated prefix, and says so", () => {
    const row = byName("5e6f7081");
    // Orange cut a 600-character first line at 500. There is no newline left in
    // the snippet, which is exactly how the cut is detectable.
    expect(row.snippet).not.toContain("\n");
    expect(row.snippet.length).toBe(SNIPPET_MAX_CHARS);
    const parsed = parseTitleFromSnippet(row.snippet);
    expect(parsed.truncated).toBe(true);
    expect(parsed.title).toBe(row.snippet);
    expect(parsed.title.length).toBe(500);
  });

  it("store_title: the snippet is 500 CHARACTERS, not 500 bytes — and the parse is still exact", () => {
    const row = byName("708192a3");
    expect(row.snippet.length).toBe(SNIPPET_MAX_CHARS);
    // The proof that substring(content,1,500) on a `text` column is
    // character-based: 500 characters, 1496 bytes of UTF-8.
    expect(Buffer.byteLength(row.snippet, "utf8")).toBeGreaterThan(500);
    const parsed = parseTitleFromSnippet(row.snippet);
    expect(parsed.truncated).toBe(false);
    expect(parsed.title.length).toBe(200);
    expect(Buffer.byteLength(parsed.title, "utf8")).toBe(600);
    expect(parsed.title.startsWith("石油ドル体制はドローン戦争によって終わる")).toBe(true);
    // No mid-character split anywhere: the server cannot produce one, so the
    // round-trip through the snippet is lossless for the title.
    expect(parsed.title).toBe(row.snippet.slice(0, 200));
  });

  it("store_title: a multibyte FIRST LINE past the limit is flagged truncated too", () => {
    const row = byName("6f708192");
    expect(row.snippet).not.toContain("\n");
    expect(Buffer.byteLength(row.snippet, "utf8")).toBe(1500);
    expect(parseTitleFromSnippet(row.snippet).truncated).toBe(true);
  });

  it("store_title: an empty snippet is an empty title, not a crash", () => {
    expect(parseTitleFromSnippet("")).toEqual({ title: "", truncated: false });
  });
});

// ── Content round-trip ──────────────────────────────────────────────────

describe("store_content", () => {
  it("store_content: build/parse round-trips title, thesis, owner and evaluation", () => {
    const content = buildHypothesisContent({
      title: "The petrodollar is ending",
      thesis: "Buy drone-parts suppliers.",
      ownerEmail: "kai@badcode.dev",
      evaluation: { evaluated_at_ms: 1, support_score: 0.5, conditions: [], metrics: [] },
      rationale: "condition_tripped",
    });
    expect(content.split("\n")[0]).toBe("The petrodollar is ending");
    const parsed = parseHypothesisContent(content);
    expect(parsed.title).toBe("The petrodollar is ending");
    expect(parsed.thesis).toBe("Buy drone-parts suppliers.");
    expect(parsed.ownerEmail).toBe("kai@badcode.dev");
    expect(parsed.rationale).toBe("condition_tripped");
    expect(parsed.evaluation?.support_score).toBe(0.5);
  });

  it("store_content: the recorded full-content body parses", () => {
    const record = JSON.parse(fixture("memory-by-id-1a2b3c4d.json")) as { content: string };
    const parsed = parseHypothesisContent(record.content);
    expect(parsed.title).toBe("The petrodollar is ending because of drone warfare");
    expect(parsed.ownerEmail).toBe("kai@badcode.dev");
    expect(parsed.thesis).toContain("Cheap attritable airframes");
    expect(parsed.evaluation).toBeNull();
  });

  it("store_content: a malformed fenced block is evidence, not a crash", () => {
    const parsed = parseHypothesisContent("A title\n\nsome prose\n\n```json\n{not json\n```");
    expect(parsed.title).toBe("A title");
    expect(parsed.thesis).toBe("some prose");
    expect(parsed.ownerEmail).toBeNull();
  });

  it("store_content: a title-only content is legal; an empty one is not", () => {
    expect(parseHypothesisContent("Just a title").title).toBe("Just a title");
    expect(() => buildHypothesisContent({ title: "   " })).toThrow(WolfError);
  });
});
