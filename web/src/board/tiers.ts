/**
 * Grouping and sorting for the attention queue —
 * `design/2026-08-24-agent-wolf-ui.md` § 4 (agent-orange repo).
 *
 * 🔴 **This module does NOT decide which tier a row belongs to.** The tier is
 * `attention_tier`, computed SERVER-SIDE by W27 from § 4's membership table.
 * A client that re-derived it from `status`/`tamper`/`support_score` would put
 * the attention model in two places — the same defect class as putting the
 * go-live validator in the browser, and it would drift the moment W27's rules
 * changed. All this file does is group rows the server has already tiered,
 * and sort within each tier.
 *
 * 🔴 **There is no chronological fallback.** A row whose `attention_tier` is
 * absent, `null`, or not one of W27's four values is rendered in
 * **NEEDS A HUMAN**, flagged `unclassified` so the board can caption it. That
 * follows the standing doctrine `api/src/routes/hypotheses.ts` states for the
 * board payload — *"an anomaly is RENDERED, never dropped"* — and W13's own
 * rule that an unknown status chip value renders verbatim rather than falling
 * back to `draft`. A board that silently listed unclassified rows by date
 * would look correct and be wrong, which is the failure this product exists to
 * make impossible.
 */

import {
  ATTENTION_TIERS,
  isAttentionTier,
  TERMINAL_STATES,
  type AttentionTier,
  type BoardRow,
} from "../api/types.js";

/** § 4's headings. "**a human**", never "you": anyone allowlisted may act on anything — `owner` is a byline. */
export const TIER_HEADINGS: Record<AttentionTier, string> = {
  needs_human: "NEEDS A HUMAN",
  watch: "WATCH",
  in_interview: "IN INTERVIEW",
  holding: "HOLDING",
};

/** Shown under a row the server did not tier. Visible, not inferred. */
export const UNCLASSIFIED_CAPTION =
  "tier could not be classified — shown here so it is not lost";

export interface TieredRow {
  row: BoardRow;
  /** True when `attention_tier` was absent or unrecognised. */
  unclassified: boolean;
}

export type BoardGroups = Record<AttentionTier, TieredRow[]>;

/**
 * Nulls sort LAST in both directions. A missing `support_score` is "not
 * evaluated yet", which is neither the worst nor the best row on the board,
 * and treating it as either would rank a hypothesis by an absence.
 */
function compareNumbers(a: number | null, b: number | null, direction: "asc" | "desc"): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction === "asc" ? a - b : b - a;
}

/** § 4's "Sort within tier" column. */
const SORTERS: Record<AttentionTier, (a: BoardRow, b: BoardRow) => number> = {
  needs_human: (a, b) => compareNumbers(a.updated_at_ms, b.updated_at_ms, "desc"),
  // Worst first: the point of WATCH is the thesis that is going wrong.
  watch: (a, b) => compareNumbers(a.support_score, b.support_score, "asc"),
  in_interview: (a, b) => compareNumbers(a.updated_at_ms, b.updated_at_ms, "desc"),
  holding: (a, b) => compareNumbers(a.support_score, b.support_score, "desc"),
};

export function groupByTier(rows: readonly BoardRow[]): BoardGroups {
  const groups: BoardGroups = { needs_human: [], watch: [], in_interview: [], holding: [] };

  for (const row of rows) {
    const known = isAttentionTier(row.attention_tier);
    const tier: AttentionTier = known ? (row.attention_tier as AttentionTier) : "needs_human";
    groups[tier].push({ row, unclassified: !known });
  }

  for (const tier of ATTENTION_TIERS) {
    // The id tiebreak makes the order total, so two rows with equal scores do
    // not swap places between renders of the same data.
    groups[tier].sort(
      (a, b) => SORTERS[tier](a.row, b.row) || a.row.id.localeCompare(b.row.id),
    );
  }

  return groups;
}

/**
 * The board shows live work; terminal hypotheses live on `/archive`
 * (§ 3 "Information architecture": "Terminal states (`confirmed`,
 * `invalidated`, `archived`) leave the board").
 *
 * This is a STATUS filter, not a tier computation — it does not touch
 * `attention_tier` and does not reorder anything. An unknown or null status is
 * NOT terminal and stays on the board: a hypothesis whose state row was forged
 * or hostilely retracted has `status: null`, and the one place it must not
 * vanish from is the queue of things needing a human.
 */
export function partitionBoard(rows: readonly BoardRow[]): {
  active: BoardRow[];
  terminal: BoardRow[];
} {
  const active: BoardRow[] = [];
  const terminal: BoardRow[] = [];
  for (const row of rows) {
    (typeof row.status === "string" && TERMINAL_STATES.has(row.status) ? terminal : active).push(row);
  }
  return { active, terminal };
}
