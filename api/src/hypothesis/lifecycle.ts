/**
 * The hypothesis state machine, and the per-id serialisation that makes it
 * mean anything.
 *
 * design/2026-08-20-agent-wolf.md § "Hypothesis lifecycle" (agent-orange repo)
 * is the authority for every constant in this file. Its table of legal
 * transitions is transcribed below edge for edge, including the one edge that
 * exists only because of owner decision B3 — `challenged → live`, without which
 * a human accepting a spec amendment leaves the hypothesis stuck at
 * `challenged` with its schedule still firing and no route back to normal
 * operation.
 *
 * Two rules that are easy to get subtly wrong, so they are stated here rather
 * than left to a reader of the table:
 *
 *  1. **A transition from a state to itself is a no-op, not an error.** It
 *     returns the current state and writes NOTHING. W10's poller re-asserts
 *     the state it computed on every tick; a machine that threw would force the
 *     poller to read-then-write under its own lock, which is more code at
 *     exactly the place concurrency bugs live.
 *  2. **The current state is re-read from Orange INSIDE the critical section.**
 *     There is no compare-and-swap on memories, so two writers that both read
 *     `challenged` and both appended would both succeed and the later one would
 *     silently win. Serialisation is per hypothesis id and in-process, which is
 *     sufficient only while wolf-api runs as a single instance — a stated
 *     constraint of the plan, not an oversight.
 */

import { WolfError } from "../errors.js";

// ── States ──────────────────────────────────────────────────────────────

/** The six states, in the order § "Hypothesis lifecycle" tabulates them. */
export const HYPOTHESIS_STATES = [
  "draft",
  "live",
  "challenged",
  "confirmed",
  "invalidated",
  "archived",
] as const;

export type HypothesisStatus = (typeof HYPOTHESIS_STATES)[number];

/**
 * The three states no edge leaves. "A hypothesis that needs to run again is a
 * new one, carrying `restated_from`."
 */
export const TERMINAL_STATES: ReadonlySet<HypothesisStatus> = new Set<HypothesisStatus>([
  "confirmed",
  "invalidated",
  "archived",
]);

export function isHypothesisStatus(value: unknown): value is HypothesisStatus {
  return typeof value === "string" && (HYPOTHESIS_STATES as readonly string[]).includes(value);
}

// ── The legal edge set ──────────────────────────────────────────────────

/**
 * The key under which one ordered pair is stored. `>` rather than `-` or `_`
 * because a state name can contain neither, so the key is unambiguous in both
 * directions.
 */
export function transitionKey(from: HypothesisStatus, to: HypothesisStatus): string {
  return `${from}>${to}`;
}

/**
 * **Exactly the eight ordered pairs of § "The legal transitions, enumerated"**,
 * and no others. Self-pairs are NOT in here — they are a third bucket
 * (`classifyTransition` below), because a self-pair is neither legal-and-
 * effective nor an error.
 */
export const LEGAL_TRANSITIONS: ReadonlySet<string> = new Set<string>([
  transitionKey("draft", "live"),
  transitionKey("draft", "archived"),
  transitionKey("live", "challenged"),
  transitionKey("live", "archived"),
  transitionKey("challenged", "confirmed"),
  transitionKey("challenged", "invalidated"),
  transitionKey("challenged", "archived"),
  // Owner decision B3. The amendment edge; the ASCII diagram in the plan draws
  // it ambiguously and the table, transcribed here, is authoritative.
  transitionKey("challenged", "live"),
]);

/**
 * Which of the three buckets an ordered pair falls in. The 36-pair table test
 * asserts 8 `legal`, 6 `self` and 22 `illegal`, which is the whole state
 * machine in one assertion.
 */
export type TransitionClass = "legal" | "self" | "illegal";

export function classifyTransition(from: HypothesisStatus, to: HypothesisStatus): TransitionClass {
  if (from === to) return "self";
  return LEGAL_TRANSITIONS.has(transitionKey(from, to)) ? "legal" : "illegal";
}

/**
 * The typed rejection. `conflict` (a state-machine rejection, § "Shared error
 * taxonomy") and the message names BOTH states — "cannot move a hypothesis
 * from X to Y" is actionable; "illegal transition" is not.
 */
export function illegalTransitionError(
  id: string,
  from: HypothesisStatus,
  to: HypothesisStatus,
): WolfError {
  const terminal = TERMINAL_STATES.has(from)
    ? ` — ${from} is terminal, and a hypothesis that needs to run again is a new one carrying restated_from`
    : "";
  return new WolfError(
    "conflict",
    `hypothesis ${id}: cannot move from ${from} to ${to}${terminal}`,
    { details: { id, from, to } },
  );
}

/** The rejection when there is no trusted state row to move from at all. */
export function missingStateError(id: string, to: HypothesisStatus): WolfError {
  return new WolfError(
    "conflict",
    `hypothesis ${id}: cannot move to ${to} — it has no trusted state row to move from`,
    { details: { id, to } },
  );
}

// ── Per-id serialisation ────────────────────────────────────────────────

/**
 * An in-process async mutex keyed by a string. Work for the SAME key runs one
 * at a time, in the order it arrived; work for DIFFERENT keys runs
 * concurrently, which is what stops one hypothesis's slow Orange round-trip
 * from stalling every other hypothesis on the board.
 *
 * The tail of each key's chain is dropped once nothing is queued behind it, so
 * a long-lived process does not accumulate one promise per hypothesis it has
 * ever touched.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  /** How many keys are currently held or queued. Test-visible on purpose. */
  get size(): number {
    return this.tails.size;
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key);
    // `previous` never rejects (see `settled` below), so a failed transition
    // does not wedge the key.
    const result: Promise<T> = previous === undefined ? fn() : previous.then(fn);
    const settled: Promise<void> = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, settled);
    void settled.then(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key);
    });
    return result;
  }
}

// ── The transition runner ───────────────────────────────────────────────

export interface TransitionOutcome {
  id: string;
  /** The state read inside the critical section. */
  from: HypothesisStatus;
  to: HypothesisStatus;
  /** False for a self-pair: nothing was written. */
  changed: boolean;
  /** The id of the appended memory, or null for a self-pair. */
  memoryId: string | null;
}

export interface TransitionContext {
  id: string;
  from: HypothesisStatus;
  to: HypothesisStatus;
}

export interface TransitionDeps {
  /**
   * Reads the CURRENT authoritative state. Called inside the critical section,
   * every time — a cached value read before the lock is exactly the race this
   * machine exists to close.
   */
  readCurrentStatus(id: string): Promise<HypothesisStatus | null>;
  /** Optional; supply one to share serialisation across several transitioners. */
  mutex?: KeyedMutex;
}

export interface Transitioner {
  /**
   * Moves `id` to `to`, serialised against every other transition of the same
   * id. `write` is called only for a legal, effective transition, and its
   * return value is the appended memory's id.
   */
  transition(
    id: string,
    to: HypothesisStatus,
    write: (ctx: TransitionContext) => Promise<string>,
  ): Promise<TransitionOutcome>;
  readonly mutex: KeyedMutex;
}

export function createTransitioner(deps: TransitionDeps): Transitioner {
  const mutex = deps.mutex ?? new KeyedMutex();
  return {
    mutex,
    transition(id, to, write) {
      return mutex.run(id, async () => {
        const from = await deps.readCurrentStatus(id);
        if (from === null) throw missingStateError(id, to);
        switch (classifyTransition(from, to)) {
          case "self":
            // No write, no error, no notification. This is what makes W10's
            // idempotence criterion mean anything.
            return { id, from, to, changed: false, memoryId: null };
          case "illegal":
            throw illegalTransitionError(id, from, to);
          case "legal": {
            const memoryId = await write({ id, from, to });
            return { id, from, to, changed: true, memoryId };
          }
        }
      });
    },
  };
}
