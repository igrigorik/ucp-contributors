import type { Item } from "./types.ts";

/**
 * What became of a pull request or issue.
 *
 * This exists so the definition of a WITHDRAWAL lives in exactly one place. It is
 * consumed by `derive` (which turns it into the metric columns and therefore the
 * acceptance rate), by `heartbeat` (which must not time a withdrawal as a decline),
 * and by `verify` (which recounts the partition from raw). Three call sites is
 * precisely the number at which this codebase has previously got a shared rule
 * wrong at one of them.
 */

/**
 * Reached an outcome, and that outcome was not a merge.
 *
 * Listed by state rather than written as `!== "open" && !== "landed"`, so a state
 * added later has to be classified deliberately instead of being absorbed into
 * whichever branch happens to catch it. `landed` is outside this set on purpose:
 * a merge is an answer, and the most favourable one available.
 */
export const decided = (it: Item) => it.state === "declined" || it.state === "closed";

/**
 * The outcome as the site counts it, which splits GitHub's single closed state in
 * two.
 *
 * GitHub reports one fact -- closed, unmerged -- for two opposite events: a
 * maintainer rejecting somebody's work, and an author taking back their own. This
 * is a JUDGMENT and therefore belongs here rather than in `pull`, which records
 * only that the item was closed and by whom.
 *
 * The judgment matters because of where it lands. In this data 118 of 246
 * closed-unmerged pull requests are withdrawals, and while they sat in
 * `declined` they were counted as REJECTIONS of their own authors: acceptance
 * read 71.5% when the honest figure is 82.8%. The blend was not merely imprecise,
 * it was imprecise in the direction that blamed contributors for tidying up after
 * themselves.
 *
 * An absent `closedBy` keeps the item as `declined`, which is the conservative
 * direction: an unknown closer stays a real verdict rather than being moved into a
 * bucket the acceptance rate ignores, which would quietly improve the project's
 * own numbers. No guard is needed for that comparison -- an undefined closer
 * cannot equal a non-empty author -- and every consumer drops authorless items
 * before reaching this.
 */
export const outcomeOf = (it: Item): string =>
  decided(it) && it.closedBy === it.author ? "withdrawn" : it.state;
