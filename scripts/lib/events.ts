import type { GitHubEvent } from "./types.ts";

/**
 * Distinct (pull request, reviewer) pairs, earliest submission per pair, with
 * self-reviews dropped. This is the ONLY definition of "a review" — it lives
 * here because it previously existed twice, and the two copies disagreed.
 *
 * `derive` collapsed rounds and dropped self-reviews; `audit` counted raw
 * submissions. So `audit` ranked a contributor whose twelve "reviews" were all
 * self-reviews (zero countable) above everyone else, and sent a human to
 * investigate the one account with no review contribution at all. A ranking
 * that decides where effort goes has to use the same arithmetic as the numbers
 * it is ranking.
 *
 * Five rounds on one PR is one PR reviewed, not five. The earliest submission
 * wins: it is when the reviewer first engaged, so org-at-date attribution
 * reflects who they worked for at the time, and it is the figure that makes
 * review latency computable later.
 */
export function firstReviews(events: GitHubEvent[]): Map<string, GitHubEvent> {
  const out = new Map<string, GitHubEvent>();
  for (const e of events) {
    if (e.kind !== "review" || e.self) continue;
    const key = `${e.repo}#${e.number}:${e.login}`;
    const prev = out.get(key);
    if (!prev || e.at < prev.at) out.set(key, e);
  }
  return out;
}
