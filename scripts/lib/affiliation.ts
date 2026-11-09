import type { Contributor } from "./types.ts";

export const UNKNOWN = "unknown";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Lexicographic span comparisons are sound only for canonical, real calendar
// dates; `2026-3-01` sorts after `2026-12-01`, so one unpadded hand-edit can make
// every later event miss.
function isCalendarDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}

/**
 * Which org was this person at on `date`?
 *
 * Spans are half-open: `from` inclusive, `until` exclusive. Dates are
 * YYYY-MM-DD strings, so lexicographic comparison is chronological
 * comparison — no Date parsing, no timezone surprises.
 *
 * Returns UNKNOWN in two distinct situations that deliberately collapse here
 * but are distinguishable upstream: no record at all (nobody has looked), and
 * a record whose spans don't cover this date (looked, but incomplete).
 */
export function orgAt(contributor: Contributor | undefined, date: string): string {
  if (!contributor) return UNKNOWN;
  for (const span of contributor.orgs ?? []) {
    const afterStart = !span.from || span.from <= date;
    const beforeEnd = !span.until || date < span.until;
    if (afterStart && beforeEnd) return span.org;
  }
  return UNKNOWN;
}

/**
 * Reject span sets that would make attribution ambiguous. Called by derive so
 * a bad hand-edit fails the build instead of silently skewing a chart.
 */
export function validateSpans(slug: string, c: Contributor, knownOrgs: Set<string>) {
  const spans = c.orgs ?? [];
  for (const s of spans) {
    if (!knownOrgs.has(s.org)) {
      throw new Error(`${slug}: unknown org "${s.org}" (add it to data/orgs.json5)`);
    }
    for (const [bound, value] of [["from", s.from], ["until", s.until]] as const) {
      if (value !== undefined && !isCalendarDate(value)) {
        throw new Error(`${slug}: invalid ${bound} date "${value}"`);
      }
    }
    if (s.from && s.until && s.from >= s.until) {
      throw new Error(`${slug}: span from ${s.from} >= until ${s.until}`);
    }
  }
  // Pairwise overlap check. n is tiny (1-3 spans per person), so O(n^2) is fine
  // and reads better than an interval tree.
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i]!;
      const b = spans[j]!;
      const aStart = a.from ?? "0000-00-00";
      const aEnd = a.until ?? "9999-99-99";
      const bStart = b.from ?? "0000-00-00";
      const bEnd = b.until ?? "9999-99-99";
      if (aStart < bEnd && bStart < aEnd) {
        throw new Error(
          `${slug}: overlapping spans (${a.org} ${aStart}..${aEnd}) and (${b.org} ${bStart}..${bEnd})`,
        );
      }
    }
  }
}
