import { describe, expect, it } from "vitest";
import { indeterminateCause, reasonPhrase } from "./reasons.js";

describe("reason glosses", () => {
  it("explains no_observations as day one, not as an empty series", () => {
    // W4 filters to observations at or after go-live, so a freshly live
    // hypothesis beside a chart of years of history lands here. "No
    // observations at all" read as a broken feed.
    expect(reasonPhrase("no_observations")).toMatch(/^no_observations: no observation dated at or after go-live/);
    expect(indeterminateCause("no_observations")).toContain("go-live");
  });

  it("keeps the raw token for a reason it does not know", () => {
    expect(reasonPhrase("stale_series")).toBe("stale_series");
  });
});
