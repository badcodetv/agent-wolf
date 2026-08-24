// @vitest-environment node
//
// 🔴 This file forces the process into `Asia/Tokyo` BEFORE anything formats a
// date. The machine that runs CI is in `Europe/London`, where a
// local-time formatter agrees with a UTC one for most of the day — so a UTC
// assertion written on a London box is very nearly vacuous. Tokyo is UTC+9
// with no DST, so every timestamp in the last nine hours of a UTC day lands
// on the NEXT local day, and a local-time formatter goes red on every case
// below.
//
// Node re-reads `process.env.TZ` and invalidates its `Intl` cache when the
// variable is assigned at runtime (verified against Node 20 on this machine),
// which is what makes this possible without a separate process.
const ORIGINAL_TZ = process.env["TZ"];
process.env["TZ"] = "Asia/Tokyo";

import { afterAll, describe, expect, it } from "vitest";
import {
  ABSENT,
  formatNumber,
  formatPercent,
  formatUtcAxisTick,
  formatUtcDate,
  formatUtcDateTime,
  formatUtcWindow,
} from "./format.js";

/** 23:30 on 12 August UTC — 08:30 on 13 August in Tokyo. */
const LATE_ON_THE_12TH = Date.UTC(2026, 7, 12, 23, 30);

afterAll(() => {
  // Restored rather than set to UTC: vitest may run several files in one
  // worker process, and leaving a different zone behind would silently change
  // what a later file's date assertions mean.
  if (ORIGINAL_TZ === undefined) delete process.env["TZ"];
  else process.env["TZ"] = ORIGINAL_TZ;
});

describe("the timezone this suite runs in", () => {
  it("is NOT UTC, so the assertions below can actually fail", () => {
    // Without this the whole file is decoration: on a UTC runner a local
    // formatter and a UTC formatter agree on every input.
    expect(new Date(LATE_ON_THE_12TH).getHours()).not.toBe(23);
    expect(new Date(LATE_ON_THE_12TH).getDate()).toBe(13);
  });
});

describe("formatUtcDate", () => {
  it("renders the UTC calendar day, not the reader's", () => {
    expect(formatUtcDate(LATE_ON_THE_12TH)).toBe("12 Aug 2026");
  });

  it("agrees with the ISO string, which is UTC by definition", () => {
    expect(formatUtcDate(LATE_ON_THE_12TH).startsWith("12 ")).toBe(true);
    expect(new Date(LATE_ON_THE_12TH).toISOString().startsWith("2026-08-12")).toBe(true);
  });

  it("renders an absent timestamp as an em dash, never as an epoch date", () => {
    expect(formatUtcDate(null)).toBe(ABSENT);
    expect(formatUtcDate(undefined)).toBe(ABSENT);
    expect(formatUtcDate(Number.NaN)).toBe(ABSENT);
  });
});

describe("formatUtcAxisTick", () => {
  it("drops the year but keeps the UTC day", () => {
    expect(formatUtcAxisTick(LATE_ON_THE_12TH)).toBe("12 Aug");
  });
});

describe("formatUtcDateTime", () => {
  it("renders the UTC clock time and names the zone", () => {
    expect(formatUtcDateTime(LATE_ON_THE_12TH)).toBe("12 Aug 2026 23:30 UTC");
  });
});

describe("formatUtcWindow", () => {
  it("renders both edges in UTC", () => {
    expect(formatUtcWindow(Date.UTC(2026, 5, 1), LATE_ON_THE_12TH)).toBe("1 Jun 2026–12 Aug 2026");
  });
});

describe("formatNumber / formatPercent", () => {
  it("renders a real zero as 0 and an absent value as an em dash", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(null)).toBe(ABSENT);
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(null)).toBe(ABSENT);
  });

  it("keeps a negative percentage's sign and adds no other decoration", () => {
    expect(formatPercent(-12.4)).toBe("-12.4%");
    expect(formatPercent(12.4)).toBe("12.4%");
  });
});
