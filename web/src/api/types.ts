/**
 * The wire shapes `web/` reads, declared HERE and driven from fixtures.
 *
 * These mirror `api/src/routes/hypotheses.ts` (`BoardRow`, `HypothesisDetail`)
 * and `api/src/routes/embed.ts` (`EmbedTokenResponse`) — snake_case on the
 * wire, and the unit in every timestamp's name: `_ms` is unix
 * **milliseconds** (memories), `_sec` is unix **seconds** (Orange's `agent_*`
 * tables, and an embed token's `exp` claim). The plan's § "Environment facts"
 * says the two units differ deliberately and must not be unified; encoding
 * the unit in the name is how that stays visible on this side too.
 *
 * ⚠️ `web/` NEVER imports from `api/` — the import boundary
 * (`src/import-boundary.test.ts`) forbids it, and these two packages ship
 * separately. So this file is a hand-kept mirror, and the wire is the
 * contract. Where a field is not yet served, it is declared OPTIONAL here and
 * every test that exercises it drives it from a fixture:
 *
 *   - `attention_tier`, `attention_count`, `stale_count` — **W27** computes
 *     these server-side. W13 renders them; W13 does NOT compute them (that
 *     would put the attention model in two places, the same defect class as
 *     putting the go-live validator in the browser). The names here are
 *     pinned by W27's own acceptance criteria.
 *   - `headline` — **W22** adds it (line 1 of the newest `kind=report`
 *     snippet). `null` means "no report yet"; `""` means "the report said
 *     nothing on line 1". They must stay distinguishable, so neither is
 *     defaulted into the other.
 *   - `restated_from` — served today on the DETAIL payload only, which is why
 *     the Archive page reads lineage from there. See `pages/Archive.tsx`.
 */

/** Unix milliseconds. */
export type UnixMs = number;
/** Unix seconds. */
export type UnixSec = number;

/** The six lifecycle states, in `api/src/hypothesis/lifecycle.ts`'s order. */
export const HYPOTHESIS_STATES = [
  "draft",
  "live",
  "challenged",
  "confirmed",
  "invalidated",
  "archived",
] as const;

export type HypothesisStatus = (typeof HYPOTHESIS_STATES)[number];

/** The three states no edge leaves. They leave the board and live on `/archive`. */
export const TERMINAL_STATES: ReadonlySet<string> = new Set<string>([
  "confirmed",
  "invalidated",
  "archived",
]);

export function isHypothesisStatus(value: unknown): value is HypothesisStatus {
  return typeof value === "string" && (HYPOTHESIS_STATES as readonly string[]).includes(value);
}

/**
 * The pinned tamper shape (`api/src/hypothesis/store.ts`). ALL FOUR fields are
 * always present; the unused provenance field is `""`, never absent.
 */
export interface Tamper {
  reason: "forged_row" | "hostile_retraction" | "cross_hypothesis_write";
  written_by_worker: string;
  written_by_session: string;
  memory_id: string;
}

export interface ConditionsSummary {
  tripped: number;
  holding: number;
  indeterminate: number;
  evaluated_at_ms: UnixMs;
}

/** W27's four tiers, spelled exactly as its acceptance criteria pin them. */
export const ATTENTION_TIERS = ["needs_human", "watch", "in_interview", "holding"] as const;
export type AttentionTier = (typeof ATTENTION_TIERS)[number];

export function isAttentionTier(value: unknown): value is AttentionTier {
  return typeof value === "string" && (ATTENTION_TIERS as readonly string[]).includes(value);
}

/** One row of `GET /api/hypotheses`. */
export interface BoardRow {
  id: string;
  title: string | null;
  /** True when the 500-byte snippet cut line 1: the UI must never claim the title is complete. */
  title_truncated: boolean;
  owner: string | null;
  /** `null` when no trusted state row survives — an anomaly, rendered, never dropped. */
  status: HypothesisStatus | string | null;
  support_score: number | null;
  conditions_summary: ConditionsSummary | null;
  updated_at_ms: UnixMs | null;
  tamper?: Tamper[];
  /** W27. Absent or unrecognised ⇒ the row is rendered in NEEDS A HUMAN as unclassified. */
  attention_tier?: AttentionTier | string | null;
  /** W27. **ABSENT STAYS ABSENT** — never defaulted to 0, which would render as a real zero. */
  attention_count?: number;
  /** W27. Same rule. */
  stale_count?: number;
  /** W22. `null` = no report yet; `""` = the report said nothing. Distinguishable. */
  headline?: string | null;
}

/** One `{ path, message }` from the server-side spec validator. The ONLY source of the Go Live gate. */
export interface SpecError {
  path: string;
  message: string;
}

export interface SpecValidation {
  valid: boolean;
  errors: SpecError[];
}

export interface HypothesisDetailRow {
  id: string;
  session_name: string;
  session_id: string | null;
  title: string | null;
  title_truncated: boolean;
  owner: string | null;
  status: HypothesisStatus | string | null;
  status_memory_id: string | null;
  updated_at_ms: UnixMs | null;
  restated_from: string | null;
  tamper?: Tamper[];
}

/**
 * `GET /api/hypotheses/:id` — the whole detail payload, widened by W14.
 *
 * There is ONE detail type and ONE detail fetch. Every block below is served
 * today by `api/src/routes/hypotheses.ts` except `challenge_reason`, which is
 * declared optional for the reason W13 declared `headline` optional: the field
 * does not exist on the wire yet, and inventing it client-side would put the
 * challenge reason in two places. See `components/ChallengedCase.tsx`.
 *
 * 🔴 Every optional-looking block must degrade rather than throw. W13's fix
 * round found an absent `spec_validation` throwing INSIDE render, which
 * unmounted the whole page (R140) — a missing field is a smaller failure than
 * a blank page, and the code must keep it that way.
 */
export interface HypothesisDetail {
  hypothesis: HypothesisDetailRow;
  /** The locked spec, else the newest candidate. `unknown | null` on the wire. */
  spec?: HypothesisSpec | null;
  spec_source: "hypothesis-spec" | "hypothesis-spec-candidate" | null;
  spec_validation: SpecValidation;
  /** W4's snapshot. `null` = never evaluated, which is day one for every hypothesis. */
  evaluation?: EvaluationResult | null;
  /** `kind=research-note` rows — UNTRUSTED, 500-byte snippets. */
  notes?: EvidenceRow[];
  /** `kind=spec-amendment` rows — UNTRUSTED proposals, 500-byte snippets. */
  amendments?: EvidenceRow[];
  verdict?: VerdictRow | null;
  attention_requests?: AttentionRequestRow[];
  atoms?: HypothesisAtoms;
  /**
   * ⚠️ **NOT SERVED TODAY.** W10 writes the challenge reason as the state
   * memory's `rationale`, and `GET /api/hypotheses/:id` does not carry it —
   * `detailRow()` projects ten fields and this is not one of them. Declared
   * here so the UI renders it the moment an API ticket adds it, and says so
   * plainly meanwhile.
   */
  challenge_reason?: ChallengeReason | string | null;
}

/** `GET /api/hypotheses/:id/embed-token`. `expires_at_sec` is unix SECONDS. */
export interface EmbedTokenResponse {
  token: string;
  expires_at_sec: UnixSec;
  /** `${ORANGE_PUBLIC_URL}/embed/session/hyp-<id>` — no fragment, and NOT what the rail uses (see `OrangeChatFrame`). */
  embed_url: string;
}

/** `GET /api/auth/me`. */
export interface SignedInUser {
  email: string;
}

// ── W14: the detail payload's remaining blocks ──────────────────────────
//
// Everything below mirrors `api/src/routes/hypotheses.ts` (the detail
// response), `api/src/hypothesis/evaluate.ts` (the evaluation W4 computes)
// and `api/src/routes/series.ts` (the series proxy). Same rule as above:
// `web/` never imports from `api/`, so this is a hand-kept mirror and the
// wire is the contract.
//
// 🔴 Two of these shapes are typed HERE more narrowly than the server types
// them. `HypothesisDetail.evaluation` and `.spec` are both `unknown | null`
// on the wire, because the server hands back whatever JSON the memory
// carried without re-validating it. Declaring them as the shapes W4 and W3
// produce is what makes this file useful — but it also means **every reader
// must treat them as untyped at runtime**: read arrays through
// `Array.isArray`, and never assume a field is present because the interface
// says so. `evaluation: null` (never evaluated) is the ordinary case on day
// one and must degrade, never throw.

/** One observation. § "Shared shapes": unix MILLISECONDS. */
export interface Point {
  tMs: UnixMs;
  v: number;
}

/** `api/src/hypothesis/evaluate.ts`. */
export type ConditionState = "tripped" | "holding" | "indeterminate";

export function isConditionState(value: unknown): value is ConditionState {
  return value === "tripped" || value === "holding" || value === "indeterminate";
}

/**
 * W4's CLOSED reason vocabulary, copied from `api/src/hypothesis/evaluate.ts`.
 *
 * ⚠️ W14's ticket enumerates `stale_series`, and **no such value exists** —
 * W4 emits `stale_data`. The list below is the code's, not the ticket's, and
 * anything outside it (including `stale_series`) is rendered VERBATIM rather
 * than dropped: a silently blank reason is how a spec mistake stays
 * invisible. See `components/ConditionTable.tsx`.
 */
export const EVALUATION_REASONS = [
  "condition_tripped",
  "insufficient_coverage",
  "non_positive_reference",
  "stale_data",
  "no_observations",
  "no_ratio_pair",
] as const;

export type EvaluationReason = (typeof EVALUATION_REASONS)[number];

/** The EXPECTED direction from the spec. `flat` is legal (R65). */
export type MetricDirection = "up" | "down" | "flat";

/** The five statistics of § "Condition semantics" (the API's `spec.ts`). */
export type ConditionStat = "level" | "change_abs" | "change_pct" | "drawdown_pct" | "ratio_to";

export type ConditionOp = "gt" | "gte" | "lt" | "lte";

/** One row of `EvaluationResult.conditions`. Note the `_ms` suffixes: the ticket writes `window_start`/`window_end`, the code writes `window_start_ms`/`window_end_ms`. */
export interface ConditionResult {
  id: string;
  metric: string;
  state: ConditionState | string;
  /** W4's reason. Never a free string in principle; rendered verbatim in practice. */
  reason: EvaluationReason | string | null;
  /** The statistic at the most recent non-skipped observation in the window. */
  value: number | null;
  threshold: number;
  op: ConditionOp | string;
  window_start_ms: UnixMs;
  window_end_ms: UnixMs;
  observations_in_window: number;
}

/**
 * One row of `EvaluationResult.metrics`.
 *
 * 🔴 `stale` + `stale_reason` are **the authority** for the condition table
 * and the scoreboard (UI design § 5, "One source of truth for staleness").
 * The chart's hatching is the one thing they do NOT decide — that comes from
 * `SeriesResponse.state`, one layer down.
 */
export interface MetricResult {
  slug: string;
  direction: MetricDirection | string;
  realised_change_pct: number | null;
  last_observation_ms: UnixMs | null;
  stale: boolean;
  stale_reason: EvaluationReason | string | null;
}

/** W4's whole object. `null` on the wire until the poller has run once. */
export interface EvaluationResult {
  evaluated_at_ms: UnixMs;
  /** −1 … +1. A SUMMARY for humans; it never trips anything. */
  support_score: number;
  conditions: ConditionResult[];
  metrics: MetricResult[];
}

/** One condition of the locked/candidate spec — the only source of a condition's `stat`. */
export interface SpecCondition {
  id: string;
  metric: string;
  stat: ConditionStat | string;
  op: ConditionOp | string;
  threshold: number;
  sustained_days: number;
  meaning: string;
  reference?: string;
  reference_days?: number;
  ratio_metric?: string;
  ratio_lookback_days?: number;
}

export interface SpecMetric {
  slug: string;
  source: string;
  series_id?: string;
  direction: MetricDirection | string;
  weight: number;
  unit: string;
}

/** The API's `Spec` (its `spec.ts`). Served as `unknown` — read defensively. */
export interface HypothesisSpec {
  thesis: string;
  horizon_days: number;
  flat_band_pct: number;
  staleness_days: number;
  metrics: SpecMetric[];
  invalidation: SpecCondition[];
}

/** The API's `DEFAULT_STALENESS_DAYS`. */
export const DEFAULT_STALENESS_DAYS = 5;

/**
 * One UNTRUSTED evidence row (`EvidenceRow` in `api/src/routes/hypotheses.ts`).
 *
 * 🔴 `snippet` is a **500-byte cut**, not the full content. Nothing built on
 * it may claim completeness.
 */
export interface EvidenceRow {
  id: string;
  snippet: string;
  status: string | null;
  created_at_ms: UnixMs;
  created_by_worker: string;
  created_by_session: string;
}

/** The trusted `kind=verdict` row, read in FULL (`content`, not a snippet). */
export interface VerdictRow {
  id: string;
  status: string | null;
  content: string;
  created_at_ms: UnixMs;
}

/** `created_at_sec` is unix SECONDS — Orange's `agent_*` tables, not a memory. */
export interface AttentionRequestRow {
  id: string;
  message: string;
  created_at_sec: UnixSec;
  session_id: string;
  worker: string;
}

export interface HypothesisAtoms {
  session_id: string | null;
  worker: string;
  schedule_id: string | null;
  datasets: string[];
}

/** Why W10's poller moved a hypothesis to `challenged` (`api/src/hypothesis/poller.ts`). */
export const CHALLENGE_REASONS = ["condition_tripped", "horizon_reached"] as const;
export type ChallengeReason = (typeof CHALLENGE_REASONS)[number];

/** `GET /api/hypotheses/:id/series/:metric` — exactly one of three, never a boolean. */
export type SeriesState = "ok" | "never_fetched" | "stale";

export interface SeriesResponse {
  /** Ascending `{ tMs, v }`, unix MILLISECONDS. */
  points: Point[];
  unit: string;
  /** `0` when never written. */
  version: number;
  fetched_at_ms: UnixMs;
  /** 🔴 The AUTHORITY for the chart's hatching. The client never recomputes it. */
  state: SeriesState;
}

/** The verdict a human can record. The wire values are these two and no others. */
export type HumanVerdict = "confirmed" | "invalidated";

/** The amendment decision. 🔴 `accept`/`reject` — NOT `accepted`/`rejected` (`amendBody`). */
export type AmendmentDecision = "accept" | "reject";
