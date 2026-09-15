/**
 * "Is the researcher working right now?" — the detail page's `research` block.
 *
 * A live hypothesis's page used to say nothing at all while a researcher tick
 * ran: the first real-model walk (2026-09-13) sat on an unchanged page for the
 * several minutes a tick takes, with no sign that anything was happening. The
 * answer is in Bob's delivery log, which records every schedule firing as one
 * row whose `subscription_id` is the schedule's id, so ONE filtered request
 * answers it.
 *
 * 🔴 This block is a PROGRESS SIGNAL and nothing else. It decides no state,
 * gates no button and feeds no score: a delivery parked at `awaiting_human`
 * never clears (a known Bob wart), which is exactly why the scoreboard reads
 * no delivery status. Here the wart costs one calm sentence, never a verdict.
 */

import { toMs, type DeliveryRecord, type ScheduleRecord, type UnixMs } from "../bob/types.js";

export type ResearchState = "queued" | "running" | "idle";

export interface ResearchStatus {
  /**
   * `queued` — the schedule fired and the job waits to be dispatched;
   * `running` — a researcher container is working on it; `idle` — nothing in
   * flight.
   */
  state: ResearchState;
  /** When the in-flight run started (`created_at` while queued). `null` when idle. */
  started_at_ms: UnixMs | null;
  /** When the newest run that has ended ended. `null` before the first one. */
  last_finished_at_ms: UnixMs | null;
  /** That run's delivery status, verbatim (`ok`, `failed`, `rate_limited`, …). */
  last_outcome: string | null;
  /** The schedule's next firing, from its cron in UTC. `null` when it cannot be computed. */
  next_run_at_ms: UnixMs | null;
  /** The schedule's cron, verbatim, so the page can say WHEN it runs and not only when next. */
  cron: string;
}

/** How many of the schedule's newest deliveries the block reads. One run in flight plus history. */
export const RESEARCH_DELIVERY_PAGE = 5;

export function researchStatusFrom(
  schedule: Pick<ScheduleRecord, "cron" | "enabled">,
  deliveries: readonly DeliveryRecord[],
  nowMs: number,
): ResearchStatus {
  // Bob lists newest first; sorted again so the answer does not depend on it.
  const ordered = [...deliveries].sort((a, b) => b.createdAtSec - a.createdAtSec);
  const inFlight = ordered.find((d) => d.status === "running" || d.status === "pending");
  const finished = ordered.find((d) => d.endedAtSec > 0);

  let state: ResearchState = "idle";
  let startedAtMs: UnixMs | null = null;
  if (inFlight !== undefined) {
    state = inFlight.status === "running" ? "running" : "queued";
    const startedSec = inFlight.startedAtSec > 0 ? inFlight.startedAtSec : inFlight.createdAtSec;
    startedAtMs = startedSec > 0 ? toMs(startedSec * 1000) : null;
  }

  const next = schedule.enabled ? nextCronRunMs(schedule.cron, nowMs) : null;
  return {
    state,
    started_at_ms: startedAtMs,
    last_finished_at_ms: finished === undefined ? null : toMs(finished.endedAtSec * 1000),
    last_outcome: finished === undefined ? null : finished.status,
    next_run_at_ms: next === null ? null : toMs(next),
    cron: schedule.cron,
  };
}

// ── Cron ────────────────────────────────────────────────────────────────
//
// A port of Bob's own `agentdb.ParseCron`/`Matches` (go/agentdb/schedules.go),
// in UTC — agentd's shipped zone. Five fields, `*`, lists, ranges, steps and
// three-letter names; both day fields restricted means EITHER matches.

interface CronField {
  min: number;
  max: number;
  names?: Record<string, number>;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DOW_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const FIELDS: CronField[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTH_NAMES },
  { min: 0, max: 7, names: DOW_NAMES },
];

function cronValue(raw: string, field: CronField): number | null {
  const named = field.names?.[raw.toLowerCase()];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(raw)) return null;
  const v = Number(raw);
  return v < field.min || v > field.max ? null : v;
}

function parseField(text: string, field: CronField): Set<number> | null {
  const out = new Set<number>();
  for (const item of text.split(",")) {
    const [spec = "", stepText] = item.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step <= 0) return null;
    let lo: number | null;
    let hi: number | null;
    if (spec === "*") {
      lo = field.min;
      hi = field.max;
    } else if (spec.includes("-")) {
      const [a = "", b = ""] = spec.split("-");
      lo = cronValue(a, field);
      hi = cronValue(b, field);
    } else {
      lo = cronValue(spec, field);
      hi = stepText === undefined ? lo : field.max;
    }
    if (lo === null || hi === null || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size === 0 ? null : out;
}

/**
 * The first minute strictly after `afterMs` that `cron` fires on, in UTC, or
 * `null` for an expression this cannot parse or that fires nowhere within
 * about five years (`0 0 30 2 *`).
 */
export function nextCronRunMs(cron: string, afterMs: number): number | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((part, i) => parseField(part, FIELDS[i]!));
  if (sets.some((s) => s === null)) return null;
  const [minutes, hours, doms, months, dowsRaw] = sets as Set<number>[];
  const dows = new Set([...dowsRaw!].map((d) => (d === 7 ? 0 : d)));
  const domRestricted = parts[2] !== "*";
  const dowRestricted = parts[4] !== "*";

  const t = new Date(Math.floor(afterMs / 60_000) * 60_000 + 60_000);
  const limit = afterMs + 5 * 366 * 24 * 60 * 60 * 1000;
  while (t.getTime() <= limit) {
    if (!months!.has(t.getUTCMonth() + 1)) {
      t.setUTCMonth(t.getUTCMonth() + 1, 1);
      t.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const domHit = doms!.has(t.getUTCDate());
    const dowHit = dows.has(t.getUTCDay());
    const dayHit =
      domRestricted && dowRestricted ? domHit || dowHit : domRestricted ? domHit : dowRestricted ? dowHit : true;
    if (!dayHit) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!hours!.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!minutes!.has(t.getUTCMinutes())) {
      t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return t.getTime();
  }
  return null;
}
