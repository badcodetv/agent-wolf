/**
 * "How is this hypothesis doing?" — the detail page's first answer, in words.
 *
 * Kai's first real use (2026-09-13, 2026-09-15): the page answered every
 * question at the same volume, so it answered none at a glance. This file
 * turns the payload the page already has into one word, one sentence, one
 * line per rule and one line for the schedule. It fetches nothing and decides
 * nothing; every figure here is read from W4's evaluation or the locked spec.
 *
 * 🔴 **Only conditions decide.** The word comes from condition states, never
 * from `support_score` — a thesis whose price moved the right way with a rule
 * tripped is "Rule tripped", not "Doing well". The score is shown beside the
 * word, as the number the board ranks by, and nothing more.
 *
 * 🔴 **No direction colour** (§ 2b principle 2). Tones here are the theme's
 * condition tones: `accent` for a trip, `warning` for can't-be-scored,
 * `neutral` for holding. A metric moving up or down gets words, not colour.
 *
 * 🔴 **The headline sentence is built from the numbers, not taken from the
 * researcher's prose** (owner decision 2026-09-15): model text stays in the
 * report and the notes, where it carries its provenance stamp.
 */

import { awaitingFirstObservation } from "./components/Scoreboard.js";
import { formatNumber, formatUtcDate } from "./format.js";
import type {
  ConditionResult,
  EvaluationResult,
  HypothesisSpec,
  SpecCondition,
  StateChangeRow,
} from "./api/types.js";

const MS_PER_DAY = 86_400_000;

export type StandingTone = "neutral" | "accent" | "warning" | "positive";

export interface Standing {
  /** One or two words, rendered large. */
  word: string;
  /** The theme's glyph for the tone, so the state survives greyscale. */
  glyph: string;
  tone: StandingTone;
  /** One plain sentence. */
  sentence: string;
}

/** Plural-aware "N rule(s)". */
function rules(n: number): string {
  return `${n} rule${n === 1 ? "" : "s"}`;
}

function conditionsOf(evaluation: EvaluationResult | null | undefined): ConditionResult[] {
  return Array.isArray(evaluation?.conditions) ? evaluation.conditions : [];
}

function specMetrics(spec: HypothesisSpec | null | undefined) {
  return Array.isArray(spec?.metrics) ? spec.metrics : [];
}

export function specConditions(spec: HypothesisSpec | null | undefined): SpecCondition[] {
  return Array.isArray(spec?.invalidation) ? spec.invalidation : [];
}

/** `+6.2%` / `-3.1%` / `0%` — signed, one decimal. */
export function signedPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${formatNumber(rounded, 1)}%`;
}

/**
 * The heaviest-weighted metric's move since go-live, as a clause:
 * "gold-futures is up 6.2% since go-live (expected up)". `null` when the
 * evaluation has no reading for it.
 */
export function leadMetricClause(
  spec: HypothesisSpec | null | undefined,
  evaluation: EvaluationResult | null | undefined,
): string | null {
  const metrics = specMetrics(spec);
  if (metrics.length === 0) return null;
  const lead = [...metrics].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0]!;
  const results = Array.isArray(evaluation?.metrics) ? evaluation.metrics : [];
  const result = results.find((m) => m?.slug === lead.slug);
  const pct = result?.realised_change_pct;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  const move = pct > 0 ? `up ${signedPercent(pct).slice(1)}` : pct < 0 ? `down ${signedPercent(-pct).slice(1)}` : "flat";
  const expected = typeof lead.direction === "string" ? ` (expected ${lead.direction})` : "";
  return `${lead.slug} is ${move} since go-live${expected}.`;
}

/**
 * The page's one-word answer. `null` for a draft, whose page is about the
 * interview and already says so in its next step.
 */
export function standingFor(
  status: string | null | undefined,
  evaluation: EvaluationResult | null | undefined,
  spec: HypothesisSpec | null | undefined,
): Standing | null {
  switch (status) {
    case "draft":
      return null;
    case "challenged":
      return {
        word: "Needs your verdict",
        glyph: "◉",
        tone: "accent",
        sentence: "A rule tripped or the horizon was reached. Confirm or invalidate the thesis. That call is yours, not the model's.",
      };
    case "confirmed":
      return { word: "Confirmed", glyph: "●", tone: "positive", sentence: "A human confirmed this thesis. It is finished." };
    case "invalidated":
      return { word: "Invalidated", glyph: "●", tone: "neutral", sentence: "A human invalidated this thesis. It is finished." };
    case "archived":
      return { word: "Archived", glyph: "●", tone: "neutral", sentence: "This hypothesis was archived. Nothing runs for it." };
    case "live":
      break;
    default:
      return null;
  }

  const conditions = conditionsOf(evaluation);
  if (evaluation === null || evaluation === undefined || conditions.length === 0) {
    return {
      word: "Too early to tell",
      glyph: "△",
      tone: "warning",
      sentence: "Nothing has been scored yet. The researcher's first run fills this in.",
    };
  }
  if (awaitingFirstObservation(evaluation)) {
    return {
      word: "Too early to tell",
      glyph: "△",
      tone: "warning",
      sentence: "It is live, but no data dated after go-live has arrived yet.",
    };
  }

  const total = conditions.length;
  const tripped = conditions.filter((c) => c.state === "tripped").length;
  const holding = conditions.filter((c) => c.state === "holding").length;
  const unscored = total - tripped - holding;
  const lead = leadMetricClause(spec, evaluation);
  const prefix = lead === null ? "" : `${lead} `;

  if (tripped > 0) {
    return {
      word: "Rule tripped",
      glyph: "◉",
      tone: "accent",
      sentence: `${prefix}${tripped} of ${rules(total)} has tripped.`,
    };
  }
  if (holding === 0) {
    return {
      word: "Too early to tell",
      glyph: "△",
      tone: "warning",
      sentence: `${prefix}None of the ${rules(total)} can be scored yet.`,
    };
  }
  const tail =
    unscored === 0
      ? `None of the ${rules(total)} has tripped.`
      : `Nothing has tripped. ${unscored} of ${rules(total)} can't be scored yet.`;
  return { word: "Holding", glyph: "●", tone: "neutral", sentence: `${prefix}${tail}` };
}

// ── The rules, one line each ────────────────────────────────────────────

const OP_WORDS: Record<string, string> = {
  gt: "above",
  gte: "at or above",
  lt: "below",
  lte: "at or below",
};

/** A statistic's value in its own unit: `+6.2%` for percentages, `1.034` for a ratio, `4,408.9` for a level. */
export function formatStat(value: number | null | undefined, stat: string | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  switch (stat) {
    case "change_pct":
      return signedPercent(value);
    case "drawdown_pct":
      return `${formatNumber(Math.round(value * 10) / 10, 1)}%`;
    case "ratio_to":
      return formatNumber(value, 3);
    default:
      return formatNumber(value, 2);
  }
}

export interface RuleLine {
  id: string;
  /** The spec's own sentence for the rule, else a mechanical one. */
  meaning: string;
  state: string;
  /** "now +6.2%" — `null` when there is no reading. */
  now: string | null;
  /** "trips below -15% for 14 days". */
  trips: string | null;
  /** "21.2 pts away" — only for a holding rule with a reading. */
  distance: string | null;
}

export function ruleLinesFor(
  evaluation: EvaluationResult | null | undefined,
  spec: HypothesisSpec | null | undefined,
): RuleLine[] {
  const byId = new Map(specConditions(spec).map((c) => [c.id, c]));
  const results = conditionsOf(evaluation);
  // Every rule in the spec gets a line, scored or not; results the spec does
  // not name still render, so an evaluator/spec mismatch is visible.
  const ids = [...byId.keys(), ...results.map((r) => r.id).filter((id) => !byId.has(id))];
  return ids.map((id) => {
    const cond = byId.get(id);
    const result = results.find((r) => r.id === id);
    const stat = cond?.stat;
    const op = cond?.op ?? result?.op;
    const threshold = cond?.threshold ?? result?.threshold;
    const meaning =
      typeof cond?.meaning === "string" && cond.meaning.trim() !== ""
        ? cond.meaning
        : `${result?.metric ?? cond?.metric ?? id} ${stat ?? ""} ${OP_WORDS[op ?? ""] ?? op ?? ""} ${threshold ?? ""}`.replace(/\s+/g, " ").trim();
    const value = result?.value;
    const hasValue = typeof value === "number" && Number.isFinite(value);
    const days = cond?.sustained_days;
    const trips =
      typeof threshold === "number" && op !== undefined
        ? `trips ${OP_WORDS[op] ?? op} ${formatStat(threshold, stat)}${typeof days === "number" && days > 1 ? ` for ${days} days` : ""}`
        : null;
    let distance: string | null = null;
    if (result?.state === "holding" && hasValue && typeof threshold === "number") {
      const gap = Math.abs(value - threshold);
      distance =
        stat === "change_pct" || stat === "drawdown_pct"
          ? `${formatNumber(Math.round(gap * 10) / 10, 1)} pts away`
          : `${formatStat(gap, stat)} away`;
    }
    return {
      id,
      meaning,
      state: result?.state ?? "indeterminate",
      now: hasValue ? `now ${formatStat(value, stat)}` : null,
      trips,
      distance,
    };
  });
}

// ── Time ────────────────────────────────────────────────────────────────

/** Go-live: the OLDEST `live` state change, the poller's own definition (`readLiveAtMs`). */
export function goLiveAtMs(history: readonly StateChangeRow[] | null | undefined): number | null {
  if (!Array.isArray(history)) return null;
  let oldest: number | null = null;
  for (const row of history) {
    if (row?.status !== "live" || typeof row.created_at_ms !== "number") continue;
    if (oldest === null || row.created_at_ms < oldest) oldest = row.created_at_ms;
  }
  return oldest;
}

export interface HorizonProgress {
  day: number;
  horizonDays: number;
  endsLabel: string;
  /** 0 … 1. */
  fraction: number;
}

export function horizonProgress(
  goLiveMs: number | null,
  horizonDays: number | null | undefined,
  nowMs: number,
): HorizonProgress | null {
  if (goLiveMs === null || typeof horizonDays !== "number" || !(horizonDays > 0)) return null;
  const elapsed = Math.max(0, nowMs - goLiveMs);
  const day = Math.min(horizonDays, Math.floor(elapsed / MS_PER_DAY) + 1);
  return {
    day,
    horizonDays,
    endsLabel: formatUtcDate(goLiveMs + horizonDays * MS_PER_DAY),
    fraction: Math.min(1, elapsed / (horizonDays * MS_PER_DAY)),
  };
}

const DOW_WORDS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * A cron in words, for the common shapes: "every day at 06:00 UTC",
 * "every Monday at 04:00 UTC", "on weekdays at 06:00 UTC". Anything else is
 * shown verbatim rather than guessed at.
 */
export function describeCron(cron: string | null | undefined): string | null {
  if (typeof cron !== "string" || cron.trim() === "") return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return `on the schedule "${cron}" (UTC)`;
  const [min, hour, dom, month, dow] = parts as [string, string, string, string, string];
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && month === "*") {
    const at = `${hour.padStart(2, "0")}:${min.padStart(2, "0")} UTC`;
    if (dow === "*") return `every day at ${at}`;
    if (dow === "1-5") return `on weekdays at ${at}`;
    if (/^[0-7]$/.test(dow)) return `every ${DOW_WORDS[Number(dow) % 7]} at ${at}`;
  }
  return `on the schedule "${cron}" (UTC)`;
}

/** "in 19 hours" / "in 5 minutes" — a future instant, relative to now. */
export function untilText(atMs: number | null | undefined, nowMs: number): string | null {
  if (typeof atMs !== "number" || !Number.isFinite(atMs)) return null;
  const delta = atMs - nowMs;
  if (delta <= 60_000) return "any minute now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(delta / 3_600_000);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(delta / MS_PER_DAY)} days`;
}
