import { describe, expect, it } from "vitest";
import { toSec, type DeliveryRecord } from "../bob/types.js";
import { nextCronRunMs, researchStatusFrom } from "./research.js";

const at = (iso: string): number => Date.parse(iso);

function delivery(over: Partial<DeliveryRecord>): DeliveryRecord {
  return {
    id: "d",
    project: "wolf",
    eventId: "e",
    subscriptionId: "sched-1",
    sessionId: "",
    worker: "researcher-1a1a1a1a",
    scheduleId: "sched-1",
    status: "ok",
    failureReason: "",
    startedAtSec: toSec(0),
    endedAtSec: toSec(0),
    createdAtSec: toSec(0),
    updatedAtSec: toSec(0),
    ...over,
  };
}

describe("nextCronRunMs", () => {
  it("finds the next daily 06:00 UTC, today or tomorrow", () => {
    expect(nextCronRunMs("0 6 * * *", at("2026-09-13T05:59:30Z"))).toBe(at("2026-09-13T06:00:00Z"));
    expect(nextCronRunMs("0 6 * * *", at("2026-09-13T06:00:00Z"))).toBe(at("2026-09-14T06:00:00Z"));
    expect(nextCronRunMs("0 6 * * *", at("2026-12-31T08:25:00Z"))).toBe(at("2027-01-01T06:00:00Z"));
  });

  it("handles steps, lists, names and the either-day rule", () => {
    expect(nextCronRunMs("*/15 * * * *", at("2026-09-13T08:16:00Z"))).toBe(at("2026-09-13T08:30:00Z"));
    // 2026-09-13 is a Sunday; Mondays at 04:00.
    expect(nextCronRunMs("0 4 * * mon", at("2026-09-13T08:00:00Z"))).toBe(at("2026-09-14T04:00:00Z"));
    // Day 20 OR a Sunday — the Sunday comes first.
    expect(nextCronRunMs("0 0 20 * 0", at("2026-09-14T00:00:00Z"))).toBe(at("2026-09-20T00:00:00Z"));
    expect(nextCronRunMs("30 1,13 * * *", at("2026-09-13T02:00:00Z"))).toBe(at("2026-09-13T13:30:00Z"));
  });

  it("answers null for an expression it cannot parse or that never fires", () => {
    expect(nextCronRunMs("@daily", 0)).toBeNull();
    expect(nextCronRunMs("61 * * * *", 0)).toBeNull();
    expect(nextCronRunMs("0 0 30 2 *", at("2026-01-01T00:00:00Z"))).toBeNull();
  });
});

describe("researchStatusFrom", () => {
  const schedule = { cron: "0 6 * * *", enabled: true };
  const now = at("2026-09-13T08:20:00Z");

  it("is idle with no deliveries, and still says when the first run is", () => {
    expect(researchStatusFrom(schedule, [], now)).toEqual({
      state: "idle",
      started_at_ms: null,
      last_finished_at_ms: null,
      last_outcome: null,
      next_run_at_ms: at("2026-09-14T06:00:00Z"),
      cron: "0 6 * * *",
    });
  });

  it("is running while the newest delivery runs, with the previous run as history", () => {
    const status = researchStatusFrom(
      schedule,
      [
        delivery({ id: "old", status: "ok", createdAtSec: toSec(100), startedAtSec: toSec(101), endedAtSec: toSec(400) }),
        delivery({ id: "new", status: "running", createdAtSec: toSec(1000), startedAtSec: toSec(1005) }),
      ],
      now,
    );
    expect(status.state).toBe("running");
    expect(status.started_at_ms).toBe(1_005_000);
    expect(status.last_finished_at_ms).toBe(400_000);
    expect(status.last_outcome).toBe("ok");
  });

  it("is queued for a pending delivery, dated from when it was queued", () => {
    const status = researchStatusFrom(schedule, [delivery({ status: "pending", createdAtSec: toSec(2000) })], now);
    expect(status.state).toBe("queued");
    expect(status.started_at_ms).toBe(2_000_000);
  });

  it("does not call a delivery parked at awaiting_human running", () => {
    const status = researchStatusFrom(schedule, [delivery({ status: "awaiting_human", createdAtSec: toSec(10) })], now);
    expect(status.state).toBe("idle");
  });

  it("names no next run for a disabled schedule", () => {
    expect(researchStatusFrom({ ...schedule, enabled: false }, [], now).next_run_at_ms).toBeNull();
  });
});
