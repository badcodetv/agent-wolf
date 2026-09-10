import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MockAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
  type Interceptable,
} from "undici";

import { createLogger } from "../logger.js";
import { WolfError } from "../errors.js";
import { createBobClient, type BobClient } from "../bob/client.js";
import { toSec } from "../bob/types.js";
import { createHypothesisStore, slugifyOwner, type HypothesisStore } from "./store.js";
import {
  METHOD_BODY_MARKER,
  SPEC_TOKEN,
  composeResearcherPrompt,
  createProvisioner,
  extractSpecJsonText,
  researcherWorkerFor,
  splitAtMethodMarker,
  type Provisioner,
} from "./provision.js";

// design/2026-08-20-agent-wolf.md, W9's acceptance criteria. Test names are
// prefixed `provision_`.
//
// Orange is mocked with undici's MockAgent (the pinned mechanism), and the
// stub RECORDS EVERY OUTBOUND REQUEST IN ORDER. That is not incidental: two
// of this ticket's criteria are orderings, and a test that asserts a SET of
// calls — "all five happened" — does not gate either of them. It is the exact
// shape of the vacuous test earlier waves were bitten by.
//
// The stub also PERSISTS appended memories, so "the status still reads
// `draft` after a failed go-live" is a real read of what was written rather
// than a restatement of the assertion above it.

const ORANGE = "http://orange.test:4100";
const API_KEY = "wolf-project-api-key-for-tests";
const OWNER = "kai@badcode.dev";
const ID = "1a2b3c4d";
const WORKER = researcherWorkerFor(ID);
const SESSION_ID = "sess-hyp-1a2b3c4d";

function repoFile(relative: string): string {
  return readFileSync(new URL(`../../../${relative}`, import.meta.url), "utf8");
}

const PREAMBLE = repoFile("prompts/researcher-preamble.md");
const METHOD = repoFile("prompts/researcher-method.md");
// `.trim()`: the committed fixture ends with a newline, and the JSON TEXT is
// what travels verbatim into the locked memory and the prompt.
const WORKED_SPEC = readFileSync(
  new URL("./__fixtures__/worked-spec.json", import.meta.url),
  "utf8",
).trim();

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

interface MemoryRow {
  id: string;
  labels: Record<string, string>;
  content: string;
  createdAtMs: number;
  createdByWorker: string;
  createdBySession: string;
}

interface DeliveryRow {
  id: string;
  worker: string;
  status: string;
  /** The tick session this delivery is running in, if any (R112). */
  sessionId?: string;
}

interface StubConfig {
  /** Seeded memories, newest LAST (the stub reverses for the wire). */
  memories?: MemoryRow[];
  schedules?: { id: string; worker: string; cron: string }[];
  /** Successive answers to `GET /agent/deliveries`; the last repeats. */
  deliveries?: DeliveryRow[][];
  /** `researcher-<id>` tick sessions returned by `?worker=`. */
  tickSessions?: string[];
  /** Inject a failure: key is `"<METHOD> <pathPrefix>"`. */
  fail?: Record<string, Answer>;
  /** Omit the `hyp-<id>` session, so the id is not in the trusted index. */
  noSession?: boolean;
}

let nextMemoryId = 0;

function memory(
  labels: Record<string, string>,
  content: string,
  provenance: { worker?: string; session?: string } = {},
): MemoryRow {
  nextMemoryId += 1;
  return {
    id: `mem-${nextMemoryId}`,
    labels,
    content,
    createdAtMs: 1787334047000 + nextMemoryId,
    createdByWorker: provenance.worker ?? "",
    createdBySession: provenance.session ?? "",
  };
}

/**
 * A trusted state row, in the shape `store.buildHypothesisContent` writes:
 * line 1 is the title, then the thesis, then the fenced block that carries
 * the owner's FULL address — which is the only place it can live, since a
 * label value may not contain `@`. `transition` reads that block forward, so
 * a fixture without it produces a synthetic owner slug on the next append.
 */
function stateRow(status: string): MemoryRow {
  return memory(
    { kind: "hypothesis", name: ID, status, owner: slugifyOwner(OWNER) },
    [
      "The petrodollar is ending",
      "",
      "the thesis prose",
      "",
      "```json",
      `{\n  "owner_email": "${OWNER}"\n}`,
      "```",
    ].join("\n"),
  );
}

function draftState(): MemoryRow {
  return stateRow("draft");
}

class Stub {
  readonly requests: Recorded[] = [];
  private deliveryCalls = 0;
  readonly memories: MemoryRow[];
  readonly schedules: { id: string; worker: string; cron: string }[];
  private nextScheduleId = 0;

  constructor(
    private readonly pool: Interceptable,
    private readonly config: StubConfig,
  ) {
    this.memories = [...(config.memories ?? [])];
    this.schedules = [...(config.schedules ?? [])];
  }

  /** Every request that CHANGES something, in the order it was issued. */
  get mutations(): Recorded[] {
    return this.requests.filter(
      (r) =>
        r.method === "DELETE" ||
        r.method === "PUT" ||
        (r.method === "POST" && !r.path.startsWith("/agent/deliveries")),
    );
  }

  get appends(): Recorded[] {
    return this.requests.filter((r) => r.method === "POST" && r.path === "/agent/memories");
  }

  appendedLabels(): Record<string, string>[] {
    return this.appends.map(
      (r) => (JSON.parse(r.body) as { labels: Record<string, string> }).labels,
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
          const answer = this.route(method, new URL(path, ORANGE), body);
          return {
            statusCode: answer.status,
            data: answer.body as never,
            responseOptions: { headers: { "content-type": "application/json" } },
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

  private wireMemory(row: MemoryRow): Record<string, unknown> {
    return {
      id: row.id,
      labels: row.labels,
      content: row.content,
      created_by_worker: row.createdByWorker,
      created_by_session: row.createdBySession,
      created_at: row.createdAtMs,
    };
  }

  private wireSearchRow(row: MemoryRow): Record<string, unknown> {
    return {
      id: row.id,
      labels: row.labels,
      snippet: row.content.slice(0, 500),
      score: 0,
      created_by_worker: row.createdByWorker,
      created_by_session: row.createdBySession,
      created_at: row.createdAtMs,
    };
  }

  private route(method: string, url: URL, body: string): Answer {
    const path = url.pathname;
    const injected = this.injected(method, path);
    if (injected !== undefined) return injected;

    if (path === "/agent/sessions") {
      const worker = url.searchParams.get("worker");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      if (worker === WORKER) {
        const rows = (this.config.tickSessions ?? []).map((id) => ({
          id,
          name: "",
          worker: WORKER,
          status: "running",
          created_at: 1787334311,
          updated_at: 1787334313,
        }));
        return { status: 200, body: JSON.stringify(offset === 0 ? rows : []) };
      }
      const rows =
        this.config.noSession === true
          ? []
          : [
              {
                id: SESSION_ID,
                name: `hyp-${ID}`,
                worker: "interviewer",
                status: "running",
                created_at: 1787334311,
                updated_at: 1787334313,
              },
            ];
      return { status: 200, body: JSON.stringify(offset === 0 ? rows : []) };
    }

    if (path.startsWith("/agent/sessions/by-name/")) {
      return {
        status: 200,
        body: JSON.stringify({ id: SESSION_ID, name: `hyp-${ID}`, status: "running" }),
      };
    }

    if (method === "DELETE" && path.startsWith("/agent/session/")) {
      return { status: 204, body: "" };
    }

    if (method === "POST" && path === "/agent/memories") {
      const parsed = JSON.parse(body) as { labels: Record<string, string>; content: string };
      const row = memory(parsed.labels, parsed.content);
      this.memories.push(row);
      return { status: 201, body: JSON.stringify(this.wireMemory(row)) };
    }

    if (path === "/agent/memories") {
      const selector = url.searchParams.get("selector") ?? "";
      const wanted = Object.fromEntries(
        selector
          .split(",")
          .filter((part) => part.includes("="))
          .map((part) => part.split("=") as [string, string]),
      );
      const rows = this.memories
        .filter((row) => Object.entries(wanted).every(([k, v]) => row.labels[k] === v))
        .slice()
        .reverse()
        .map((row) => this.wireSearchRow(row));
      return { status: 200, body: JSON.stringify({ memories: rows }) };
    }

    if (path.startsWith("/agent/memories/")) {
      const id = decodeURIComponent(path.slice("/agent/memories/".length));
      const row = this.memories.find((m) => m.id === id);
      return row === undefined
        ? { status: 404, body: "memory not found" }
        : { status: 200, body: JSON.stringify(this.wireMemory(row)) };
    }

    if (method === "PUT" && path.startsWith("/agent/workers/")) {
      const parsed = JSON.parse(body) as { system_prompt?: string };
      return {
        status: 200,
        body: JSON.stringify({
          project: "wolf",
          name: WORKER,
          description: "",
          system_prompt: parsed.system_prompt ?? "",
          mcp_config: {},
          image: "",
          max_instances: 1,
          enabled: true,
          frozen: false,
          created_at: 1787334311,
          updated_at: 1787334313,
        }),
      };
    }

    if (method === "GET" && path.startsWith("/agent/workers/")) {
      return { status: 404, body: "no such worker" };
    }

    if (method === "DELETE" && path.startsWith("/agent/workers/")) {
      return { status: 204, body: "" };
    }

    if (method === "POST" && path === "/agent/schedules") {
      this.nextScheduleId += 1;
      const parsed = JSON.parse(body) as { worker?: string; cron?: string };
      const row = {
        id: `sched-${this.nextScheduleId}`,
        worker: parsed.worker ?? "",
        cron: parsed.cron ?? "",
      };
      this.schedules.push(row);
      return {
        status: 201,
        body: JSON.stringify({ ...row, project: "wolf", input: "", enabled: true }),
      };
    }

    if (method === "GET" && path === "/agent/schedules") {
      return {
        status: 200,
        body: JSON.stringify({
          schedules: this.schedules.map((s) => ({
            ...s,
            project: "wolf",
            input: "",
            enabled: true,
          })),
        }),
      };
    }

    if (method === "DELETE" && path.startsWith("/agent/schedules/")) {
      const id = decodeURIComponent(path.slice("/agent/schedules/".length));
      const at = this.schedules.findIndex((s) => s.id === id);
      if (at >= 0) this.schedules.splice(at, 1);
      return { status: 200, body: "{}" };
    }

    if (path === "/agent/deliveries") {
      const pages = this.config.deliveries ?? [[]];
      const all = pages[Math.min(this.deliveryCalls, pages.length - 1)] ?? [];
      this.deliveryCalls += 1;
      // Orange filters on `?status=` server-side, and so does this stub: the
      // drain asks for `pending` only, which is what lets a tick session
      // already RUNNING finish rather than hold teardown up.
      const wantStatus = url.searchParams.get("status");
      const page = wantStatus === null ? all : all.filter((d) => d.status === wantStatus);
      return {
        status: 200,
        body: JSON.stringify({
          deliveries: page.map((d) => ({
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
  pool = mockAgent.get(ORANGE);
});

afterEach(async () => {
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
});

interface Harness {
  stub: Stub;
  client: BobClient;
  store: HypothesisStore;
  provisioner: Provisioner;
}

function harness(
  stubConfig: StubConfig = {},
  overrides: { scheduleCron?: string; teardownDrainSeconds?: number } = {},
): Harness {
  const stub = new Stub(pool, stubConfig);
  stub.install();
  const logger = createLogger({ logLevel: "silent" });
  const client = createBobClient({ baseUrl: ORANGE, apiKey: API_KEY, logger });
  const store = createHypothesisStore({ client, logger });
  // A fake clock, so the drain bound is exercised for real without the test
  // waiting a real minute.
  let clock = 1_000_000;
  const provisioner = createProvisioner({
    client,
    store,
    logger,
    config: {
      scheduleCron: overrides.scheduleCron ?? "0 6 * * *",
      teardownDrainSeconds: overrides.teardownDrainSeconds ?? 60,
    },
    prompts: { preamble: PREAMBLE, methodBody: METHOD },
    drainPollIntervalMs: 1000,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  });
  return { stub, client, store, provisioner };
}

function candidate(json: string = WORKED_SPEC): MemoryRow {
  // Written from inside the interview container, so it carries provenance and
  // is untrusted by construction — W3's validator is the whole gate.
  return memory({ kind: "hypothesis-spec-candidate", name: ID }, `A proposed spec\n${json}`, {
    worker: "interviewer",
    session: "sess-interview",
  });
}

// ── The prompt contract (W12's marker, R93) ─────────────────────────────

describe("provision_prompt_composition", () => {
  it("provision_prompt_composition: the split is LINE-ANCHORED, and the preamble's PROSE mention of the marker stays inside the locked half", () => {
    // The shipped preamble contains the marker twice as a SUBSTRING: once in
    // prose inside backticks near the top, once as the real boundary line. A
    // substring split cuts at the prose occurrence and silently makes most of
    // the locked preamble mutable, with nothing failing anywhere (R93).
    expect(PREAMBLE.split(METHOD_BODY_MARKER)).toHaveLength(3); // i.e. two occurrences
    const wholeLines = PREAMBLE.split("\n").filter((line) => line.trim() === METHOD_BODY_MARKER);
    expect(wholeLines).toHaveLength(1);

    const split = splitAtMethodMarker(PREAMBLE);
    expect(split.locked).toContain(METHOD_BODY_MARKER); // the prose one
    expect(split.locked).toContain("## The locked spec");
    // A naive `indexOf`/substring split would have put everything from the
    // prose mention onwards into the mutable half.
    expect(split.methodBody.trim()).toBe("");
  });

  it("provision_prompt_composition: refuses a prompt whose marker line is missing or duplicated", () => {
    expect(() => splitAtMethodMarker("no marker here")).toThrow(WolfError);
    expect(() =>
      splitAtMethodMarker(`a\n${METHOD_BODY_MARKER}\nb\n${METHOD_BODY_MARKER}\nc`),
    ).toThrow(/exactly once/);
  });

  it("provision_prompt_composition: compose then split is a ROUND TRIP, so an amendment can carry a rewritten method body across", () => {
    const rewritten = "## Method\n\nthe critic rewrote this entirely.\n";
    const prompt = composeResearcherPrompt({
      preambleTemplate: PREAMBLE,
      specJson: WORKED_SPEC,
      methodBody: rewritten,
    });
    expect(splitAtMethodMarker(prompt).methodBody).toBe(rewritten);
    expect(prompt).not.toContain(SPEC_TOKEN);
  });

  it("provision_prompt_composition: a derived metric's method object appears BYTE-FOR-BYTE in the composed prompt", () => {
    const prompt = composeResearcherPrompt({
      preambleTemplate: PREAMBLE,
      specJson: WORKED_SPEC,
      methodBody: METHOD,
    });
    // The whole spec, verbatim — not re-serialised.
    expect(prompt).toContain(WORKED_SPEC);
    // And the `method` object specifically, cut out of the source text so the
    // comparison really is byte-for-byte rather than a re-print of it.
    const start = WORKED_SPEC.indexOf('"method"');
    const end = WORKED_SPEC.indexOf("\n      }", start) + "\n      }".length;
    const methodObject = WORKED_SPEC.slice(start, end);
    expect(methodObject).toContain('"formula": "usd_settled / total_settled * 100"');
    expect(prompt).toContain(methodObject);
  });

  it("provision_prompt_composition: a spec containing $& is substituted literally, not as a replacement pattern", () => {
    const spec = '{"thesis": "$& $\' $1 $$"}';
    const prompt = composeResearcherPrompt({
      preambleTemplate: `above ${SPEC_TOKEN}\n${METHOD_BODY_MARKER}\nbelow`,
      specJson: spec,
      methodBody: "below",
    });
    expect(prompt).toContain(spec);
  });
});

describe("provision_spec_extraction", () => {
  it("provision_spec_extraction: reads the JSON out of all three memory shapes, as TEXT", () => {
    expect(extractSpecJsonText(WORKED_SPEC)).toBe(WORKED_SPEC);
    expect(extractSpecJsonText(`A summary line\n${WORKED_SPEC}`)).toBe(WORKED_SPEC);
    expect(extractSpecJsonText(`A summary\n\n\`\`\`json\n${WORKED_SPEC}\n\`\`\`\nafter`)).toBe(
      WORKED_SPEC,
    );
    expect(extractSpecJsonText("no json at all")).toBeUndefined();
    expect(extractSpecJsonText("{not json}")).toBeUndefined();
  });
});

// ── Go-live ─────────────────────────────────────────────────────────────

describe("provision_go_live", () => {
  it("provision_go_live: writes the four steps in ORDER, with the status=live row LAST", async () => {
    const h = harness({ memories: [draftState(), candidate()] });
    const result = await h.provisioner.goLive({ id: ID, email: OWNER });

    expect(h.stub.mutations.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /agent/memories",
      `PUT /agent/workers/${WORKER}`,
      "POST /agent/schedules",
      "POST /agent/memories",
    ]);

    const labels = h.stub.appendedLabels();
    expect(labels[0]).toEqual({ kind: "hypothesis-spec", name: ID, status: "locked" });
    expect(labels[1]).toMatchObject({ kind: "hypothesis", name: ID, status: "live" });

    // Step 1's content is the candidate JSON VERBATIM.
    expect(JSON.parse(h.stub.appends[0]?.body ?? "{}").content).toBe(WORKED_SPEC);

    expect(result.worker).toBe(WORKER);
    expect(result.schedule_id).toBe("sched-1");
    expect(result.status).toBe("live");
    await expect(h.store.readHypothesis(ID).then((r) => r.status)).resolves.toBe("live");
  });

  it("provision_go_live: the NEWEST candidate wins, whatever its provenance", async () => {
    const older = candidate('{"thesis": "the superseded one"}');
    const newer = candidate();
    // Seeded oldest-first; the stub serves them newest-first, as Orange does.
    const h = harness({ memories: [draftState(), older, newer] });
    await h.provisioner.goLive({ id: ID, email: OWNER });

    expect(JSON.parse(h.stub.appends[0]?.body ?? "{}").content).toBe(WORKED_SPEC);
    expect(JSON.parse(h.stub.appends[0]?.body ?? "{}").content).not.toContain("superseded");
  });

  it("provision_go_live: the worker's system_prompt is locked preamble + spec + method body", async () => {
    const h = harness({ memories: [draftState(), candidate()] });
    await h.provisioner.goLive({ id: ID, email: OWNER });

    const put = h.stub.requests.find((r) => r.method === "PUT");
    const prompt = (JSON.parse(put?.body ?? "{}") as { system_prompt: string }).system_prompt;
    expect(prompt).toContain(WORKED_SPEC);
    expect(prompt).toContain("share of oil trade settled in USD");
    expect(prompt).not.toContain(SPEC_TOKEN);
    // The mutable body is APPENDED AFTER the preamble and is the only part a
    // critic may later rewrite.
    expect(splitAtMethodMarker(prompt).methodBody).toBe(METHOD);
    expect(splitAtMethodMarker(prompt).locked).toContain("## The locked spec");
  });

  it("provision_go_live: the schedule is worker-mode with a 5-FIELD cron, never a nickname", async () => {
    const h = harness({ memories: [draftState(), candidate()] });
    await h.provisioner.goLive({ id: ID, email: OWNER });

    const post = h.stub.requests.find((r) => r.path === "/agent/schedules" && r.method === "POST");
    const parsed = JSON.parse(post?.body ?? "{}") as { worker: string; cron: string };
    expect(parsed.worker).toBe(WORKER);
    expect(parsed.cron).toBe("0 6 * * *");
    expect(parsed.cron.trim().split(/\s+/)).toHaveLength(5);
    expect(parsed.cron).not.toContain("@");
  });

  it("provision_go_live: WOLF_SCHEDULE_CRON is what reaches Orange, so X1 can run * * * * *", async () => {
    const h = harness({ memories: [draftState(), candidate()] }, { scheduleCron: "* * * * *" });
    await h.provisioner.goLive({ id: ID, email: OWNER });
    const post = h.stub.requests.find((r) => r.path === "/agent/schedules" && r.method === "POST");
    expect((JSON.parse(post?.body ?? "{}") as { cron: string }).cron).toBe("* * * * *");
  });

  it("provision_go_live: a hypothesis with no candidate is 422 with the pinned error, and nothing is written", async () => {
    const h = harness({ memories: [draftState()] });
    await expect(h.provisioner.goLive({ id: ID, email: OWNER })).rejects.toMatchObject({
      status: 422,
      kind: "invalid",
      details: { errors: [{ path: "", message: "no spec proposed yet" }] },
    });
    expect(h.stub.mutations).toHaveLength(0);
  });

  it("provision_go_live: an invalid candidate is 422 with EVERY error at once, each with its path, and nothing is provisioned", async () => {
    const broken = JSON.stringify(
      {
        thesis: "a thesis",
        horizon_days: 2, // out of [7, 3650]
        metrics: [{ slug: "one", source: "stooq", direction: "up", weight: 0.5 }], // no series_id; weights ≠ 1
        invalidation: [],
      },
      null,
      2,
    );
    const h = harness({ memories: [draftState(), candidate(broken)] });

    const err = (await h.provisioner
      .goLive({ id: ID, email: OWNER })
      .catch((e: unknown) => e)) as WolfError;
    expect(err.status).toBe(422);
    const errors = (err.details as { errors: { path: string; message: string }[] }).errors;
    expect(errors.length).toBeGreaterThan(2);
    for (const error of errors) expect(typeof error.path).toBe("string");
    expect(errors.map((e) => e.path).join(" ")).toContain("horizon_days");

    // ZERO worker, schedule and memory writes on that path.
    expect(h.stub.mutations).toHaveLength(0);
    await expect(h.store.readHypothesis(ID).then((r) => r.status)).resolves.toBe("draft");
  });

  it("provision_go_live: refuses a hypothesis that is not draft", async () => {
    const h = harness({ memories: [stateRow("live"), candidate()] });
    await expect(h.provisioner.goLive({ id: ID, email: OWNER })).rejects.toMatchObject({
      kind: "conflict",
    });
    expect(h.stub.mutations).toHaveLength(0);
  });
});

// ── Rollback: a failure injected at EACH of steps 1, 2 and 3 ────────────

describe("provision_rollback", () => {
  /** No `status=live` row was appended, whatever else happened. */
  function assertNotLive(stub: Stub): void {
    for (const labels of stub.appendedLabels()) {
      expect(labels["status"]).not.toBe("live");
    }
  }

  /** Step 1's locked spec is deliberately NOT withdrawn — assert no retraction. */
  function assertSpecNotWithdrawn(stub: Stub): void {
    for (const labels of stub.appendedLabels()) {
      expect(labels["retracts"]).toBeUndefined();
    }
  }

  it("provision_rollback: a failure at STEP 1 leaves no live row, no worker and no schedule", async () => {
    const h = harness({
      memories: [draftState(), candidate()],
      fail: { "POST /agent/memories": { status: 503, body: "orange is down" } },
    });
    await expect(h.provisioner.goLive({ id: ID, email: OWNER })).rejects.toThrow();

    assertNotLive(h.stub);
    assertSpecNotWithdrawn(h.stub);
    expect(h.stub.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
    expect(h.stub.requests.filter((r) => r.path === "/agent/schedules")).toHaveLength(0);
    await expect(h.store.readHypothesis(ID).then((r) => r.status)).resolves.toBe("draft");
  });

  it("provision_rollback: a failure at STEP 2 leaves no schedule and no live row, and does NOT withdraw the locked spec", async () => {
    const h = harness({
      memories: [draftState(), candidate()],
      fail: { "PUT /agent/workers/": { status: 500, body: "worker write failed" } },
    });
    await expect(h.provisioner.goLive({ id: ID, email: OWNER })).rejects.toThrow();

    assertNotLive(h.stub);
    assertSpecNotWithdrawn(h.stub);
    // The locked spec WAS written, and stays written: an orphaned spec with no
    // live row is inert, and there is no delete to reach for.
    expect(h.stub.appendedLabels()).toEqual([
      { kind: "hypothesis-spec", name: ID, status: "locked" },
    ]);
    expect(h.stub.requests.filter((r) => r.method === "POST" && r.path === "/agent/schedules"))
      .toHaveLength(0);
    await expect(h.store.readHypothesis(ID).then((r) => r.status)).resolves.toBe("draft");
  });

  it("provision_rollback: a failure at STEP 3 DELETES the worker step 2 created", async () => {
    const h = harness({
      memories: [draftState(), candidate()],
      fail: { "POST /agent/schedules": { status: 500, body: "schedule write failed" } },
    });
    await expect(h.provisioner.goLive({ id: ID, email: OWNER })).rejects.toThrow();

    assertNotLive(h.stub);
    assertSpecNotWithdrawn(h.stub);
    expect(h.stub.mutations.map((r) => `${r.method} ${r.path.split("?")[0] ?? ""}`)).toEqual([
      "POST /agent/memories",
      `PUT /agent/workers/${WORKER}`,
      "POST /agent/schedules",
      `DELETE /agent/workers/${WORKER}`,
    ]);
    await expect(h.store.readHypothesis(ID).then((r) => r.status)).resolves.toBe("draft");
  });

  it("provision_rollback: a failure at STEP 4 deletes the SCHEDULE FIRST, then the worker", async () => {
    // Not one of the three the criterion names, but the same invariant: after
    // any failure the hypothesis is still `draft` with no atoms behind it.
    // Step 4 is the SECOND append (step 1 is the first), and the stub keys
    // its injected failures by path — so the failure is injected on the
    // client instead, which is the only way to fail one of two calls to the
    // same route.
    const h = harness({ memories: [draftState(), candidate()] });
    let appends = 0;
    const original = h.client.appendMemory.bind(h.client);
    h.client.appendMemory = async (params) => {
      appends += 1;
      if (appends === 2) throw new WolfError("unavailable", "orange went away");
      return original(params);
    };

    await expect(h.provisioner.goLive({ id: ID, email: OWNER })).rejects.toThrow();
    const rollback = h.stub.mutations
      .map((r) => `${r.method} ${r.path.split("?")[0] ?? ""}`)
      .filter((step) => step.startsWith("DELETE"));
    expect(rollback).toEqual([
      "DELETE /agent/schedules/sched-1",
      `DELETE /agent/workers/${WORKER}`,
    ]);
    assertNotLive(h.stub);
    assertSpecNotWithdrawn(h.stub);
  });
});

// ── Teardown ────────────────────────────────────────────────────────────

function liveState(): MemoryRow {
  return stateRow("challenged");
}

function evaluationMemory(): MemoryRow {
  const snapshot = {
    evaluated_at_ms: 1787334000000,
    support_score: -0.42,
    conditions: [
      {
        id: "inv-1",
        state: "tripped",
        reason: "condition_tripped",
        value: 31.2,
        window_start_ms: 1787000000000,
        window_end_ms: 1787334000000,
        observations_in_window: 22,
        evaluated_at_ms: 1787334000000,
      },
    ],
    metrics: [],
  };
  return memory(
    { kind: "evaluation", name: ID },
    `score=-0.42 tripped=1 holding=0 indeterminate=0 evaluated=2026-08-20T06:05:00Z\n${JSON.stringify(
      snapshot,
      null,
      2,
    )}`,
  );
}

describe("provision_teardown", () => {
  function torndown(extra: Partial<StubConfig> = {}): StubConfig {
    return {
      memories: [liveState(), evaluationMemory()],
      schedules: [{ id: "sched-9", worker: WORKER, cron: "0 6 * * *" }],
      tickSessions: ["sess-tick-1", "sess-tick-2"],
      ...extra,
    };
  }

  it("provision_teardown: the five steps happen in the ORDER the scheduler forces, not merely all five", async () => {
    const h = harness(torndown());
    await h.provisioner.verdict({
      id: ID,
      email: OWNER,
      verdict: "invalidated",
      rationale: "the basket never responded",
    });

    // The ORDERED sequence, filtered to the teardown's own five steps. A set
    // assertion here would not gate this criterion at all.
    const order = h.stub.requests
      .map((r) => `${r.method} ${r.path.split("?")[0] ?? ""}`)
      .filter(
        (step) =>
          step.startsWith("DELETE") || step === "GET /agent/deliveries",
      );
    expect(order).toEqual([
      "DELETE /agent/schedules/sched-9", // 1. FIRST — the scheduler ignores `enabled`
      "GET /agent/deliveries", // 2. drain what it already queued
      `DELETE /agent/workers/${WORKER}`, // 3.
      "DELETE /agent/session/sess-tick-1", // 4. the tick sessions
      "DELETE /agent/session/sess-tick-2",
      `DELETE /agent/session/${SESSION_ID}`, // 5. the hyp-<id> chat session, LAST
    ]);
  });

  it("provision_teardown: NEVER deletes a dataset — the datasets are the evidence behind the verdict", async () => {
    const h = harness(torndown());
    await h.provisioner.verdict({
      id: ID,
      email: OWNER,
      verdict: "confirmed",
      rationale: "it held",
    });
    for (const request of h.stub.requests) {
      expect(request.path).not.toContain("/agent/datasets");
    }
  });

  it("provision_teardown: drains only THIS worker's pending deliveries, then proceeds", async () => {
    const h = harness(
      torndown({
        deliveries: [
          [
            { id: "d-1", worker: WORKER, status: "pending" },
            { id: "d-other", worker: "researcher-99999999", status: "pending" },
          ],
          [{ id: "d-other", worker: "researcher-99999999", status: "pending" }],
        ],
      }),
    );
    const result = await h.provisioner.retire({ id: ID, email: OWNER, rationale: "done" });

    expect(result.teardown.drained).toBe(true);
    expect(result.teardown.pending_left_behind).toEqual([]);
    // Two polls: the first still had d-1, the second had only another
    // worker's row — which must not hold this teardown up.
    expect(h.stub.requests.filter((r) => r.path.startsWith("/agent/deliveries"))).toHaveLength(2);
    expect(result.teardown.worker_deleted).toBe(true);
  });

  it("provision_teardown: gives up after WOLF_TEARDOWN_DRAIN_SECONDS, proceeds anyway, and reports the ids it left behind", async () => {
    const h = harness(
      torndown({ deliveries: [[{ id: "stuck-1", worker: WORKER, status: "pending" }]] }),
      { teardownDrainSeconds: 5 },
    );
    const result = await h.provisioner.retire({ id: ID, email: OWNER, rationale: "done" });

    expect(result.teardown.drained).toBe(false);
    expect(result.teardown.pending_left_behind).toEqual(["stuck-1"]);
    // Teardown PROCEEDED: the worker and both session kinds still went.
    expect(result.teardown.worker_deleted).toBe(true);
    expect(result.teardown.session_deleted).toBe(SESSION_ID);
    // Bounded by the clock, not by an unbounded loop: 5s at a 1s poll.
    expect(h.stub.requests.filter((r) => r.path.startsWith("/agent/deliveries")).length).toBeLessThanOrEqual(7);
  });

  it("provision_teardown: a tick session already RUNNING is allowed to finish — only PENDING deliveries are drained", async () => {
    // Anything an in-flight tick writes carries a session id in its
    // provenance and is untrusted by construction, so it cannot change state.
    // Waiting for it would stall every teardown behind a 30-minute container.
    const h = harness(
      torndown({ deliveries: [[{ id: "in-flight", worker: WORKER, status: "running" }]] }),
    );
    const result = await h.provisioner.retire({ id: ID, email: OWNER, rationale: "done" });

    expect(result.teardown.drained).toBe(true);
    expect(result.teardown.pending_left_behind).toEqual([]);
    const polls = h.stub.requests.filter((r) => r.path.startsWith("/agent/deliveries"));
    expect(polls).toHaveLength(1);
    // The `pending`-only wait is asserted by BEHAVIOUR, not by the query
    // string: the one poll above saw a `running` delivery for this very
    // worker and still returned immediately. The status filter moved
    // client-side with R112 — the same page now also answers "which tick
    // sessions are in flight" for step 4, and `?status=pending` would hide
    // exactly the rows that question needs. Asserting the URL here would gate
    // the mechanism rather than the rule.
    expect(polls[0]?.path).not.toContain("status=");
    expect(result.teardown.drained).toBe(true);
  });

  it("provision_teardown: a tick session that is the session of a RUNNING delivery is NOT deleted (R112)", async () => {
    // design/2026-08-20-agent-wolf.md, W10: "The in-flight exclusion is ONE
    // predicate, shared with W9's teardown (R112)." W9 shipped step 4
    // literally — "delete every row it returns" — which contradicted its own
    // rule three lines below that "a tick session still in flight is allowed
    // to finish": a /verdict issued while a tick is running deleted that
    // tick's session row out from under it, mid-`dataset_put`. The predicate
    // lives in store.ts and W10's sweep uses the same one.
    const h = harness(
      torndown({
        tickSessions: ["sess-tick-1", "sess-tick-2", "sess-tick-live"],
        deliveries: [
          [
            { id: "d-live", worker: WORKER, status: "running", sessionId: "sess-tick-live" },
            // Another worker's running tick is irrelevant, even though it
            // names one of OUR sessions: the exclusion is per worker.
            { id: "d-other", worker: "researcher-99999999", status: "running", sessionId: "sess-tick-1" },
          ],
        ],
      }),
    );
    const result = await h.provisioner.retire({ id: ID, email: OWNER, rationale: "done" });

    expect(result.teardown.tick_sessions_in_flight).toEqual(["sess-tick-live"]);
    expect(result.teardown.tick_sessions_deleted).toEqual(["sess-tick-1", "sess-tick-2"]);
    // And the DELETE never went out — the report is not the only evidence.
    const deletes = h.stub.requests
      .filter((r) => r.method === "DELETE" && r.path.startsWith("/agent/session/"))
      .map((r) => r.path);
    expect(deletes).not.toContain("/agent/session/sess-tick-live");
    expect(deletes).toContain("/agent/session/sess-tick-1");
  });

  it("provision_teardown: the in-flight exclusion costs NO extra request — the drain's own page answers it", async () => {
    // The five-step ORDER is asserted by recorded call order (the first test
    // in this block), and `GET /agent/deliveries` is one of the six entries
    // in that sequence. A second delivery read for the exclusion would appear
    // in it and change an ordering W9 is graded on, so the exclusion reuses
    // the page the drain already fetched.
    const h = harness(torndown());
    await h.provisioner.retire({ id: ID, email: OWNER, rationale: "done" });
    expect(h.stub.requests.filter((r) => r.path.startsWith("/agent/deliveries"))).toHaveLength(1);
  });

  it("provision_teardown: a schedule that will not delete ABORTS before the worker is removed", async () => {
    const h = harness({
      ...torndown(),
      fail: { "DELETE /agent/schedules/": { status: 500, body: "nope" } },
    });
    const result = await h.provisioner.retire({ id: ID, email: OWNER, rationale: "done" });

    expect(result.teardown.errors[0]?.step).toBe("delete_schedule");
    expect(result.teardown.worker_deleted).toBe(false);
    // A surviving schedule with no worker mints one failed delivery a day
    // until the five-failure streak retires it. Leaving the worker in place is
    // the lesser of the two states.
    expect(h.stub.requests.filter((r) => r.method === "DELETE" && r.path.includes("/agent/workers/")))
      .toHaveLength(0);
  });
});

// ── The verdict, the retirement and the amendment ───────────────────────

describe("provision_verdict", () => {
  it("provision_verdict: appends a trusted verdict memory carrying the rationale, the full address and the WHOLE evaluation snapshot", async () => {
    const h = harness({
      memories: [liveState(), evaluationMemory()],
      schedules: [{ id: "sched-9", worker: WORKER, cron: "0 6 * * *" }],
    });
    const result = await h.provisioner.verdict({
      id: ID,
      email: OWNER,
      verdict: "invalidated",
      rationale: "the basket never responded to the thesis",
    });

    const verdictAppend = h.stub.appends
      .map((r) => JSON.parse(r.body) as { labels: Record<string, string>; content: string })
      .find((a) => a.labels["kind"] === "verdict");
    expect(verdictAppend?.labels).toEqual({ kind: "verdict", name: ID, status: "invalidated" });
    expect(verdictAppend?.content).toContain("the basket never responded to the thesis");
    // The FULL address — a label may not carry it (no `@` in the K8s charset).
    expect(verdictAppend?.content).toContain(OWNER);
    // The complete snapshot: this is why the record outlives O3's 30-version
    // dataset reaper.
    expect(verdictAppend?.content).toContain('"support_score": -0.42');
    expect(verdictAppend?.content).toContain('"observations_in_window": 22');

    expect(result.status).toBe("invalidated");
    await expect(h.store.readHypothesis(ID).then((r) => r.status)).resolves.toBe("invalidated");
  });

  it("provision_verdict: the state row carries the snapshot too, and the verdict is written BEFORE the transition", async () => {
    const h = harness({ memories: [liveState(), evaluationMemory()] });
    await h.provisioner.verdict({ id: ID, email: OWNER, verdict: "confirmed", rationale: "held" });
    const kinds = h.stub.appendedLabels().map((labels) => labels["kind"]);
    expect(kinds).toEqual(["verdict", "hypothesis"]);
    const state = JSON.parse(h.stub.appends[1]?.body ?? "{}") as { content: string };
    expect(state.content).toContain('"support_score": -0.42');
  });

  it("provision_verdict: an illegal transition is refused BEFORE the unretractable verdict memory is written", async () => {
    // `live -> confirmed` is not an edge: only `challenged` may be resolved.
    const h = harness({ memories: [stateRow("live")] });
    await expect(
      h.provisioner.verdict({ id: ID, email: OWNER, verdict: "confirmed", rationale: "held" }),
    ).rejects.toMatchObject({ kind: "conflict" });
    expect(h.stub.appends).toHaveLength(0);
  });
});

describe("provision_retire", () => {
  it("provision_retire: archives from a non-terminal state and runs the same teardown", async () => {
    const h = harness({
      memories: [liveState()],
      schedules: [{ id: "sched-9", worker: WORKER, cron: "0 6 * * *" }],
      tickSessions: ["sess-tick-1"],
    });
    const result = await h.provisioner.retire({ id: ID, email: OWNER, rationale: "not worth it" });

    expect(result.status).toBe("archived");
    expect(h.stub.appendedLabels()).toEqual([
      { kind: "hypothesis", name: ID, status: "archived", owner: slugifyOwner(OWNER) },
    ]);
    expect(result.teardown.schedules_deleted).toEqual(["sched-9"]);
    expect(result.teardown.tick_sessions_deleted).toEqual(["sess-tick-1"]);
    expect(result.teardown.session_deleted).toBe(SESSION_ID);
  });

  it("provision_retire: a TERMINAL hypothesis cannot be retired, and nothing is written", async () => {
    // `confirmed` is terminal: no edge leaves it. A hypothesis that needs to
    // run again is a new one carrying `restated_from`.
    const h = harness({ memories: [stateRow("confirmed")] });
    await expect(
      h.provisioner.retire({ id: ID, email: OWNER, rationale: "again" }),
    ).rejects.toMatchObject({ kind: "conflict" });
    expect(h.stub.mutations).toHaveLength(0);
  });

  it("provision_retire: retiring an ALREADY-archived hypothesis is a no-op that appends nothing (B3)", async () => {
    // A self-transition is a no-op, not an error — the rule that makes W10's
    // idempotence criterion mean anything. Teardown still runs, so a
    // half-finished earlier teardown can be completed.
    const h = harness({ memories: [stateRow("archived")] });
    const result = await h.provisioner.retire({ id: ID, email: OWNER, rationale: "again" });
    expect(result.memory_id).toBeNull();
    expect(h.stub.appends).toHaveLength(0);
  });
});

describe("provision_amend", () => {
  function amendment(json: string = WORKED_SPEC): MemoryRow {
    return memory(
      { kind: "spec-amendment", name: ID, status: "proposed" },
      `raise the drawdown threshold\n${json}`,
      { worker: WORKER, session: "sess-tick-9" },
    );
  }

  it("provision_amend: accepting appends a locked spec carrying the amendment id, the decider and the rationale, and returns to LIVE", async () => {
    const proposal = amendment();
    const h = harness({ memories: [liveState(), proposal] });
    const result = await h.provisioner.amend({
      id: ID,
      email: OWNER,
      amendmentId: proposal.id,
      decision: "accept",
      rationale: "the market regime changed",
    });

    expect(result.status).toBe("live");
    const appended = h.stub.appends.map(
      (r) => JSON.parse(r.body) as { labels: Record<string, string>; content: string },
    );
    const spec = appended.find((a) => a.labels["kind"] === "hypothesis-spec");
    expect(spec?.labels).toEqual({ kind: "hypothesis-spec", name: ID, status: "locked" });
    expect(spec?.content).toContain(WORKED_SPEC); // verbatim
    expect(spec?.content).toContain(proposal.id);
    expect(spec?.content).toContain(OWNER);
    expect(spec?.content).toContain("the market regime changed");
    await expect(h.store.readHypothesis(ID).then((r) => r.status)).resolves.toBe("live");
  });

  it("provision_amend: the researcher's LOCKED preamble is recomposed while the critic's method body is carried across", async () => {
    const proposal = amendment();
    const h = harness({ memories: [liveState(), proposal] });
    const rewritten = "## Method\n\nthe critic's rewritten body.\n";
    // The worker already exists, with a method body a critic has rewritten.
    h.client.getWorker = async () => ({
      project: "wolf",
      name: WORKER,
      description: "",
      systemPrompt: composeResearcherPrompt({
        preambleTemplate: PREAMBLE,
        specJson: '{"old": true}',
        methodBody: rewritten,
      }),
      mcpConfig: {},
      image: "",
      maxInstances: 1,
      enabled: true,
      frozen: false,
      createdAtSec: toSec(0),
      updatedAtSec: toSec(0),
    });

    await h.provisioner.amend({
      id: ID,
      email: OWNER,
      amendmentId: proposal.id,
      decision: "accept",
      rationale: "regime change",
    });

    const put = h.stub.requests.find((r) => r.method === "PUT");
    const prompt = (JSON.parse(put?.body ?? "{}") as { system_prompt: string }).system_prompt;
    expect(prompt).toContain(WORKED_SPEC);
    expect(prompt).not.toContain('{"old": true}');
    expect(splitAtMethodMarker(prompt).methodBody).toBe(rewritten);
  });

  it("provision_amend: an amended spec that does not validate is 422 and NOTHING is written", async () => {
    const proposal = amendment('{"thesis": "x", "metrics": [], "invalidation": []}');
    const h = harness({ memories: [liveState(), proposal] });
    await expect(
      h.provisioner.amend({
        id: ID,
        email: OWNER,
        amendmentId: proposal.id,
        decision: "accept",
        rationale: "why not",
      }),
    ).rejects.toMatchObject({ status: 422, kind: "invalid" });
    expect(h.stub.mutations).toHaveLength(0);
  });

  it("provision_amend: rejecting writes nothing and leaves the state alone", async () => {
    const proposal = amendment();
    const h = harness({ memories: [liveState(), proposal] });
    const result = await h.provisioner.amend({
      id: ID,
      email: OWNER,
      amendmentId: proposal.id,
      decision: "reject",
      rationale: "not convinced",
    });
    expect(result.decision).toBe("reject");
    expect(result.status).toBe("challenged");
    expect(h.stub.mutations).toHaveLength(0);
  });

  it("provision_amend: an unknown amendment id is 404 and writes nothing", async () => {
    const h = harness({ memories: [liveState()] });
    await expect(
      h.provisioner.amend({
        id: ID,
        email: OWNER,
        amendmentId: "mem-does-not-exist",
        decision: "accept",
        rationale: "x",
      }),
    ).rejects.toMatchObject({ kind: "not_found" });
    expect(h.stub.mutations).toHaveLength(0);
  });
});

describe("provision_unknown_hypothesis", () => {
  it("provision_unknown_hypothesis: an id with no hyp-<id> session is 404 — the session list is the authoritative index", async () => {
    const h = harness({ memories: [draftState(), candidate()], noSession: true });
    await expect(h.provisioner.goLive({ id: ID, email: OWNER })).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(h.stub.mutations).toHaveLength(0);
  });
});

describe("provision_serialisation", () => {
  it("provision_serialisation: two concurrent retirements of the same id append exactly ONE state row", async () => {
    // Every state change goes through W5's machine inside a per-id mutex,
    // with the current state re-read INSIDE the critical section. Without
    // that, both callers read `challenged`, both append, and the later one
    // silently wins — there is no compare-and-swap on memories.
    const h = harness({ memories: [liveState()] });
    const results = await Promise.all([
      h.provisioner.retire({ id: ID, email: OWNER, rationale: "first" }),
      h.provisioner.retire({ id: ID, email: OWNER, rationale: "second" }),
    ]);

    expect(h.stub.appends).toHaveLength(1);
    expect(h.stub.appendedLabels()[0]).toMatchObject({ status: "archived" });
    // The second call saw `archived` inside the lock: a self-transition, so a
    // no-op rather than an error or a second row.
    const written = results.filter((r) => r.memory_id !== null);
    expect(written).toHaveLength(1);
  });
});

describe("provision_serialisation_go_live", () => {
  it("provision_serialisation_go_live: two concurrent go-lives provision ONE worker and ONE schedule", async () => {
    // The store's mutex guards the state append alone. Go-live is four calls
    // wide, so without a mutex around the WHOLE of it both callers pass the
    // `draft` pre-flight and Orange ends up with two daily schedules for one
    // hypothesis — two ticks a day, two writers racing the same dataset CAS.
    const h = harness({ memories: [draftState(), candidate()] });
    const results = await Promise.allSettled([
      h.provisioner.goLive({ id: ID, email: OWNER }),
      h.provisioner.goLive({ id: ID, email: OWNER }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(h.stub.schedules).toHaveLength(1);
    expect(h.stub.requests.filter((r) => r.method === "POST" && r.path === "/agent/schedules"))
      .toHaveLength(1);
    expect(h.stub.appendedLabels().filter((l) => l["status"] === "live")).toHaveLength(1);
  });
});
