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
 * `GET /api/hypotheses/:id`. Only the fields W13 needs are typed; W14 widens
 * this (`spec`, `evaluation`, `notes`, `amendments`, `verdict`,
 * `attention_requests`, `atoms`) rather than declaring a second detail type.
 */
export interface HypothesisDetail {
  hypothesis: HypothesisDetailRow;
  spec_source: "hypothesis-spec" | "hypothesis-spec-candidate" | null;
  spec_validation: SpecValidation;
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
