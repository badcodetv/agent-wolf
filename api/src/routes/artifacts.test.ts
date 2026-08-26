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
import { createArtifactsRouter, artifactRow } from "./artifacts.js";

// design/2026-08-20-agent-wolf.md, W29's acceptance criteria for
// `GET /api/hypotheses/:id/artifacts`. Test names are prefixed `artifacts_`.
//
// Orange is mocked with undici's MockAgent (the pinned mechanism); no live
// network anywhere in this file.

const ORANGE = "http://orange.test:4100";
const API_KEY = "wolf-project-api-key-for-tests";
const SECRET = "session-secret-for-tests-0123456789abcdef";
const OWNER = "kai@badcode.dev";
const ID = "1a2b3c4d";
const SESSION_NAME = `hyp-${ID}`;

/**
 * The blob path Orange puts on every artifact row. It names the bucket and the
 * object key of the STORE, and it is the field this route's allow-list
 * projection exists to drop: echoing Orange's row verbatim would publish the
 * storage layout to the browser and to the log.
 */
const BLOB_PATH = "gs://webkit-servers-agent-orange/sess-99/report.md";

/**
 * 🔴 Orange does NOT send this field today (`go/artifacts/artifacts.go`'s
 * `Artifact` has no such tag). It is on the fake anyway, because "never log a
 * `download_url`" is only a testable criterion if an upstream row can carry
 * one: an allow-list projection drops it, a `res.json(rows)` passthrough does
 * not, and the two are indistinguishable against a fixture that never
 * supplies it.
 */
const UPSTREAM_DOWNLOAD_URL = `${ORANGE}/agent/artifacts/art-1/download?token=abc`;

/** One row of Orange's `GET /agent/sessions/by-name/{name}/artifacts`, camelCase on the wire. */
function orangeArtifact(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "art-1",
    sessionId: "sess-99",
    filePath: "/workspace/report.md",
    artifactType: "file",
    status: "extracted",
    blobPath: BLOB_PATH,
    label: "Report",
    description: "the daily report",
    mimeType: "text/markdown",
    fileSize: 4096,
    source: "tool",
    isDir: false,
    download_url: UPSTREAM_DOWNLOAD_URL,
    ...over,
  };
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
  /**
   * `GET /agent/sessions/by-name/<name>/artifacts` — keyed by SESSION NAME, so
   * the fake honours the name in the URL rather than answering the same list
   * for every session (R180: a fake that ignores a parameter makes every
   * assertion that "covers" it decoration).
   */
  artifacts?: Record<string, Answer>;
}

class Stub {
  readonly requests: Recorded[] = [];

  constructor(
    private readonly pool: Interceptable,
    private readonly config: StubConfig,
  ) {}

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

  private route(method: string, url: URL): Answer {
    const match = /^\/agent\/sessions\/by-name\/([^/]+)\/artifacts$/.exec(url.pathname);
    if (match !== null) {
      const name = decodeURIComponent(match[1] ?? "");
      const answer = this.config.artifacts?.[name];
      // Orange resolves the session name first and 404s an unknown one
      // (`go/httpapi/artifacts_download.go:80` → `resolveSessionByName`).
      return answer ?? { status: 404, body: '{"error":"session not found"}' };
    }
    return { status: 404, body: `unrouted in the stub: ${method} ${url.pathname}` };
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

async function harness(stubConfig: StubConfig = {}): Promise<Harness> {
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
  app.use(createArtifactsRouter({ client, logger }));
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
  location: string | null;
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
  return {
    status: res.status,
    json,
    raw,
    contentType: res.headers.get("content-type") ?? "",
    location: res.headers.get("location"),
  };
}

const ARTIFACTS = `/api/hypotheses/${ID}/artifacts`;

function listed(rows: Record<string, unknown>[]): Record<string, Answer> {
  return { [SESSION_NAME]: { status: 200, body: JSON.stringify(rows) } };
}

// ── The proxy, and its shape ────────────────────────────────────────────

describe("artifacts_list", () => {
  it("artifacts_list: proxies the metadata list SERVER-SIDE — 200 JSON, never a 3xx, never Orange's address", async () => {
    const h = await harness({ artifacts: listed([orangeArtifact()]) });
    const res = await get(h, ARTIFACTS);

    expect(res.status).toBe(200);
    expect(res.status).toBeLessThan(300);
    expect(res.location).toBeNull();
    expect(res.contentType).toContain("application/json");
    // Orange sets no CORS headers by design, so handing the browser a URL on
    // Orange's origin would fail there for a reason nothing here can see —
    // and it would put Wolf's project API key within reach of the page.
    expect(res.raw).not.toContain(ORANGE);
    expect(res.raw).not.toContain("orange.test");
    expect(res.raw).not.toContain("download_url");
    expect(res.raw).not.toContain("downloadUrl");

    // The request that was actually made: the by-name route for `hyp-<id>`,
    // and exactly one of them.
    expect(h.stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET /agent/sessions/by-name/${SESSION_NAME}/artifacts`,
    ]);
  });

  it("artifacts_list: projects an ALLOW-LIST — blobPath, sessionId and an unexpected download_url never reach the body", async () => {
    const h = await harness({ artifacts: listed([orangeArtifact()]) });
    const res = await get(h, ARTIFACTS);

    expect(res.json).toEqual({
      artifacts: [
        {
          id: "art-1",
          file_path: "/workspace/report.md",
          artifact_type: "file",
          status: "extracted",
          label: "Report",
          description: "the daily report",
          mime_type: "text/markdown",
          file_size_bytes: 4096,
          source: "tool",
          is_dir: false,
        },
      ],
    });
    // Named individually as well as pinned by the deep-equal above: a later
    // widening of the row that re-admits one of these must fail HERE, where
    // the reason is written down, and not only as a diff in a large object.
    expect(res.raw).not.toContain(BLOB_PATH);
    expect(res.raw).not.toContain("blob_path");
    expect(res.raw).not.toContain("blobPath");
    expect(res.raw).not.toContain("sess-99");
    expect(res.raw).not.toContain(UPSTREAM_DOWNLOAD_URL);
  });

  it("artifacts_list: LOGS the read with a count — and no captured pino line carries a download_url, a blob path or the key", async () => {
    const h = await harness({
      artifacts: listed([orangeArtifact(), orangeArtifact({ id: "art-2", filePath: "/workspace/chart.json" })]),
    });
    const res = await get(h, ARTIFACTS);
    expect(res.status).toBe(200);

    // 🔴 The POSITIVE half, and it is what makes the prohibitions below mean
    // anything: a route that logs NOTHING satisfies every "does not contain"
    // assertion trivially. This one pins that the read is logged, and with
    // what.
    const listedLine = h.lines.find((line) => line.includes("artifacts listed"));
    expect(listedLine, `no "artifacts listed" line in: ${h.lines.join("")}`).toBeDefined();
    const parsed = JSON.parse(listedLine ?? "{}");
    expect(parsed.id).toBe(ID);
    expect(parsed.session).toBe(SESSION_NAME);
    expect(parsed.artifacts).toBe(2);

    // 🔴 The SHAPE, not only the values. Three fields and no more — pinned
    // because the prohibitions below are negative assertions and a negative
    // assertion cannot see a field nobody thought to forbid. A sweep found
    // this: adding `records` to this line left every "does not contain"
    // assertion green, because the client's mapper had already dropped the
    // two strings they name. The next field added here might not be so
    // harmless, and the point of the rule is that adding one is a DELIBERATE
    // act rather than a silent one.
    const ownKeys = Object.keys(parsed).filter(
      (key) => !["level", "time", "pid", "hostname", "msg"].includes(key),
    );
    expect(ownKeys.sort()).toEqual(["artifacts", "id", "session"]);

    const allLines = h.lines.join("");
    expect(allLines).not.toContain(UPSTREAM_DOWNLOAD_URL);
    expect(allLines).not.toContain("download_url");
    expect(allLines).not.toContain("downloadUrl");
    expect(allLines).not.toContain(BLOB_PATH);
    expect(allLines).not.toContain(API_KEY);
  });

  it("artifacts_list: a session with NO artifacts is a 200 and an empty list, never a 404", async () => {
    const h = await harness({ artifacts: listed([]) });
    const res = await get(h, ARTIFACTS);
    expect(res.status).toBe(200);
    // Mirrors its sibling below ("an ABSENT session is 404, never a 500"):
    // both cases name the status they must NOT be, and both now assert it.
    expect(res.status).not.toBe(404);
    expect(res.json).toEqual({ artifacts: [] });
  });

  it("artifacts_list: an ABSENT session is 404 not_found, never a 500", async () => {
    // The stub answers 404 for any session name it does not hold.
    const h = await harness({ artifacts: {} });
    const res = await get(h, ARTIFACTS);
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(500);
    expect(res.json.kind).toBe("not_found");
  });

  it("artifacts_list: an Orange OUTAGE is `unavailable` — distinguishable from an absent session", async () => {
    // `not_found` and `unavailable` must stay distinguishable: an outage is
    // not a missing session, and only one of the two is retryable. The status
    // is Orange's own 502, passed through by `defaultErrorFor`; the KIND is
    // what a caller branches on.
    const h = await harness({
      artifacts: { [SESSION_NAME]: { status: 502, body: '{"error":"bad gateway"}' } },
    });
    const res = await get(h, ARTIFACTS);
    expect(res.json.kind).toBe("unavailable");
    expect(res.json.kind).not.toBe("not_found");
    expect(res.status).toBe(502);
  });

  it("artifacts_list: signed OUT is 401, and NOT ONE upstream request is made", async () => {
    const h = await harness({ artifacts: listed([orangeArtifact()]) });
    const res = await get(h, ARTIFACTS, false);
    expect(res.status).toBe(401);
    // The KIND too, levelling this case with the other three error cases in
    // this group (404/502/400 all pin it). Without it a route that answered
    // 401 from somewhere other than `requireSignedIn` — Express's own body, a
    // hand-rolled guard — reads the same.
    expect(res.json.kind).toBe("forbidden");
    expect(h.stub.requests).toEqual([]);
  });

  it("artifacts_list: a malformed id is 400 invalid, before any upstream request", async () => {
    const h = await harness({ artifacts: listed([orangeArtifact()]) });
    const res = await get(h, "/api/hypotheses/NOTANID/artifacts");
    expect(res.status).toBe(400);
    expect(res.json.kind).toBe("invalid");
    expect(h.stub.requests).toEqual([]);
  });

  it("artifacts_list: the session name is derived ONCE, from the id, and is the `hyp-` form", async () => {
    // § Vocabulary: the id is bare and the prefix belongs to the session name.
    // A doubled prefix (`hyp-hyp-…`) resolves to no session at all, so the
    // stub — which is keyed by name — answers 404 and this test dies.
    const h = await harness({ artifacts: listed([orangeArtifact()]) });
    const res = await get(h, ARTIFACTS);
    expect(res.status).toBe(200);
    expect(h.stub.requests[0]?.path).toBe(`/agent/sessions/by-name/hyp-${ID}/artifacts`);
    expect(h.stub.requests[0]?.path).not.toContain("hyp-hyp-");
  });
});

// ── The projection, in isolation ────────────────────────────────────────

describe("artifactRow", () => {
  it("artifacts_row: maps every field of the allow-list and drops everything else", () => {
    const row = artifactRow({
      id: "art-7",
      sessionId: "sess-99",
      filePath: "chart.json",
      artifactType: "data",
      status: "live",
      label: "Chart",
      description: "",
      mimeType: "application/json",
      fileSizeBytes: 17,
      source: "auto",
      isDir: false,
    });
    expect(row).toEqual({
      id: "art-7",
      file_path: "chart.json",
      artifact_type: "data",
      status: "live",
      label: "Chart",
      description: "",
      mime_type: "application/json",
      file_size_bytes: 17,
      source: "auto",
      is_dir: false,
    });
    // The projection is an allow-list, so the key that is NOT there is as much
    // of the contract as the ten that are.
    expect(Object.keys(row)).not.toContain("session_id");
    expect(Object.keys(row)).not.toContain("sessionId");
  });
});
