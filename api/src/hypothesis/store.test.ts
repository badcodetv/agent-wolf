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
  parseEvaluationSummaryLine,
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
  /**
   * Raw body for the `latest_per=name` board read WITH `include_retracted=1`,
   * which is the only way Wolf reads the board.
   */
  board?: string;
  /**
   * Raw body for the same query WITHOUT the flag. Orange answers these two
   * DIFFERENTLY (that is the whole point of the flag), so the stub does too:
   * a board read that drops `include_retracted` gets this body, and the
   * resurrection tests below then fail loudly instead of passing by accident.
   * Left unset it is the empty page — so every board test in this file also
   * fails if the flag is ever dropped.
   */
  boardDefault?: string;
  /**
   * Raw body for the `kind=evaluation` `latest_per=name` read (W8). Separate
   * from `board` because the two are different queries against the same
   * route, and answering one with the other would hide a wrong selector.
   */
  evaluations?: string;
  /** Raw bodies for the per-name follow-up, keyed by bare id. */
  details?: Record<string, string>;
  /** Raw bodies for the `kind=report-template,name=<id>` read (W15), keyed by bare id. */
  templates?: Record<string, string>;
  /** Raw bodies for the `kind=report,name=<id>` read (W15), keyed by bare id. */
  reports?: Record<string, string>;
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
        if ((url.searchParams.get("selector") ?? "").startsWith("kind=evaluation")) {
          return { status: 200, data: this.config.evaluations ?? EMPTY_MEMORIES };
        }
        if (url.searchParams.get("include_retracted") === "1") {
          return { status: 200, data: this.config.board ?? EMPTY_MEMORIES };
        }
        return { status: 200, data: this.config.boardDefault ?? EMPTY_MEMORIES };
      }
      const selector = url.searchParams.get("selector") ?? "";
      const match = /name=([0-9a-f]{8})/.exec(selector);
      const id = match?.[1];
      // Dispatch on the selector's OWN `kind=` term, not on a prefix test:
      // "kind=report" is a prefix of "kind=report-template", and answering one
      // query with the other's body is exactly the kind of stub bug that makes
      // a wrong selector pass.
      const kind = selector
        .split(",")
        .find((term) => term.startsWith("kind="))
        ?.slice("kind=".length);
      const bucket =
        kind === "report-template"
          ? this.config.templates
          : kind === "report"
            ? this.config.reports
            : this.config.details;
      const found = id === undefined ? undefined : bucket?.[id];
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
  board: fixture("board-latest-per-include-retracted.json"),
  boardDefault: fixture("board-latest-per.json"),
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
      board: fixture("board-all-trusted-include-retracted.json"),
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
    // LOAD-BEARING, and absent from the plan's board criterion. Orange applies
    // its retraction filter before the `latest_per` reduction, so without this
    // a hostile retraction of the newest row promotes the OLDER trusted row and
    // the board rolls back with no warning — see the resurrection tests below,
    // and `readBoard`'s comment. It costs nothing here: the fast path is still
    // one request.
    expect(query.get("include_retracted")).toBe("1");
  });

  it("store_board: the board read carries the title, owner slug and updated_at from the trusted row", async () => {
    const { store } = harness({
      sessions: sessionsNamed("hyp-1a2b3c4d", "hyp-2b3c4d5e", "hyp-3c4d5e6f"),
      board: fixture("board-all-trusted-include-retracted.json"),
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

  it("store_board: a follow-up is issued ONLY for the ids the newest row cannot settle", async () => {
    const { store, stub } = harness(TAMPERED);
    await store.readBoard();
    const followUps = stub.memoryRequests.filter(
      (r) => new URL(r.path, BASE_URL).searchParams.get("latest_per") === null,
    );
    // Two, not three. The newest row settles the hypothesis whenever it is
    // trusted and Wolf has not withdrawn it:
    //   1a2b3c4d — trusted, no retraction              → free
    //   3c4d5e6f — trusted, retracted BY A SESSION     → free, plus a Tamper;
    //              a container cannot withdraw Wolf's word, so there is
    //              nothing older to look for
    //   2b3c4d5e — newest row written by a researcher  → follow-up
    //   4d5e6f70 — trusted but retracted BY WOLF       → follow-up, because the
    //              answer is whatever row lies underneath
    expect(followUps).toHaveLength(2);
    const ids = followUps
      .map((r) => new URL(r.path, BASE_URL).searchParams.get("selector") ?? "")
      .sort();
    expect(ids).toEqual(["kind=hypothesis,name=2b3c4d5e", "kind=hypothesis,name=4d5e6f70"]);
    for (const request of followUps) {
      const query = new URL(request.path, BASE_URL).searchParams;
      expect(query.get("include_retracted")).toBe("1");
      expect(query.get("limit")).toBe("50");
    }
  });

  it("store_board: a hypothesis in the session index whose state row is missing is an anomaly, never a drop", async () => {
    const { store } = harness({
      sessions: sessionsNamed("hyp-1a2b3c4d", "hyp-2b3c4d5e", "hyp-3c4d5e6f", "hyp-4d5e6f70"),
      board: fixture("board-all-trusted-include-retracted.json"),
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
      board: fixture("board-all-trusted-include-retracted.json"),
    });
    const records = await store.readBoard();
    expect(records.map((r) => r.id)).toEqual(["1a2b3c4d"]);
  });
});

// ── The resurrection: a hostile retraction rolling the BOARD back ────────
//
// This block is the fix round's reason for existing. The board's fast path
// used to read WITHOUT `include_retracted=1`, exactly as the plan's board
// criterion is written. Orange applies its retraction filter BEFORE the
// `latest_per` reduction, so a hostile retraction of Wolf's NEWEST state row
// did not hide the hypothesis — it promoted the OLDER trusted row beneath it,
// which passes every clause of `isTrusted` and was accepted as authoritative.
// The board silently showed the previous status, with no tamper warning, while
// the detail read showed the true one.
//
// The three fixtures here are the same seeded project read three ways from a
// running build (see `__fixtures__/README.md` → "The second capture"): the
// board without the flag, the board with it, and the per-name follow-up.

describe("store_resurrection", () => {
  const RESURRECTION = {
    board: fixture("board-resurrection-include-retracted.json"),
    boardDefault: fixture("board-resurrection-default.json"),
    details: {
      "1a2b3c4d": fixture("detail-1a2b3c4d-resurrection-include-retracted.json"),
      "3c4d5e6f": fixture("detail-3c4d5e6f-wolf-retraction-include-retracted.json"),
    },
    sessions: sessionsNamed("hyp-1a2b3c4d", "hyp-2b3c4d5e", "hyp-3c4d5e6f"),
  };

  it("store_resurrection: RECORDED — without the flag Orange hands back the OLDER trusted row", () => {
    // Not an assertion about Wolf's code: about Orange's. Two captured bodies,
    // the same query, one query parameter apart.
    type Row = { id: string; labels: Record<string, string>; created_by_worker: string };
    const rowsOf = (name: string): Row[] =>
      (JSON.parse(fixture(name)) as { memories: Row[] }).memories;
    const withoutFlag = rowsOf("board-resurrection-default.json").find(
      (m) => m.labels["name"] === "1a2b3c4d",
    );
    const withFlag = rowsOf("board-resurrection-include-retracted.json").find(
      (m) => m.labels["name"] === "1a2b3c4d",
    );
    // The unflagged read reports the PREVIOUS status, from a different row.
    expect(withoutFlag?.labels["status"]).toBe("draft");
    expect(withFlag?.labels["status"]).toBe("live");
    expect(withoutFlag?.id).not.toBe(withFlag?.id);
    // And nothing about the row it hands back looks wrong: it is one of Wolf's
    // own, with empty provenance. No provenance check can catch this; only
    // asking for the retracted rows can.
    expect(withoutFlag?.created_by_worker).toBe("");
  });

  it("store_resurrection: the board does NOT roll back — status stays live, with the retractor named", async () => {
    const { store, stub } = harness(RESURRECTION);
    const records = await store.readBoard();
    const attacked = records.find((r) => r.id === "1a2b3c4d");
    expect(attacked?.status).toBe("live");
    expect(attacked?.statusMemoryId).toBe("ae3e8b7b-03e8-4e83-8fcd-f0193e7ac2cc");
    expect(tamperOf(attacked ?? {}, "hostile_retraction")).toEqual([
      {
        reason: "hostile_retraction",
        written_by_worker: "researcher-1a2b3c4d",
        written_by_session: "sess-c0ffee11",
        memory_id: "dcd8e753-010f-4c9b-a95c-ba17944a443e",
      },
    ]);
    // The attack costs the attacked hypothesis nothing: its newest row is
    // trusted and a container cannot withdraw it, so there is no follow-up.
    const followUps = stub.memoryRequests.filter(
      (r) => new URL(r.path, BASE_URL).searchParams.get("latest_per") === null,
    );
    expect(followUps.map((r) => new URL(r.path, BASE_URL).searchParams.get("selector"))).toEqual([
      "kind=hypothesis,name=3c4d5e6f",
    ]);
  });

  it("store_resurrection: the board and the detail read give the SAME answer", async () => {
    // The defect this closes was two surfaces disagreeing, with the wrong one
    // being the one the product renders.
    const { store } = harness(RESURRECTION);
    const board = (await store.readBoard()).find((r) => r.id === "1a2b3c4d");
    const detail = await store.readHypothesis("1a2b3c4d");
    expect(board?.status).toBe(detail.status);
    expect(board?.statusMemoryId).toBe(detail.statusMemoryId);
    expect(board?.tamper).toEqual(detail.tamper);
    expect(detail.status).toBe("live");
  });

  it("store_resurrection: WOLF's own retraction still falls through to the row underneath", async () => {
    // The mirror image, and the reason the fast path cannot simply trust the
    // newest row: when the retraction is Wolf's own it IS honoured, and the
    // answer is the trusted row beneath — which only the follow-up can see.
    const { store, stub } = harness(RESURRECTION);
    const records = await store.readBoard();
    const withdrawn = records.find((r) => r.id === "3c4d5e6f");
    expect(withdrawn?.status).toBe("live");
    expect(withdrawn?.statusMemoryId).toBe("3dd171ed-5bb4-4bba-8be1-2aa4ab02407d");
    // Wolf correcting itself is not tamper.
    expect(withdrawn?.tamper).toBeUndefined();
    expect(stub.memoryRequests).toHaveLength(2); // the board, plus one follow-up
  });

  it("store_resurrection: a clean board is unchanged by the flag — which is why it stays free", () => {
    // Orange attaches `retracted_by` only where there IS a retraction, so the
    // flag adds no key, no row and no request to an untampered board. Both
    // captured all-trusted bodies carry the same three names and no
    // `retracted_by` anywhere.
    for (const name of ["board-all-trusted.json", "board-all-trusted-include-retracted.json"]) {
      const body = fixture(name);
      expect(body).not.toContain("retracted_by");
      const rows = (JSON.parse(body) as { memories: Array<{ labels: Record<string, string> }> })
        .memories;
      expect(rows.map((m) => m.labels["name"]).sort()).toEqual([
        "1a2b3c4d",
        "2b3c4d5e",
        "3c4d5e6f",
      ]);
    }
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

// ── The evaluation summary line (W8) ────────────────────────────────────

describe("store_evaluation_summary_line", () => {
  const LINE = "score=-0.42 tripped=1 holding=3 indeterminate=0 evaluated=2026-08-20T06:05:00Z";

  it("store_evaluation_summary_line: parses the pinned format", () => {
    expect(parseEvaluationSummaryLine(LINE)).toEqual({
      supportScore: -0.42,
      tripped: 1,
      holding: 3,
      indeterminate: 0,
      evaluatedAtMs: Date.parse("2026-08-20T06:05:00Z"),
    });
  });

  it("store_evaluation_summary_line: IGNORES unrecognised key=value tokens", () => {
    // W10 must be able to extend the line without breaking the board.
    const extended = `${LINE} horizon_days_left=12 version=2`;
    expect(parseEvaluationSummaryLine(extended)?.supportScore).toBe(-0.42);
  });

  it("store_evaluation_summary_line: all five keys are REQUIRED", () => {
    for (const key of ["score", "tripped", "holding", "indeterminate", "evaluated"]) {
      const without = LINE.split(" ")
        .filter((token) => !token.startsWith(`${key}=`))
        .join(" ");
      expect(parseEvaluationSummaryLine(without)).toBeNull();
    }
  });

  it("store_evaluation_summary_line: a line that does not parse yields null and never throws", () => {
    for (const bad of [
      "",
      "   ",
      "this is prose, not a summary",
      "score=NaN tripped=1 holding=3 indeterminate=0 evaluated=2026-08-20T06:05:00Z",
      "score=0.1 tripped=one holding=3 indeterminate=0 evaluated=2026-08-20T06:05:00Z",
      "score=0.1 tripped=-1 holding=3 indeterminate=0 evaluated=2026-08-20T06:05:00Z",
      "score=0.1 tripped=1 holding=3 indeterminate=0 evaluated=never",
      "=1 score=0.1",
    ]) {
      expect(() => parseEvaluationSummaryLine(bad)).not.toThrow();
      expect(parseEvaluationSummaryLine(bad)).toBeNull();
    }
  });

  it("store_evaluation_summary_line: the FIRST occurrence of a key wins", () => {
    expect(parseEvaluationSummaryLine(`${LINE} score=1`)?.supportScore).toBe(-0.42);
  });
});

describe("store_read_evaluation_summaries", () => {
  const ID = "1a2b3c4d";
  const LINE = "score=0.75 tripped=0 holding=4 indeterminate=1 evaluated=2026-08-20T06:05:00Z";

  function evalRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "eval-1",
      labels: { kind: "evaluation", name: ID },
      snippet: `${LINE}\n{"support_score":0.75}`,
      score: 0,
      created_by_worker: "",
      created_by_session: "",
      created_at: 1787334047000,
      ...extra,
    };
  }

  it("store_read_evaluation_summaries: ONE request, latest_per=name, with include_retracted", async () => {
    const { store, stub } = harness({ evaluations: JSON.stringify({ memories: [evalRow()] }) });
    const summaries = await store.readEvaluationSummaries(new Set([ID]));

    expect(summaries.get(ID)?.supportScore).toBe(0.75);
    expect(summaries.get(ID)?.memoryId).toBe("eval-1");
    expect(stub.memoryRequests).toHaveLength(1);
    const path = stub.memoryRequests[0]?.path ?? "";
    expect(path).toContain("selector=kind%3Devaluation");
    expect(path).toContain("latest_per=name");
    // Same reason the board read carries it: without the flag a hostile
    // retraction of the newest row hands back the OLDER one (R90).
    expect(path).toContain("include_retracted=1");
  });

  it("store_read_evaluation_summaries: an untrusted row sets no score", async () => {
    const { store } = harness({
      evaluations: JSON.stringify({
        memories: [evalRow({ created_by_worker: `researcher-${ID}` })],
      }),
    });
    expect((await store.readEvaluationSummaries(new Set([ID]))).size).toBe(0);
  });

  // One harness per test: the stub installs a PERSISTENT undici interceptor
  // on the shared pool, so two harnesses in one test would leave the first one
  // answering the second one's requests.
  it("store_read_evaluation_summaries: a row Wolf itself retracted is skipped", async () => {
    const { store } = harness({
      evaluations: JSON.stringify({
        memories: [
          evalRow({
            retracted_by: [
              { memory_id: "r1", created_by_worker: "", created_by_session: "", created_at: 1787334047100 },
            ],
          }),
        ],
      }),
    });
    expect((await store.readEvaluationSummaries(new Set([ID]))).size).toBe(0);
  });

  it("store_read_evaluation_summaries: a HOSTILE retraction changes nothing — an untrusted actor cannot withdraw server-written state", async () => {
    const { store } = harness({
      evaluations: JSON.stringify({
        memories: [
          evalRow({
            retracted_by: [
              {
                memory_id: "r2",
                created_by_worker: "",
                created_by_session: "sess-hostile",
                created_at: 1787334047100,
              },
            ],
          }),
        ],
      }),
    });
    const summaries = await store.readEvaluationSummaries(new Set([ID]));
    expect(summaries.size).toBe(1);
    expect(summaries.get(ID)?.supportScore).toBe(0.75);
  });

  it("store_read_evaluation_summaries: a row naming something that is not a hypothesis is ignored", async () => {
    const { store } = harness({
      evaluations: JSON.stringify({
        memories: [evalRow({ labels: { kind: "evaluation", name: "99999999" } })],
      }),
    });
    expect((await store.readEvaluationSummaries(new Set([ID]))).size).toBe(0);
  });
});

// ── The report layer's two reads (W15) ──────────────────────────────────

describe("store_read_template", () => {
  const ID = "1a2b3c4d";
  const HASH = "9f8b1c0d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f900112233";
  // Deliberately far past the 500-character snippet: the whole reason
  // `readTemplate` pays for a second `GET /agent/memories/{id}` is that a
  // template fragment does not fit in one.
  const HTML = `<section data-wolf-slot="headline"></section>\n<div data-wolf-fallback>${"x".repeat(700)}</div>`;

  // These bodies are CONSTRUCTED, not captured: they are the same
  // MemorySearchResult / memoryRecord shapes W5 recorded from a running O11
  // build (`__fixtures__/`), with the labels and content this ticket's kinds
  // require. Nothing about the SHAPE is invented — see the fixtures README —
  // and no file below is presented as a recording.
  function templateRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "tmpl-1",
      labels: { kind: "report-template", name: ID, status: "locked" },
      snippet: `${HASH}\n<section data-wolf-slot="headline">`,
      score: 0,
      created_by_worker: "",
      created_by_session: "",
      created_at: 1787334047500,
      ...extra,
    };
  }

  function templateFull(id = "tmpl-1", extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      id,
      labels: { kind: "report-template", name: ID, status: "locked" },
      content: `${HASH}\n${HTML}`,
      created_by_worker: "",
      created_by_session: "",
      created_at: 1787334047500,
      ...extra,
    });
  }

  const SESSIONS = sessionsNamed("hyp-1a2b3c4d");

  it("store_read_template: the locked template comes back in FULL, with include_retracted=1 on the search", async () => {
    const { store, stub } = harness({
      sessions: SESSIONS,
      templates: { [ID]: JSON.stringify({ memories: [templateRow()] }) },
      memoriesById: { "tmpl-1": templateFull() },
    });
    const read = await store.readTemplate(ID);

    expect(read.tamper).toEqual([]);
    expect(read.template?.structureHash).toBe(HASH);
    expect(read.template?.html).toBe(HTML);
    expect(read.template?.html.length).toBeGreaterThan(500);
    expect(read.template?.memoryId).toBe("tmpl-1");
    expect(read.template?.hypothesisId).toBe(ID);

    const search = stub.memoryRequests.find((r) => r.path.includes("selector="));
    expect(search?.path).toContain("selector=kind%3Dreport-template%2Cname%3D1a2b3c4d");
    expect(search?.path).toContain("include_retracted=1");
    // The second request is the full-content read — the snippet cannot hold it.
    expect(stub.memoryRequests.some((r) => r.path === "/agent/memories/tmpl-1")).toBe(true);
  });

  it("store_read_template: a FORGED template (non-empty provenance) is refused and reported, never served", async () => {
    // Reusing W5's `isTrusted` / `forgedRowTamper`, not a second check: a
    // `report-template` written from inside a container is a forgery, and the
    // frame route must answer 404 rather than render whatever it says.
    const { store } = harness({
      sessions: SESSIONS,
      templates: {
        [ID]: JSON.stringify({
          memories: [
            templateRow({
              id: "tmpl-forged",
              created_by_worker: "researcher-1a2b3c4d",
              created_by_session: "sess-77c1e2d5",
            }),
          ],
        }),
      },
      memoriesById: { "tmpl-forged": templateFull("tmpl-forged") },
    });
    const read = await store.readTemplate(ID);

    expect(read.template).toBeNull();
    expect(read.tamper).toEqual([
      {
        reason: "forged_row",
        written_by_worker: "researcher-1a2b3c4d",
        written_by_session: "sess-77c1e2d5",
        memory_id: "tmpl-forged",
      },
    ]);
  });

  it("store_read_template: a template naming a hypothesis with NO session is unreachable — clause 3 in situ", async () => {
    // Empty provenance + a trusted kind, but no `hyp-<id>` session: the
    // `ApplyTopology` forgery path (R24). Clause 3 is the one that cannot be
    // forged from inside a container, and at this level it bites twice — the
    // session list is also the authoritative index, so the read refuses before
    // the row is ever considered. (`isTrusted`'s own three-clause test, with
    // the first two passing and the third failing, is in
    // `src/report/kinds.test.ts`.)
    const { store } = harness({
      sessions: sessionsNamed("hyp-2b3c4d5e"),
      templates: { [ID]: JSON.stringify({ memories: [templateRow()] }) },
      memoriesById: { "tmpl-1": templateFull() },
    });
    await expect(store.readTemplate(ID)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("store_read_template: a HOSTILE retraction hides nothing — the template is still SERVED, and the retractor is named", async () => {
    // ⚠️ The criterion this file exists for. `retracts` is an ordinary label
    // and `notRetractedSQL` (`go/agentdb/memories.go:284-288`) never checks
    // who wrote the retraction, so anything holding the core MCP tools can
    // withdraw the locked template. Served-and-flagged, never absent: an
    // erasure that reads as "nobody authored one" is the attack succeeding.
    const { store } = harness({
      sessions: SESSIONS,
      templates: {
        [ID]: JSON.stringify({
          memories: [
            templateRow({
              retracted_by: [
                {
                  memory_id: "ret-hostile",
                  created_by_worker: "researcher-1a2b3c4d",
                  created_by_session: "sess-77c1e2d5",
                  created_at: 1787334047600,
                },
              ],
            }),
          ],
        }),
      },
      memoriesById: { "tmpl-1": templateFull() },
    });
    const read = await store.readTemplate(ID);

    expect(read.template?.structureHash).toBe(HASH);
    expect(read.template?.html).toBe(HTML);
    expect(read.tamper).toEqual([
      {
        reason: "hostile_retraction",
        written_by_worker: "researcher-1a2b3c4d",
        written_by_session: "sess-77c1e2d5",
        memory_id: "ret-hostile",
      },
    ]);
  });

  it("store_read_template: WOLF's own retraction IS honoured — that is how Wolf corrects itself", async () => {
    const { store } = harness({
      sessions: SESSIONS,
      templates: {
        [ID]: JSON.stringify({
          memories: [
            templateRow({
              retracted_by: [
                { memory_id: "ret-wolf", created_by_worker: "", created_by_session: "", created_at: 1787334047600 },
              ],
            }),
          ],
        }),
      },
      memoriesById: { "tmpl-1": templateFull() },
    });
    const read = await store.readTemplate(ID);
    expect(read.template).toBeNull();
    expect(read.tamper).toEqual([]);
  });

  it("store_read_template: Wolf's retraction plus a hostile one on top still counts as retracted — no resurrection", async () => {
    // "At least one retraction with empty provenance" (owner decision B5).
    // Reading only the NEWEST retraction would let an attacker resurrect a
    // template Wolf legitimately withdrew by appending its own on top.
    const { store } = harness({
      sessions: SESSIONS,
      templates: {
        [ID]: JSON.stringify({
          memories: [
            templateRow({
              retracted_by: [
                { memory_id: "ret-hostile", created_by_worker: "", created_by_session: "sess-77c1e2d5", created_at: 1787334047700 },
                { memory_id: "ret-wolf", created_by_worker: "", created_by_session: "", created_at: 1787334047600 },
              ],
            }),
          ],
        }),
      },
      memoriesById: { "tmpl-1": templateFull() },
    });
    const read = await store.readTemplate(ID);
    expect(read.template).toBeNull();
    expect(read.tamper.map((t) => t.memory_id)).toEqual(["ret-hostile"]);
  });

  it("store_read_template: a withdrawn template falls through to the older one beneath it", async () => {
    const { store } = harness({
      sessions: SESSIONS,
      templates: {
        [ID]: JSON.stringify({
          memories: [
            templateRow({
              id: "tmpl-2",
              created_at: 1787334047900,
              retracted_by: [
                { memory_id: "ret-wolf", created_by_worker: "", created_by_session: "", created_at: 1787334047950 },
              ],
            }),
            templateRow(),
          ],
        }),
      },
      memoriesById: { "tmpl-1": templateFull(), "tmpl-2": templateFull("tmpl-2") },
    });
    const read = await store.readTemplate(ID);
    expect(read.template?.memoryId).toBe("tmpl-1");
  });

  it("store_read_template: no template at all is `null` with no tamper — absence, not an anomaly", async () => {
    const { store } = harness({ sessions: SESSIONS });
    expect(await store.readTemplate(ID)).toEqual({ template: null, tamper: [] });
  });

  it("store_read_template: an id absent from the SESSION index is not_found — the session list is the authoritative index", async () => {
    const { store } = harness({ sessions: [] });
    await expect(store.readTemplate(ID)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("store_read_template: a supplied session index skips the session walk entirely", async () => {
    const { store, stub } = harness({
      sessions: SESSIONS,
      templates: { [ID]: JSON.stringify({ memories: [templateRow()] }) },
      memoriesById: { "tmpl-1": templateFull() },
    });
    await store.readTemplate(ID, { sessions: new Set([ID]) });
    expect(stub.sessionRequests).toHaveLength(0);
  });
});

describe("store_read_latest_report", () => {
  const ID = "1a2b3c4d";
  const SLOTS = { headline: "<p>the basket held</p>", "chart-main": '<div id="c"></div>' };
  const SESSIONS = sessionsNamed("hyp-1a2b3c4d");

  function reportRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "rep-1",
      labels: { kind: "report", name: ID },
      snippet: "the basket held\n{",
      score: 0,
      // `kind=report` is written from INSIDE a container on every tick. This
      // provenance is normal, not an attack.
      created_by_worker: "researcher-1a2b3c4d",
      created_by_session: "sess-77c1e2d5",
      created_at: 1787334048000,
      ...extra,
    };
  }

  function reportFull(id = "rep-1", headline = "the basket held", slots: unknown = SLOTS): string {
    return JSON.stringify({
      id,
      labels: { kind: "report", name: ID },
      content: `${headline}\n${JSON.stringify(slots)}`,
      created_by_worker: "researcher-1a2b3c4d",
      created_by_session: "sess-77c1e2d5",
      created_at: 1787334048000,
    });
  }

  it("store_read_latest_report: the newest report comes back in full, and its container provenance is NOT tamper", async () => {
    // `report` is untrusted by construction — the researcher is what writes
    // it. Flagging every one `forged_row` would fill the board with warnings
    // for the system working as designed. The check that DOES belong to these
    // rows — that the writer is this hypothesis's own researcher or session —
    // is cross-hypothesis defence and belongs to W22.
    const { store, stub } = harness({
      sessions: SESSIONS,
      reports: { [ID]: JSON.stringify({ memories: [reportRow()] }) },
      memoriesById: { "rep-1": reportFull() },
    });
    const read = await store.readLatestReport(ID);

    expect(read.tamper).toEqual([]);
    expect(read.report?.headline).toBe("the basket held");
    expect(read.report?.headlineTruncated).toBe(false);
    expect(read.report?.slots).toEqual(SLOTS);
    expect(read.report?.createdByWorker).toBe("researcher-1a2b3c4d");
    expect(read.report?.createdBySession).toBe("sess-77c1e2d5");

    const search = stub.memoryRequests.find((r) => r.path.includes("selector="));
    expect(search?.path).toContain("selector=kind%3Dreport%2Cname%3D1a2b3c4d");
    expect(search?.path).toContain("include_retracted=1");
  });

  it("store_read_latest_report: a hostile retraction of a report changes nothing but is reported", async () => {
    const { store } = harness({
      sessions: SESSIONS,
      reports: {
        [ID]: JSON.stringify({
          memories: [
            reportRow({
              retracted_by: [
                { memory_id: "ret-hostile", created_by_worker: "critic", created_by_session: "sess-9", created_at: 1787334048100 },
              ],
            }),
          ],
        }),
      },
      memoriesById: { "rep-1": reportFull() },
    });
    const read = await store.readLatestReport(ID);
    expect(read.report?.headline).toBe("the basket held");
    expect(read.tamper).toEqual([
      {
        reason: "hostile_retraction",
        written_by_worker: "critic",
        written_by_session: "sess-9",
        memory_id: "ret-hostile",
      },
    ]);
  });

  it("store_read_latest_report: a report WOLF retracted is skipped, and the one beneath it wins", async () => {
    const { store } = harness({
      sessions: SESSIONS,
      reports: {
        [ID]: JSON.stringify({
          memories: [
            reportRow({
              id: "rep-2",
              created_at: 1787334048900,
              retracted_by: [
                { memory_id: "ret-wolf", created_by_worker: "", created_by_session: "", created_at: 1787334048950 },
              ],
            }),
            reportRow(),
          ],
        }),
      },
      memoriesById: { "rep-1": reportFull(), "rep-2": reportFull("rep-2", "withdrawn") },
    });
    const read = await store.readLatestReport(ID);
    expect(read.report?.memoryId).toBe("rep-1");
  });

  it("store_read_latest_report: a headline over 400 characters is truncated on read and flagged", async () => {
    const { store } = harness({
      sessions: SESSIONS,
      reports: { [ID]: JSON.stringify({ memories: [reportRow()] }) },
      memoriesById: { "rep-1": reportFull("rep-1", "w".repeat(512)) },
    });
    const read = await store.readLatestReport(ID);
    expect(read.report?.headline).toHaveLength(400);
    expect(read.report?.headlineTruncated).toBe(true);
  });

  it("store_read_latest_report: a body that is not a flat {slotId: html} map is `invalid`, naming the key", async () => {
    const { store } = harness({
      sessions: SESSIONS,
      reports: { [ID]: JSON.stringify({ memories: [reportRow()] }) },
      memoriesById: { "rep-1": reportFull("rep-1", "a headline", { "chart-main": { html: "<div/>" } }) },
    });
    await expect(store.readLatestReport(ID)).rejects.toMatchObject({
      kind: "invalid",
      details: { key: "chart-main" },
    });
  });

  it("store_read_latest_report: no report yet is `null`, never an empty headline", async () => {
    const { store } = harness({ sessions: SESSIONS });
    expect(await store.readLatestReport(ID)).toEqual({ report: null, tamper: [] });
  });

  it("store_read_latest_report: a row naming a DIFFERENT hypothesis is not this hypothesis's report", async () => {
    // Labels are chosen entirely by the caller, so a search that came back
    // with a foreign `name` must not be applied here. (Whether the WRITER
    // belongs to this hypothesis is W22's criterion, not this one's.)
    const { store } = harness({
      sessions: SESSIONS,
      reports: {
        [ID]: JSON.stringify({
          memories: [reportRow({ id: "rep-other", labels: { kind: "report", name: "2b3c4d5e" } })],
        }),
      },
      memoriesById: { "rep-other": reportFull("rep-other") },
    });
    expect((await store.readLatestReport(ID)).report).toBeNull();
  });

  it("store_read_latest_report: an id absent from the session index is not_found", async () => {
    const { store } = harness({ sessions: [] });
    await expect(store.readLatestReport(ID)).rejects.toMatchObject({ kind: "not_found" });
  });
});
