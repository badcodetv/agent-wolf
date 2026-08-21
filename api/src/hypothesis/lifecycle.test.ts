import { describe, expect, it } from "vitest";

import { WolfError } from "../errors.js";
import {
  HYPOTHESIS_STATES,
  KeyedMutex,
  LEGAL_TRANSITIONS,
  TERMINAL_STATES,
  classifyTransition,
  createTransitioner,
  isHypothesisStatus,
  transitionKey,
  type HypothesisStatus,
} from "./lifecycle.js";

// design/2026-08-20-agent-wolf.md § "Hypothesis lifecycle" and W5's acceptance
// criteria. Test names are prefixed `lifecycle_` per the ticket.

/** Every ordered pair of states — 6 × 6 = 36 of them. */
const ALL_PAIRS: Array<[HypothesisStatus, HypothesisStatus]> = HYPOTHESIS_STATES.flatMap((from) =>
  HYPOTHESIS_STATES.map((to): [HypothesisStatus, HypothesisStatus] => [from, to]),
);

/**
 * The eight legal-and-effective edges, transcribed from the plan's table — NOT
 * read out of `LEGAL_TRANSITIONS`, which is the thing under test. A test that
 * asks the implementation what the answer is proves nothing.
 */
const EXPECTED_LEGAL: ReadonlyArray<[HypothesisStatus, HypothesisStatus]> = [
  ["draft", "live"],
  ["draft", "archived"],
  ["live", "challenged"],
  ["live", "archived"],
  ["challenged", "confirmed"],
  ["challenged", "invalidated"],
  ["challenged", "archived"],
  ["challenged", "live"],
];

function expectedClass(from: HypothesisStatus, to: HypothesisStatus): "legal" | "self" | "illegal" {
  if (from === to) return "self";
  return EXPECTED_LEGAL.some(([f, t]) => f === from && t === to) ? "legal" : "illegal";
}

describe("lifecycle_states", () => {
  it("lifecycle_states: the six states are exactly the plan's six", () => {
    expect([...HYPOTHESIS_STATES]).toEqual([
      "draft",
      "live",
      "challenged",
      "confirmed",
      "invalidated",
      "archived",
    ]);
  });

  it("lifecycle_states: confirmed, invalidated and archived are the terminal three", () => {
    expect([...TERMINAL_STATES].sort()).toEqual(["archived", "confirmed", "invalidated"]);
  });

  it("lifecycle_states: isHypothesisStatus rejects anything else", () => {
    expect(isHypothesisStatus("live")).toBe(true);
    expect(isHypothesisStatus("challenged")).toBe(true);
    expect(isHypothesisStatus("LIVE")).toBe(false);
    expect(isHypothesisStatus("retired")).toBe(false);
    expect(isHypothesisStatus(undefined)).toBe(false);
    expect(isHypothesisStatus(7)).toBe(false);
  });
});

// ── The exhaustive 36-pair table ────────────────────────────────────────

describe("lifecycle_table: all 36 ordered pairs fall in exactly three buckets", () => {
  it("lifecycle_table: the buckets are 8 legal-and-effective, 6 self no-ops, 22 illegal", () => {
    const counts = { legal: 0, self: 0, illegal: 0 };
    for (const [from, to] of ALL_PAIRS) counts[classifyTransition(from, to)] += 1;
    expect(ALL_PAIRS).toHaveLength(36);
    expect(counts).toEqual({ legal: 8, self: 6, illegal: 22 });
  });

  it("lifecycle_table: LEGAL_TRANSITIONS holds exactly the eight edges and no self-pair", () => {
    expect([...LEGAL_TRANSITIONS].sort()).toEqual(
      EXPECTED_LEGAL.map(([f, t]) => transitionKey(f, t)).sort(),
    );
    for (const state of HYPOTHESIS_STATES) {
      expect(LEGAL_TRANSITIONS.has(transitionKey(state, state))).toBe(false);
    }
  });

  it.each(ALL_PAIRS)(
    "lifecycle_table: %s → %s is classified as its bucket (legal-and-effective / self no-op / illegal)",
    (from, to) => {
      expect(classifyTransition(from, to)).toBe(expectedClass(from, to));
    },
  );

  it.each(ALL_PAIRS.filter(([f, t]) => expectedClass(f, t) === "illegal"))(
    "lifecycle_table (illegal bucket): %s → %s throws a conflict WolfError naming both states",
    async (from, to) => {
      const t = createTransitioner({ readCurrentStatus: async () => from });
      const error = await t
        .transition("1a2b3c4d", to, async () => "should-not-be-called")
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(WolfError);
      const wolf = error as WolfError;
      expect(wolf.kind).toBe("conflict");
      expect(wolf.status).toBe(409);
      expect(wolf.message).toContain(from);
      expect(wolf.message).toContain(to);
      expect(wolf.message).toContain("1a2b3c4d");
    },
  );

  it.each(ALL_PAIRS.filter(([f, t]) => expectedClass(f, t) === "legal"))(
    "lifecycle_table (legal-and-effective bucket): %s → %s writes exactly once",
    async (from, to) => {
      let writes = 0;
      const t = createTransitioner({ readCurrentStatus: async () => from });
      const outcome = await t.transition("1a2b3c4d", to, async () => {
        writes += 1;
        return "mem-1";
      });
      expect(writes).toBe(1);
      expect(outcome).toEqual({
        id: "1a2b3c4d",
        from,
        to,
        changed: true,
        memoryId: "mem-1",
      });
    },
  );

  it.each(HYPOTHESIS_STATES.map((s): [HypothesisStatus] => [s]))(
    "lifecycle_table (self no-op bucket): %s → %s neither throws nor writes",
    async (state) => {
      let writes = 0;
      const t = createTransitioner({ readCurrentStatus: async () => state });
      const outcome = await t.transition("1a2b3c4d", state, async () => {
        writes += 1;
        return "mem-1";
      });
      expect(writes).toBe(0);
      expect(outcome).toEqual({
        id: "1a2b3c4d",
        from: state,
        to: state,
        changed: false,
        memoryId: null,
      });
    },
  );
});

describe("lifecycle_terminal", () => {
  it.each([...TERMINAL_STATES].map((s): [HypothesisStatus] => [s]))(
    "lifecycle_terminal: no edge leaves %s",
    (terminal) => {
      for (const to of HYPOTHESIS_STATES) {
        if (to === terminal) continue;
        expect(classifyTransition(terminal, to)).toBe("illegal");
      }
    },
  );
});

describe("lifecycle_missing_state", () => {
  it("lifecycle_missing_state: a hypothesis with no trusted state row cannot be transitioned", async () => {
    const t = createTransitioner({ readCurrentStatus: async () => null });
    await expect(t.transition("1a2b3c4d", "live", async () => "mem-1")).rejects.toMatchObject({
      kind: "conflict",
    });
  });
});

// ── Serialisation ───────────────────────────────────────────────────────

describe("lifecycle_serialisation", () => {
  /**
   * The race the mutex exists to close: two callers move the same hypothesis
   * out of `challenged` at the same moment. There is no compare-and-swap on
   * memories, so without serialisation BOTH would read `challenged`, both would
   * append, and the later write would silently win.
   *
   * With it, one writes and the other re-reads `confirmed` inside the critical
   * section, where `confirmed → invalidated` is illegal.
   */
  it("lifecycle_serialisation: two concurrent transitions from the same state — one writes, one is rejected as illegal", async () => {
    let state: HypothesisStatus = "challenged";
    const writes: HypothesisStatus[] = [];
    const t = createTransitioner({
      readCurrentStatus: async () => {
        // A real read is a network round-trip; the yield is what would let an
        // unserialised second caller interleave.
        await new Promise((r) => setTimeout(r, 1));
        return state;
      },
    });
    const write = (to: HypothesisStatus) => async () => {
      await new Promise((r) => setTimeout(r, 1));
      writes.push(to);
      state = to;
      return `mem-${to}`;
    };

    const results = await Promise.allSettled([
      t.transition("1a2b3c4d", "confirmed", write("confirmed")),
      t.transition("1a2b3c4d", "invalidated", write("invalidated")),
    ]);

    expect(writes).toEqual(["confirmed"]);
    expect(state).toBe("confirmed");
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as WolfError;
    expect(reason).toBeInstanceOf(WolfError);
    expect(reason.kind).toBe("conflict");
    expect(reason.message).toContain("confirmed");
    expect(reason.message).toContain("invalidated");
  });

  it("lifecycle_serialisation: the second caller re-reads state INSIDE the critical section", async () => {
    // Both callers ask for `live` from `draft`. The first wins; the second
    // re-reads `live` and gets a self no-op — not a second write.
    let state: HypothesisStatus = "draft";
    let writes = 0;
    const t = createTransitioner({ readCurrentStatus: async () => state });
    const write = async () => {
      writes += 1;
      state = "live";
      return "mem-live";
    };
    const [a, b] = await Promise.all([
      t.transition("1a2b3c4d", "live", write),
      t.transition("1a2b3c4d", "live", write),
    ]);
    expect(writes).toBe(1);
    expect([a.changed, b.changed].sort()).toEqual([false, true]);
  });

  it("lifecycle_serialisation: serialisation is PER ID — two different ids proceed concurrently", async () => {
    const t = createTransitioner({ readCurrentStatus: async () => "draft" });
    let started = 0;
    let bothInFlight = false;
    // Each write waits for the other to have started. If the mutex were global
    // rather than per key this would deadlock and time out.
    const write = async () => {
      started += 1;
      const deadline = Date.now() + 1000;
      while (started < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1));
      }
      if (started >= 2) bothInFlight = true;
      return "mem";
    };
    await Promise.all([
      t.transition("1a2b3c4d", "live", write),
      t.transition("2b3c4d5e", "live", write),
    ]);
    expect(bothInFlight).toBe(true);
  });
});

describe("lifecycle_mutex", () => {
  it("lifecycle_mutex: work for one key runs in arrival order", async () => {
    const mutex = new KeyedMutex();
    const order: number[] = [];
    const task = (n: number, delayMs: number) => async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      order.push(n);
      return n;
    };
    await Promise.all([
      mutex.run("k", task(1, 8)),
      mutex.run("k", task(2, 4)),
      mutex.run("k", task(3, 0)),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("lifecycle_mutex: a rejected task does not wedge its key", async () => {
    const mutex = new KeyedMutex();
    await expect(
      mutex.run("k", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(mutex.run("k", async () => "after")).resolves.toBe("after");
  });

  it("lifecycle_mutex: keys are dropped once nothing is queued behind them", async () => {
    const mutex = new KeyedMutex();
    await mutex.run("k", async () => 1);
    // The tail is deleted in a microtask after settling.
    await new Promise((r) => setTimeout(r, 0));
    expect(mutex.size).toBe(0);
  });
});
