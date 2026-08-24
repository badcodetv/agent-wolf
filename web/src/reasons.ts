/**
 * W4's reason vocabulary, in words — **one gloss table in the tree**.
 *
 * The condition table and the scoreboard both render a reason, and two gloss
 * tables would drift the first time W4 gains a seventh value: one surface
 * would explain it and the other would show a bare token, and nobody would
 * notice which was which.
 *
 * 🔴 **The raw token always appears.** The gloss is additional. A reason
 * outside `EVALUATION_REASONS` — including `stale_series`, which W14's ticket
 * enumerates and which W4 does **not** emit (it emits `stale_data`) — renders
 * as the token alone rather than being dropped: a silently blank reason is how
 * a spec mistake, such as a percentage statistic on a zero-crossing series,
 * stays invisible for three weeks.
 */

/** W4's closed set, in words (`api/src/hypothesis/evaluate.ts`). */
export const REASON_GLOSS: Record<string, string> = {
  condition_tripped: "the condition's comparison held for its sustained window",
  insufficient_coverage: "too few observations in the window to judge",
  non_positive_reference: "the reference value was zero or negative, so a percentage means nothing",
  stale_data: "the series has not been updated recently enough to judge",
  no_observations: "the window contains no observations at all",
  no_ratio_pair: "the two series never had observations on the same day",
};

/** Shown when a degraded state carries no reason at all. Never a blank marker. */
export const NO_REASON_GIVEN = "no reason was recorded by the evaluator";

/** `<token>: <gloss>`, or the bare token when we do not recognise it, or the no-reason sentence. */
export function reasonPhrase(reason: string | null | undefined): string {
  const token = typeof reason === "string" ? reason.trim() : "";
  if (token === "") return NO_REASON_GIVEN;
  const gloss = REASON_GLOSS[token];
  return gloss === undefined ? token : `${token}: ${gloss}`;
}

/** The mandatory `Severity` cause for an `indeterminate` condition row. */
export function indeterminateCause(reason: string | null | undefined): string {
  return `indeterminate — ${reasonPhrase(reason)}`;
}

/**
 * The mandatory `Severity` cause for a stale metric on the scoreboard.
 *
 * 🔴 Driven by `EvaluationResult.metrics[].stale` + `stale_reason` — W4's
 * numbers, the ONE authority for the table and the scoreboard (UI design § 5).
 * The chart's hatching is the only thing that comes from the series route
 * instead, one layer down.
 */
export function staleMetricCause(slug: string, reason: string | null | undefined): string {
  return `${slug} is stale — ${reasonPhrase(reason)}`;
}
