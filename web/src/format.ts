/**
 * Formatting helpers, written down ONCE.
 *
 * Two rules live here rather than in five components:
 *
 *  1. 🔴 **Every date this product renders is UTC.** Observations, windows,
 *     evaluation timestamps and dataset ticks are all unix milliseconds
 *     produced server-side against UTC days, and rendering them in the
 *     reader's local zone silently moves an observation across a day boundary
 *     — which, on a chart whose whole job is "when did this last update",
 *     is a lie. `format.test.ts` proves this by forcing the process into
 *     `Asia/Tokyo` and asserting the UTC calendar day survives.
 *  2. **An absent number renders as `—`, never as `0`.** A zero is a real
 *     reading; the absence of one is not, and the two must never be confused
 *     — the same rule W13 applies to `attention_count`.
 *
 * The plan pins native `Date` plus explicit UTC helpers and forbids moment and
 * dayjs: "the units are the bug surface, keep them visible".
 */

/** What every absent value renders as. Never `0`, never blank. */
export const ABSENT = "—";

const UTC_DATE = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric",
});

const UTC_DAY_MONTH = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
});

const UTC_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function usable(ms: number | null | undefined): ms is number {
  return typeof ms === "number" && Number.isFinite(ms);
}

/** `12 Aug 2026`, in UTC. */
export function formatUtcDate(ms: number | null | undefined): string {
  return usable(ms) ? UTC_DATE.format(ms) : ABSENT;
}

/** `12 Aug`, in UTC — the chart axis, where the year is noise on a 180-day horizon. */
export function formatUtcAxisTick(ms: number | null | undefined): string {
  return usable(ms) ? UTC_DAY_MONTH.format(ms) : ABSENT;
}

const UTC_MONTH_YEAR = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  month: "short",
  year: "numeric",
});

/**
 * The axis formatter for a series running from `firstMs` to `lastMs`.
 *
 * 🔴 A year-less tick is only honest on a range inside one calendar year. A
 * Bitcoin series with years of history read "9 Oct · 9 Apr · 9 Oct · 9 Apr"
 * along the axis (2026-09-13 walk), which says nothing about WHEN. So: more
 * than a year of data ticks as `Oct 2021`; a range crossing a new year ticks
 * as `12 Dec 2025`; anything else keeps `12 Aug`.
 */
export function utcAxisTickFormatterFor(
  firstMs: number | null | undefined,
  lastMs: number | null | undefined,
): (ms: number | null | undefined) => string {
  if (!usable(firstMs) || !usable(lastMs)) return formatUtcAxisTick;
  const span = Math.abs(lastMs - firstMs);
  if (span > 365 * 86_400_000) {
    return (ms) => (usable(ms) ? UTC_MONTH_YEAR.format(ms) : ABSENT);
  }
  if (new Date(firstMs).getUTCFullYear() !== new Date(lastMs).getUTCFullYear()) return formatUtcDate;
  return formatUtcAxisTick;
}

/** `12 Aug 2026 23:30 UTC`. The zone is named because the reader is not in it. */
export function formatUtcDateTime(ms: number | null | undefined): string {
  return usable(ms) ? `${UTC_DATE.format(ms)} ${UTC_TIME.format(ms)} UTC` : ABSENT;
}

/** `2026-06-01→2026-08-21`, in UTC — a condition's evaluation window. */
export function formatUtcWindow(startMs: number | null | undefined, endMs: number | null | undefined): string {
  return `${formatUtcDate(startMs)}–${formatUtcDate(endMs)}`;
}

/**
 * A figure, at most `maxFractionDigits` decimals, grouped.
 *
 * 🔴 No sign styling and no colour anywhere near this function: § 2b
 * principle 2 forbids colouring a metric by which way it moved, because a
 * thesis predicting a fall SUCCEEDS when the line drops.
 */
export function formatNumber(value: number | null | undefined, maxFractionDigits = 4): string {
  if (!usable(value)) return ABSENT;
  return value.toLocaleString("en-GB", { maximumFractionDigits: maxFractionDigits });
}

/** `-12.4%`. An ASCII hyphen, so the figure survives being pasted into a spreadsheet. */
export function formatPercent(value: number | null | undefined, maxFractionDigits = 2): string {
  if (!usable(value)) return ABSENT;
  return `${value.toLocaleString("en-GB", { maximumFractionDigits: maxFractionDigits })}%`;
}
