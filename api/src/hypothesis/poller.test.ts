import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MockAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
  type Interceptable,
} from "undici";

import { createLogger } from "../logger.js";
import { loadConfig } from "../config.js";
import { createBobClient, type BobClient } from "../bob/client.js";
import {
  createHypothesisStore,
  evaluationLineWithoutTimestamp,
  slugifyOwner,
  type HypothesisStore,
} from "./store.js";
import { researcherWorkerFor } from "./provision.js";
import {
  ATTENTION_RUN_LENGTH,
  EVALUATION_MAX_AGE_MS,
  TICK_SESSIONS_KEPT,
  createPoller,
  type Poller,
} from "./poller.js";

// design/2026-08-20-agent-wolf.md, W10's acceptance criteria. Test names are
// prefixed `poller_`.
//
// Bob is mocked with undici's MockAgent (the pinned mechanism) by a stub
// that keeps REAL STATE: memories it is POSTed come back on the next read, so
// "an unchanged evaluation appends nothing" is a fact about what the poller
// wrote rather than a restatement of the assertion above it. Every request is
// recorded in order, which is how the version gate ("a second poll issues NO
// download") is gated at all.

const BOB = "http://bob.test:4100";
const API_KEY = "wolf-project-api-key-for-tests";
const OWNER = "kai@badcode.dev";
const ID = "1a2b3c4d";
const OTHER_ID = "2b3c4d5e";
const SESSION_ID = "sess-hyp-1a2b3c4d";
const WORKER = researcherWorkerFor(ID);

const LIVE_AT_MS = Date.UTC(2026, 7, 1); // 2026-08-01T00:00:00Z
const NOW_MS = Date.UTC(2026, 7, 20); // 2026-08-20T00:00:00Z
const HOUR_MS = 3_600_000;

/** One metric, one condition, `sustained_days: 0` — so the newest observation
 * alone decides tripped/holding and the fixtures below can put a condition in
 * any of its three states by changing two numbers. */
const SPEC = {
  thesis: "the drone-suppliers basket rises as the petrodollar unwinds",
  horizon_days: 30,
  flat_band_pct: 2.0,
  staleness_days: 5,
  metrics: [
    {
      slug: "basket",
      source: "stooq",
      series_id: "avav.us",
      direction: "up",
      weight: 1.0,
      unit: "USD",
    },
  ],
  invalidation: [
    {
      id: "inv-1",
      metric: "basket",
      stat: "change_pct",
      reference: "value_at_live",
      op: "lt",
      threshold: -5,
      sustained_days: 0,
      meaning: "the basket fell more than 5% from its go-live value",
    },
  ],
};

const DATASET = `${ID}-basket`;

/** Two fresh observations 10% down — the condition TRIPS. */
const CSV_TRIPPED = "timestamp,value\n2026-08-18T00:00:00Z,100\n2026-08-19T00:00:00Z,90\n";
/** Two fresh observations 10% UP — the condition holds and the metric moved
 * the way the thesis predicted, so `support_score` is +1. */
const CSV_HOLDING = "timestamp,value\n2026-08-18T00:00:00Z,100\n2026-08-19T00:00:00Z,110\n";
/** Header only — zero observations, so the condition is INDETERMINATE. */
const CSV_EMPTY = "timestamp,value\n";

// ── The stub Bob ─────────────────────────────────────────────────────

interface Recorded {
  method: string;
  path: string;
  body: string;
}

interface Answer {
  status: number;
  body: string;
  contentType?: string;
}

interface MemRow {
  id: string;
  labels: Record<string, string>;
  content: string;
  createdAtMs: number;
  createdByWorker: string;
  createdBySession: string;
}

interface DatasetRow {
  /** Omit to make the metadata route 404 ("never written yet"). */
  version?: number;
  csv?: string;
  /** Serve a metadata body with NO `version` field at all. */
  versionless?: boolean;
  /** The worker the metadata reports as the writer. Defaults to this
   * hypothesis's OWN researcher; set it to forge a foreign write. */
  writtenBy?: string;
}

interface SessionRow {
  id: string;
  name?: string;
  worker: string;
  status: string;
  createdAtSec: number;
}

interface DeliveryRow {
  id: string;
  worker: string;
  status: string;
  sessionId?: string;
}

interface StubConfig {
  memories?: MemRow[];
  sessions?: SessionRow[];
  datasets?: Record<string, DatasetRow>;
  deliveries?: DeliveryRow[];
  /** `"<METHOD> <path prefix>"` -> the answer to inject instead. */
  fail?: Record<string, Answer>;
}

let nextMemoryId = 0;

function memory(
  labels: Record<string, string>,
  content: string,
  provenance: { worker?: string; session?: string; createdAtMs?: number } = {},
): MemRow {
  nextMemoryId += 1;
  return {
    id: `mem-${nextMemoryId}`,
    labels,
    content,
    createdAtMs: provenance.createdAtMs ?? 1787334047000 + nextMemoryId,
    createdByWorker: provenance.worker ?? "",
    createdBySession: provenance.session ?? "",
  };
}

/** The trusted state row, in the shape `buildHypothesisContent` writes. */
function stateRow(id: string, status: string, createdAtMs?: number): MemRow {
  return memory(
    { kind: "hypothesis", name: id, status, owner: slugifyOwner(OWNER) },
    [
      "The petrodollar is ending",
      "",
      "the thesis prose",
      "",
      "```json",
      `{\n  "owner_email": "${OWNER}"\n}`,
      "```",
    ].join("\n"),
    { createdAtMs },
  );
}

/** The locked spec, written by go-live with EMPTY provenance. */
function lockedSpec(id: string, spec: unknown = SPEC): MemRow {
  return memory({ kind: "hypothesis-spec", name: id, status: "locked" }, JSON.stringify(spec));
}

function hypSession(id: string): SessionRow {
  return {
    id: id === ID ? SESSION_ID : `sess-hyp-${id}`,
    name: `hyp-${id}`,
    worker: "interviewer",
    status: "running",
    createdAtSec: 1787334311,
  };
}

class Stub {
  readonly requests: Recorded[] = [];
  readonly memories: MemRow[];
  readonly sessions: SessionRow[];
  readonly deleted: string[] = [];

  constructor(
    private readonly pool: Interceptable,
    private readonly config: StubConfig,
  ) {
    this.memories = [...(config.memories ?? [])];
    this.sessions = [...(config.sessions ?? [])];
  }

  paths(predicate: (path: string) => boolean): string[] {
    return this.requests.map((r) => r.path).filter(predicate);
  }

  get downloads(): string[] {
    return this.paths((path) => path.includes("/download"));
  }

  get appends(): Recorded[] {
    return this.requests.filter((r) => r.method === "POST" && r.path === "/agent/memories");
  }

  appendedWith(kind: string): Recorded[] {
    return this.appends.filter(
      (r) => (JSON.parse(r.body) as { labels: Record<string, string> }).labels["kind"] === kind,
    );
  }

  install(): void {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      this.pool
        .intercept({ method, path: () => true })
        .reply((opts) => {
          const path = String(opts.path);
          const body = typeof opts.body === "string" ? opts.body : "";
          this.requests.push({ method, path, body });
          const answer = this.route(method, new URL(path, BOB), body);
          return {
            statusCode: answer.status,
            data: answer.body as never,
            responseOptions: {
              headers: { "content-type": answer.contentType ?? "application/json" },
            },
          };
        })
        .persist();
    }
  }

  private injected(method: string, path: string): Answer | undefined {
    for (const [key, answer] of Object.entries(this.config.fail ?? {})) {
      const [failMethod, prefix] = key.split(" ");
      if (failMethod === method && prefix !== undefined && path.startsWith(prefix)) return answer;
    }
    return undefined;
  }

  private wire(row: MemRow, snippet: boolean): Record<string, unknown> {
    const base = {
      id: row.id,
      labels: row.labels,
      created_by_worker: row.createdByWorker,
      created_by_session: row.createdBySession,
      created_at: row.createdAtMs,
    };
    return snippet
      ? { ...base, snippet: row.content.slice(0, 500), score: 0 }
      : { ...base, content: row.content };
  }

  private route(method: string, url: URL, body: string): Answer {
    const path = url.pathname;
    const injected = this.injected(method, path);
    if (injected !== undefined) return injected;

    if (path === "/agent/sessions") {
      const worker = url.searchParams.get("worker");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const rows = this.sessions
        .filter((s) => worker === null || s.worker === worker)
        .map((s) => ({
          id: s.id,
          name: s.name ?? "",
          worker: s.worker,
          status: s.status,
          created_at: s.createdAtSec,
          updated_at: s.createdAtSec,
        }));
      return { status: 200, body: JSON.stringify(offset === 0 ? rows : []) };
    }

    if (method === "DELETE" && path.startsWith("/agent/session/")) {
      this.deleted.push(decodeURIComponent(path.slice("/agent/session/".length)));
      return { status: 204, body: "" };
    }

    if (method === "POST" && path === "/agent/memories") {
      const parsed = JSON.parse(body) as { labels: Record<string, string>; content: string };
      // Appended through the API key, so provenance is EMPTY: this is the
      // trust anchor, and a stub that stamped a worker here would make every
      // row the poller writes untrusted on the next read.
      const row = memory(parsed.labels, parsed.content, { createdAtMs: this.clockMs });
      this.memories.push(row);
      return { status: 201, body: JSON.stringify(this.wire(row, false)) };
    }

    if (path.startsWith("/agent/memories/")) {
      const id = decodeURIComponent(path.slice("/agent/memories/".length));
      const row = this.memories.find((m) => m.id === id);
      return row === undefined
        ? { status: 404, body: "memory not found" }
        : { status: 200, body: JSON.stringify(this.wire(row, false)) };
    }

    if (path === "/agent/memories") {
      const selector = url.searchParams.get("selector") ?? "";
      const wanted = Object.fromEntries(
        selector
          .split(",")
          .filter((part) => part.includes("="))
          .map((part) => part.split("=") as [string, string]),
      );
      let rows = this.memories
        .filter((row) => Object.entries(wanted).every(([k, v]) => row.labels[k] === v))
        .slice()
        .reverse(); // newest first, exactly as Bob orders them
      if (url.searchParams.get("latest_per") === "name") {
        const seen = new Set<string>();
        rows = rows.filter((row) => {
          const name = row.labels["name"] ?? "";
          if (seen.has(name)) return false;
          seen.add(name);
          return true;
        });
      }
      const limit = Number(url.searchParams.get("limit") ?? "100");
      return {
        status: 200,
        body: JSON.stringify({ memories: rows.slice(0, limit).map((r) => this.wire(r, true)) }),
      };
    }

    if (path.startsWith("/agent/datasets/")) {
      const rest = path.slice("/agent/datasets/".length);
      const download = rest.endsWith("/download");
      const name = decodeURIComponent(download ? rest.slice(0, -"/download".length) : rest);
      const row = this.config.datasets?.[name];
      if (row === undefined || row.version === undefined) {
        // "Never written yet" — the metadata route's 404, which the poller
        // must NOT confuse with an outage.
        return { status: 404, body: "dataset not found" };
      }
      if (download) {
        return { status: 200, body: row.csv ?? CSV_EMPTY, contentType: "text/csv" };
      }
      const metadata: Record<string, unknown> = {
        id: `ds-${name}`,
        name,
        labels: { hypothesis: ID, metric: "basket" },
        size_bytes: (row.csv ?? CSV_EMPTY).length,
        row_count: Math.max(0, (row.csv ?? CSV_EMPTY).split("\n").length - 2),
        sha256: "sha-" + String(row.version),
        content_type: "text/csv",
        // 🔴 DERIVED FROM THE NAME, not a constant. A dataset is named
        // `<hypothesis-id>-<slug>` and in reality is written by THAT
        // hypothesis's researcher. The old fixture reported one hard-coded
        // worker for every dataset, so `2b3c4d5e-basket` claimed to be written
        // by `researcher-1a2b3c4d` — a combination the real system cannot
        // produce. Harmless while nothing checked the writer; wrong the moment
        // anything did. `writtenBy` remains the explicit forgery override.
        created_by_worker: row.writtenBy ?? researcherWorkerFor(name.split("-")[0] ?? ID),
        created_by_session: "sess-tick",
        created_at: 1787334047000,
      };
      // The BARE metadata object — the list route is the one that wraps in
      // {"datasets":[…]}, and confusing the two is an explicit W10 hazard.
      if (row.versionless !== true) metadata["version"] = row.version;
      return { status: 200, body: JSON.stringify(metadata) };
    }

    if (path === "/agent/deliveries") {
      const wantStatus = url.searchParams.get("status");
      const rows = (this.config.deliveries ?? []).filter(
        (d) => wantStatus === null || d.status === wantStatus,
      );
      return {
        status: 200,
        body: JSON.stringify({
          deliveries: rows.map((d) => ({
            id: d.id,
            project: "wolf",
            event_id: "evt",
            subscription_id: "sub",
            session_id: d.sessionId ?? "",
            worker: d.worker,
            schedule_id: "sched-1",
            status: d.status,
            failure_reason: "",
            started_at: 0,
            ended_at: 0,
            created_at: 1787334311,
            updated_at: 1787334311,
          })),
        }),
      };
    }

    return { status: 404, body: `unrouted in the stub: ${path}` };
  }

  /** The wall clock a POSTed memory is stamped with; the harness moves it. */
  clockMs = NOW_MS;
}

// ── Harness ─────────────────────────────────────────────────────────────

let mockAgent: MockAgent;
let pool: Interceptable;
let originalDispatcher: Dispatcher;

beforeEach(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  pool = mockAgent.get(BOB);
});

afterEach(async () => {
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
  vi.useRealTimers();
});

interface Harness {
  stub: Stub;
  client: BobClient;
  store: HypothesisStore;
  poller: Poller;
  /** Moves both the poller's clock and the stub's memory-stamping clock. */
  setNow(ms: number): void;
}

function harness(config: StubConfig, pollIntervalSeconds = 300): Harness {
  const stub = new Stub(pool, config);
  stub.install();
  const logger = createLogger({ logLevel: "silent" });
  const client = createBobClient({ baseUrl: BOB, apiKey: API_KEY, logger });
  const store = createHypothesisStore({ client, logger });
  let clock = NOW_MS;
  const poller = createPoller({
    client,
    store,
    logger,
    config: { pollIntervalSeconds },
    now: () => clock,
  });
  return {
    stub,
    client,
    store,
    poller,
    setNow(ms: number) {
      clock = ms;
      stub.clockMs = ms;
    },
  };
}

/** One live hypothesis with a locked spec and a written dataset. */
function liveHypothesis(csv: string, extra: Partial<StubConfig> = {}): StubConfig {
  return {
    memories: [stateRow(ID, "live", LIVE_AT_MS), lockedSpec(ID)],
    sessions: [hypSession(ID)],
    datasets: { [DATASET]: { version: 1, csv } },
    ...extra,
  };
}

// ── The timer contract ──────────────────────────────────────────────────

describe("poller_no_import_side_effect", () => {
  it("poller_no_import_side_effect: importing AND building the app schedules no timer", async () => {
    // W10: "The interval is started in api/src/index.ts after app.listen,
    // never as an import side effect. A test that imports createApp asserts
    // no timer was scheduled — otherwise every route test in the repo starts
    // a live poller." This is that test, and it is the whole guard.
    const spy = vi.spyOn(globalThis, "setInterval");
    const { createApp } = await import("../app.js");
    const config = loadConfig(
      {
        WOLF_MCP_TOKEN: "wolf-mcp-token-for-tests-0123456789abcdef",
        WOLF_SESSION_SECRET: "session-secret-for-tests-0123456789abcdef",
        WOLF_ALLOWED_EMAILS: OWNER,
        WOLF_API_KEY: API_KEY,
      },
      { readRouteTable: () => undefined },
    );
    createApp(createLogger({ logLevel: "silent" }), config);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("poller_no_import_side_effect: app.ts does not import the poller at all", () => {
    // The runtime assertion above proves no timer today; this one proves the
    // module graph cannot grow one by accident, which is the failure mode
    // that would put a live poller inside every route test.
    const app = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    // The word appears in app.ts's prose (the R39 comment explains what the
    // poller does with `unavailable`); what must not appear is an IMPORT.
    expect(app).not.toMatch(/from "\.\/hypothesis\/poller\.js"/);
    expect(app).not.toContain("createPoller");
  });

  it("poller_no_import_side_effect: createPoller schedules nothing; start() schedules exactly one interval", () => {
    vi.useFakeTimers();
    const h = harness({}, 42);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.poller.running).toBe(false);

    const spy = vi.spyOn(globalThis, "setInterval");
    h.poller.start();
    expect(h.poller.running).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    expect(spy.mock.calls[0]?.[1]).toBe(42_000); // SECONDS -> ms, exactly once

    h.poller.start(); // idempotent
    expect(vi.getTimerCount()).toBe(1);

    h.poller.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.poller.running).toBe(false);
    spy.mockRestore();
  });

  it("poller_no_import_side_effect: index.ts starts it AFTER app.listen", () => {
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const listenAt = index.indexOf("app.listen(");
    const startAt = index.indexOf("poller.start()");
    expect(listenAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(listenAt);
  });
});

// ── Enumeration ─────────────────────────────────────────────────────────

describe("poller_enumeration", () => {
  it("poller_enumeration: live hypotheses come from the SESSION INDEX, never from memory alone", async () => {
    // A `kind=hypothesis, status=live` memory naming an id with no `hyp-<id>`
    // session is not a hypothesis — that clause is the one that cannot be
    // forged from inside a container.
    const h = harness({
      memories: [
        stateRow(ID, "live", LIVE_AT_MS),
        lockedSpec(ID),
        stateRow("deadbeef", "live", LIVE_AT_MS),
      ],
      sessions: [hypSession(ID)],
      datasets: { [DATASET]: { version: 1, csv: CSV_HOLDING } },
    });
    const report = await h.poller.tick();
    expect(report.live).toBe(1);
    expect(report.hypotheses.map((x) => x.id)).toEqual([ID]);
    expect(h.stub.paths((path) => path.startsWith("/agent/sessions"))[0]).toContain("user_email=*");
  });

  it("poller_enumeration: a hypothesis that is not `live` is never polled", async () => {
    const h = harness({
      memories: [stateRow(ID, "challenged", LIVE_AT_MS), lockedSpec(ID)],
      sessions: [hypSession(ID)],
      datasets: { [DATASET]: { version: 1, csv: CSV_TRIPPED } },
    });
    const report = await h.poller.tick();
    expect(report.live).toBe(0);
    expect(h.stub.appends).toHaveLength(0);
    expect(h.stub.downloads).toHaveLength(0);
  });
});

// ── The version gate ────────────────────────────────────────────────────

describe("poller_version_gate", () => {
  it("poller_version_gate: a second poll over UNCHANGED data issues no download request", async () => {
    const h = harness(liveHypothesis(CSV_HOLDING));
    await h.poller.tick();
    expect(h.stub.downloads).toHaveLength(1);

    h.setNow(NOW_MS + HOUR_MS);
    await h.poller.tick();
    // The metadata was re-read (that is how "unchanged" is established) and
    // the bytes were not.
    expect(h.stub.downloads).toHaveLength(1);
    expect(h.stub.paths((r) => r.startsWith(`/agent/datasets/${DATASET}`) && !r.includes("/download")))
      .toHaveLength(2);
  });

  it("poller_version_gate: a BUMPED version re-downloads and re-parses", async () => {
    const datasets: Record<string, DatasetRow> = { [DATASET]: { version: 1, csv: CSV_HOLDING } };
    const h = harness({ ...liveHypothesis(CSV_HOLDING), datasets });
    await h.poller.tick();
    expect(h.stub.downloads).toHaveLength(1);

    datasets[DATASET] = { version: 2, csv: CSV_TRIPPED };
    h.setNow(NOW_MS + HOUR_MS);
    const report = await h.poller.tick();
    expect(h.stub.downloads).toHaveLength(2);
    // The new bytes were actually USED, not merely fetched.
    expect(report.hypotheses[0]?.transitionedTo).toBe("challenged");
    // ...and the download was pinned to the version the metadata named, so a
    // `dataset_put` landing between the two requests cannot be cached under
    // the wrong version.
    expect(h.stub.downloads[1]).toContain("version=2");
  });

  it("poller_version_gate: a metadata body with NO `version` is a hard invalid error, never 'unchanged'", async () => {
    // `undefined !== undefined` is false, and that single mistake would
    // re-download every CSV 288 times a day while the mocked test passed —
    // or, worse here, treat a broken response as "nothing changed" forever.
    const h = harness({
      memories: [stateRow(ID, "live", LIVE_AT_MS), lockedSpec(ID), stateRow(OTHER_ID, "draft")],
      sessions: [hypSession(ID)],
      datasets: { [DATASET]: { version: 1, csv: CSV_HOLDING, versionless: true } },
    });
    const report = await h.poller.tick();
    expect(report.hypotheses[0]?.error?.kind).toBe("invalid");
    expect(report.hypotheses[0]?.evaluated).toBe(false);
    expect(h.stub.downloads).toHaveLength(0);
    expect(h.stub.appends).toHaveLength(0);
  });
});

// ── The board's numbers ─────────────────────────────────────────────────

function appendedEvaluation(stub: Stub, at = 0): { line: string; snapshot: Record<string, unknown> } {
  const request = stub.appendedWith("evaluation")[at];
  if (request === undefined) throw new Error(`no kind=evaluation append at index ${at}`);
  const content = (JSON.parse(request.body) as { content: string }).content;
  const newline = content.indexOf("\n");
  return {
    line: content.slice(0, newline),
    snapshot: JSON.parse(content.slice(newline + 1)) as Record<string, unknown>,
  };
}

describe("poller_evaluation_memory", () => {
  it("poller_evaluation_memory: line 1 is the pinned summary line and the body is the full snapshot", async () => {
    const h = harness(liveHypothesis(CSV_HOLDING));
    await h.poller.tick();

    const request = h.stub.appendedWith("evaluation")[0];
    expect(JSON.parse(request?.body ?? "{}")).toMatchObject({
      labels: { kind: "evaluation", name: ID },
      embed: false,
    });
    const { line, snapshot } = appendedEvaluation(h.stub);
    expect(line).toBe(
      "score=1.00 tripped=0 holding=1 indeterminate=0 evaluated=2026-08-20T00:00:00Z",
    );
    expect(snapshot["support_score"]).toBe(1);
    // Two decimals, and RFC3339 with whole seconds — the spelling
    // § "Where the board's numbers come from" prints, which is also what W8's
    // `parseEvaluationSummaryLine` (the only reader) round-trips.
    expect(snapshot["evaluated_at_ms"]).toBe(NOW_MS);
    expect((snapshot["conditions"] as unknown[])).toHaveLength(1);
    expect((snapshot["metrics"] as unknown[])).toHaveLength(1);
    // A row Wolf appended through its API key: EMPTY provenance, which is what
    // makes it trusted on the next read.
    expect(h.stub.memories.at(-1)?.createdByWorker).toBe("");
  });

  it("poller_evaluation_memory: an UNCHANGED evaluation appends nothing", async () => {
    const h = harness(liveHypothesis(CSV_HOLDING));
    await h.poller.tick();
    expect(h.stub.appendedWith("evaluation")).toHaveLength(1);

    h.setNow(NOW_MS + HOUR_MS);
    await h.poller.tick();
    // `evaluated=` moved by an hour and the line is otherwise identical, so
    // nothing was written. Comparing WHOLE lines here would append 288 rows a
    // day for a hypothesis nothing happened to.
    expect(h.stub.appendedWith("evaluation")).toHaveLength(1);
  });

  it("poller_evaluation_memory: the same unchanged evaluation 21 hours later appends exactly once", async () => {
    const h = harness(liveHypothesis(CSV_HOLDING));
    await h.poller.tick();

    h.setNow(NOW_MS + 21 * HOUR_MS);
    await h.poller.tick();
    expect(h.stub.appendedWith("evaluation")).toHaveLength(2);
    expect(EVALUATION_MAX_AGE_MS).toBe(20 * HOUR_MS);

    // ...and not a third time an hour after that.
    h.setNow(NOW_MS + 22 * HOUR_MS);
    await h.poller.tick();
    expect(h.stub.appendedWith("evaluation")).toHaveLength(2);
  });

  it("poller_evaluation_memory: a CHANGED score appends a second row", async () => {
    const datasets: Record<string, DatasetRow> = { [DATASET]: { version: 1, csv: CSV_HOLDING } };
    const h = harness({ ...liveHypothesis(CSV_HOLDING), datasets });
    await h.poller.tick();

    datasets[DATASET] = {
      version: 2,
      csv: "timestamp,value\n2026-08-18T00:00:00Z,100\n2026-08-19T00:00:00Z,97\n",
    };
    h.setNow(NOW_MS + HOUR_MS);
    await h.poller.tick();
    const rows = h.stub.appendedWith("evaluation");
    expect(rows).toHaveLength(2);
    expect(appendedEvaluation(h.stub, 1).line).toContain("score=-1.00");
  });
});

// ── Staleness on line 1 (W27) ───────────────────────────────────────────

/**
 * `SPEC` plus a SECOND metric, `hedge`, that no condition mentions.
 *
 * 🔴 That is the point of the fixture. With one metric and one condition on
 * it, a stale series also makes its condition `indeterminate` (`evaluate.ts`
 * :396), so `stale=<n>` would carry nothing `indeterminate=<n>` does not
 * already say. A metric NOTHING is conditioned on can go stale while every
 * condition stays determinate — the board learns "half the evidence stopped
 * arriving" from a line that otherwise reads as perfectly healthy.
 */
const SPEC_TWO_METRICS = {
  ...SPEC,
  metrics: [
    // 0.9 / 0.1, not 1.0 / 1.0: V13 requires the weights to sum to 1.0, and
    // V27 requires any metric weighing >= 0.25 to be named by a condition —
    // so "a metric no condition mentions" is only a legal spec below that
    // floor. That is the shape this test needs, and it is a real one.
    { ...SPEC.metrics[0]!, weight: 0.9 },
    { slug: "hedge", source: "stooq", series_id: "gld.us", direction: "up", weight: 0.1, unit: "USD" },
  ],
};
const HEDGE_DATASET = `${ID}-hedge`;
/** Two observations 10% up, both older than `staleness_days: 5` at NOW_MS. */
const CSV_STALE = "timestamp,value\n2026-08-01T00:00:00Z,100\n2026-08-05T00:00:00Z,110\n";

function twoMetricHypothesis(hedgeCsv: string): StubConfig {
  return {
    memories: [stateRow(ID, "live", LIVE_AT_MS), lockedSpec(ID, SPEC_TWO_METRICS)],
    sessions: [hypSession(ID)],
    datasets: {
      [DATASET]: { version: 1, csv: CSV_HOLDING },
      [HEDGE_DATASET]: { version: 1, csv: hedgeCsv },
    },
  };
}

describe("poller_stale_token", () => {
  it("poller_stale_token: a stale metric NO condition mentions still puts ` stale=<n>` on line 1", async () => {
    // Staleness lives in `metrics[].stale`, inside the JSON BODY, and the
    // board reads only the 500-byte snippet — so without this token the board
    // cannot see it at all. And it has to be on LINE 1 specifically: the
    // memory is written only when line 1 changes, so a signal put anywhere
    // else has its own write suppressed.
    const h = harness(twoMetricHypothesis(CSV_STALE));
    await h.poller.tick();

    const { line, snapshot } = appendedEvaluation(h.stub);
    expect(line).toBe(
      "score=1.00 tripped=0 holding=1 indeterminate=0 evaluated=2026-08-20T00:00:00Z stale=1",
    );
    // 🔴 The condition tally says nothing is wrong. `stale=1` is the only
    // token on this line carrying the fact that a series stopped updating.
    expect(line).toContain("indeterminate=0");
    // The token reports what W4 decided — it is not a second staleness rule.
    const metrics = snapshot["metrics"] as { slug: string; stale: boolean }[];
    expect(metrics.find((m) => m.slug === "hedge")?.stale).toBe(true);
    expect(metrics.find((m) => m.slug === "basket")?.stale).toBe(false);
    expect(line).not.toContain("attention=");
    expect(snapshot["attention"]).toBeUndefined();
  });

  it("poller_stale_token: a FRESH second metric puts no stale token on line 1 at all", async () => {
    // The twin of the case above — same spec, same conditions, same basket
    // series — differing only in the hedge series' observation dates, so the
    // assertion lists match line for line and staleness is the only thing
    // that can move the result.
    const h = harness(twoMetricHypothesis(CSV_HOLDING));
    await h.poller.tick();

    const { line, snapshot } = appendedEvaluation(h.stub);
    expect(line).toBe(
      "score=1.00 tripped=0 holding=1 indeterminate=0 evaluated=2026-08-20T00:00:00Z",
    );
    expect(line).toContain("indeterminate=0");
    const metrics = snapshot["metrics"] as { slug: string; stale: boolean }[];
    expect(metrics.find((m) => m.slug === "hedge")?.stale).toBe(false);
    expect(metrics.find((m) => m.slug === "basket")?.stale).toBe(false);
    expect(line).not.toContain("attention=");
    expect(snapshot["attention"]).toBeUndefined();
  });

  it("poller_stale_token: a metric GOING stale is a change to line 1, so the write LANDS", async () => {
    // The justification for putting the token on line 1, executed rather than
    // asserted in prose: the append rule compares line 1 minus the clock, so a
    // signal that is not on it has the write that carries it suppressed as
    // "nothing changed" — and the board would never learn.
    const stub = twoMetricHypothesis(CSV_HOLDING);
    const h = harness(stub);
    await h.poller.tick();
    expect(h.stub.appendedWith("evaluation")).toHaveLength(1);

    stub.datasets![HEDGE_DATASET] = { version: 2, csv: CSV_STALE };
    h.setNow(NOW_MS + HOUR_MS);
    await h.poller.tick();

    expect(h.stub.appendedWith("evaluation")).toHaveLength(2);
    const first = appendedEvaluation(h.stub, 0).line;
    const second = appendedEvaluation(h.stub, 1).line;
    expect(first).toBe(
      "score=1.00 tripped=0 holding=1 indeterminate=0 evaluated=2026-08-20T00:00:00Z",
    );
    expect(second).toBe(
      "score=1.00 tripped=0 holding=1 indeterminate=0 evaluated=2026-08-20T01:00:00Z stale=1",
    );
    // Every token but the clock and `stale=` is byte-identical, which is what
    // makes this a test of the token rather than of the score moving.
    expect(evaluationLineWithoutTimestamp(second)).toBe(
      `${evaluationLineWithoutTimestamp(first)} stale=1`,
    );
  });
});

// ── Attention ───────────────────────────────────────────────────────────

/** A stored `kind=evaluation` row whose condition `inv-1` is indeterminate. */
function indeterminateEvaluation(atMs: number): MemRow {
  const snapshot = {
    evaluated_at_ms: atMs,
    support_score: 0,
    conditions: [
      {
        id: "inv-1",
        metric: "basket",
        state: "indeterminate",
        reason: "no_observations",
        value: null,
        threshold: -5,
        op: "lt",
        window_start_ms: atMs,
        window_end_ms: atMs,
        observations_in_window: 0,
      },
    ],
    metrics: [
      {
        slug: "basket",
        direction: "up",
        realised_change_pct: null,
        last_observation_ms: null,
        stale: true,
        stale_reason: "no_observations",
      },
    ],
  };
  return memory(
    { kind: "evaluation", name: ID },
    `score=0.00 tripped=0 holding=0 indeterminate=1 evaluated=${new Date(atMs).toISOString().replace(/\.\d{3}Z$/, "Z")}\n${JSON.stringify(snapshot)}`,
    { createdAtMs: atMs },
  );
}

describe("poller_attention", () => {
  it("poller_attention: a THIRD consecutive indeterminate writes attention into the body and onto line 1", async () => {
    // Derived from MEMORY, not from a counter in this process: the poller
    // below is brand new and has never seen the two earlier evaluations. That
    // is the whole point — a restart must not reset the run.
    const h = harness({
      memories: [
        stateRow(ID, "live", LIVE_AT_MS),
        lockedSpec(ID),
        indeterminateEvaluation(NOW_MS - 48 * HOUR_MS),
        indeterminateEvaluation(NOW_MS - 24 * HOUR_MS),
      ],
      sessions: [hypSession(ID)],
      datasets: { [DATASET]: { version: 1, csv: CSV_EMPTY } },
    });
    const report = await h.poller.tick();

    expect(report.hypotheses[0]?.attention).toEqual([
      { condition_id: "inv-1", reason: "no_observations", since_ms: NOW_MS - 48 * HOUR_MS },
    ]);
    const { line, snapshot } = appendedEvaluation(h.stub);
    // Appending to line 1 is what makes the write LAND: the memory is written
    // only when line 1 changes, so attention that did not alter the line
    // would be suppressed by the very rule that keeps a quiet hypothesis to
    // one row a day.
    expect(line).toContain("indeterminate=1");
    // 🔴 The whole line, not `endsWith(" attention=1")` — W27 appends a
    // SECOND optional token after it, and an `endsWith` assertion on the
    // first one would have to be rewritten by every future extension. This
    // metric has no observations at all, so W4 marks it stale and both
    // tokens ride the same line, in the order the formatter pins.
    expect(line).toBe(
      "score=0.00 tripped=0 holding=0 indeterminate=1 evaluated=2026-08-20T00:00:00Z attention=1 stale=1",
    );
    expect(snapshot["attention"]).toEqual([
      { condition_id: "inv-1", reason: "no_observations", since_ms: NOW_MS - 48 * HOUR_MS },
    ]);
    // The STATE does not change.
    expect(report.hypotheses[0]?.transitionedTo).toBeNull();
    expect(h.stub.appendedWith("hypothesis")).toHaveLength(0);
  });

  it("poller_attention: TWO consecutive indeterminates are not enough", async () => {
    const h = harness({
      memories: [
        stateRow(ID, "live", LIVE_AT_MS),
        lockedSpec(ID),
        indeterminateEvaluation(NOW_MS - 24 * HOUR_MS),
      ],
      sessions: [hypSession(ID)],
      datasets: { [DATASET]: { version: 1, csv: CSV_EMPTY } },
    });
    const report = await h.poller.tick();
    expect(ATTENTION_RUN_LENGTH).toBe(3);
    expect(report.hypotheses[0]?.attention).toEqual([]);
    expect(appendedEvaluation(h.stub).line).not.toContain("attention=");
  });

  it("poller_attention: a non-indeterminate row in the history BREAKS the run", async () => {
    const holding = memory(
      { kind: "evaluation", name: ID },
      "score=1.00 tripped=0 holding=1 indeterminate=0 evaluated=2026-08-18T00:00:00Z\n" +
        JSON.stringify({
          evaluated_at_ms: NOW_MS - 48 * HOUR_MS,
          support_score: 1,
          conditions: [{ id: "inv-1", state: "holding" }],
          metrics: [],
        }),
      { createdAtMs: NOW_MS - 48 * HOUR_MS },
    );
    const h = harness({
      memories: [
        stateRow(ID, "live", LIVE_AT_MS),
        lockedSpec(ID),
        indeterminateEvaluation(NOW_MS - 72 * HOUR_MS),
        holding,
        indeterminateEvaluation(NOW_MS - 24 * HOUR_MS),
      ],
      sessions: [hypSession(ID)],
      datasets: { [DATASET]: { version: 1, csv: CSV_EMPTY } },
    });
    const report = await h.poller.tick();
    expect(report.hypotheses[0]?.attention).toEqual([]);
  });

  it("poller_attention: an UNTRUSTED evaluation row cannot extend the run", async () => {
    // A researcher inside a container appending `kind=evaluation` rows must
    // not be able to conjure an attention flag (or, by the same read, a score).
    const forged = indeterminateEvaluation(NOW_MS - 24 * HOUR_MS);
    forged.createdBySession = "sess-tick-hostile";
    const h = harness({
      memories: [
        stateRow(ID, "live", LIVE_AT_MS),
        lockedSpec(ID),
        indeterminateEvaluation(NOW_MS - 48 * HOUR_MS),
        forged,
      ],
      sessions: [hypSession(ID)],
      datasets: { [DATASET]: { version: 1, csv: CSV_EMPTY } },
    });
    const report = await h.poller.tick();
    expect(report.hypotheses[0]?.attention).toEqual([]);
  });
});

// ── The transition ──────────────────────────────────────────────────────

describe("poller_transition", () => {
  it("poller_transition: a tripped condition moves live -> challenged with the FULL snapshot embedded", async () => {
    const h = harness(liveHypothesis(CSV_TRIPPED));
    const report = await h.poller.tick();

    expect(report.hypotheses[0]?.reason).toBe("condition_tripped");
    expect(report.hypotheses[0]?.transitionedTo).toBe("challenged");

    const state = h.stub.appendedWith("hypothesis").at(-1);
    const parsed = JSON.parse(state?.body ?? "{}") as {
      labels: Record<string, string>;
      content: string;
    };
    expect(parsed.labels).toMatchObject({ kind: "hypothesis", name: ID, status: "challenged" });
    // § "Snapshotting, because the reaper will delete the evidence": the memory
    // is the permanent record and the dataset is working storage, so the whole
    // evaluation — every condition's state, value and window — goes in.
    const block = JSON.parse(
      parsed.content.slice(parsed.content.indexOf("{"), parsed.content.lastIndexOf("}") + 1),
    ) as { rationale: string; evaluation: { conditions: { state: string }[] } };
    expect(block.rationale).toBe("condition_tripped");
    expect(block.evaluation.conditions[0]?.state).toBe("tripped");
  });

  it("poller_transition: horizon_days elapsed with NOTHING tripped also challenges, with reason horizon_reached", async () => {
    // "so the UI can say 'time's up, verdict?' rather than 'your thesis failed'."
    const h = harness({
      memories: [stateRow(ID, "live", NOW_MS - 31 * 86_400_000), lockedSpec(ID)],
      sessions: [hypSession(ID)],
      datasets: {
        [DATASET]: {
          version: 1,
          csv: "timestamp,value\n2026-08-18T00:00:00Z,100\n2026-08-19T00:00:00Z,99\n",
        },
      },
    });
    const report = await h.poller.tick();
    expect(report.hypotheses[0]?.reason).toBe("horizon_reached");
    expect(report.hypotheses[0]?.transitionedTo).toBe("challenged");
    const block = JSON.parse(
      (() => {
        const content = (
          JSON.parse(h.stub.appendedWith("hypothesis").at(-1)?.body ?? "{}") as { content: string }
        ).content;
        return content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
      })(),
    ) as { rationale: string };
    expect(block.rationale).toBe("horizon_reached");
  });

  it("poller_transition: the horizon clock runs from the OLDEST live row, not the newest", async () => {
    // `challenged -> live` is legal on an accepted amendment (B3). Reading the
    // newest `status=live` row would restart the horizon every time a human
    // accepts one, so a hypothesis could be amended past its own deadline
    // forever.
    const h = harness({
      memories: [
        stateRow(ID, "live", NOW_MS - 31 * 86_400_000),
        lockedSpec(ID),
        stateRow(ID, "challenged", NOW_MS - 10 * 86_400_000),
        stateRow(ID, "live", NOW_MS - 2 * 86_400_000),
      ],
      sessions: [hypSession(ID)],
      datasets: { [DATASET]: { version: 1, csv: CSV_HOLDING } },
    });
    const report = await h.poller.tick();
    expect(report.hypotheses[0]?.reason).toBe("horizon_reached");
  });

  it("poller_transition: IDEMPOTENT — two runs over the same data write the memories of one", async () => {
    const h = harness(liveHypothesis(CSV_TRIPPED));
    await h.poller.tick();
    const afterFirst = h.stub.appends.length;
    expect(h.stub.appendedWith("hypothesis")).toHaveLength(1);

    h.setNow(NOW_MS + HOUR_MS);
    await h.poller.tick();
    // The hypothesis now reads `challenged`, so it is not even polled — and
    // were it re-read, W5's machine treats `challenged -> challenged` as a
    // self-transition: no write, no error (owner decision B3, which is what
    // makes this criterion mean anything).
    expect(h.stub.appends).toHaveLength(afterFirst);
    expect(h.stub.appendedWith("hypothesis")).toHaveLength(1);
  });
});

// ── The sweep ───────────────────────────────────────────────────────────

function tickSessions(count: number, prefix = "sess-tick"): SessionRow[] {
  // Newest first on the wire; the sweep sorts by created_at descending itself.
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    name: "",
    worker: WORKER,
    status: i < 2 ? "running" : "archived",
    createdAtSec: 1_800_000_000 - i * 86_400,
  }));
}

describe("poller_sweep", () => {
  it("poller_sweep: deletes every tick session past the 7th, newest first, WITHOUT consulting status", async () => {
    // Bob has no "completed" session status: a finished tick reads
    // running/active for up to 30 minutes and archived only afterwards, so a
    // status filter either sweeps nothing or deletes a session mid-dataset_put.
    const h = harness({
      ...liveHypothesis(CSV_HOLDING),
      sessions: [hypSession(ID), ...tickSessions(10)],
    });
    const report = await h.poller.tick();
    expect(TICK_SESSIONS_KEPT).toBe(7);
    expect(report.hypotheses[0]?.swept).toEqual(["sess-tick-7", "sess-tick-8", "sess-tick-9"]);
    expect(h.stub.deleted).toEqual(["sess-tick-7", "sess-tick-8", "sess-tick-9"]);
    // The `hyp-<id>` chat session is NEVER swept — only `worker=` rows are.
    expect(h.stub.deleted).not.toContain(SESSION_ID);
  });

  it("poller_sweep: seven or fewer tick sessions cost no delivery read at all", async () => {
    const h = harness({
      ...liveHypothesis(CSV_HOLDING),
      sessions: [hypSession(ID), ...tickSessions(7)],
    });
    const report = await h.poller.tick();
    expect(report.hypotheses[0]?.swept).toEqual([]);
    expect(h.stub.deleted).toEqual([]);
    expect(h.stub.paths((r) => r.startsWith("/agent/deliveries"))).toHaveLength(0);
  });

  it("poller_sweep: never deletes the session of a PENDING or RUNNING delivery for that worker (R112)", async () => {
    const h = harness({
      ...liveHypothesis(CSV_HOLDING),
      sessions: [hypSession(ID), ...tickSessions(10)],
      deliveries: [
        { id: "d-run", worker: WORKER, status: "running", sessionId: "sess-tick-8" },
        { id: "d-pend", worker: WORKER, status: "pending", sessionId: "sess-tick-9" },
        // Terminal, and another worker's in-flight row naming one of ours:
        // neither protects anything here.
        { id: "d-done", worker: WORKER, status: "succeeded", sessionId: "sess-tick-7" },
        { id: "d-other", worker: "researcher-99999999", status: "running", sessionId: "sess-tick-7" },
      ],
    });
    const report = await h.poller.tick();
    expect(report.hypotheses[0]?.swept).toEqual(["sess-tick-7"]);
    expect(report.hypotheses[0]?.inFlight).toEqual(["sess-tick-8", "sess-tick-9"]);
    expect(h.stub.deleted).toEqual(["sess-tick-7"]);
  });
});

// ── Failure handling ────────────────────────────────────────────────────

describe("poller_failures", () => {
  it("poller_failures: a 404 dataset means NEVER WRITTEN — no error, no evaluation, no append", async () => {
    const h = harness({
      memories: [stateRow(ID, "live", LIVE_AT_MS), lockedSpec(ID)],
      sessions: [hypSession(ID)],
      datasets: {},
    });
    const report = await h.poller.tick();
    expect(report.hypotheses[0]?.skipped).toBe("no_datasets_yet");
    expect(report.hypotheses[0]?.error).toBeNull();
    expect(report.hypotheses[0]?.evaluated).toBe(false);
    expect(h.stub.appends).toHaveLength(0);
  });

  it("poller_failures: `unavailable` skips that hypothesis without penalty and the NEXT one is still polled", async () => {
    // not_found and unavailable must stay distinguishable: conflating them
    // makes a provider outage look like a missing metric.
    const h = harness({
      memories: [
        stateRow(ID, "live", LIVE_AT_MS),
        lockedSpec(ID),
        stateRow(OTHER_ID, "live", LIVE_AT_MS),
        lockedSpec(OTHER_ID),
      ],
      sessions: [hypSession(ID), hypSession(OTHER_ID)],
      datasets: {
        [`${OTHER_ID}-basket`]: { version: 1, csv: CSV_HOLDING },
      },
      fail: { [`GET /agent/datasets/${DATASET}`]: { status: 503, body: "bob is down" } },
    });
    const report = await h.poller.tick();

    const failed = report.hypotheses.find((x) => x.id === ID);
    const healthy = report.hypotheses.find((x) => x.id === OTHER_ID);
    expect(failed?.error?.kind).toBe("unavailable");
    expect(failed?.evaluated).toBe(false);
    expect(healthy?.evaluated).toBe(true);
    expect(h.stub.appendedWith("evaluation")).toHaveLength(1);
  });

  it("poller_failures: any OTHER kind is recorded and skipped; one hypothesis's failure never stops the rest", async () => {
    const h = harness({
      memories: [
        stateRow(ID, "live", LIVE_AT_MS),
        lockedSpec(ID),
        stateRow(OTHER_ID, "live", LIVE_AT_MS),
        lockedSpec(OTHER_ID),
      ],
      sessions: [hypSession(ID), hypSession(OTHER_ID)],
      datasets: {
        [DATASET]: { version: 1, csv: "t,value\n2026-08-19T00:00:00Z,90\n" },
        [`${OTHER_ID}-basket`]: { version: 1, csv: CSV_HOLDING },
      },
    });
    const report = await h.poller.tick();
    const failed = report.hypotheses.find((x) => x.id === ID);
    // A `t,value` header: the exact silent failure the canonical CSV is pinned
    // to prevent, surfaced here as a loud `invalid`.
    expect(failed?.error?.kind).toBe("invalid");
    expect(failed?.error?.message).toContain("canonical CSV line 1");
    expect(report.hypotheses.find((x) => x.id === OTHER_ID)?.evaluated).toBe(true);
  });

  it("poller_failures: a locked spec that no longer validates skips the hypothesis rather than throwing", async () => {
    const h = harness({
      memories: [stateRow(ID, "live", LIVE_AT_MS), lockedSpec(ID, { thesis: "nope" })],
      sessions: [hypSession(ID)],
      datasets: { [DATASET]: { version: 1, csv: CSV_TRIPPED } },
    });
    const report = await h.poller.tick();
    expect(report.hypotheses[0]?.skipped).toBe("no_locked_spec");
    expect(report.hypotheses[0]?.error).toBeNull();
    expect(h.stub.appends).toHaveLength(0);
  });

  it("poller_failures: a board read that fails is recorded, not thrown — no throw escapes the interval", async () => {
    const h = harness({
      fail: { "GET /agent/sessions": { status: 500, body: "boom" } },
    });
    const report = await h.poller.tick();
    expect(report.error?.kind).toBe("unavailable");
    expect(report.hypotheses).toEqual([]);

    // And the same through the real interval callback, which is where an
    // unhandled rejection would take the process down. This also proves the
    // interval actually RUNS a tick rather than merely being scheduled.
    vi.useFakeTimers();
    const before = h.stub.requests.length;
    h.poller.start();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.stub.requests.length).toBeGreaterThan(before);
    const afterOne = h.stub.requests.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.stub.requests.length).toBeGreaterThan(afterOne); // and again, on the interval
    h.poller.stop();
    const afterStop = h.stub.requests.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.stub.requests).toHaveLength(afterStop);
  });

  it("poller_failures: an untrusted (container-written) locked spec is not read", async () => {
    const forged = lockedSpec(ID);
    forged.createdByWorker = WORKER;
    const h = harness({
      memories: [stateRow(ID, "live", LIVE_AT_MS), forged],
      sessions: [hypSession(ID)],
      datasets: { [DATASET]: { version: 1, csv: CSV_TRIPPED } },
    });
    const report = await h.poller.tick();
    expect(report.hypotheses[0]?.skipped).toBe("no_locked_spec");
  });

  // ── The DATASET half of the trust model ───────────────────────────────
  //
  // 🔴 Memories were provenance-checked at every read and datasets were not,
  // while BOTH decide status. Bob lets any session in the project write any
  // dataset name (measured 2026-08-27: a container wrote and read
  // `hyp-victim-fable-probe-rate`, a name it did not own, and got version 2),
  // so a peer container could write TRIPPING values into this hypothesis's
  // series and Wolf would append a genuine `challenged` transition. No tamper
  // flag would fire, because the state row really was Wolf's.

  it("poller_failures: a FOREIGN-written dataset never drives a transition", async () => {
    const h = harness({
      memories: [stateRow(ID, "live", LIVE_AT_MS), lockedSpec(ID)],
      sessions: [hypSession(ID)],
      // Values that WOULD trip the condition — written by another hypothesis's
      // researcher. The numbers are hostile; the point is that the writer is.
      datasets: {
        [DATASET]: { version: 1, csv: CSV_TRIPPED, writtenBy: "researcher-deadbeef" },
      },
    });
    const report = await h.poller.tick();

    // THE SECURITY CLAIM, asserted first: no state was written.
    expect(report.hypotheses[0]?.transitionedTo).toBeNull();
    expect(report.hypotheses[0]?.evaluated).toBe(false);
    // And it is reported as REFUSED, not as absent — an operator must be able
    // to tell "nobody has written yet" from "someone else is writing here".
    expect(report.hypotheses[0]?.skipped).toBe("forged_datasets");
  });

  // THE POSITIVE HALF. Without this, a check that refused EVERY dataset would
  // pass the test above and silently stop every legitimate hypothesis.
  it("poller_failures: the hypothesis's OWN researcher still trips the condition", async () => {
    const h = harness({
      memories: [stateRow(ID, "live", LIVE_AT_MS), lockedSpec(ID)],
      sessions: [hypSession(ID)],
      datasets: { [DATASET]: { version: 1, csv: CSV_TRIPPED, writtenBy: WORKER } },
    });
    const report = await h.poller.tick();
    expect(report.hypotheses[0]?.evaluated).toBe(true);
    expect(report.hypotheses[0]?.transitionedTo).toBe("challenged");
  });

  it("poller_failures: an EMPTY writer is foreign, not the application", async () => {
    // `dataset_put` refuses an unidentified caller, so every dataset carries a
    // session; an empty WORKER is a human chat session inside a container. The
    // "the application wrote it" rule needs BOTH provenance fields empty, and
    // no MCP dataset write can produce that.
    const h = harness({
      memories: [stateRow(ID, "live", LIVE_AT_MS), lockedSpec(ID)],
      sessions: [hypSession(ID)],
      datasets: { [DATASET]: { version: 1, csv: CSV_TRIPPED, writtenBy: "" } },
    });
    const report = await h.poller.tick();
    expect(report.hypotheses[0]?.transitionedTo).toBeNull();
    expect(report.hypotheses[0]?.skipped).toBe("forged_datasets");
  });
});

// ── What it must NOT do ─────────────────────────────────────────────────

describe("poller_boundaries", () => {
  it("poller_boundaries: never reads GET /agent/attention-requests", async () => {
    // Over HTTP attention is read-only, W8's detail route owns it, and the
    // `challenged` state on the board is Wolf's notification surface. A poller
    // that read the rows and exported them would be dead code.
    const h = harness({
      ...liveHypothesis(CSV_TRIPPED),
      sessions: [hypSession(ID), ...tickSessions(9)],
    });
    await h.poller.tick();
    for (const request of h.stub.requests) {
      expect(request.path).not.toContain("/agent/attention-requests");
    }
  });

  it("poller_boundaries: never deletes a dataset — the datasets are the evidence", async () => {
    const h = harness({
      ...liveHypothesis(CSV_TRIPPED),
      sessions: [hypSession(ID), ...tickSessions(9)],
    });
    await h.poller.tick();
    for (const request of h.stub.requests) {
      if (request.method === "DELETE") expect(request.path).not.toContain("/agent/datasets");
    }
  });
});
