import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import cookieParser from "cookie-parser";
import express, { type Request, type Response } from "express";
import pino from "pino";
import {
  MockAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
  type Interceptable,
} from "undici";

import { createErrorHandler } from "../app.js";
import { loadConfig, type WolfConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { createOrangeClient } from "../orange/client.js";
import { setSessionCookie } from "../auth/session.js";
import { MS_PER_DAY } from "../hypothesis/evaluate.js";
import { createSeriesRouter, seriesState } from "./series.js";

// design/2026-08-20-agent-wolf.md, W11's acceptance criteria for
// `GET /api/hypotheses/:id/series/:metric`. Test names are prefixed `series_`.
//
// Orange is mocked with undici's MockAgent (the pinned mechanism). The SPEC
// below is the committed W3 fixture — the same worked example that ticket
// asserts validates — so these tests cannot pass against a spec shape the
// validator would reject. Everything else is synthetic and is not presented
// as a recording.

const ORANGE = "http://orange.test:4100";
const API_KEY = "wolf-project-api-key-for-tests";
const SECRET = "session-secret-for-tests-0123456789abcdef";
const OWNER = "kai@badcode.dev";
const ID = "1a2b3c4d";
const METRIC = "drone-suppliers-basket";
const DATASET = `${ID}-${METRIC}`;

/** "Now" for every test that cares: 2026-08-24T00:00:00Z. */
const NOW_MS = Date.UTC(2026, 7, 24);

function workedSpec(): Record<string, unknown> {
  // `readFileSync(new URL(...))`, not a JSON import: `api/` is NodeNext, so a
  // JSON import would need an import attribute (§ "Environment facts").
  return JSON.parse(
    readFileSync(new URL("../hypothesis/__fixtures__/worked-spec.json", import.meta.url), "utf8"),
  );
}

/** The canonical dataset CSV: `timestamp,value`, LF, one terminating LF. */
function csv(rows: [string, number][]): string {
  return ["timestamp,value", ...rows.map(([t, v]) => `${t},${v}`), ""].join("\n");
}

function daysBefore(nowMs: number, days: number): string {
  return new Date(nowMs - days * MS_PER_DAY).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ── The stub Orange ─────────────────────────────────────────────────────

interface Recorded {
  method: string;
  path: string;
}

interface Answer {
  status: number;
  body: string;
}

interface StubConfig {
  /** The spec JSON the locked `kind=hypothesis-spec` memory carries. `null` = no spec row. */
  spec?: Record<string, unknown> | null;
  /** Provenance of the spec row — non-empty makes it UNTRUSTED. */
  specProvenance?: { worker: string; session: string };
  /** `GET /agent/datasets/<name>`. */
  metadata?: Answer;
  /** `GET /agent/datasets/<name>/download`. */
  download?: Answer;
}

const EMPTY_MEMORIES = '{"memories":[]}';

class Stub {
  readonly requests: Recorded[] = [];

  constructor(
    private readonly pool: Interceptable,
    private readonly config: StubConfig,
  ) {}

  paths(substring: string): Recorded[] {
    return this.requests.filter((r) => r.path.includes(substring));
  }

  install(): void {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      this.pool
        .intercept({ method, path: () => true })
        .reply((opts) => {
          const path = String(opts.path);
          this.requests.push({ method, path });
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

  private specRow(): Record<string, unknown> {
    const provenance = this.config.specProvenance ?? { worker: "", session: "" };
    return {
      id: "spec-mem-1",
      labels: { kind: "hypothesis-spec", name: ID, status: "locked" },
      snippet: "the locked spec",
      score: 0,
      created_by_worker: provenance.worker,
      created_by_session: provenance.session,
      created_at: 1787334047000,
    };
  }

  private route(method: string, url: URL): Answer {
    const path = url.pathname;

    if (path === "/agent/memories") {
      if (this.config.spec === null) return { status: 200, body: EMPTY_MEMORIES };
      return { status: 200, body: JSON.stringify({ memories: [this.specRow()] }) };
    }
    if (path === "/agent/memories/spec-mem-1") {
      const provenance = this.config.specProvenance ?? { worker: "", session: "" };
      return {
        status: 200,
        body: JSON.stringify({
          id: "spec-mem-1",
          labels: { kind: "hypothesis-spec", name: ID, status: "locked" },
          content: JSON.stringify(this.config.spec ?? workedSpec()),
          created_by_worker: provenance.worker,
          created_by_session: provenance.session,
          created_at: 1787334047000,
        }),
      };
    }
    if (path.endsWith("/download")) {
      return this.config.download ?? { status: 200, body: csv([["2026-08-23T00:00:00Z", 141.22]]) };
    }
    if (path.startsWith("/agent/datasets/")) {
      return (
        this.config.metadata ?? {
          status: 200,
          body: JSON.stringify({
            id: "ds-1",
            name: DATASET,
            version: 7,
            labels: { hypothesis: ID, metric: METRIC },
            size_bytes: 42,
            row_count: 1,
            sha256: "abc",
            content_type: "text/csv",
            created_by_worker: `researcher-${ID}`,
            created_by_session: "sess-tick",
            created_at: 1787334047000,
          }),
        }
      );
    }
    return { status: 404, body: `unrouted in the stub: ${method} ${path}` };
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

function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback): void {
      lines.push(String(chunk));
      callback();
    },
  });
  return { logger: pino({ level: "trace" }, stream) as unknown as Logger, lines };
}

interface Harness {
  base: string;
  stub: Stub;
  cookie: string;
  lines: string[];
}

async function harness(stubConfig: StubConfig = {}, nowMs = NOW_MS): Promise<Harness> {
  const stub = new Stub(pool, stubConfig);
  stub.install();
  const cfg = config();
  const { logger, lines } = capturingLogger();
  const client = createOrangeClient({ baseUrl: cfg.orangeBaseUrl, apiKey: cfg.orangeApiKey, logger });

  const app = express();
  app.use(express.json());
  app.use(cookieParser(cfg.sessionSecret));
  app.post("/test-sign-in", (_req: Request, res: Response) => {
    setSessionCookie(res, OWNER, cfg);
    res.status(200).end();
  });
  app.use(createSeriesRouter({ client, logger, now: () => nowMs }));
  app.use(createErrorHandler(logger));

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  close = () => server.close();
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const signIn = await fetch(`${base}/test-sign-in`, { method: "POST" });
  const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { base, stub, cookie, lines };
}

interface Result {
  status: number;
  json: any;
  raw: string;
  contentType: string;
}

async function get(h: Harness, path: string, withCookie = true): Promise<Result> {
  const res = await fetch(`${h.base}${path}`, {
    headers: withCookie ? { cookie: h.cookie } : {},
    // MANUAL: a 3xx must show up as a 3xx here rather than being followed
    // silently, which is the whole point of the "never redirects" criterion.
    redirect: "manual",
  });
  const raw = await res.text();
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    json = raw;
  }
  return { status: res.status, json, raw, contentType: res.headers.get("content-type") ?? "" };
}

const SERIES = `/api/hypotheses/${ID}/series/${METRIC}`;

// ── The proxy, and its shape ────────────────────────────────────────────

describe("series_proxy", () => {
  it("series_proxy: proxies the bytes server-side and answers 200 with JSON, never a 3xx", async () => {
    const h = await harness();
    const res = await get(h, SERIES);

    // Orange sets no CORS headers by design, so a redirect or a
    // `download_url` for the browser to fetch would fail in the browser.
    expect(res.status).toBe(200);
    expect(res.status).toBeLessThan(300);
    expect(res.contentType).toContain("application/json");
    expect(res.raw).not.toContain(ORANGE);
    expect(res.raw).not.toContain("download_url");
  });

  it("series_proxy: the response is { points, unit, version, fetched_at_ms, state }", async () => {
    const h = await harness({
      download: {
        status: 200,
        body: csv([
          ["2026-08-22T00:00:00Z", 141.22],
          ["2026-08-23T00:00:00Z", 143.9],
        ]),
      },
    });
    const res = await get(h, SERIES);

    expect(res.status).toBe(200);
    expect(Object.keys(res.json).sort()).toEqual([
      "fetched_at_ms",
      "points",
      "state",
      "unit",
      "version",
    ]);
    // `Point` is the pinned `{ tMs, v }`, unix MILLISECONDS — not `{t, v}`.
    expect(res.json.points).toEqual([
      { tMs: Date.UTC(2026, 7, 22), v: 141.22 },
      { tMs: Date.UTC(2026, 7, 23), v: 143.9 },
    ]);
    expect(res.json.unit).toBe("USD");
    expect(res.json.version).toBe(7);
    expect(res.json.fetched_at_ms).toBe(NOW_MS);
    expect(res.json.state).toBe("ok");
  });

  it("series_proxy: reads the BARE metadata object then the download, both with the project key and no dataset token", async () => {
    const h = await harness();
    await get(h, SERIES);

    const metadata = h.stub.paths(`/agent/datasets/${DATASET}`).filter((r) => !r.path.includes("/download"));
    const download = h.stub.paths("/download");
    expect(metadata).toHaveLength(1);
    expect(download).toHaveLength(1);
    // No O4 dataset token is minted: those exist so a CONTAINER can curl a
    // URL, and a server holding the project key has no use for one.
    expect(h.stub.requests.some((r) => r.path.includes("token"))).toBe(false);
    expect(download[0]?.path).not.toContain("token=");
    // The download IS pinned to the version the metadata named, so the
    // reported `version` and the returned points cannot come from different
    // snapshots when a dataset_put lands between the two requests.
    expect(download[0]?.path).toContain("version=7");
  });
});

// ── The three states ────────────────────────────────────────────────────

describe("series_state", () => {
  it("series_state: a 404 from Orange is 200 never_fetched with an empty series and version 0", async () => {
    const h = await harness({ metadata: { status: 404, body: "dataset not found" } });
    const res = await get(h, SERIES);

    // Never a 500: this is the state of every metric on the day its
    // hypothesis goes live.
    expect(res.status).toBe(200);
    expect(res.json.state).toBe("never_fetched");
    expect(res.json.points).toEqual([]);
    expect(res.json.version).toBe(0);
    // The unit is still known — it comes from the spec, not from the dataset.
    expect(res.json.unit).toBe("USD");
    // And no download was attempted for a dataset that does not exist.
    expect(h.stub.paths("/download")).toEqual([]);
  });

  it("series_state: an observation older than staleness_days is stale, WITH its points", async () => {
    const h = await harness({
      download: { status: 200, body: csv([[daysBefore(NOW_MS, 9), 141.22]]) },
    });
    const res = await get(h, SERIES);

    expect(res.status).toBe(200);
    // The default staleness_days is 5 (the worked spec sets none).
    expect(res.json.state).toBe("stale");
    // The points come back anyway: "stale, with its reason" is a different
    // rendering from a flat line or a silent gap.
    expect(res.json.points).toHaveLength(1);
  });

  it("series_state: a fresh observation inside staleness_days is ok", async () => {
    const h = await harness({
      download: { status: 200, body: csv([[daysBefore(NOW_MS, 2), 141.22]]) },
    });
    const res = await get(h, SERIES);

    expect(res.json.state).toBe("ok");
  });

  it("series_state: never_fetched is produced ONLY by the 404 branch, never by staleness", async () => {
    // The two are different renderings and therefore different values, not
    // one "no data" marker. `seriesState` — which is what decides everything
    // about a dataset that EXISTS — can never return `never_fetched`, however
    // old or empty the series is; that value comes solely from the branch
    // that saw Orange 404 the dataset.
    const nowMs = NOW_MS;
    for (const points of [[], [{ tMs: nowMs - 400 * MS_PER_DAY, v: 1 }], [{ tMs: nowMs, v: 1 }]]) {
      expect(seriesState(points, 5, nowMs)).not.toBe("never_fetched");
    }
    const h = await harness({ metadata: { status: 404, body: "no dataset" } });
    expect((await get(h, SERIES)).json.state).toBe("never_fetched");
  });

  it("series_state: a written-but-empty dataset is stale, not ok and not never_fetched", async () => {
    // A header-only file is zero observations and NOT a parse error (W10's
    // parser says so); but a dataset that exists carrying nothing is a failed
    // tick, and calling it `ok` would draw an empty chart with no explanation.
    const h = await harness({ download: { status: 200, body: "timestamp,value\n" } });
    const res = await get(h, SERIES);

    expect(res.status).toBe(200);
    expect(res.json.points).toEqual([]);
    expect(res.json.state).toBe("stale");
    expect(res.json.version).toBe(7);
  });

  it("series_state: seriesState honours the spec's own staleness_days, not the default", async () => {
    const nowMs = NOW_MS;
    const sevenDaysOld = [{ tMs: nowMs - 7 * MS_PER_DAY, v: 1 }];
    expect(seriesState(sevenDaysOld, 5, nowMs)).toBe("stale");
    expect(seriesState(sevenDaysOld, 10, nowMs)).toBe("ok");
    // The boundary is "OLDER than", so exactly staleness_days is still ok.
    expect(seriesState([{ tMs: nowMs - 5 * MS_PER_DAY, v: 1 }], 5, nowMs)).toBe("ok");
    expect(seriesState([], 5, nowMs)).toBe("stale");
  });

  it("series_state: a spec-level staleness_days is what the route uses", async () => {
    const spec = { ...workedSpec(), staleness_days: 30 };
    const h = await harness({
      spec,
      download: { status: 200, body: csv([[daysBefore(NOW_MS, 9), 141.22]]) },
    });
    const res = await get(h, SERIES);

    // 9 days old, and 9 < 30 — the same series that was `stale` under the
    // default is `ok` here. A route that hardcoded 5 would fail this.
    expect(res.json.state).toBe("ok");
  });
});

// ── The unit, and the metric that does not exist ────────────────────────

describe("series_metric", () => {
  it("series_metric: unit comes from the metric's entry in the LOCKED spec", async () => {
    const h = await harness();
    const res = await get(h, `/api/hypotheses/${ID}/series/petro-settlement-share`);

    expect(res.status).toBe(200);
    // The second metric of the worked spec carries a different unit.
    expect(res.json.unit).toBe("pct");
  });

  it("series_metric: a metric that names no slug in the spec is 404 not_found, NOT an empty series", async () => {
    const h = await harness();
    const res = await get(h, `/api/hypotheses/${ID}/series/no-such-metric`);

    expect(res.status).toBe(404);
    expect(res.json.kind).toBe("not_found");
    // An empty series would render as a real, empty chart for a metric that
    // does not exist.
    expect(res.json.points).toBeUndefined();
    // And nothing was asked of the dataset routes.
    expect(h.stub.paths("/agent/datasets")).toEqual([]);
  });

  it("series_metric: a hypothesis with no locked spec is 404 not_found", async () => {
    const h = await harness({ spec: null });
    const res = await get(h, SERIES);

    expect(res.status).toBe(404);
    expect(res.json.kind).toBe("not_found");
  });

  it("series_metric: an UNTRUSTED spec row does not count as a locked spec", async () => {
    // Written from inside a container (non-empty provenance): the trust rule's
    // first clause. A route that read it would let a session define its own
    // metrics and units.
    const h = await harness({
      specProvenance: { worker: `researcher-${ID}`, session: "sess-tick" },
    });
    const res = await get(h, SERIES);

    expect(res.status).toBe(404);
    expect(res.json.kind).toBe("not_found");
  });

  it("series_metric: the spec read asks for retracted rows too, so a hostile retraction cannot hide it", async () => {
    const h = await harness();
    await get(h, SERIES);

    const read = h.stub.paths("/agent/memories")[0];
    expect(read?.path).toContain("include_retracted=1");
    expect(read?.path).toContain(encodeURIComponent(`kind=hypothesis-spec,name=${ID}`));
  });
});

// ── The one parser, and its loud rejections ─────────────────────────────

describe("series_parsing", () => {
  it("series_parsing: a wrong header is 400 invalid naming the line, NOT an empty series", async () => {
    // W10's graded rejection 1. This is the one that matters most: `t,value`
    // would otherwise yield zero observations from a legitimate-looking file
    // with no error anywhere in the system.
    const h = await harness({
      download: { status: 200, body: "t,value\n2026-08-23T00:00:00Z,141.22\n" },
    });
    const res = await get(h, SERIES);

    expect(res.status).toBe(400);
    expect(res.json.kind).toBe("invalid");
    expect(res.json.message).toContain("line 1");
    expect(res.json.message).toContain(DATASET);
    expect(res.json.points).toBeUndefined();
  });

  it("series_parsing: a CRLF file is rejected rather than parsed silently", async () => {
    const h = await harness({
      download: { status: 200, body: "timestamp,value\r\n2026-08-23T00:00:00Z,141.22\r\n" },
    });
    const res = await get(h, SERIES);

    expect(res.status).toBe(400);
    expect(res.json.kind).toBe("invalid");
  });

  it("series_parsing: a non-ascending timestamp is rejected, naming the offending line", async () => {
    const h = await harness({
      download: {
        status: 200,
        body: csv([
          ["2026-08-23T00:00:00Z", 1],
          ["2026-08-22T00:00:00Z", 2],
        ]),
      },
    });
    const res = await get(h, SERIES);

    expect(res.status).toBe(400);
    expect(res.json.message).toContain("line 3");
  });
});

// ── Authentication ──────────────────────────────────────────────────────

describe("series_auth", () => {
  it("series_auth: no wolf_session cookie is 401 and NO upstream request is made at all", async () => {
    const h = await harness();
    const res = await get(h, SERIES, false);

    expect(res.status).toBe(401);
    expect(h.stub.requests).toEqual([]);
  });

  it("series_auth: no captured pino line carries WOLF_API_KEY", async () => {
    const h = await harness();
    const res = await get(h, SERIES);
    expect(res.status).toBe(200);

    expect(h.lines.length).toBeGreaterThan(0);
    const logged = h.lines.join("\n");
    expect(logged).not.toContain(API_KEY);
    // Nor does it log a download URL of any kind.
    expect(logged).not.toContain("download_url");
  });

  it("series_auth: a malformed hypothesis id is 400 invalid and never reaches Orange", async () => {
    const h = await harness();
    const res = await get(h, `/api/hypotheses/hyp-1a2b3c4d/series/${METRIC}`);

    expect(res.status).toBe(400);
    expect(res.json.kind).toBe("invalid");
    expect(h.stub.requests).toEqual([]);
  });

  it("series_auth: an Orange outage on the metadata read is unavailable, not never_fetched", async () => {
    const h = await harness({ metadata: { status: 503, body: "upstream down" } });
    const res = await get(h, SERIES);

    // Conflating the two would make a provider outage look like a missing
    // metric — the exact confusion the taxonomy exists to prevent.
    expect(res.status).toBe(503);
    expect(res.json.kind).toBe("unavailable");
  });
});
