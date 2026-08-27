/**
 * X1's shared rig. Three spec files drive the same nine-step provisioning
 * chain, and a copy per file would drift the moment one of them was fixed.
 *
 * 🔴 CREDENTIAL RULES, WHICH ARE NOT NEGOTIABLE IN THIS FILE
 *
 *   * `WOLF_API_KEY` is read from the environment and sent as a header. It is
 *     never logged, never interpolated into a message, never returned.
 *   * A dataset `download_url` and an embed token are credentials. Nothing
 *     here prints one.
 *   * 🔴 `SESSION_TOKEN` is NEVER read out of a container. `execInSessionContainer`
 *     runs a program INSIDE the container, where `$SESSION_TOKEN` is already in
 *     the environment — so the value never crosses onto the host, never enters
 *     a Playwright log, and never lands in a trace. X1's ticket text describes
 *     `docker exec … printenv SESSION_TOKEN` instead; running the program in
 *     place is both safer and a closer model of the attack being tested, which
 *     is a prompt-injected agent acting from inside its own container.
 */

import { spawn } from "node:child_process";
import { expect, type APIRequestContext, type Page } from "@playwright/test";

/** One child process, with optional stdin. Rejects on a non-zero exit. */
function run(
  command: string,
  args: readonly string[],
  stdin?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr.slice(0, 500)}`));
    });
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

export const ORANGE_BASE = process.env.X1_ORANGE_BASE ?? "http://localhost:8090";
export const WOLF_BASE = process.env.X1_WOLF_BASE ?? "http://localhost:8091";
export const DIND = process.env.X1_DIND_CONTAINER ?? "agent-orange-dind-1";
export const LOGIN_EMAIL = process.env.X1_LOGIN_EMAIL ?? "kai@badcode.dev";
export const LOGIN_PASSWORD = process.env.X1_LOGIN_PASSWORD ?? "x1-dev-login";

/** The one metric every X1 spec is built on. Must match e2e/mock/build-script.py. */
export const METRIC_SLUG = "probe-rate";

const API_KEY = process.env.WOLF_API_KEY ?? "";
if (API_KEY === "") {
  throw new Error("WOLF_API_KEY is not set — run these specs through e2e/run.sh");
}

// ── Orange, with the project API key ────────────────────────────────────────

export interface OrangeResponse<T> {
  status: number;
  body: T;
  text: string;
}

export async function orange<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<OrangeResponse<T>> {
  const headers: Record<string, string> = { "X-API-Key": API_KEY };
  let payload: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${ORANGE_BASE}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = undefined;
  }
  return { status: res.status, body: parsed as T, text };
}

export interface MemoryRow {
  id: string;
  labels: Record<string, string>;
  snippet?: string;
  created_by_worker: string;
  created_by_session: string;
  created_at: number;
  retracted_by?: { memory_id: string; created_by_worker: string; created_by_session: string }[];
}

export async function listMemories(
  selector: string,
  opts: { latestPer?: string; includeRetracted?: boolean; limit?: number } = {},
): Promise<MemoryRow[]> {
  const q = new URLSearchParams({ selector, limit: String(opts.limit ?? 50) });
  if (opts.latestPer !== undefined) q.set("latest_per", opts.latestPer);
  if (opts.includeRetracted === true) q.set("include_retracted", "1");
  const res = await orange<{ memories: MemoryRow[] }>("GET", `/agent/memories?${q.toString()}`);
  expect(res.status, `GET /agent/memories?${q.toString()} → ${res.text.slice(0, 200)}`).toBe(200);
  return res.body.memories ?? [];
}

export async function getMemory(id: string): Promise<MemoryRow & { content: string }> {
  const res = await orange<MemoryRow & { content: string }>("GET", `/agent/memories/${id}`);
  expect(res.status, `GET /agent/memories/${id} → ${res.text.slice(0, 200)}`).toBe(200);
  return res.body;
}

export interface DatasetMeta {
  name: string;
  version: number;
  size_bytes: number;
  row_count: number;
  sha256: string;
  content_type: string;
  labels?: Record<string, string>;
}

/** Dataset metadata, or null when the dataset has never been written. */
export async function datasetMeta(name: string): Promise<DatasetMeta | null> {
  const res = await orange<DatasetMeta>("GET", `/agent/datasets/${encodeURIComponent(name)}`);
  if (res.status === 404) return null;
  expect(res.status, `GET /agent/datasets/${name} → ${res.text.slice(0, 200)}`).toBe(200);
  return res.body;
}

export interface OrangeSession {
  id: string;
  name: string;
  worker: string;
  status: string;
  customer: string;
}

/**
 * Every session in the `wolf` project, optionally narrowed to one worker.
 *
 * 🔴 `?user_email=*` IS NOT OPTIONAL. `GET /agent/sessions` defaults to the
 * CALLING principal's own user_email (`go/httpapi/history.go:111-116`), and an
 * API key's synthetic email is not what the dispatcher stamps on a job session
 * — so a plain listing returns the `hyp-<id>` sessions and NONE of the per-tick
 * ones. Wolf's own client has always passed it (`api/src/orange/client.ts:698`).
 */
export async function sessions(worker?: string): Promise<OrangeSession[]> {
  const q = new URLSearchParams({ user_email: "*", limit: "200" });
  if (worker !== undefined) q.set("worker", worker);
  const res = await orange<OrangeSession[]>("GET", `/agent/sessions?${q.toString()}`);
  expect(res.status, `GET /agent/sessions → ${res.text.slice(0, 200)}`).toBe(200);
  return Array.isArray(res.body) ? res.body : [];
}

export async function sessionByName(name: string): Promise<OrangeSession | null> {
  const res = await orange<OrangeSession>(
    "GET",
    `/agent/sessions/by-name/${encodeURIComponent(name)}`,
  );
  if (res.status === 404) return null;
  expect(res.status, `GET /agent/sessions/by-name/${name} → ${res.text.slice(0, 200)}`).toBe(200);
  return res.body;
}

export async function workerExists(name: string): Promise<boolean> {
  const res = await orange("GET", `/agent/workers/${encodeURIComponent(name)}`);
  return res.status === 200;
}

export async function schedulesForWorker(worker: string): Promise<unknown[]> {
  const res = await orange<{ schedules?: { worker?: string }[] }>(
    "GET",
    "/agent/schedules?limit=200",
  );
  expect(res.status, `GET /agent/schedules → ${res.text.slice(0, 200)}`).toBe(200);
  const rows = res.body?.schedules ?? [];
  return rows.filter((row) => row.worker === worker);
}

// ── Polling ─────────────────────────────────────────────────────────────────

export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 8 * 60_000,
  intervalMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    let value: T | null | undefined | false = null;
    try {
      value = await probe();
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}` +
          (last ? ` (last error: ${last})` : ""),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ── Signing in ──────────────────────────────────────────────────────────────

/**
 * The test-only login (owner decision B6). Playwright cannot obtain a real
 * Google ID token offline, and forging the `wolf_session` cookie here would
 * prove the cookie rather than the login — so this posts real credentials to a
 * real route that mints a real cookie, on the same context the page uses.
 */
export async function signIn(page: Page): Promise<void> {
  const res = await page.request.post(`${WOLF_BASE}/api/auth/dev-login`, {
    data: { email: LOGIN_EMAIL, password: LOGIN_PASSWORD },
  });
  expect(res.status(), `dev-login → ${(await res.text()).slice(0, 200)}`).toBe(200);
  const me = await page.request.get(`${WOLF_BASE}/api/auth/me`);
  expect(me.status()).toBe(200);
  expect((await me.json()) as { email: string }).toEqual({ email: LOGIN_EMAIL });
}

// ── Wolf's own API, through the signed-in context ───────────────────────────

export async function wolf<T = unknown>(
  api: APIRequestContext,
  method: "get" | "post",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T; text: string }> {
  const res =
    method === "get"
      ? await api.get(`${WOLF_BASE}${path}`)
      : await api.post(`${WOLF_BASE}${path}`, body === undefined ? {} : { data: body });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = undefined;
  }
  return { status: res.status(), body: parsed as T, text };
}

// ── Nested docker ───────────────────────────────────────────────────────────

/**
 * The container id of one session's container, inside DinD. Found by the
 * `agentkit.session-id` label the Docker adapter stamps
 * (`go/execenv/docker/client.go:204`), never by parsing a container name.
 *
 * 🔴 This is scoped by a label agentd set. It never enumerates containers it
 * does not own, and nothing in this file stops, removes or kills a container.
 */
export async function sessionContainerId(sessionId: string): Promise<string | null> {
  const { stdout } = await run("docker", [
    "exec",
    DIND,
    "docker",
    "ps",
    "-q",
    "--filter",
    `label=agentkit.session-id=${sessionId}`,
  ]);
  const id = stdout.trim().split("\n")[0] ?? "";
  return id === "" ? null : id;
}

/**
 * Runs a Python program INSIDE a session's container.
 *
 * The program sees the container's own environment, so it can use
 * `$SESSION_TOKEN` without that value ever reaching the host. That is the
 * whole point: the credential stays where agentd put it, and the code path
 * being exercised is the real one — an agent acting from inside its own
 * container, which is what a prompt injection produces.
 */
export async function execInSessionContainer(
  sessionId: string,
  program: string,
): Promise<string> {
  const containerId = await waitFor(
    `a running container for session ${sessionId}`,
    () => sessionContainerId(sessionId),
    3 * 60_000,
    2_000,
  );
  const { stdout, stderr } = await run(
    "docker",
    ["exec", "-i", DIND, "docker", "exec", "-i", containerId, "python3", "-"],
    program,
  );
  if (stderr.trim() !== "") {
    throw new Error(`in-container program wrote to stderr: ${stderr.slice(0, 500)}`);
  }
  return stdout;
}

/** The preamble every in-container program shares: one core-MCP JSON-RPC call. */
export const IN_CONTAINER_RPC = `
import json, os, sys, urllib.request
BASE = os.environ.get("HOST_API_URL") or "http://172.17.0.1:8099"
MCP = BASE.rstrip("/") + "/mcp"
TOKEN = os.environ["SESSION_TOKEN"]   # read, used, NEVER printed

def rpc(tool, args):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": tool, "arguments": args}}).encode("utf-8")
    req = urllib.request.Request(MCP, data=body, headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN})
    with urllib.request.urlopen(req, timeout=120) as resp:
        doc = json.loads(resp.read().decode("utf-8"))
    if "error" in doc:
        raise RuntimeError(tool + ": " + json.dumps(doc["error"])[:300])
    result = doc.get("result") or {}
    if result.get("isError"):
        raise RuntimeError(tool + ": " + "".join(c.get("text", "") for c in result.get("content", []))[:300])
    return result.get("structuredContent") or {}
`;

// ── The nine-step provisioning chain ────────────────────────────────────────

export interface LiveHypothesis {
  id: string;
  sessionName: string;
  sessionId: string;
  datasetName: string;
}

/**
 * Creates a hypothesis, drives the interview, accepts the proposed report
 * template and goes live. Returns once the hypothesis is `live`; the caller
 * waits for whatever the tick produces.
 *
 * `interviewMarker` chooses which mock rule answers (e2e/mock/build-script.py).
 */
export async function createAndGoLive(
  page: Page,
  opts: { title: string; thesis: string; interviewMarker: string },
): Promise<LiveHypothesis> {
  const api = page.request;

  // 1. Create — this is what mints the `hyp-<id>` session and its container.
  const created = await wolf<{ id: string }>(api, "post", "/api/hypotheses", {
    title: opts.title,
    thesis: opts.thesis,
  });
  expect(created.status, `POST /api/hypotheses → ${created.text.slice(0, 400)}`).toBe(201);
  const id = created.body.id;

  // 🔴 THE PREFIX IS ADDED EXACTLY ONCE. `hyp-hyp-…` is a real failure mode
  // (§ Vocabulary) under which the trust rule's session clause never matches
  // and every hypothesis reads as untrusted, so assert the shape here rather
  // than discovering it as a missing tamper flag six steps later.
  expect(id, "the hypothesis id is BARE 8-hex, never prefixed").toMatch(/^[0-9a-f]{8}$/);
  const sessionName = `hyp-${id}`;

  const session = await waitFor(
    `the ${sessionName} session to exist`,
    () => sessionByName(sessionName),
    3 * 60_000,
  );
  expect(session.name).toBe(sessionName);

  // 2. The run-scoped marker that tells the interview container WHICH
  //    hypothesis it is interviewing for. It is written through
  //    `POST /agent/memories` with the project API key, so its provenance is
  //    server-stamped EMPTY — which also exercises O7's trust anchor.
  const marker = await orange<MemoryRow>("POST", "/agent/memories", {
    labels: { kind: "x1-target", name: id, session: session.id },
    content: `X1: the interview session ${session.id} is interviewing for hypothesis ${id}.`,
    embed: false,
  });
  expect(marker.status, `POST /agent/memories → ${marker.text.slice(0, 300)}`).toBe(201);
  expect(marker.body.created_by_worker, "O7 stamps provenance empty").toBe("");
  expect(marker.body.created_by_session, "O7 stamps provenance empty").toBe("");

  // 3. The interview itself. One message; the mock rule matching
  //    `interviewMarker` answers it. The response is an SSE stream that ends
  //    when the turn does, so awaiting the body is awaiting the turn.
  const chat = await fetch(`${ORANGE_BASE}/agent/session/${session.id}/message`, {
    method: "POST",
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      content: `${opts.interviewMarker} — please propose a scoreboard and a report for this thesis.`,
    }),
  });
  expect(chat.status, "POST /agent/session/{id}/message").toBe(200);
  const stream = await chat.text();
  expect(stream.length, "the interview turn produced no SSE at all").toBeGreaterThan(0);

  // 4. The candidate spec must validate, or the Go Live gate has nothing to
  //    read and every later step is untestable.
  await waitFor(`a VALID spec candidate for ${id}`, async () => {
    const detail = await wolf<{ spec_validation?: { valid: boolean } }>(
      api,
      "get",
      `/api/hypotheses/${id}`,
    );
    return detail.status === 200 && detail.body.spec_validation?.valid === true;
  });

  // 5. The report candidate, and the human action that locks it. W22 refuses
  //    go-live without a locked template.
  const candidate = await waitFor(
    `a VALID report candidate for ${id}`,
    async () => {
      const res = await wolf<{ valid: boolean; html: string; errors?: unknown }>(
        api,
        "get",
        `/api/hypotheses/${id}/report-candidate`,
      );
      if (res.status !== 200) return null;
      if (res.body.valid !== true) {
        throw new Error(`candidate invalid: ${JSON.stringify(res.body.errors).slice(0, 300)}`);
      }
      return res.body;
    },
  );

  const accepted = await wolf<{ structure_hash: string }>(
    api,
    "post",
    `/api/hypotheses/${id}/report-template`,
    { html: candidate.html },
  );
  expect(accepted.status, `POST report-template → ${accepted.text.slice(0, 400)}`).toBe(201);
  expect(accepted.body.structure_hash).toMatch(/^[0-9a-f]{64}$/);

  // 6. Go live.
  const live = await wolf(api, "post", `/api/hypotheses/${id}/go-live`);
  expect(live.status, `POST go-live → ${live.text.slice(0, 600)}`).toBe(200);

  return { id, sessionName, sessionId: session.id, datasetName: `${id}-${METRIC_SLUG}` };
}

/**
 * Waits for the daily researcher's first tick to land its dataset.
 *
 * There is NO force-fire route — `WOLF_SCHEDULE_CRON="* * * * *"` and we wait
 * for a cron minute, a container, and several harness turns.
 */
export async function waitForTick(hyp: LiveHypothesis): Promise<DatasetMeta> {
  return waitFor(
    `the first tick to write dataset ${hyp.datasetName}`,
    async () => {
      const meta = await datasetMeta(hyp.datasetName);
      return meta !== null && meta.version >= 1 ? meta : null;
    },
    9 * 60_000,
    5_000,
  );
}

/** Retires a hypothesis, which is what runs W9's ordered teardown. */
export async function retire(page: Page, id: string, rationale: string): Promise<void> {
  const res = await wolf(page.request, "post", `/api/hypotheses/${id}/retire`, { rationale });
  expect(res.status, `POST retire → ${res.text.slice(0, 400)}`).toBe(200);
}
