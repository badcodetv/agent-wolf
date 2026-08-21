import { describe, expect, it } from "vitest";
import { toMs, toSec, type UnixMs, type UnixSec } from "./types.js";

describe("UnixMs / UnixSec branding", () => {
  it("toMs and toSec pass the numeric value through unchanged", () => {
    expect(toMs(1755600000000)).toBe(1755600000000);
    expect(toSec(1755600000)).toBe(1755600000);
  });

  it("1755600000000 !== 1755600000 — the units really are different numbers, not just different names", () => {
    // Named in the ticket as the runtime check that "proves nothing about
    // the code": it is true regardless of whether the branding below is
    // wired up correctly. It is here only as the numeric sanity check the
    // compile-time proof below builds on, not as a substitute for it.
    expect(1755600000000).not.toBe(1755600000);
  });

  it("a UnixSec is not assignable where a UnixMs is expected, and vice versa — compile-time only, this is the brand proof", () => {
    const ms: UnixMs = toMs(1755600000000);
    const sec: UnixSec = toSec(1755600000);

    function wantsMs(_v: UnixMs): void {
      /* no-op: this function exists only to be a typed sink for the assignability check below */
    }
    function wantsSec(_v: UnixSec): void {
      /* no-op, see wantsMs */
    }

    // Both of these compile: each value flows into the sink typed for its
    // own unit.
    wantsMs(ms);
    wantsSec(sec);

    // design/2026-08-20-agent-wolf.md, W2: "A field *name* creates no
    // TypeScript incompatibility, so a plainly-named `number` cannot
    // satisfy this." These two lines are the actual proof — each is a
    // genuine type error today because UnixMs and UnixSec are distinct
    // branded intersections, not just distinct names for `number`.
    //
    // The ticket's Validation deletes `& { readonly __unit: "ms" }` from
    // UnixMs in types.ts and re-runs `yarn typecheck`, expecting the
    // failure "Unused '@ts-expect-error' directive" — because once UnixMs
    // collapses to a plain `number`, `wantsMs(sec)` below stops being an
    // error (a UnixSec, being `number & {...}`, IS assignable to a bare
    // `number`), so this suppression comment becomes redundant and tsc
    // flags exactly that.
    // @ts-expect-error — a UnixSec is not a UnixMs.
    wantsMs(sec);

    // Symmetric case: a UnixMs is not a UnixSec. This one keeps failing
    // even after the deletion above (a bare `number` is never assignable
    // to the still-branded UnixSec), which is why the brand proof targets
    // UnixMs specifically, not this line.
    // @ts-expect-error — a UnixMs is not a UnixSec.
    wantsSec(ms);

    expect(true).toBe(true);
  });
});
