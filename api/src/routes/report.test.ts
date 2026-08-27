import { createHash } from "node:crypto";
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

import { createApp, createErrorHandler } from "../app.js";
import { WolfError } from "../errors.js";
import { loadConfig, type WolfConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { createOrangeClient } from "../orange/client.js";
import { setSessionCookie } from "../auth/session.js";
import { createHypothesisStore } from "../hypothesis/store.js";
import { reportDecisionLabels } from "../report/kinds.js";
import { createReportRouter, type ReportRouter } from "./report.js";

/**
 * W21 — the three report routes. Test names are prefixed `report_`.
 *
 * Orange is an in-memory fake behind undici's `MockAgent` (the pinned
 * mechanism; no live network anywhere in this file). It is a FAKE rather than
 * a per-request canned answer because three of this ticket's criteria are
 * about a sequence: POST a template then GET the frame; accept an amendment
 * then GET the frame again; bump a dataset version then GET the frame again.
 * A stub that cannot remember a write cannot express any of them.
 *
 * Two conventions this file holds itself to:
 *
 *  - **Every CSP expectation is a whole string literal**, never assembled
 *    from `frameCsp` or from a shared constant. An expectation built out of
 *    the implementation's own pieces moves with the bug (R133), and the point
 *    of the derived-CSP criterion is that the bytes on the wire are right.
 *  - **The credential test drives the REAL app** (`createApp`), because the
 *    claim "no credential reaches the frame" is about this route's wiring.
 *    `composeFrame` is pure and cannot see config at all, so a unit test of it
 *    would assert nothing about the thing that could leak.
 */

const ORANGE = "http://orange.test:4100";
const API_KEY = "wolf-project-api-key-for-tests";
const SECRET = "session-secret-for-tests-0123456789abcdef";
const OWNER = "kai@badcode.dev";
const ID = "1a2b3c4d";
const ID_B = "2b3c4d5e";

const SLUG_A = "drone-suppliers-basket";
const SLUG_B = "petro-settlement-share";

/** The mandatory operator signal: a CDN failure is invisible inside an opaque frame. */
const FALLBACK = "<div data-wolf-fallback>no chart</div>";

/**
 * A template whose only remote URL is a SCRIPT: its origin is in both
 * `scriptSrcs` and `remoteOrigins`, so it lands in all four CSP positions.
 */
const TEMPLATE_A =
  `${FALLBACK}<script src="https://cdn-a.example/chart.js"></script>` +
  `<section data-wolf-slot="analysis">placeholder</section>`;

/**
 * A template whose only remote URL is an IMAGE: its origin is in
 * `remoteOrigins` and NOT in `scriptSrcs`. This is the R152 case — the host
 * must reach `img-src`/`font-src` and must NOT reach `script-src`/`style-src`.
 */
const TEMPLATE_B =
  `${FALLBACK}<img src="https://img-b.example/pixel.png">` +
  `<section data-wolf-slot="analysis">placeholder</section>`;

/** The whole header for `TEMPLATE_A`, byte for byte. */
const CSP_A =
  "sandbox allow-scripts; default-src 'none'; " +
  "script-src 'unsafe-inline' https://cdn-a.example; " +
  "style-src 'unsafe-inline' https://cdn-a.example; " +
  "img-src https://cdn-a.example data:; font-src https://cdn-a.example data:; " +
  "connect-src 'none'; form-action 'none'; frame-ancestors 'self'; frame-src 'none'; " +
  "child-src 'none'; object-src 'none'; base-uri 'none'; manifest-src 'none'; " +
  "media-src 'none'; worker-src 'none'";

/** A third template, so a decided-and-superseded chain has three distinct headers. */
const TEMPLATE_C =
  `${FALLBACK}<script src="https://cdn-c.example/chart.js"></script>` +
  `<section data-wolf-slot="analysis">placeholder</section>`;

/** The whole header for `TEMPLATE_B`, byte for byte. Note the empty `<CODE>` list. */
const CSP_B =
  "sandbox allow-scripts; default-src 'none'; " +
  "script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; " +
  "img-src https://img-b.example data:; font-src https://img-b.example data:; " +
  "connect-src 'none'; form-action 'none'; frame-ancestors 'self'; frame-src 'none'; " +
  "child-src 'none'; object-src 'none'; base-uri 'none'; manifest-src 'none'; " +
  "media-src 'none'; worker-src 'none'";

/** The whole header for `TEMPLATE_C`, byte for byte. */
const CSP_C =
  "sandbox allow-scripts; default-src 'none'; " +
  "script-src 'unsafe-inline' https://cdn-c.example; " +
  "style-src 'unsafe-inline' https://cdn-c.example; " +
  "img-src https://cdn-c.example data:; font-src https://cdn-c.example data:; " +
  "connect-src 'none'; form-action 'none'; frame-ancestors 'self'; frame-src 'none'; " +
  "child-src 'none'; object-src 'none'; base-uri 'none'; manifest-src 'none'; " +
  "media-src 'none'; worker-src 'none'";

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

// ── The in-memory Orange ────────────────────────────────────────────────

interface Recorded {
  method: string;
  path: string;
  body?: string;
}

interface Retraction {
  memory_id: string;
  created_by_worker: string;
  created_by_session: string;
  created_at: number;
}

interface MemRow {
  id: string;
  labels: Record<string, string>;
  content: string;
  worker: string;
  session: string;
  atMs: number;
  retractedBy?: Retraction[];
}

class FakeOrange {
  readonly requests: Recorded[] = [];
  readonly sessions: Record<string, unknown>[] = [];
  readonly memories: MemRow[] = [];
  /** Per name: every version ever written, plus which one is current. */
  readonly datasets = new Map<string, { version: number; byVersion: Map<number, string> }>();
  /**
   * Bumps a dataset the moment its METADATA is read — the race the version
   * pin exists for. Without the pin the download then returns the NEW bytes
   * under the OLD version number.
   */
  bumpOnMetadataRead: Map<string, { version: number; csv: string }> = new Map();
  /** Names whose metadata read fails with a 503 — the outage leg. */
  readonly unavailableDatasets = new Set<string>();
  /**
   * Makes one append fail, so the partial-write path is reachable: the
   * template lands and the decision write does not. Ruling 2's whole
   * justification for template-first rests on that retry being possible.
   */
  failAppendWhere: ((labels: Record<string, string>) => boolean) | undefined;
  private clock = 1787334047000;
  private appended = 0;

  constructor(private readonly pool: Interceptable) {}

  // ── fixture building ──

  hypothesis(id: string): this {
    this.sessions.push({
      id: `sess-hyp-${id}`,
      name: `hyp-${id}`,
      worker: "interviewer",
      status: "running",
      created_at: 1787334311,
      updated_at: 1787334313,
    });
    return this;
  }

  memory(row: Omit<MemRow, "atMs"> & { atMs?: number }): MemRow {
    const full: MemRow = { ...row, atMs: row.atMs ?? this.clock++ };
    this.memories.push(full);
    return full;
  }

  /** A trusted, locked `report-template`: empty provenance, line 1 the hash. */
  template(id: string, html: string, memoryId = `tmpl-${id}`): MemRow {
    return this.memory({
      id: memoryId,
      labels: { kind: "report-template", name: id, status: "locked" },
      content: `${hashOf(html)}\n${html}`,
      worker: "",
      session: "",
    });
  }

  /** A `kind=report`: written from inside a container, so provenance is NOT empty. */
  report(id: string, headline: string, slots: Record<string, string>, memoryId = `rep-${id}`): MemRow {
    return this.memory({
      id: memoryId,
      labels: { kind: "report", name: id },
      content: `${headline}\n${JSON.stringify(slots)}`,
      worker: `researcher-${id}`,
      session: `sess-hyp-${id}`,
    });
  }

  /**
   * A `kind=report-candidate`: the INTERVIEW writes it, from inside the
   * container, so its provenance is never empty. The default names this
   * hypothesis's own `hyp-<id>` session, which is clause 2 of `isOwnReport`.
   */
  candidate(
    id: string,
    html: string,
    opts: {
      memoryId?: string;
      worker?: string;
      session?: string;
      summary?: string;
      /** Unix MILLISECONDS, so a test can pin `created_at_ms` exactly. */
      atMs?: number;
    } = {},
  ): MemRow {
    return this.memory({
      id: opts.memoryId ?? `cand-${id}`,
      labels: { kind: "report-candidate", name: id },
      content: `${opts.summary ?? "a proposed report template"}\n${html}`,
      worker: opts.worker ?? "",
      session: opts.session ?? `sess-hyp-${id}`,
      ...(opts.atMs !== undefined ? { atMs: opts.atMs } : {}),
    });
  }

  /** Retracts a row the way WOLF does: empty provenance, so it really is withdrawn. */
  retractByWolf(memoryId: string): this {
    const row = this.memories.find((m) => m.id === memoryId);
    if (row === undefined) throw new Error(`no such row to retract: ${memoryId}`);
    row.retractedBy = [
      {
        memory_id: memoryId,
        created_by_worker: "",
        created_by_session: "",
        created_at: 1787334098000,
      },
    ];
    return this;
  }

  spec(
    id: string,
    spec: Record<string, unknown> = workedSpec(),
    provenance: { worker: string; session: string } = { worker: "", session: "" },
  ): MemRow {
    return this.memory({
      id: `spec-${id}`,
      labels: { kind: "hypothesis-spec", name: id, status: "locked" },
      content: JSON.stringify(spec),
      worker: provenance.worker,
      session: provenance.session,
    });
  }

  amendment(id: string, html: string, memoryId = `amend-${id}`): MemRow {
    return this.memory({
      id: memoryId,
      labels: { kind: "report-amendment", name: id, status: "proposed" },
      content: `the chart needs a second axis\n${html}`,
      worker: `critic-${id}`,
      session: `sess-hyp-${id}`,
    });
  }

  /** Retracts a row from INSIDE A CONTAINER: non-empty provenance, so untrusted. */
  retractHostilely(memoryId: string): this {
    const row = this.memories.find((m) => m.id === memoryId);
    if (row === undefined) throw new Error(`no such row to retract: ${memoryId}`);
    row.retractedBy = [
      {
        memory_id: memoryId,
        created_by_worker: "researcher-attacker",
        created_by_session: "sess-attacker",
        created_at: 1787334099000,
      },
    ];
    return this;
  }

  dataset(name: string, version: number, body: string): this {
    const existing = this.datasets.get(name);
    const byVersion = existing?.byVersion ?? new Map<number, string>();
    byVersion.set(version, body);
    this.datasets.set(name, { version, byVersion });
    return this;
  }

  // ── request accounting ──

  paths(substring: string): Recorded[] {
    return this.requests.filter((r) => r.path.includes(substring));
  }

  get downloads(): Recorded[] {
    return this.paths("/download");
  }

  get appends(): Recorded[] {
    return this.requests.filter((r) => r.method === "POST" && r.path === "/agent/memories");
  }

  // ── the wire ──

  install(): void {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      this.pool
        .intercept({ method, path: () => true })
        .reply((opts) => {
          const path = String(opts.path);
          const body = typeof opts.body === "string" ? opts.body : undefined;
          this.requests.push({ method, path, ...(body !== undefined ? { body } : {}) });
          const answer = this.route(method, new URL(path, ORANGE), body);
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

  private searchRow(row: MemRow): Record<string, unknown> {
    const out: Record<string, unknown> = {
      id: row.id,
      labels: row.labels,
      // Orange returns `substring(content, 1, 500)` — a snippet, never the
      // full content. Modelling the truncation is what keeps the template
      // reads honest: a route that read `snippet` would silently serve a
      // truncated template here, and pass every other assertion.
      snippet: row.content.slice(0, 500),
      score: 0,
      created_by_worker: row.worker,
      created_by_session: row.session,
      created_at: row.atMs,
    };
    if (row.retractedBy !== undefined) out["retracted_by"] = row.retractedBy;
    return out;
  }

  private fullRow(row: MemRow): Record<string, unknown> {
    return {
      id: row.id,
      labels: row.labels,
      content: row.content,
      created_by_worker: row.worker,
      created_by_session: row.session,
      created_at: row.atMs,
    };
  }

  private route(
    method: string,
    url: URL,
    body: string | undefined,
  ): { status: number; body: string; contentType?: string } {
    const path = url.pathname;

    if (path === "/agent/sessions") {
      const limit = Number(url.searchParams.get("limit") ?? "200");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      return { status: 200, body: JSON.stringify(this.sessions.slice(offset, offset + limit)) };
    }

    if (method === "POST" && path === "/agent/memories") {
      const parsed = JSON.parse(body ?? "{}") as { labels: Record<string, string>; content: string };
      if (this.failAppendWhere?.(parsed.labels) === true) {
        return { status: 503, body: '{"error":"orange is having a moment"}' };
      }
      this.appended += 1;
      // Written with Wolf's own API key, so the provenance is EMPTY — which
      // is the only reason a `report-template` can be trusted.
      const row = this.memory({
        id: `appended-${this.appended}`,
        labels: parsed.labels,
        content: parsed.content,
        worker: "",
        session: "",
      });
      return { status: 201, body: JSON.stringify(this.fullRow(row)) };
    }

    if (method === "GET" && path === "/agent/memories") {
      const selector = url.searchParams.get("selector") ?? "";
      const terms = selector
        .split(",")
        .filter((t) => t !== "")
        .map((term) => term.split("="));
      // 🔴 `limit` is HONOURED, newest first, exactly as Orange does. A fake
      // that returned every match made every page cap in the system invisible
      // — `ROW_LIMIT`, `DETAIL_LIMIT`, all of them — so a test claiming to
      // prove a lookup survives a full page proved nothing (found by a
      // surviving mutation, fix round 2).
      // Orange's own semantics: `limit` DEFAULTS to 20 and is CAPPED at 100
      // (`go/agentdb/memories.go:36-37,443-448`). The fake defaulted to 100
      // and applied no cap, which is the same "kinder than reality"
      // direction that produced two defects already — a caller relying on a
      // page bigger than Orange will ever return would pass here and fail in
      // production.
      const limit = Math.min(Number(url.searchParams.get("limit") ?? "20"), 100);
      // 🔴 `include_retracted` is HONOURED. Without it Orange filters
      // retracted rows server-side (`client.ts` sends `include_retracted=1`
      // deliberately), so a fake that always returned them made every
      // retraction defence in the system untestable — a hostile retraction
      // could hide a row and no test could see it.
      const includeRetracted = url.searchParams.get("include_retracted") === "1";
      const rows = this.memories
        .filter((row) => terms.every(([k, v]) => k !== undefined && row.labels[k] === v))
        .filter((row) => includeRetracted || (row.retractedBy ?? []).length === 0)
        .sort((a, b) => b.atMs - a.atMs)
        .slice(0, limit)
        .map((row) => this.searchRow(row));
      return { status: 200, body: JSON.stringify({ memories: rows }) };
    }

    if (method === "GET" && path.startsWith("/agent/memories/")) {
      const id = decodeURIComponent(path.slice("/agent/memories/".length));
      const row = this.memories.find((m) => m.id === id);
      if (row === undefined) return { status: 404, body: '{"error":"no such memory"}' };
      return { status: 200, body: JSON.stringify(this.fullRow(row)) };
    }

    if (path.startsWith("/agent/datasets/")) {
      const rest = path.slice("/agent/datasets/".length);
      const download = rest.endsWith("/download");
      const name = decodeURIComponent(download ? rest.slice(0, -"/download".length) : rest);
      if (this.unavailableDatasets.has(name)) {
        return { status: 503, body: '{"error":"upstream is down"}' };
      }
      const entry = this.datasets.get(name);
      if (entry === undefined) return { status: 404, body: '{"error":"no such dataset"}' };
      if (download) {
        // 🔴 `?version=` is HONOURED. A fake that always served the current
        // bytes made the version pin provable only by inspecting the URL;
        // now it is provable by BEHAVIOUR, which is what the pin is for.
        const asked = url.searchParams.get("version");
        const wanted = asked === null ? entry.version : Number(asked);
        const bytes = entry.byVersion.get(wanted);
        if (bytes === undefined) return { status: 404, body: '{"error":"no such version"}' };
        return { status: 200, body: bytes, contentType: "text/csv" };
      }
      const current = entry.byVersion.get(entry.version) ?? "";
      const bump = this.bumpOnMetadataRead.get(name);
      if (bump !== undefined) {
        // Answer with the version the caller is about to pin, THEN move the
        // dataset on — exactly a `dataset_put` landing between the two
        // requests.
        this.bumpOnMetadataRead.delete(name);
        this.dataset(name, bump.version, bump.csv);
      }
      return {
        status: 200,
        body: JSON.stringify({
          id: `ds-${name}`,
          name,
          version: entry.version,
          labels: {},
          size_bytes: current.length,
          row_count: current.split("\n").length - 2,
          sha256: "abc",
          content_type: "text/csv",
          // 🔴 DERIVED FROM THE NAME. A dataset is `<hypothesis-id>-<slug>`
          // and is written by THAT hypothesis's researcher. This fixture said
          // a bare `"researcher"` — not merely the wrong hypothesis, but a
          // worker name the real system never mints (they are all
          // `researcher-<id>`). It was inert while nothing read the field and
          // wrong the moment the frame started checking who wrote its numbers.
          created_by_worker: `researcher-${name.split("-")[0] ?? ID}`,
          created_by_session: "sess-tick",
          created_at: 1787334047000,
        }),
      };
    }

    if (path === "/agent/embed-token") {
      return {
        status: 200,
        body: JSON.stringify({ token: EMBED_TOKEN, expires_at_sec: 1787334947 }),
      };
    }

    return { status: 404, body: `unrouted in the fake: ${method} ${path}` };
  }
}

/** sha256 of the bytes, lowercase hex — the same thing `structureHash` computes. */
function hashOf(html: string): string {
  return createHash("sha256").update(html, "utf8").digest("hex");
}

// ── Harness ─────────────────────────────────────────────────────────────

/** A recognisable fake embed token: the credential-leak test greps for it. */
const EMBED_TOKEN = "EMBED-TOKEN-SENTINEL-must-never-reach-the-frame";
/** The dev-login password used by `realHarness`. Never a real credential. */
const TEST_PASSWORD = "hunter2-for-tests";
/** A recognisable fake project API key, for the same test. */
const SENTINEL_API_KEY = "WOLF-API-KEY-SENTINEL-must-never-reach-the-frame";
/** The MCP token sentinel. Must satisfy `WOLF_MCP_TOKEN`'s pinned shape: 32-128 of [A-Za-z0-9_-]. */
const SENTINEL_MCP_TOKEN = "WOLF_MCP_TOKEN_SENTINEL_must_never_reach_the_frame_0123456789";
/** The session-secret sentinel — the value that SIGNS the cookie. */
const SENTINEL_SESSION_SECRET = "WOLF-SESSION-SECRET-SENTINEL-must-never-reach-the-frame";

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

function config(env: NodeJS.ProcessEnv = {}): WolfConfig {
  return loadConfig(
    {
      WOLF_SESSION_SECRET: SECRET,
      WOLF_ALLOWED_EMAILS: OWNER,
      WOLF_API_KEY: API_KEY,
      ORANGE_BASE_URL: ORANGE,
      NODE_ENV: "test",
      ...env,
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
  orange: FakeOrange;
  cookie: string;
  lines: string[];
  /** W22's accessor, bound to the SAME router instance the routes are mounted from. */
  composeReportStats?: ReportRouter["composeReportStats"];
}

/** Builds the fixture set most tests start from: one hypothesis, one template. */
function seeded(orange: FakeOrange): FakeOrange {
  orange.hypothesis(ID);
  orange.spec(ID);
  orange.template(ID, TEMPLATE_A);
  orange.dataset(`${ID}-${SLUG_A}`, 3, csv([["2026-08-23T00:00:00Z", 141.22]]));
  orange.dataset(`${ID}-${SLUG_B}`, 1, csv([["2026-08-23T00:00:00Z", 61.5]]));
  return orange;
}

interface HarnessOptions {
  cacheMaxEntries?: number;
  signIn?: boolean;
}

async function harness(
  seed: (orange: FakeOrange) => void = seeded,
  options: HarnessOptions = {},
): Promise<Harness> {
  const orange = new FakeOrange(pool);
  seed(orange);
  orange.install();

  const cfg = config();
  const { logger, lines } = capturingLogger();
  const client = createOrangeClient({ baseUrl: cfg.orangeBaseUrl, apiKey: cfg.orangeApiKey, logger });
  const store = createHypothesisStore({ client, logger });

  const app = express();
  app.use(express.json());
  app.use(cookieParser(cfg.sessionSecret));
  app.post("/test-sign-in", (_req: Request, res: Response) => {
    setSessionCookie(res, OWNER, cfg);
    res.status(200).end();
  });
  const report = createReportRouter({
    store,
    client,
    config: cfg,
    logger,
    ...(options.cacheMaxEntries !== undefined ? { cacheMaxEntries: options.cacheMaxEntries } : {}),
  });
  app.use(report.router);
  app.use(createErrorHandler(logger));

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  close = () => server.close();
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const signIn = await fetch(`${base}/test-sign-in`, { method: "POST" });
  const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { base, orange, cookie, lines, composeReportStats: report.composeReportStats };
}

/**
 * The same fixtures, driven through the REAL app (`createApp`) rather than
 * this file's minimal one.
 *
 * Three criteria are about the app's WIRING and not about the router in
 * isolation — that no credential reaches the frame, and that a template
 * inside the configured byte budget survives the body parser — and a harness
 * that mounts only the router cannot see any of them. `WOLF_TEST_LOGIN`
 * mounts the dev-login route (owner decision B6), which is the only way to
 * obtain a cookie from an app whose route table this file must not modify.
 */
async function realHarness(
  seed: (orange: FakeOrange) => void = seeded,
  env: NodeJS.ProcessEnv = {},
): Promise<Harness> {
  const orange = new FakeOrange(pool);
  seed(orange);
  orange.install();

  const { logger, lines } = capturingLogger();
  const cfg = loadConfig(
    {
      WOLF_MCP_TOKEN: "wolf-mcp-token-for-tests-0123456789abcdef",
      WOLF_SESSION_SECRET: SECRET,
      WOLF_ALLOWED_EMAILS: OWNER,
      WOLF_API_KEY: API_KEY,
      ORANGE_BASE_URL: ORANGE,
      WOLF_TEST_LOGIN: `${OWNER}:${TEST_PASSWORD}`,
      NODE_ENV: "test",
      ...env,
    },
    { readRouteTable: () => undefined },
  );

  const app = createApp(logger, cfg);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  close = () => server.close();
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const signIn = await fetch(`${base}/api/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: OWNER, password: TEST_PASSWORD }),
  });
  if (signIn.status !== 200) throw new Error(`dev-login failed: ${signIn.status}`);
  const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { base, orange, cookie, lines };
}

interface Result {
  status: number;
  json: any;
  raw: string;
  headers: Headers;
  contentType: string;
  csp: string | null;
}

async function get(h: Harness, path: string, withCookie = true): Promise<Result> {
  return request(h, "GET", path, undefined, withCookie);
}

async function post(h: Harness, path: string, body: unknown, withCookie = true): Promise<Result> {
  return request(h, "POST", path, body, withCookie);
}

async function request(
  h: Harness,
  method: string,
  path: string,
  body: unknown,
  withCookie: boolean,
): Promise<Result> {
  const headers: Record<string, string> = {};
  if (withCookie) headers["cookie"] = h.cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${h.base}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
    headers: res.headers,
    contentType: res.headers.get("content-type") ?? "",
    csp: res.headers.get("content-security-policy"),
  };
}

const frameUrl = (id: string): string => `/api/hypotheses/${id}/report/frame`;
const FRAME = frameUrl(ID);

/* ================================================================== */
/* GET …/report/frame — the document and its headers                   */
/* ================================================================== */

describe("report_frame", () => {
  it("report_frame: serves text/html with nosniff and NO Set-Cookie", async () => {
    const h = await harness();
    const res = await get(h, FRAME);

    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/html");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // Asserted explicitly: the session middleware refreshing a cookie onto
    // THIS response would put a credential into the one document that is
    // allowed to hold none.
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.raw.startsWith("<!doctype html>\n")).toBe(true);
    // The template fragment is in the body, byte for byte.
    expect(res.raw).toContain('<script src="https://cdn-a.example/chart.js"></script>');
  });

  it("report_frame: the CSP is the one composeFrame derived for THAT template", async () => {
    // Two hypotheses, two templates, two different remote-origin sets. A
    // route emitting a constant policy passes every W19 test and fails here.
    const h = await harness((orange) => {
      seeded(orange);
      orange.hypothesis(ID_B);
      orange.template(ID_B, TEMPLATE_B);
    });

    const a = await get(h, FRAME);
    const b = await get(h, frameUrl(ID_B));

    expect(a.csp).toBe(CSP_A);
    expect(b.csp).toBe(CSP_B);
    expect(a.csp).not.toBe(b.csp);
  });

  it("report_frame: an origin that is fetched but not executable stays out of script-src (R152)", async () => {
    const h = await harness((orange) => {
      orange.hypothesis(ID_B);
      orange.template(ID_B, TEMPLATE_B);
    });
    const res = await get(h, frameUrl(ID_B));

    expect(res.csp).toContain("img-src https://img-b.example data:");
    expect(res.csp).toContain("script-src 'unsafe-inline';");
    expect(res.csp).not.toContain("script-src 'unsafe-inline' https://img-b.example");
  });

  it("report_frame: the sandbox is in the CSP and never carries allow-same-origin", async () => {
    const h = await harness();
    const res = await get(h, FRAME);

    // `sandbox` in the CSP is the entire reason direct navigation to this URL
    // is safe — an iframe attribute does nothing on direct navigation. The
    // pair `allow-scripts allow-same-origin` CANCELS the sandbox (hazard H3
    // in docs/19-embedding.md).
    expect(res.csp?.startsWith("sandbox allow-scripts;")).toBe(true);
    expect(res.csp).not.toContain("allow-same-origin");
  });

  it("report_frame: the policy is a HEADER only — no <meta http-equiv> copy in the body", async () => {
    const h = await harness();
    const res = await get(h, FRAME);

    // A meta policy silently ignores `sandbox` and `frame-ancestors`, so a
    // copy there reads as a second line of defence while being neither.
    expect(res.raw.toLowerCase()).not.toContain("http-equiv");
    expect(res.raw).not.toContain("Content-Security-Policy");
  });

  it("report_frame: 404 kind=not_found, distinguishable from a server error, when no template exists", async () => {
    const h = await harness((orange) => {
      orange.hypothesis(ID);
      orange.spec(ID);
    });
    const res = await get(h, FRAME);

    expect(res.status).toBe(404);
    expect(res.json.kind).toBe("not_found");
    expect(res.json.details.reason).toBe("no_report_template");
    // Not a blank 200 frame: the UI renders an empty state from this.
    expect(res.contentType).toContain("application/json");
  });

  it("report_frame: 401 with no cookie, and NOT ONE upstream request", async () => {
    const h = await harness();
    const res = await get(h, FRAME, false);

    expect(res.status).toBe(401);
    expect(h.orange.requests).toHaveLength(0);
  });

  it("report_frame: a FORGED report-template is 404, never rendered", async () => {
    const h = await harness((orange) => {
      orange.hypothesis(ID);
      // Written from inside a container: non-empty provenance, so `isTrusted`
      // refuses it. Rendering it would let a researcher session own the
      // document a human reads.
      orange.memory({
        id: "forged",
        labels: { kind: "report-template", name: ID, status: "locked" },
        content: `${hashOf(TEMPLATE_A)}\n${TEMPLATE_A}`,
        worker: `researcher-${ID}`,
        session: `sess-hyp-${ID}`,
      });
    });
    const res = await get(h, FRAME);

    expect(res.status).toBe(404);
    expect(res.json.kind).toBe("not_found");
    expect(res.raw).not.toContain("cdn-a.example");
  });

  it("report_frame: a template hidden by a HOSTILE retraction is still served", async () => {
    const h = await harness((orange) => {
      seeded(orange);
      // A retraction whose OWN provenance is non-empty: an untrusted actor
      // cannot withdraw server-written state. Serving `null` here would be
      // the retraction defence failing open.
      orange.retractHostilely(`tmpl-${ID}`);
    });
    const res = await get(h, FRAME);

    expect(res.status).toBe(200);
    expect(res.csp).toBe(CSP_A);
    expect(h.lines.join("\n")).toContain("hostile_retraction");
  });

  it("report_frame: the id is validated before anything upstream is touched", async () => {
    const h = await harness();
    const res = await get(h, "/api/hypotheses/hyp-1a2b3c4d/report/frame");

    // `hyp-` belongs to the SESSION NAME and nowhere else; a prefixed value
    // arriving here is the `hyp-hyp-…` bug being born.
    expect(res.status).toBe(400);
    expect(res.json.kind).toBe("invalid");
    expect(h.orange.requests).toHaveLength(0);
  });

  it("report_frame: a stored template that no longer validates is internal, and its message is not echoed", async () => {
    const h = await harness((orange) => {
      orange.hypothesis(ID);
      // No `[data-wolf-fallback]` — a validation failure, and one that could
      // only arise from a validator change or a write path that skipped
      // validation. The caller sent nothing, so it is not their 400.
      orange.template(ID, '<section data-wolf-slot="analysis">x</section>');
    });
    const res = await get(h, FRAME);

    expect(res.status).toBe(500);
    expect(res.json.kind).toBe("internal");
    expect(res.json.message).toBe("internal error");
    expect(res.raw).not.toContain("data-wolf-fallback");
    // The operator gets the real reason, server-side.
    expect(h.lines.join("\n")).toContain("no longer validates");
  });
});

/* ================================================================== */
/* GET …/report/frame — slot content and the series injection          */
/* ================================================================== */

describe("report_frame_content", () => {
  it("report_frame_content: slot content is sanitised into the document", async () => {
    const h = await harness((orange) => {
      seeded(orange);
      orange.report(ID, "the basket held", {
        analysis: '<p onclick="alert(1)">the basket <em>held</em></p><script>steal()</script>',
      });
    });
    const res = await get(h, FRAME);

    expect(res.status).toBe(200);
    expect(res.raw).toContain("the basket <em>held</em>");
    expect(res.raw).not.toContain("onclick");
    expect(res.raw).not.toContain("steal()");
    // The sign is the contract, not the magnitude: `<p onclick>` removes no
    // ELEMENT, so a node-only counter would report a live XSS attempt as
    // "nothing was removed".
    const composed = h.lines.find((l) => l.includes("report frame composed")) ?? "";
    expect(JSON.parse(composed).stripped_count).toBeGreaterThan(0);
  });

  it("report_frame_content: an unfilled slot renders empty, never the string undefined", async () => {
    const h = await harness((orange) => {
      seeded(orange);
      orange.report(ID, "nothing to say", {});
    });
    const res = await get(h, FRAME);

    expect(res.status).toBe(200);
    expect(res.raw).toContain('<section data-wolf-slot="analysis"></section>');
    expect(res.raw).not.toContain("undefined");
    // The template's own placeholder children are REPLACED, not kept.
    expect(res.raw).not.toContain("placeholder");
  });

  it("report_frame_content: the series lands in window.__WOLF_SERIES__, keyed by metric slug", async () => {
    const h = await harness();
    const res = await get(h, FRAME);

    const match = /window\.__WOLF_SERIES__ = (.*);<\/script>/.exec(res.raw);
    expect(match).not.toBeNull();
    const series = JSON.parse(match![1]!);
    expect(Object.keys(series).sort()).toEqual([SLUG_A, SLUG_B]);
    expect(series[SLUG_A]).toEqual({
      unit: "USD",
      version: 3,
      points: [{ tMs: Date.UTC(2026, 7, 23), v: 141.22 }],
    });
  });

  it("report_frame_content: a metric whose dataset was never written is version 0 and empty, never absent", async () => {
    const h = await harness((orange) => {
      orange.hypothesis(ID);
      orange.spec(ID);
      orange.template(ID, TEMPLATE_A);
      orange.dataset(`${ID}-${SLUG_A}`, 3, csv([["2026-08-23T00:00:00Z", 141.22]]));
      // SLUG_B is deliberately never written.
    });
    const res = await get(h, FRAME);

    const series = JSON.parse(/window\.__WOLF_SERIES__ = (.*);<\/script>/.exec(res.raw)![1]!);
    expect(series[SLUG_B]).toEqual({ unit: "pct", version: 0, points: [] });
  });

  it("report_frame_content: a metric slug that is an Object.prototype key renders, it does not 500", async () => {
    // `constructor` matches LABEL_VALUE_PATTERN, so a model can choose it and
    // the locked spec then freezes it. This class has produced two live
    // defects here (R156/R160, and `present()`); a route-level regression
    // test is what keeps the fix from being undone in a module test's blind
    // spot.
    const spec = workedSpec() as any;
    spec.metrics[0].slug = "constructor";
    spec.invalidation[0].metric = "constructor";
    const h = await harness((orange) => {
      orange.hypothesis(ID);
      orange.spec(ID, spec);
      orange.template(ID, TEMPLATE_A);
      // No dataset for `constructor` — the branch that broke.
    });
    const res = await get(h, FRAME);

    expect(res.status).toBe(200);
    const series = JSON.parse(/window\.__WOLF_SERIES__ = (.*);<\/script>/.exec(res.raw)![1]!);
    expect(series["constructor"]).toEqual({ unit: "USD", version: 0, points: [] });
  });

  it("report_frame_content: a FORGED locked spec is ignored — no metrics, no dataset reads", async () => {
    // The spec read applies the trust rule (`newestTrustedRow`), not "the
    // newest row". A spec written from inside a container decides which
    // metrics exist, what unit each carries and which datasets are fetched —
    // so trusting one would let a researcher session choose what its own
    // report renders. The frame still serves; it just has no series.
    const h = await harness((orange) => {
      orange.hypothesis(ID);
      orange.spec(ID, workedSpec(), { worker: `researcher-${ID}`, session: `sess-hyp-${ID}` });
      orange.template(ID, TEMPLATE_A);
      orange.dataset(`${ID}-${SLUG_A}`, 3, csv([["2026-08-23T00:00:00Z", 141.22]]));
    });
    const res = await get(h, FRAME);

    expect(res.status).toBe(200);
    expect(res.raw).toContain("window.__WOLF_SERIES__ = {};");
    expect(h.orange.paths("/agent/datasets/")).toHaveLength(0);
  });

  it("report_frame_content: a hostilely retracted locked SPEC is still used", async () => {
    // The same defence as the template path's, on the same kind of read. The
    // spec decides which metrics exist and which datasets are fetched, so a
    // container able to hide it by retracting it could blank the report's
    // numbers without forging anything. `include_retracted=1` is what makes
    // the trust rule the judge instead of Orange's server-side filter.
    const h = await harness((orange) => {
      seeded(orange);
      orange.retractHostilely(`spec-${ID}`);
    });
    const res = await get(h, FRAME);

    expect(res.status).toBe(200);
    const series = JSON.parse(/window\.__WOLF_SERIES__ = (.*);<\/script>/.exec(res.raw)![1]!);
    expect(Object.keys(series).sort()).toEqual([SLUG_A, SLUG_B]);
    expect(h.orange.paths("/agent/datasets/").length).toBeGreaterThan(0);
  });

  it("report_frame_content: a hypothesis with no locked spec still renders, with an empty series", async () => {
    const h = await harness((orange) => {
      orange.hypothesis(ID);
      orange.template(ID, TEMPLATE_A);
    });
    const res = await get(h, FRAME);

    expect(res.status).toBe(200);
    expect(res.raw).toContain("window.__WOLF_SERIES__ = {};");
    expect(h.orange.paths("/agent/datasets/")).toHaveLength(0);
  });

  it("report_frame_content: an upstream outage on a dataset is unavailable, never a missing metric", async () => {
    const h = await harness((orange) => {
      seeded(orange);
      orange.unavailableDatasets.add(`${ID}-${SLUG_A}`);
    });
    const res = await get(h, FRAME);

    // `not_found` and `unavailable` must stay distinguishable: rendering an
    // outage as `version: 0` would draw an empty chart and say nothing.
    expect(res.status).toBe(503);
    expect(res.json.kind).toBe("unavailable");
  });
});

/* ================================================================== */
/* GET …/report/frame — the version gate and the cache key             */
/* ================================================================== */

describe("report_frame_cache", () => {
  it("report_frame_cache: a second view downloads no CSV, and still reads every version", async () => {
    const h = await harness();

    const first = await get(h, FRAME);
    const downloadsAfterFirst = h.orange.downloads.length;
    const second = await get(h, FRAME);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.raw).toBe(first.raw);
    expect(second.csp).toBe(first.csp);
    // Two metrics, downloaded once. Without the gate this is four.
    expect(downloadsAfterFirst).toBe(2);
    expect(h.orange.downloads).toHaveLength(2);
    // The version is still READ on every request — the gate is a comparison,
    // not a decision to stop looking.
    expect(h.orange.paths(`/agent/datasets/${ID}-${SLUG_A}`).length).toBeGreaterThanOrEqual(2);
  });

  it("report_frame_cache: a new dataset version re-downloads and re-composes", async () => {
    const h = await harness();
    const first = await get(h, FRAME);

    h.orange.dataset(
      `${ID}-${SLUG_A}`,
      4,
      csv([
        ["2026-08-23T00:00:00Z", 141.22],
        ["2026-08-24T00:00:00Z", 155.75],
      ]),
    );
    const second = await get(h, FRAME);

    expect(second.raw).not.toBe(first.raw);
    expect(second.raw).toContain("155.75");
    // Only the changed dataset is fetched again.
    const slugADownloads = h.orange.downloads.filter((r) => r.path.includes(SLUG_A));
    expect(slugADownloads).toHaveLength(2);
    expect(h.orange.downloads.filter((r) => r.path.includes(SLUG_B))).toHaveLength(1);
    // Each download is PINNED to the version its metadata read named.
    expect(slugADownloads[0]!.path).toContain("version=3");
    expect(slugADownloads[1]!.path).toContain("version=4");
  });

  it("report_frame_cache: a dataset_put BETWEEN the two requests cannot mislabel the frame", async () => {
    // 🔴 The version pin, proved by BEHAVIOUR rather than by reading the URL.
    // The fake bumps this dataset the instant its metadata is read — exactly
    // a `dataset_put` landing between the metadata read and the download — so
    // an unpinned download returns v4's bytes while the frame reports v3.
    // The invariant is that the number the frame states and the numbers it
    // draws come from the same snapshot.
    const h = await harness((orange) => {
      seeded(orange);
      orange.bumpOnMetadataRead.set(`${ID}-${SLUG_A}`, {
        version: 4,
        csv: csv([["2026-08-24T00:00:00Z", 999.99]]),
      });
    });

    const res = await get(h, FRAME);
    expect(res.status).toBe(200);
    const series = JSON.parse(/window\.__WOLF_SERIES__ = (.*);<\/script>/.exec(res.raw)![1]!);

    expect(series[SLUG_A].version).toBe(3);
    expect(series[SLUG_A].points).toEqual([{ tMs: Date.UTC(2026, 7, 23), v: 141.22 }]);
    expect(res.raw).not.toContain("999.99");
  });

  it("report_frame_cache: an accepted amendment changes the frame although NO dataset moved", async () => {
    // 🔴 The structureHash half of the cache key. The dataset versions are
    // identical across these two requests, so a version-only key serves the
    // superseded document for ever — silently, and past a human review.
    const h = await harness((orange) => {
      seeded(orange);
      orange.amendment(ID, TEMPLATE_B);
    });

    const before = await get(h, FRAME);
    expect(before.csp).toBe(CSP_A);
    const versionsBefore = h.orange.paths("/agent/datasets/").length;

    const accepted = await post(h, `/api/hypotheses/${ID}/report-amendment`, {
      amendment_id: `amend-${ID}`,
      decision: "accept",
      rationale: "the second axis is worth it",
    });
    expect(accepted.status).toBe(200);

    const after = await get(h, FRAME);
    expect(after.status).toBe(200);
    expect(after.csp).toBe(CSP_B);
    expect(after.raw).toContain("https://img-b.example/pixel.png");
    expect(after.raw).not.toContain("cdn-a.example");
    // And it did NOT pay to re-download the CSVs it already holds.
    expect(h.orange.downloads).toHaveLength(2);
    expect(h.orange.paths("/agent/datasets/").length).toBeGreaterThan(versionsBefore);
  });

  it("report_frame_cache: a new daily report re-composes, although the template and datasets are unchanged", async () => {
    const h = await harness((orange) => {
      seeded(orange);
      orange.report(ID, "day one", { analysis: "<p>day one</p>" }, "rep-1");
    });

    const first = await get(h, FRAME);
    expect(first.raw).toContain("day one");

    h.orange.report(ID, "day two", { analysis: "<p>day two</p>" }, "rep-2");
    const second = await get(h, FRAME);

    expect(second.raw).toContain("day two");
    expect(second.raw).not.toContain("day one");
  });

  it("report_frame_cache: one hypothesis never renders another's numbers", async () => {
    // 🔴 The frame cache is keyed by hypothesis id, and this is what that key
    // is FOR. These two hypotheses have the same template bytes, the same
    // metric slugs, the same dataset VERSIONS and no report memory, so their
    // cache keys are byte-identical: the id is the only thing separating them.
    // A constant key serves A's document for B at HTTP 200 — cross-hypothesis
    // contamination, in the one place a human reads numbers.
    const h = await harness((orange) => {
      orange.hypothesis(ID);
      orange.spec(ID);
      orange.template(ID, TEMPLATE_A, "tmpl-a");
      orange.dataset(`${ID}-${SLUG_A}`, 3, csv([["2026-08-23T00:00:00Z", 111.11]]));
      orange.dataset(`${ID}-${SLUG_B}`, 1, csv([["2026-08-23T00:00:00Z", 111.22]]));

      orange.hypothesis(ID_B);
      orange.spec(ID_B);
      orange.template(ID_B, TEMPLATE_A, "tmpl-b");
      orange.dataset(`${ID_B}-${SLUG_A}`, 3, csv([["2026-08-23T00:00:00Z", 999.11]]));
      orange.dataset(`${ID_B}-${SLUG_B}`, 1, csv([["2026-08-23T00:00:00Z", 999.22]]));
    });

    const a = await get(h, FRAME);
    const b = await get(h, frameUrl(ID_B));

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.raw).toContain("111.11");
    expect(a.raw).not.toContain("999.11");
    expect(b.raw).toContain("999.11");
    expect(b.raw).not.toContain("111.11");
  });

  it("report_frame_cache: the cache is bounded — the oldest entry is evicted at the cap", async () => {
    const h = await harness(
      (orange) => {
        seeded(orange);
        orange.hypothesis(ID_B);
        orange.spec(ID_B);
        orange.template(ID_B, TEMPLATE_B);
      },
      { cacheMaxEntries: 1 },
    );

    await get(h, FRAME); // caches ID
    await get(h, frameUrl(ID_B)); // evicts ID
    const downloadsBefore = h.orange.downloads.length;
    const again = await get(h, FRAME); // must re-compose from scratch

    expect(again.status).toBe(200);
    expect(again.csp).toBe(CSP_A);
    expect(h.orange.downloads.length).toBeGreaterThan(downloadsBefore);
  });
});

/* ================================================================== */
/* composeReportStats — W22's accessor, on the ONE cache                */
/* ================================================================== */

describe("report_compose_stats", () => {
  it("report_compose_stats: returns the stripped_count of the document the frame SERVED", async () => {
    const h = await harness((orange) => {
      seeded(orange);
      orange.report(ID, "the basket held", {
        analysis: '<p onclick="alert(1)">the basket <em>held</em></p><script>steal()</script>',
      });
    });

    const frame = await get(h, FRAME);
    expect(frame.status).toBe(200);
    const logged = JSON.parse(h.lines.find((l) => l.includes("report frame composed"))!);

    const stats = await h.composeReportStats!(ID);
    expect(stats).not.toBeNull();
    // The SAME number, from the SAME compose — not a second sanitiser pass
    // whose result can disagree with what the browser was sent.
    expect(stats!.strippedCount).toBe(logged.stripped_count);
    expect(stats!.strippedCount).toBeGreaterThan(0);
    expect(stats!.structureHash).toBe(hashOf(TEMPLATE_A));
    expect(stats!.reportMemoryId).toBe(`rep-${ID}`);
  });

  it("report_compose_stats: goes through the frame route's cache — no second compose, no re-download", async () => {
    const h = await harness();
    await get(h, FRAME);
    const downloadsAfterFrame = h.orange.downloads.length;
    const composesAfterFrame = h.lines.filter((l) => l.includes("report frame composed")).length;

    await h.composeReportStats!(ID);

    // A second cache — or a second compose path — shows up as either.
    expect(h.orange.downloads).toHaveLength(downloadsAfterFrame);
    expect(h.lines.filter((l) => l.includes("report frame composed"))).toHaveLength(
      composesAfterFrame,
    );
  });

  it("report_compose_stats: null when there is no locked template — the detail block's has_template:false", async () => {
    const h = await harness((orange) => {
      orange.hypothesis(ID);
      orange.spec(ID);
    });

    await expect(h.composeReportStats!(ID)).resolves.toBeNull();
  });

  it("report_compose_stats: does NOT hand back the document", async () => {
    // 🔴 A security boundary, not a size decision: the HTML is safe only
    // inside the sandboxed frame the CSP header applies to. A caller holding
    // it could put it in a JSON payload and the SPA would render it with no
    // sandbox, no frame-ancestors and no opaque origin.
    const h = await harness();
    const stats = await h.composeReportStats!(ID);

    expect(Object.keys(stats!).sort()).toEqual([
      "reportMemoryId",
      "strippedCount",
      "structureHash",
    ]);
    expect(JSON.stringify(stats)).not.toContain("<!doctype");
    expect(JSON.stringify(stats)).not.toContain("data-wolf-slot");
  });
});

/* ================================================================== */
/* The credential boundary                                             */
/* ================================================================== */

describe("report_frame_credentials", () => {
  /**
   * The test the threat model rests on. It drives the REAL app, with a config
   * holding recognisable fake values, mints a real embed token through the
   * real route (so the sentinel is genuinely live in this process), and then
   * asserts neither string is anywhere in the frame — body, or any header.
   *
   * It must not be weakened to a unit test of `composeFrame`: that function
   * is pure, cannot see config, and so cannot fail this.
   */
  it("report_frame_credentials: neither the API key nor an embed token appears in the frame", async () => {
    const h = await realHarness(
      (orange) => {
        seeded(orange);
        orange.report(ID, "the basket held", { analysis: "<p>the basket held</p>" });
      },
      {
        WOLF_API_KEY: SENTINEL_API_KEY,
        WOLF_MCP_TOKEN: SENTINEL_MCP_TOKEN,
        WOLF_SESSION_SECRET: SENTINEL_SESSION_SECRET,
      },
    );

    // Mint a real embed token first, so the sentinel is a value this process
    // has actually handled rather than one that was never in play.
    const minted = await get(h, `/api/hypotheses/${ID}/embed-token`);
    expect(minted.status).toBe(200);
    expect(minted.json.token).toBe(EMBED_TOKEN);

    const res = await get(h, FRAME);
    expect(res.status).toBe(200);
    expect(res.raw).toContain("the basket held");

    // 🔴 Asserted HERE, on the real app, because the criterion's words are
    // "the session middleware will otherwise refresh a cookie onto this
    // response". The file-local harness mounts no app middleware, so the same
    // assertion there cannot see a refresh added to `createApp`.
    expect(res.headers.get("set-cookie")).toBeNull();

    const headerText = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
    // All four credentials this process holds. The session secret SIGNS the
    // cookie, and the frame is the one document allowed to hold none of them.
    for (const secret of [
      SENTINEL_API_KEY,
      EMBED_TOKEN,
      SENTINEL_MCP_TOKEN,
      SENTINEL_SESSION_SECRET,
    ]) {
      expect(res.raw).not.toContain(secret);
      expect(headerText).not.toContain(secret);
      // And it must not reach the log either — a token or a `download_url` in
      // a pino line lands in every proxy log and error report downstream.
      expect(h.lines.join("\n")).not.toContain(secret);
    }
    // Nor does Orange's own base URL, which would hand the page a route to it.
    expect(res.raw).not.toContain(ORANGE);
  });
});

/* ================================================================== */
/* The transport limit — measured against the REAL app                 */
/* ================================================================== */

describe("report_body_limit", () => {
  const url = `/api/hypotheses/${ID}/report-template`;

  function noTemplateYet(orange: FakeOrange): void {
    orange.hypothesis(ID);
    orange.spec(ID);
  }

  it("report_body_limit: a template inside the configured budget reaches the validator", async () => {
    // 🔴 `express.json()`'s DEFAULT limit is 100kb and `WOLF_REPORT_MAX_BYTES`
    // defaults to 512000, so before W21 every template between those two
    // numbers died in the body parser as an opaque 500 — the configured
    // budget was unreachable and nothing said so. Measured here against the
    // real app, because the limit is set in `app.ts` and a router-only
    // harness cannot see it.
    const h = await realHarness(noTemplateYet);
    const big = `${FALLBACK}<section data-wolf-slot="analysis">${"x".repeat(300_000)}</section>`;
    expect(big.length).toBeGreaterThan(100 * 1024);
    const res = await post(h, url, { html: big });

    expect(res.status).toBe(201);
    expect(res.json.structure_hash).toBe(hashOf(big));
  });

  it("report_body_limit: a template past the byte budget is 422, not a 500", async () => {
    const h = await realHarness(noTemplateYet);
    const huge = `${FALLBACK}<section data-wolf-slot="analysis">${"x".repeat(600_000)}</section>`;
    const res = await post(h, url, { html: huge });

    expect(res.status).toBe(422);
    expect(res.json.kind).toBe("invalid");
    expect(res.json.details.errors[0].message).toContain("exceeds the limit");
    expect(h.orange.appends).toHaveLength(0);
  });

  it("report_body_limit: a body past the TRANSPORT limit is invalid, never internal", async () => {
    // The caller sent too many bytes; that is not a server bug, and
    // `internal` would tell them it was. Answered 413 `invalid`.
    const h = await realHarness(noTemplateYet);
    const res = await post(h, url, { html: "y".repeat(1_200_000) });

    expect(res.status).toBe(413);
    expect(res.json.kind).toBe("invalid");
    expect(h.orange.appends).toHaveLength(0);
  });
});

describe("report_body_errors", () => {
  const url = `/api/hypotheses/${ID}/report-template`;

  function noTemplateYet(orange: FakeOrange): void {
    orange.hypothesis(ID);
    orange.spec(ID);
  }

  it("report_body_errors: malformed JSON is invalid, never internal", async () => {
    const h = await realHarness(noTemplateYet);
    const res = await fetch(`${h.base}${url}`, {
      method: "POST",
      headers: { cookie: h.cookie, "content-type": "application/json" },
      body: '{"html": "<div',
    });
    const json = (await res.json()) as { kind: string };

    // `entity.parse.failed`. The caller's bytes never became a body; telling
    // them the server has a bug is the R39 rule inverted.
    expect(res.status).toBe(400);
    expect(json.kind).toBe("invalid");
  });

  it("report_body_errors: an unsupported charset is invalid, never internal", async () => {
    const h = await realHarness(noTemplateYet);
    const res = await fetch(`${h.base}${url}`, {
      method: "POST",
      headers: { cookie: h.cookie, "content-type": "application/json; charset=not-a-real-charset" },
      body: '{"html":"x"}',
    });
    const json = (await res.json()) as { kind: string };

    expect(res.status).toBe(415);
    expect(json.kind).toBe("invalid");
  });

  it("report_body_errors: our OWN taxonomy decides before any duck-typing", async () => {
    // A `WolfError` that happens to carry `type = "entity.too.large"` — the
    // property the body-parser check reads — must still be answered as the
    // WolfError it is. With the duck-typed branch first this was 413
    // `invalid` instead of 403 `forbidden`: a classifier that reads a property
    // any object may carry must never run before the type we own.
    const { logger } = capturingLogger();
    const app = express();
    app.get("/boom", () => {
      throw Object.assign(new WolfError("forbidden", "you may not"), {
        type: "entity.too.large",
      });
    });
    app.use(createErrorHandler(logger));
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    close = () => server.close();
    const { port } = server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/boom`);
    const json = (await res.json()) as { kind: string };

    expect(res.status).toBe(403);
    expect(json.kind).toBe("forbidden");
  });
});

/* ================================================================== */
/* POST …/report-template                                              */
/* ================================================================== */

describe("report_template", () => {
  const url = `/api/hypotheses/${ID}/report-template`;

  function noTemplate(orange: FakeOrange): void {
    orange.hypothesis(ID);
    orange.spec(ID);
    orange.dataset(`${ID}-${SLUG_A}`, 3, csv([["2026-08-23T00:00:00Z", 141.22]]));
    orange.dataset(`${ID}-${SLUG_B}`, 1, csv([["2026-08-23T00:00:00Z", 61.5]]));
  }

  it("report_template: 201 { structure_hash } and a trusted, locked row", async () => {
    const h = await harness(noTemplate);
    const res = await post(h, url, { html: TEMPLATE_A });

    expect(res.status).toBe(201);
    expect(res.json.structure_hash).toBe(hashOf(TEMPLATE_A));
    // W24 renders "everything else" as the SET DIFFERENCE of these two lists
    // (§ 6b); returning them keeps a second parser off the approval path.
    expect(res.json.remote_origins).toEqual(["https://cdn-a.example"]);
    expect(res.json.script_srcs).toEqual(["https://cdn-a.example/chart.js"]);

    expect(h.orange.appends).toHaveLength(1);
    const body = JSON.parse(h.orange.appends[0]!.body!);
    expect(body.labels).toEqual({ kind: "report-template", name: ID, status: "locked" });
    // Line 1 is the hash; the rest is the fragment, byte for byte.
    expect(body.content).toBe(`${hashOf(TEMPLATE_A)}\n${TEMPLATE_A}`);
    // Wolf's own credential is what makes provenance empty — the body must
    // carry no provenance keys at all (O7 rejects a body that does).
    expect(body).not.toHaveProperty("created_by_worker");
    expect(body).not.toHaveProperty("created_by_session");
  });

  it("report_template: remote_origins is the SUPERSET and script_srcs the code half", async () => {
    // TEMPLATE_B's only remote URL is an image: fetched, never executed. A
    // response that reported it as a script src would put a host the human
    // filed under "images" on the code list W24 asks them to approve.
    const h = await harness(noTemplate);
    const res = await post(h, url, { html: TEMPLATE_B });

    expect(res.status).toBe(201);
    expect(res.json.remote_origins).toEqual(["https://img-b.example"]);
    expect(res.json.script_srcs).toEqual([]);
  });

  it("report_template: the frame route serves what was just POSTed", async () => {
    const h = await harness(noTemplate);
    await post(h, url, { html: TEMPLATE_A });
    const res = await get(h, FRAME);

    expect(res.status).toBe(200);
    expect(res.csp).toBe(CSP_A);
  });

  it("report_template: 409 when a locked template already exists, and nothing is written", async () => {
    const h = await harness();
    const res = await post(h, url, { html: TEMPLATE_B });

    expect(res.status).toBe(409);
    expect(res.json.kind).toBe("conflict");
    expect(res.json.message).toContain("amendment");
    expect(h.orange.appends).toHaveLength(0);
  });

  it("report_template: an existing template is 409 even when the submitted HTML is invalid", async () => {
    // § "HTTP routes added", note 4: a template that already exists is never
    // `invalid`. The caller cannot POST here whatever they send.
    const h = await harness();
    const res = await post(h, url, { html: "<p>no slot and no fallback</p>" });

    expect(res.status).toBe(409);
    expect(res.json.kind).toBe("conflict");
    expect(h.orange.appends).toHaveLength(0);
  });

  it("report_template: 422 invalid with a per-path error list, and nothing is written", async () => {
    const h = await harness(noTemplate);
    const res = await post(h, url, { html: '<section data-wolf-slot="analysis">x</section>' });

    expect(res.status).toBe(422);
    expect(res.json.kind).toBe("invalid");
    expect(Array.isArray(res.json.details.errors)).toBe(true);
    expect(res.json.details.errors[0]).toHaveProperty("path");
    expect(res.json.details.errors[0]).toHaveProperty("message");
    expect(res.json.details.errors.some((e: any) => e.message.includes("data-wolf-fallback"))).toBe(
      true,
    );
    expect(h.orange.appends).toHaveLength(0);
  });

  it("report_template: a missing html field is a 400 invalid body, not a 422", async () => {
    const h = await harness(noTemplate);
    const res = await post(h, url, { template: TEMPLATE_A });

    expect(res.status).toBe(400);
    expect(res.json.kind).toBe("invalid");
    expect(res.json.details.errors[0].path).toBe("html");
  });

  it("report_template: an unknown hypothesis is 404, and nothing is written", async () => {
    const h = await harness((orange) => {
      orange.hypothesis(ID_B);
    });
    const res = await post(h, url, { html: TEMPLATE_A });

    expect(res.status).toBe(404);
    expect(res.json.kind).toBe("not_found");
    expect(h.orange.appends).toHaveLength(0);
  });

  it("report_template: 401 with no cookie, and NOT ONE upstream request", async () => {
    const h = await harness(noTemplate);
    const res = await post(h, url, { html: TEMPLATE_A }, false);

    expect(res.status).toBe(401);
    expect(h.orange.requests).toHaveLength(0);
  });
});

/* ================================================================== */
/* The FAKE itself — load-bearing test infrastructure, tested           */
/* ================================================================== */

describe("report_fixture", () => {
  /**
   * 🔴 **The fake is an oracle, and an oracle kinder than reality
   * manufactures coverage.** Two of its parameters were ignored in this file
   * and each silently converted a production defence into decoration:
   * `limit` made every page-cap test vacuous, and `include_retracted` made
   * EVERY retraction defence untestable — including the one with a dedicated
   * test, which passed because the fake never filtered rather than because
   * the code asked for the flag.
   *
   * Neither could be found the way the rest of this file's defects were: a
   * mutation of PRODUCTION code refusing to die is the tool, and **a mutation
   * of fixture code dies nowhere, by construction.** Measured: with the fake
   * ignoring `include_retracted` and both production reads dropping
   * `includeRetracted: true`, the whole suite stays green.
   *
   * So the fake's own behaviour is asserted here, through the real client,
   * the same way `sanitise.ts` pins `#text`/`KEEP_CONTENT`. These tests fail
   * when the FIXTURE regresses, which is what makes every defence downstream
   * of it honest.
   *
   * The check that generalises: for every filter parameter the client can
   * send, assert the fake implements it rather than ignores it. The client
   * sends two — `limit` and `include_retracted` — and both are below.
   */
  async function fixtureClient(seed: (orange: FakeOrange) => void): Promise<{
    orange: FakeOrange;
    client: ReturnType<typeof createOrangeClient>;
  }> {
    const orange = new FakeOrange(pool);
    seed(orange);
    orange.install();
    const cfg = config();
    const { logger } = capturingLogger();
    return {
      orange,
      client: createOrangeClient({ baseUrl: cfg.orangeBaseUrl, apiKey: cfg.orangeApiKey, logger }),
    };
  }

  function threeAmendments(orange: FakeOrange): void {
    orange.hypothesis(ID);
    orange.amendment(ID, TEMPLATE_B, "amend-1");
    orange.amendment(ID, TEMPLATE_B, "amend-2");
    orange.amendment(ID, TEMPLATE_B, "amend-3");
  }

  it("report_fixture: HIDES a retracted row when include_retracted is not sent", async () => {
    const { client } = await fixtureClient((orange) => {
      threeAmendments(orange);
      orange.retractHostilely("amend-2");
    });

    const rows = await client.listMemories({ selector: `kind=report-amendment,name=${ID}` });

    expect(rows.map((r) => r.id).sort()).toEqual(["amend-1", "amend-3"]);
  });

  it("report_fixture: SHOWS a retracted row when include_retracted is sent", async () => {
    const { client } = await fixtureClient((orange) => {
      threeAmendments(orange);
      orange.retractHostilely("amend-2");
    });

    const rows = await client.listMemories({
      selector: `kind=report-amendment,name=${ID}`,
      includeRetracted: true,
    });

    expect(rows.map((r) => r.id).sort()).toEqual(["amend-1", "amend-2", "amend-3"]);
    // And the retraction travels with it, so the trust rule can judge it.
    expect(rows.find((r) => r.id === "amend-2")?.retractedBy?.[0]?.createdByWorker).toBe(
      "researcher-attacker",
    );
  });

  it("report_fixture: HONOURS limit, newest first", async () => {
    const { client } = await fixtureClient(threeAmendments);

    const one = await client.listMemories({
      selector: `kind=report-amendment,name=${ID}`,
      limit: 1,
    });

    expect(one).toHaveLength(1);
    // Newest first: `amend-3` was seeded last.
    expect(one[0]?.id).toBe("amend-3");
  });

  it("report_fixture: defaults limit to 20 and caps it at 100, as Orange does", async () => {
    const { client } = await fixtureClient((orange) => {
      orange.hypothesis(ID);
      for (let i = 0; i < 150; i += 1) orange.amendment(ID, TEMPLATE_B, `amend-${i}`);
    });
    const selector = `kind=report-amendment,name=${ID}`;

    expect(await client.listMemories({ selector })).toHaveLength(20);
    expect(await client.listMemories({ selector, limit: 150 })).toHaveLength(100);
  });

  it("report_fixture: serves the dataset VERSION that was asked for", async () => {
    const { client } = await fixtureClient((orange) => {
      orange.dataset("ds", 3, csv([["2026-08-23T00:00:00Z", 33.3]]));
      orange.dataset("ds", 4, csv([["2026-08-24T00:00:00Z", 44.4]]));
    });

    const pinned = await client.downloadDataset("ds", { version: 3 });
    const current = await client.downloadDataset("ds");

    expect(new TextDecoder().decode(pinned.body)).toContain("33.3");
    expect(new TextDecoder().decode(current.body)).toContain("44.4");
  });
});

/* ================================================================== */
/* The decision label builder, called directly                         */
/* ================================================================== */

describe("report_decision_labels", () => {
  // `amendmentBody`'s zod regex refuses an illegal id before the route ever
  // reaches this builder, so this guard is UNREACHABLE from the routes — and a
  // guard that cannot be made to fail is a comment (R148). It is kept because
  // `reportDecisionLabels` is part of `kinds.ts`'s public label vocabulary,
  // where every other builder validates its inputs the same way, and the next
  // caller may not have a zod schema in front of it. So it is tested here,
  // directly, rather than left as decoration.
  it("report_decision_labels: carries the proposal id as the `amendment` label", () => {
    expect(reportDecisionLabels("1a2b3c4d", "accept", "mem-42")).toEqual({
      kind: "report-amendment",
      name: "1a2b3c4d",
      status: "accepted",
      amendment: "mem-42",
    });
    expect(reportDecisionLabels("1a2b3c4d", "reject", "mem-42").status).toBe("rejected");
  });

  it("report_decision_labels: refuses an id that cannot be a label value", () => {
    // A value with a comma would corrupt the selector the already-decided
    // query is built from; one over 63 characters would be refused by Orange.
    expect(() => reportDecisionLabels("1a2b3c4d", "accept", "mem,kind=x")).toThrow(WolfError);
    expect(() => reportDecisionLabels("1a2b3c4d", "accept", "m".repeat(64))).toThrow(WolfError);
    try {
      reportDecisionLabels("1a2b3c4d", "accept", "mem,kind=x");
      expect.unreachable();
    } catch (err) {
      expect((err as WolfError).kind).toBe("invalid");
    }
  });
});

/* ================================================================== */
/* POST …/report-amendment                                             */
/* ================================================================== */

describe("report_amendment", () => {
  const url = `/api/hypotheses/${ID}/report-amendment`;

  function withAmendment(html: string): (orange: FakeOrange) => void {
    return (orange) => {
      seeded(orange);
      orange.amendment(ID, html);
    };
  }

  it("report_amendment: accept re-validates and writes a NEW report-template", async () => {
    const h = await harness(withAmendment(TEMPLATE_B));
    const res = await post(h, url, {
      amendment_id: `amend-${ID}`,
      decision: "accept",
      rationale: "the second axis is worth it",
    });

    expect(res.status).toBe(200);
    expect(res.json.decision).toBe("accept");
    expect(res.json.structure_hash).toBe(hashOf(TEMPLATE_B));
    expect(res.json.template_memory_id).toBe("appended-1");

    // The template row, then the decision row (asserted in its own test).
    expect(h.orange.appends).toHaveLength(2);
    const body = JSON.parse(h.orange.appends[0]!.body!);
    expect(body.labels).toEqual({ kind: "report-template", name: ID, status: "locked" });
    expect(body.content).toBe(`${hashOf(TEMPLATE_B)}\n${TEMPLATE_B}`);
  });

  it("report_amendment: a proposal that fails validation is 422 and NO template is written", async () => {
    const h = await harness(withAmendment("<p>no slot, no fallback</p>"));
    const res = await post(h, url, {
      amendment_id: `amend-${ID}`,
      decision: "accept",
      rationale: "trust me",
    });

    expect(res.status).toBe(422);
    expect(res.json.kind).toBe("invalid");
    expect(res.json.details.errors.length).toBeGreaterThan(0);
    // The criterion is the CONJUNCTION: 422 *and* nothing written.
    expect(h.orange.appends).toHaveLength(0);

    // And the old template is still what the frame serves.
    const frame = await get(h, FRAME);
    expect(frame.csp).toBe(CSP_A);
  });

  it("report_amendment: reject writes nothing", async () => {
    const h = await harness(withAmendment(TEMPLATE_B));
    const res = await post(h, url, {
      amendment_id: `amend-${ID}`,
      decision: "reject",
      rationale: "the current chart is fine",
    });

    expect(res.status).toBe(200);
    expect(res.json.decision).toBe("reject");
    expect(res.json.template_memory_id).toBeNull();
    expect(res.json.structure_hash).toBeNull();
    // One append, and it is the decision — never a template.
    expect(h.orange.appends).toHaveLength(1);
    expect(JSON.parse(h.orange.appends[0]!.body!).labels.kind).toBe("report-amendment");

    const frame = await get(h, FRAME);
    expect(frame.csp).toBe(CSP_A);
  });

  it("report_amendment: accept records the HUMAN's rationale as a decision row", async () => {
    const h = await harness(withAmendment(TEMPLATE_B));
    const res = await post(h, url, {
      amendment_id: `amend-${ID}`,
      decision: "accept",
      rationale: "the second axis is worth it",
    });

    expect(res.status).toBe(200);
    // TWO appends: the template, then the decision. The order is deliberate —
    // a decision row for a template that was never locked is a lie about
    // state; a template with no decision row is merely repeatable.
    expect(h.orange.appends).toHaveLength(2);
    expect(res.json.decision_memory_id).toBe("appended-2");

    const decision = JSON.parse(h.orange.appends[1]!.body!);
    expect(decision.labels).toEqual({
      kind: "report-amendment",
      name: ID,
      status: "accepted",
      // 🔴 WHICH proposal was decided, as a LABEL — the only form a selector
      // can see, and therefore the only form an "already decided" check can
      // be built from.
      amendment: `amend-${ID}`,
    });
    // Line 1 is the rationale; the body is empty.
    expect(decision.content).toBe("the second axis is worth it\n");
    // Wolf's own credential writes it, so provenance is empty — the row could
    // not have come from inside a container.
    expect(decision).not.toHaveProperty("created_by_worker");
  });

  it("report_amendment: reject records the rationale too, and writes NO template", async () => {
    const h = await harness(withAmendment(TEMPLATE_B));
    const res = await post(h, url, {
      amendment_id: `amend-${ID}`,
      decision: "reject",
      rationale: "the current chart is fine",
    });

    expect(res.status).toBe(200);
    expect(h.orange.appends).toHaveLength(1);
    const decision = JSON.parse(h.orange.appends[0]!.body!);
    expect(decision.labels).toEqual({
      kind: "report-amendment",
      name: ID,
      status: "rejected",
      amendment: `amend-${ID}`,
    });
    expect(decision.content).toBe("the current chart is fine\n");
    expect(res.json.decision_memory_id).toBe("appended-1");
    // And no template was locked by it.
    expect(decision.labels.kind).not.toBe("report-template");
  });

  it("report_amendment: a DECISION row cannot itself be decided", async () => {
    // A decision is a `kind=report-amendment` row, so it comes back in the
    // same selector as the proposals. Without the status guard a caller could
    // "accept" one, and its empty body would surface as a 422 about invalid
    // HTML rather than as what it is.
    const h = await harness(withAmendment(TEMPLATE_B));
    const first = await post(h, url, {
      amendment_id: `amend-${ID}`,
      decision: "reject",
      rationale: "no thanks",
    });
    expect(first.status).toBe(200);

    const again = await post(h, url, {
      amendment_id: first.json.decision_memory_id,
      decision: "accept",
      rationale: "actually yes",
    });

    expect(again.status).toBe(409);
    expect(again.json.kind).toBe("conflict");
    expect(again.json.details.status).toBe("rejected");
    // Still exactly the one decision row from the first call.
    expect(h.orange.appends).toHaveLength(1);
  });

  it("report_amendment: a failed proposal writes NO row at all, not even a decision", async () => {
    const h = await harness(withAmendment("<p>no slot, no fallback</p>"));
    const res = await post(h, url, {
      amendment_id: `amend-${ID}`,
      decision: "accept",
      rationale: "trust me",
    });

    expect(res.status).toBe(422);
    // The decision is written only on a path that reached a decision. A
    // rejected-by-the-validator proposal is not a human's decision.
    expect(h.orange.appends).toHaveLength(0);
  });

  it("report_amendment: an unknown amendment id is 404, and nothing is written", async () => {
    const h = await harness(withAmendment(TEMPLATE_B));
    const res = await post(h, url, {
      amendment_id: "amend-someone-elses",
      decision: "accept",
      rationale: "…",
    });

    expect(res.status).toBe(404);
    expect(res.json.kind).toBe("not_found");
    expect(h.orange.appends).toHaveLength(0);
  });

  it("report_amendment: another hypothesis's amendment id is 404, not adopted", async () => {
    const h = await harness((orange) => {
      seeded(orange);
      orange.hypothesis(ID_B);
      orange.amendment(ID_B, TEMPLATE_B, "amend-other");
    });
    const res = await post(h, url, {
      amendment_id: "amend-other",
      decision: "accept",
      rationale: "…",
    });

    // The selector is `kind=report-amendment,name=<id>`, so a row belonging to
    // another hypothesis is not in the candidate set at all.
    expect(res.status).toBe(404);
    expect(h.orange.appends).toHaveLength(0);
  });

  it("report_amendment: an EMPTY rationale is refused, and nothing is written", async () => {
    // 🔴 Under ruling 1 the rationale is line 1 of a durable decision memory,
    // not a log line. Dropping this guard writes a permanent record that a
    // human decided with no reason, on the one row the design points to as
    // "agent proposes, human decides".
    const h = await harness(withAmendment(TEMPLATE_B));
    const empty = await post(h, url, {
      amendment_id: `amend-${ID}`,
      decision: "accept",
      rationale: "",
    });

    // The append assertion FIRST: it is the load-bearing one, and putting a
    // shape-dependent assertion above it made a mutation die on a TypeError
    // inside the assertion rather than on the assertion (R146, round 3).
    expect(h.orange.appends).toHaveLength(0);
    expect(empty.status).toBe(400);
    expect(empty.json.kind).toBe("invalid");
    const emptyErrors = (empty.json.details?.errors ?? []) as { path: string }[];
    expect(emptyErrors.some((e) => e.path === "rationale")).toBe(true);

    // 🔴 Whitespace is refused AT THE EDGE, before the first write.
    //
    // The `appends` assertion below is the whole test and it was missing: the
    // two status assertions passed while a template had ALREADY BEEN LOCKED,
    // because `z.string().min(1)` accepts "   " and the only refusal came
    // from `buildLineAndBody` — which, under template-first ordering, throws
    // AFTER `appendMemory(template)`. A 400 whose request took effect. The
    // comment here previously claimed whitespace "gets no further", which was
    // false, and the assertion that would have caught it was four lines above
    // in the empty-string half and absent here (R133, fix round 3).
    const blank = await post(h, url, {
      amendment_id: `amend-${ID}`,
      decision: "accept",
      rationale: "   ",
    });
    expect(blank.status).toBe(400);
    expect(blank.json.kind).toBe("invalid");
    expect(h.orange.appends).toHaveLength(0);
  });

  it("report_amendment: an unknown decision is a 400 invalid body", async () => {
    const h = await harness(withAmendment(TEMPLATE_B));
    const res = await post(h, url, {
      amendment_id: `amend-${ID}`,
      decision: "maybe",
      rationale: "…",
    });

    expect(res.status).toBe(400);
    expect(res.json.kind).toBe("invalid");
    expect(h.orange.appends).toHaveLength(0);
  });

  it("report_amendment: a decided proposal cannot be decided AGAIN", async () => {
    const h = await harness(withAmendment(TEMPLATE_B));
    const body = {
      amendment_id: `amend-${ID}`,
      decision: "accept" as const,
      rationale: "the second axis is worth it",
    };

    expect((await post(h, url, body)).status).toBe(200);
    const replay = await post(h, url, body);

    expect(replay.status).toBe(409);
    expect(replay.json.kind).toBe("conflict");
    expect(replay.json.details.decided_as).toBe("accepted");
    // Two appends from the first call (template + decision) and nothing from
    // the second.
    expect(h.orange.appends).toHaveLength(2);
  });

  it("report_amendment: a REPLAYED accept cannot revert a template a later review superseded", async () => {
    // The defect in full: accept B, accept C, re-accept B. Without the
    // already-decided guard the third call answers 200 and the frame serves
    // B's template again — with a fresh `status: accepted` row asserting a
    // human chose it, after a human had already chosen C.
    const h = await harness((orange) => {
      seeded(orange);
      orange.amendment(ID, TEMPLATE_B, "amend-b");
      orange.amendment(ID, TEMPLATE_C, "amend-c");
    });

    expect(
      (await post(h, url, { amendment_id: "amend-b", decision: "accept", rationale: "b" })).status,
    ).toBe(200);
    expect(
      (await post(h, url, { amendment_id: "amend-c", decision: "accept", rationale: "c" })).status,
    ).toBe(200);
    expect((await get(h, FRAME)).csp).toBe(CSP_C);

    const replay = await post(h, url, {
      amendment_id: "amend-b",
      decision: "accept",
      rationale: "b again",
    });

    expect(replay.status).toBe(409);
    // And the frame still carries C, the template the last human review chose.
    expect((await get(h, FRAME)).csp).toBe(CSP_C);
  });

  it("report_amendment: reject-after-reject blocks — a human does not decide twice", async () => {
    const h = await harness(withAmendment(TEMPLATE_B));
    const body = { amendment_id: `amend-${ID}`, decision: "reject" as const, rationale: "no" };
    expect((await post(h, url, body)).status).toBe(200);

    const again = await post(h, url, { ...body, rationale: "still no" });

    expect(again.status).toBe(409);
    expect(again.json.details.decided_as).toBe("rejected");
    expect(h.orange.appends).toHaveLength(1);
  });

  it("report_amendment: reject-after-accept blocks — a reject cannot undo a lock", async () => {
    // A reject writes no template, so it cannot revert one. Allowing it would
    // produce a record implying it did.
    const h = await harness(withAmendment(TEMPLATE_B));
    expect(
      (await post(h, url, { amendment_id: `amend-${ID}`, decision: "accept", rationale: "yes" }))
        .status,
    ).toBe(200);

    const undo = await post(h, url, {
      amendment_id: `amend-${ID}`,
      decision: "reject",
      rationale: "actually no",
    });

    expect(undo.status).toBe(409);
    expect(undo.json.details.decided_as).toBe("accepted");
    // The template it locked is still what the frame serves.
    expect((await get(h, FRAME)).csp).toBe(CSP_B);
  });

  it("report_amendment: the 409 NAMES the way forward, with when it was decided", async () => {
    // accept-after-reject is the one blocked case where the human is doing
    // something legitimate. An append-only log cannot express un-reject, so
    // the exit is a fresh proposal — and a wall with no signposted exit is
    // what produces someone "fixing" the guard.
    const h = await harness(withAmendment(TEMPLATE_B));
    const rejected = await post(h, url, {
      amendment_id: `amend-${ID}`,
      decision: "reject",
      rationale: "not in March",
    });
    expect(rejected.status).toBe(200);

    const later = await post(h, url, {
      amendment_id: `amend-${ID}`,
      decision: "accept",
      rationale: "circumstances changed",
    });

    expect(later.status).toBe(409);
    expect(later.json.message).toContain("propose a new");
    expect(later.json.details.next).toBe("propose a new report-amendment");
    expect(later.json.details.decided_as).toBe("rejected");
    expect(typeof later.json.details.decided_at_ms).toBe("number");
    expect(later.json.details.decided_at_ms).toBeGreaterThan(0);
  });

  it("report_amendment: a hostile retraction cannot erase a decision and re-open the replay", async () => {
    // Wolf never retracts a decision, so any retraction of one came from
    // inside a container. Without `include_retracted=1` on the decision query
    // Orange would filter it server-side and the replay guard would silently
    // stop firing.
    const h = await harness(withAmendment(TEMPLATE_B));
    const first = await post(h, url, {
      amendment_id: `amend-${ID}`,
      decision: "accept",
      rationale: "yes",
    });
    expect(first.status).toBe(200);
    h.orange.retractHostilely(first.json.decision_memory_id);

    const replay = await post(h, url, {
      amendment_id: `amend-${ID}`,
      decision: "accept",
      rationale: "yes again",
    });

    expect(replay.status).toBe(409);
    expect(replay.json.details.decided_as).toBe("accepted");
  });

  it("report_amendment: a retry after a PARTIAL write is allowed, and is benign", async () => {
    // 🔴 The one interaction between the template-first ordering and the
    // replay guard, and the reason the guard must be a QUERY over decision
    // rows rather than a flag on the proposal. If the decision append fails
    // after the template landed, no decision row exists — so the human may
    // decide again, which is exactly what template-first was chosen to allow.
    const h = await harness(withAmendment(TEMPLATE_B));
    h.orange.failAppendWhere = (labels) => labels["kind"] === "report-amendment";

    const partial = await post(h, url, {
      amendment_id: `amend-${ID}`,
      decision: "accept",
      rationale: "first try",
    });
    // The template landed; the decision did not, and the caller is told the
    // upstream failed rather than that the decision stands.
    expect(partial.status).toBe(503);
    expect(partial.json.kind).toBe("unavailable");
    expect(h.orange.appends.filter((r) => r.body!.includes("report-template"))).toHaveLength(1);

    h.orange.failAppendWhere = undefined;
    const retry = await post(h, url, {
      amendment_id: `amend-${ID}`,
      decision: "accept",
      rationale: "second try",
    });

    // NOT a 409.
    expect(retry.status).toBe(200);
    expect(retry.json.structure_hash).toBe(hashOf(TEMPLATE_B));

    // Two template rows now exist, with identical bytes and the same hash, so
    // the newest-first read serves the same document either way — benign.
    const templates = h.orange.appends.filter((r) => r.body!.includes('"report-template"'));
    expect(templates).toHaveLength(2);
    expect(JSON.parse(templates[0]!.body!).content).toBe(JSON.parse(templates[1]!.body!).content);
    // Four append REQUESTS in total: two templates, the decision that failed
    // with a 503, and the decision that succeeded.
    expect(h.orange.appends).toHaveLength(4);
    expect((await get(h, FRAME)).csp).toBe(CSP_B);

    // And now it IS decided, so a third attempt is refused.
    const third = await post(h, url, {
      amendment_id: `amend-${ID}`,
      decision: "accept",
      rationale: "third try",
    });
    expect(third.status).toBe(409);
  });

  it("report_amendment: a rejected proposal cannot then be accepted", async () => {
    const h = await harness(withAmendment(TEMPLATE_B));
    expect(
      (await post(h, url, { amendment_id: `amend-${ID}`, decision: "reject", rationale: "no" }))
        .status,
    ).toBe(200);

    const flip = await post(h, url, {
      amendment_id: `amend-${ID}`,
      decision: "accept",
      rationale: "on reflection",
    });

    expect(flip.status).toBe(409);
    expect(flip.json.details.decided_as).toBe("rejected");
    expect(h.orange.appends).toHaveLength(1);
  });

  it("report_amendment: an amendment_id that cannot be a label value is a 400, never a selector term", async () => {
    // 🔴 The id is interpolated into `…,amendment=<id>`. A comma would ADD a
    // term, and since selector terms are ANDed the already-decided query would
    // match nothing — silently re-opening the guard above. Refused at the edge.
    const h = await harness(withAmendment(TEMPLATE_B));
    const res = await post(h, url, {
      amendment_id: `amend-${ID},kind=nonsense`,
      decision: "accept",
      rationale: "…",
    });

    expect(res.status).toBe(400);
    expect(res.json.kind).toBe("invalid");
    expect(res.json.details.errors[0].path).toBe("amendment_id");
    expect(h.orange.requests).toHaveLength(0);
  });

  it("report_amendment: finds a proposal a single 50-row page would have lost", async () => {
    // The kind now carries decisions as well as proposals, so the page fills
    // at twice the old rate; the old scan took ONE page of 50 and 404ed a
    // legitimate id that had fallen off the end. The id read cannot overflow.
    const h = await harness((orange) => {
      seeded(orange);
      orange.amendment(ID, TEMPLATE_B, "amend-old");
      for (let i = 0; i < 60; i += 1) {
        orange.amendment(ID, TEMPLATE_B, `amend-noise-${i}`);
      }
    });

    const res = await post(h, url, {
      amendment_id: "amend-old",
      decision: "accept",
      rationale: "the oldest proposal is still a proposal",
    });

    expect(res.status).toBe(200);
    // Read by id, not scanned: the row came from `/agent/memories/<id>`.
    expect(h.orange.paths("/agent/memories/amend-old")).toHaveLength(1);
  });

  it("report_amendment: 401 with no cookie, and NOT ONE upstream request", async () => {
    const h = await harness(withAmendment(TEMPLATE_B));
    const res = await post(
      h,
      url,
      { amendment_id: `amend-${ID}`, decision: "accept", rationale: "…" },
      false,
    );

    expect(res.status).toBe(401);
    expect(h.orange.requests).toHaveLength(0);
  });
});

/* ================================================================== */
/* GET …/report-candidate — the read W24 needs and nothing had (R206)  */
/* ================================================================== */

/**
 * W24 — the go-live review screen's read.
 *
 * `kind=report-candidate` had a WRITER and no READER for nine tickets, and
 * this route is the first consumer. Two things it must get right, and both
 * are here because getting them wrong is invisible:
 *
 *  1. 🔴 **The trust rule.** A candidate is written from INSIDE a container,
 *     so `isTrusted` cannot be the rule (every legitimate one has non-empty
 *     provenance). The rule is W22's `isOwnReport`: the row's provenance
 *     names THIS hypothesis's researcher worker or its `hyp-<id>` session, or
 *     it is a `cross_hypothesis_write`. A screen that renders a forged
 *     candidate for a human to approve is the worst possible place to skip it
 *     — the human's click LOCKS the template.
 *  2. 🔴 **`script_srcs` is not the set that reaches `script-src`.** It is the
 *     raw URL list in document order, and it is not https-only. Labelling it
 *     "permitted script origins" would be lying to the approving human, so
 *     the route carries BOTH: the raw list and `code_origins`, derived by
 *     `frame.ts`'s own `codeOrigins()` rather than by a third mapping.
 */

const candidateUrl = (id: string): string => `/api/hypotheses/${id}/report-candidate`;
const CANDIDATE = candidateUrl(ID);
const CANDIDATE_FRAME = `${CANDIDATE}/frame`;

/** A candidate the interview wrote: one script, one image, one slot. */
const CANDIDATE_HTML =
  `${FALLBACK}<script src="https://cdn-a.example/chart.js"></script>` +
  `<img src="https://img-b.example/logo.png">` +
  `<section data-wolf-slot="analysis">placeholder</section>`;

/**
 * A candidate whose only remote URL is an IMAGE — the criterion's own case.
 * `scriptSrcs` is EMPTY and the host appears only in `remoteOrigins`, so a
 * screen listing script URLs alone would show the human nothing at all.
 */
const CANDIDATE_IMG_ONLY =
  `${FALLBACK}<img src="https://evil.example/px.gif?d=1">` +
  `<section data-wolf-slot="analysis">placeholder</section>`;

/**
 * A candidate whose CSS `@import` names a `data:` URL. It validates clean and
 * lands in `scriptSrcs`, while `new URL("data:…").origin` is the four
 * characters `null` — a HOST NAME in a CSP, not the keyword `'none'` — so it
 * must not reach `code_origins` (R155, measured by W19).
 */
const CANDIDATE_DATA_IMPORT =
  `${FALLBACK}<style>@import url(data:text/css,x);</style>` +
  `<script src="https://cdn-a.example/chart.js"></script>` +
  `<section data-wolf-slot="analysis">placeholder</section>`;

/** Adds a candidate to whatever else the seed built. */
function withCandidate(
  html: string,
  opts: {
    memoryId?: string;
    worker?: string;
    session?: string;
    summary?: string;
    atMs?: number;
  } = {},
): (orange: FakeOrange) => void {
  return (orange) => {
    seeded(orange);
    orange.candidate(ID, html, opts);
  };
}

describe("report_candidate", () => {
  it("report_candidate: serves the newest candidate's html, summary and provenance", async () => {
    const h = await harness((orange) => {
      seeded(orange);
      orange.candidate(ID, TEMPLATE_B, { memoryId: "cand-old", summary: "the first attempt" });
      orange.candidate(ID, CANDIDATE_HTML, { memoryId: "cand-new", summary: "a chart of the basket" });
    });

    const res = await get(h, CANDIDATE);

    expect(res.status).toBe(200);
    expect(res.json.memory_id).toBe("cand-new");
    expect(res.json.summary).toBe("a chart of the basket");
    expect(res.json.html).toBe(CANDIDATE_HTML);
    expect(res.json.created_by_session).toBe(`sess-hyp-${ID}`);
    expect(res.json.valid).toBe(true);
    expect(res.json.tamper).toEqual([]);
  });

  it("report_candidate: carries created_at_ms — unix MILLISECONDS, from the row", async () => {
    // N7: the field was on the wire and asserted nowhere, so zeroing it
    // survived. It is the memory table's unit (milliseconds), NOT the
    // `agent_*` tables' seconds, and the screen renders it as the "when" of
    // the § 2 provenance stamp.
    const h = await harness(withCandidate(CANDIDATE_HTML, { atMs: 1_787_334_047_123 }));

    const res = await get(h, CANDIDATE);

    expect(res.json.created_at_ms).toBe(1_787_334_047_123);
  });

  it("report_candidate: carries BOTH provenance fields, distinctly", async () => {
    // 🔴 A DISCRIMINATING fixture (R146, N6). Every other candidate fixture
    // leaves the worker empty, so the two fields could be swapped, or one
    // copied into the other, with nothing failing — and the UI's stamp is
    // `worker || session`, so a swap silently changes who a human is told
    // wrote the template they are about to lock.
    const h = await harness(
      withCandidate(CANDIDATE_HTML, {
        worker: `researcher-${ID}`,
        session: "sess-tick-4f2a",
      }),
    );

    const res = await get(h, CANDIDATE);

    expect(res.json.created_by_worker).toBe(`researcher-${ID}`);
    expect(res.json.created_by_session).toBe("sess-tick-4f2a");
  });

  it("report_candidate: reads the FULL row, not the 500-character snippet", async () => {
    // Orange's list route returns `substring(content, 1, 500)`. A template
    // routinely runs to tens of kilobytes, so a route reading `snippet` would
    // serve a truncated document that still passed every other assertion here
    // — and the human would approve, and lock, half a template.
    const padding = "<p>x</p>".repeat(200);
    const long = `${FALLBACK}${padding}<section data-wolf-slot="analysis">placeholder</section>`;
    expect(long.length).toBeGreaterThan(500);
    const h = await harness(withCandidate(long));

    const res = await get(h, CANDIDATE);

    expect(res.status).toBe(200);
    expect(res.json.html).toBe(long);
  });

  it("report_candidate: 404 not_found with reason no_report_candidate when the interview wrote none", async () => {
    const h = await harness();

    const res = await get(h, CANDIDATE);

    expect(res.status).toBe(404);
    expect(res.json.kind).toBe("not_found");
    expect(res.json.details.reason).toBe("no_report_candidate");
    expect(res.json.details.id).toBe(ID);
    // The empty state, not an attack: nothing was witnessed on the way.
    expect(res.json.details.tamper).toEqual([]);
  });

  it("report_candidate: 404 for a hypothesis that is not in the session index", async () => {
    // 🔴 The provenance here WOULD satisfy `isOwnReport` — `researcher-<ID_B>`
    // is clause 1 — so the only thing that can refuse this row is the
    // session-index check. An earlier version of this test used a row the
    // trust rule rejected anyway and passed with the check deleted (found by
    // a surviving mutation, A16). The session list is the authoritative index
    // of hypotheses, never memory.
    const h = await harness((orange) => {
      seeded(orange);
      orange.candidate(ID_B, CANDIDATE_HTML, { worker: `researcher-${ID_B}`, session: "" });
    });

    const res = await get(h, candidateUrl(ID_B));

    expect(res.status).toBe(404);
    expect(res.json.kind).toBe("not_found");
    expect(res.json.message).toBe(`no hypothesis ${ID_B}`);
    // NOT the "no candidate" 404: this id is not a hypothesis at all.
    expect(res.json.details.reason).toBeUndefined();
  });

  it("report_candidate_frame: 404 for a hypothesis that is not in the session index", async () => {
    // The same guard on the frame route. Two routes, two proofs — a guard
    // tested on one of a pair is the guard that goes missing from the other.
    const h = await harness((orange) => {
      seeded(orange);
      orange.candidate(ID_B, CANDIDATE_HTML, { worker: `researcher-${ID_B}`, session: "" });
    });

    const res = await get(h, `${candidateUrl(ID_B)}/frame`);

    expect(res.status).toBe(404);
    expect(res.json.kind).toBe("not_found");
    expect(res.json.message).toBe(`no hypothesis ${ID_B}`);
    // NOT the "no candidate" 404: this id is not a hypothesis at all.
    expect(res.json.details.reason).toBeUndefined();
  });

  it("report_candidate: 400 invalid for an id that is not 8 lowercase hex characters", async () => {
    const h = await harness();

    const res = await get(h, "/api/hypotheses/hyp-1a2b3c4d/report-candidate");

    expect(res.status).toBe(400);
    expect(res.json.kind).toBe("invalid");
  });

  it("report_candidate: 401 with no cookie, and NOT ONE upstream request", async () => {
    const h = await harness(withCandidate(CANDIDATE_HTML));

    const res = await get(h, CANDIDATE, false);

    expect(res.status).toBe(401);
    expect(h.orange.requests).toHaveLength(0);
  });
});

describe("report_candidate_urls", () => {
  it("report_candidate_urls: script_srcs are the RAW urls in document order, never origins", async () => {
    const html =
      `${FALLBACK}<link rel="stylesheet" href="https://cdn-z.example/late.css">` +
      `<script src="https://cdn-a.example/chart.js?v=2"></script>` +
      `<section data-wolf-slot="analysis">placeholder</section>`;
    const h = await harness(withCandidate(html));

    const res = await get(h, CANDIDATE);

    // Document order, full URLs including the query string — an origin list
    // would have collapsed both to two bare hosts and lost `?v=2`.
    expect(res.json.script_srcs).toEqual([
      "https://cdn-z.example/late.css",
      "https://cdn-a.example/chart.js?v=2",
    ]);
  });

  it("report_candidate_urls: a data: url reaches script_srcs and NOT code_origins", async () => {
    const h = await harness(withCandidate(CANDIDATE_DATA_IMPORT));

    const res = await get(h, CANDIDATE);

    expect(res.json.script_srcs).toContain("data:text/css,x");
    // `new URL("data:…").origin` is the literal four characters `null`, which
    // in a CSP is a host name. It must never be presented as an approved
    // code origin.
    expect(res.json.code_origins).toEqual(["https://cdn-a.example"]);
    expect(res.json.code_origins).not.toContain("null");
  });

  it("report_candidate_urls: an IMG host appears in remote_origins though script_srcs is empty", async () => {
    // The whole reason revision 5 added `remoteOrigins` to this screen: a
    // template that exfiltrates through an image URL was approved by a human
    // who never saw the host.
    const h = await harness(withCandidate(CANDIDATE_IMG_ONLY));

    const res = await get(h, CANDIDATE);

    expect(res.json.script_srcs).toEqual([]);
    expect(res.json.code_origins).toEqual([]);
    expect(res.json.remote_origins).toEqual(["https://evil.example"]);
  });

  it("report_candidate_urls: code_origins is a SUBSET of remote_origins and may equal it", async () => {
    // § 6b's "subset", corrected from "strict subset": for a template whose
    // only remote URL is a `<script src>` the two sets are EQUAL and W24's
    // "everything else" difference is empty. That is the common case and it
    // is not an error.
    const h = await harness(withCandidate(TEMPLATE_A));

    const res = await get(h, CANDIDATE);

    expect(res.json.code_origins).toEqual(["https://cdn-a.example"]);
    expect(res.json.remote_origins).toEqual(["https://cdn-a.example"]);
  });

  it("report_candidate_urls: both lists together for a template with code AND an image host", async () => {
    const h = await harness(withCandidate(CANDIDATE_HTML));

    const res = await get(h, CANDIDATE);

    expect(res.json.script_srcs).toEqual(["https://cdn-a.example/chart.js"]);
    expect(res.json.code_origins).toEqual(["https://cdn-a.example"]);
    // Sorted and deduplicated by `parseTemplate`; the image host is here and
    // in neither of the two lists above.
    expect(res.json.remote_origins).toEqual(["https://cdn-a.example", "https://img-b.example"]);
  });

  it("report_candidate_urls: a candidate that does not validate answers valid:false with the errors", async () => {
    // A missing `[data-wolf-fallback]` is the model's mistake, not the
    // caller's and not Wolf's stored state: the human is shown what is wrong
    // rather than an error page, and the accept button has nothing to post.
    const broken = `<section data-wolf-slot="analysis">placeholder</section>`;
    const h = await harness(withCandidate(broken));

    const res = await get(h, CANDIDATE);

    expect(res.status).toBe(200);
    expect(res.json.valid).toBe(false);
    expect(res.json.errors.length).toBeGreaterThan(0);
    expect(res.json.errors.every((e: any) => typeof e.path === "string")).toBe(true);
    expect(res.json.structure_hash).toBeNull();
    expect(res.json.script_srcs).toEqual([]);
    expect(res.json.remote_origins).toEqual([]);
    expect(res.json.code_origins).toEqual([]);
    // The bytes still come back: the screen shows the human what was proposed.
    expect(res.json.html).toBe(broken);
  });

  it("report_candidate_urls: the html round-trips into POST …/report-template unchanged", async () => {
    // The accept button posts exactly these bytes back. If the read normalised
    // the HTML in any way the hash the human approved and the hash Wolf locked
    // would differ, silently.
    // No locked template in this seed: the accept POST must succeed, which is
    // the state the review screen is actually in.
    const h = await harness((orange) => {
      orange.hypothesis(ID);
      orange.spec(ID);
      orange.candidate(ID, CANDIDATE_HTML);
    });

    const read = await get(h, CANDIDATE);
    const locked = await post(h, `/api/hypotheses/${ID}/report-template`, {
      html: read.json.html,
    });

    expect(locked.status).toBe(201);
    // The bytes the human approved and the bytes Wolf locked hash the same.
    expect(locked.json.structure_hash).toBe(read.json.structure_hash);
    expect(locked.json.structure_hash).toBe(
      createHash("sha256").update(CANDIDATE_HTML, "utf8").digest("hex"),
    );
    expect(locked.json.script_srcs).toEqual(read.json.script_srcs);
    expect(locked.json.remote_origins).toEqual(read.json.remote_origins);
  });
});

describe("report_candidate_trust", () => {
  it("report_candidate_trust: a candidate from ANOTHER hypothesis's session is not served", async () => {
    const h = await harness((orange) => {
      seeded(orange);
      orange.hypothesis(ID_B);
      // Labelled `name=<ID>` but written from B's session: a well-formed row
      // in the right kind with another hypothesis's name on it.
      orange.candidate(ID, CANDIDATE_IMG_ONLY, {
        memoryId: "cand-forged",
        worker: `researcher-${ID_B}`,
        session: `sess-hyp-${ID_B}`,
      });
    });

    const res = await get(h, CANDIDATE);

    expect(res.status).toBe(404);
    expect(res.json.kind).toBe("not_found");
    // The SAME 404 shape as the empty state — this is not a different route —
    // and the tamper is the only thing that distinguishes the two.
    expect(res.json.details.reason).toBe("no_report_candidate");
    expect(res.json.details.id).toBe(ID);
    // 🔴 Named, never silently dropped: the human must be told an attack was
    // witnessed rather than shown a benign "no candidate yet".
    expect(res.json.details.tamper).toEqual([
      {
        reason: "cross_hypothesis_write",
        written_by_worker: `researcher-${ID_B}`,
        written_by_session: `sess-hyp-${ID_B}`,
        memory_id: "cand-forged",
      },
    ]);
  });

  it("report_candidate_trust: a NEWER forged candidate does not displace this hypothesis's own", async () => {
    const h = await harness((orange) => {
      seeded(orange);
      orange.hypothesis(ID_B);
      orange.candidate(ID, CANDIDATE_HTML, { memoryId: "cand-mine" });
      orange.candidate(ID, CANDIDATE_IMG_ONLY, {
        memoryId: "cand-forged",
        worker: `researcher-${ID_B}`,
        session: `sess-hyp-${ID_B}`,
      });
    });

    const res = await get(h, CANDIDATE);

    expect(res.status).toBe(200);
    expect(res.json.memory_id).toBe("cand-mine");
    expect(res.json.html).toBe(CANDIDATE_HTML);
    expect(res.json.tamper).toEqual([
      {
        reason: "cross_hypothesis_write",
        written_by_worker: `researcher-${ID_B}`,
        written_by_session: `sess-hyp-${ID_B}`,
        memory_id: "cand-forged",
      },
    ]);
  });

  it("report_candidate_trust: this hypothesis's own RESEARCHER worker also owns a candidate", async () => {
    // Clause 1 of `isOwnReport`. The interviewer normally writes the
    // candidate from the session; the researcher may propose one too.
    const h = await harness((orange) => {
      seeded(orange);
      orange.candidate(ID, CANDIDATE_HTML, {
        memoryId: "cand-researcher",
        worker: `researcher-${ID}`,
        session: "sess-tick-4f2a",
      });
    });

    const res = await get(h, CANDIDATE);

    expect(res.status).toBe(200);
    expect(res.json.memory_id).toBe("cand-researcher");
    expect(res.json.tamper).toEqual([]);
  });

  it("report_candidate_trust: an unattributed candidate is NOT owned", async () => {
    // `""` is what Orange stamps when there is no worker and no session.
    // Comparing it to an absent owner value would make an unattributed row
    // look owned — the failure `isOwnReport` guards against explicitly.
    const h = await harness((orange) => {
      seeded(orange);
      orange.candidate(ID, CANDIDATE_HTML, {
        memoryId: "cand-nobody",
        worker: "",
        session: "",
      });
    });

    const res = await get(h, CANDIDATE);

    expect(res.status).toBe(404);
    expect(res.json.kind).toBe("not_found");
    expect(res.json.details.reason).toBe("no_report_candidate");
    expect(res.json.details.id).toBe(ID);
    expect(res.json.details.tamper).toEqual([
      {
        reason: "cross_hypothesis_write",
        written_by_worker: "",
        written_by_session: "",
        memory_id: "cand-nobody",
      },
    ]);
  });

  it("report_candidate_trust: a HOSTILE retraction does not hide the candidate", async () => {
    const h = await harness((orange) => {
      seeded(orange);
      orange.candidate(ID, CANDIDATE_HTML, { memoryId: "cand-mine" });
      orange.retractHostilely("cand-mine");
    });

    const res = await get(h, CANDIDATE);

    expect(res.status).toBe(200);
    expect(res.json.memory_id).toBe("cand-mine");
    expect(res.json.tamper).toEqual([
      {
        reason: "hostile_retraction",
        written_by_worker: "researcher-attacker",
        written_by_session: "sess-attacker",
        memory_id: "cand-mine",
      },
    ]);
  });

  it("report_candidate_trust: a retraction WOLF wrote does hide it, and the older one is served", async () => {
    const h = await harness((orange) => {
      seeded(orange);
      orange.candidate(ID, CANDIDATE_HTML, { memoryId: "cand-old" });
      orange.candidate(ID, CANDIDATE_IMG_ONLY, { memoryId: "cand-withdrawn" });
      orange.retractByWolf("cand-withdrawn");
    });

    const res = await get(h, CANDIDATE);

    expect(res.status).toBe(200);
    expect(res.json.memory_id).toBe("cand-old");
    expect(res.json.tamper).toEqual([]);
  });
});

describe("report_candidate_frame", () => {
  it("report_candidate_frame: serves text/html with the DERIVED csp, nosniff and no Set-Cookie", async () => {
    const h = await harness(withCandidate(TEMPLATE_B));

    const res = await get(h, CANDIDATE_FRAME);

    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/html");
    // 🔴 The whole header, byte for byte, and it is the CSP of the CANDIDATE
    // — not of the locked template `seeded` also installed. Reviewing a
    // preview that differs from production defeats the point of the screen.
    expect(res.csp).toBe(CSP_B);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("set-cookie")).toBeNull();
    // A HEADER and only a header: a `<meta http-equiv>` copy silently ignores
    // `sandbox` and `frame-ancestors`, which is what makes direct navigation
    // to this URL safe.
    expect(res.raw).not.toContain("http-equiv");
  });

  it("report_candidate_frame: composes the CANDIDATE, not the locked template", async () => {
    const h = await harness(withCandidate(CANDIDATE_IMG_ONLY));

    const res = await get(h, CANDIDATE_FRAME);

    expect(res.raw).toContain("https://evil.example/px.gif?d=1");
    expect(res.raw).not.toContain("cdn-a.example");
  });

  it("report_candidate_frame: the preview's slots are EMPTY, never yesterday's report", async () => {
    const h = await harness((orange) => {
      seeded(orange);
      orange.report(ID, "yesterday's headline", { analysis: "<p>SENTINEL-TICK-CONTENT</p>" });
      orange.candidate(ID, CANDIDATE_HTML);
    });

    const res = await get(h, CANDIDATE_FRAME);

    expect(res.status).toBe(200);
    // A candidate has never been filled by a tick. Splicing the locked
    // template's slot content into it would show the human data the proposed
    // template did not produce.
    expect(res.raw).not.toContain("SENTINEL-TICK-CONTENT");
  });

  it("report_candidate_frame: 404 not_found when there is no candidate", async () => {
    const h = await harness();

    const res = await get(h, CANDIDATE_FRAME);

    expect(res.status).toBe(404);
    expect(res.json.kind).toBe("not_found");
    expect(res.json.details.reason).toBe("no_report_candidate");
    expect(res.json.details.id).toBe(ID);
    expect(res.json.details.tamper).toEqual([]);
  });

  it("report_candidate_frame: a FORGED candidate is never previewed", async () => {
    // 🔴 D2 — the trust rule, proved ON THIS ROUTE and not only on the read.
    // The check is shared today, but a route that lost `isOwnReport` while
    // the read kept it stayed green: this is the route serving the document
    // a human LOOKS AT before locking a template, so a forgery reaching it is
    // the worst version of the failure, not a lesser one.
    //
    // This is the "two routes, two proofs" rule this file already applies to
    // the session-index guard — applied, in round 1, to the weaker guard of
    // the two and not to this one.
    const h = await harness((orange) => {
      seeded(orange);
      orange.hypothesis(ID_B);
      orange.candidate(ID, CANDIDATE_IMG_ONLY, {
        memoryId: "cand-forged",
        worker: `researcher-${ID_B}`,
        session: `sess-hyp-${ID_B}`,
      });
    });

    const res = await get(h, CANDIDATE_FRAME);

    expect(res.status).toBe(404);
    expect(res.json.kind).toBe("not_found");
    expect(res.json.details.reason).toBe("no_report_candidate");
    expect(res.json.details.id).toBe(ID);
    expect(res.json.details.tamper).toEqual([
      {
        reason: "cross_hypothesis_write",
        written_by_worker: `researcher-${ID_B}`,
        written_by_session: `sess-hyp-${ID_B}`,
        memory_id: "cand-forged",
      },
    ]);
    // 🔴 Not one byte of the forged template was composed.
    expect(res.raw).not.toContain("evil.example");
  });

  it("report_candidate_frame: a NEWER forged candidate does not displace the previewed one", async () => {
    // The other direction, and the reason the rule is a skip rather than a
    // refusal: this hypothesis's own candidate is still previewed, and the
    // attack is named rather than merely suppressed.
    const h = await harness((orange) => {
      seeded(orange);
      orange.hypothesis(ID_B);
      orange.candidate(ID, CANDIDATE_HTML, { memoryId: "cand-mine" });
      orange.candidate(ID, CANDIDATE_IMG_ONLY, {
        memoryId: "cand-forged",
        worker: `researcher-${ID_B}`,
        session: `sess-hyp-${ID_B}`,
      });
    });

    const res = await get(h, CANDIDATE_FRAME);

    expect(res.status).toBe(200);
    expect(res.raw).toContain("cdn-a.example");
    expect(res.raw).not.toContain("evil.example");
    // ⚠️ Deliberately SHORTER than the read's twin above, which also asserts
    // the `tamper` list. This route answers with a DOCUMENT — there is
    // nowhere in `text/html` to carry an anomaly, and putting one there would
    // mean model-authored bytes and Wolf's own warning sharing a body. The
    // screen gets its tamper from the read, which it always performs, and
    // `report_candidate_trust` above is where that list is pinned.
  });

  it("report_candidate_frame: a HOSTILE retraction does not hide the preview either", async () => {
    // The frame must not OVER-refuse: a retraction written from inside a
    // container cannot withdraw the candidate, or an attacker blanks the
    // review screen and the human approves nothing at all.
    const h = await harness((orange) => {
      seeded(orange);
      orange.candidate(ID, CANDIDATE_HTML, { memoryId: "cand-mine" });
      orange.retractHostilely("cand-mine");
    });

    const res = await get(h, CANDIDATE_FRAME);

    expect(res.status).toBe(200);
    expect(res.csp).toBe(
      "sandbox allow-scripts; default-src 'none'; " +
        "script-src 'unsafe-inline' https://cdn-a.example; " +
        "style-src 'unsafe-inline' https://cdn-a.example; " +
        "img-src https://cdn-a.example https://img-b.example data:; " +
        "font-src https://cdn-a.example https://img-b.example data:; " +
        "connect-src 'none'; form-action 'none'; frame-ancestors 'self'; frame-src 'none'; " +
        "child-src 'none'; object-src 'none'; base-uri 'none'; manifest-src 'none'; " +
        "media-src 'none'; worker-src 'none'",
    );
    // The whole header proves the CANDIDATE was composed — it is
    // `CANDIDATE_HTML`'s policy, with both of its hosts — so a retraction
    // written inside a container changed nothing about what is previewed.
    // Same reason as above for carrying no `tamper` assertion: the read is
    // where that list lives.
  });

  it("report_candidate_frame: 422 invalid when the candidate does not validate", async () => {
    const broken = `<section data-wolf-slot="analysis">placeholder</section>`;
    const h = await harness(withCandidate(broken));

    const res = await get(h, CANDIDATE_FRAME);

    // The caller asked to preview a document that cannot be composed. `422`
    // is `invalid` in § "Shared error taxonomy" — never `internal`, which
    // would claim WOLF has the bug when a model wrote a bad template.
    expect(res.status).toBe(422);
    expect(res.json.kind).toBe("invalid");
    expect(res.json.details.errors.length).toBeGreaterThan(0);
  });

  it("report_candidate_frame: 401 with no cookie, and NOT ONE upstream request", async () => {
    const h = await harness(withCandidate(CANDIDATE_HTML));

    const res = await get(h, CANDIDATE_FRAME, false);

    expect(res.status).toBe(401);
    expect(h.orange.requests).toHaveLength(0);
  });

  it("report_candidate_frame: NO credential of any kind reaches the document", async () => {
    // The same claim the locked frame makes, through the REAL app: this
    // document is composed from model-authored bytes and rendered in an
    // opaque origin, and a credential in it would be readable by the script
    // the template carries.
    const h = await realHarness(withCandidate(CANDIDATE_HTML), {
      WOLF_API_KEY: SENTINEL_API_KEY,
      WOLF_MCP_TOKEN: SENTINEL_MCP_TOKEN,
      WOLF_SESSION_SECRET: SENTINEL_SESSION_SECRET,
    });

    const res = await get(h, CANDIDATE_FRAME);

    expect(res.status).toBe(200);
    expect(res.raw).not.toContain(SENTINEL_API_KEY);
    expect(res.raw).not.toContain(SENTINEL_MCP_TOKEN);
    expect(res.raw).not.toContain(SENTINEL_SESSION_SECRET);
    expect(res.raw).not.toContain(EMBED_TOKEN);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
