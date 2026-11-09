import { isAttributed } from "../../site/vocab.js";
import { firstReviews } from "./events.ts";
import { decided, outcomeOf } from "./items.ts";
import type { GitHubEvent, Item } from "./types.ts";

/**
 * Project responsiveness: how long a contribution waits, and how often it waits
 * forever.
 *
 * This module measures the PROJECT, not the people in it — the inversion is the
 * whole reason it is allowed to exist. Every other number on the site is volume,
 * never merit, because ranking humans by output is illegitimate. Ranking the
 * project's own treatment of arrivals is not: the subject is the project, and it
 * is the one place a figure here is permitted to be an accusation.
 *
 * Nothing in here is per-person, and nothing in here may become per-person. A
 * per-reviewer latency column would turn a diagnostic into a performance review
 * and teach everyone to post "thanks, will look" inside the window, which is
 * also why time-to-first-REVIEW is carried separately from
 * time-to-first-response.
 *
 * OVERLAY ONLY. Commits carry a calendar date with no clock (see `Commit.date`),
 * so latency is not merely unmeasured without the GitHub overlay, it is
 * uncomputable from the git spine. Every figure here is absent rather than zero
 * when the overlay did not run.
 */

/** Hours, one decimal, or null when nothing was measured. */
export type Stat = {
  n: number; med: number | null; p75: number | null; p90: number | null;
};

const HOUR = 36e5;
const DAY = 864e5;


/**
 * Linear-interpolated quantile (the R-7 / NumPy default), so `median` of an even
 * sample is the true midpoint rather than whichever neighbour an index happened
 * to land on. ONE definition for every percentile the page prints: a table that
 * mixed nearest-rank with interpolation would put two figures side by side in the
 * same row that the reader has no way to compare.
 */
export function quantile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = p * (sorted.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  const a = sorted[lo]!;
  return lo === hi ? a : a + (sorted[hi]! - a) * (i - lo);
}

/**
 * Durations in ms -> hours, as a percentile progression.
 *
 * The tail IS the finding: a median says what a typical contributor waits, and
 * says nothing about how bad it gets. Three points let the reader see the SHAPE
 * of the wait rather than one summary of it — a median of 19h with a 90th of 22d
 * is a different project from a median of 19h with a 90th of 2d, and only one of
 * those is fine.
 */
export function stat(ms: number[]): Stat {
  const sorted = ms.slice().sort((a, b) => a - b);
  const h = (v: number | null) => (v == null ? null : Math.round((v / HOUR) * 10) / 10);
  return {
    n: sorted.length,
    med: h(quantile(sorted, 0.5)),
    p75: h(quantile(sorted, 0.75)),
    p90: h(quantile(sorted, 0.9)),
  };
}

export type HeartbeatInput = {
  items: Item[];
  events: GitHubEvent[];
  /** Span-resolved org id for a login at an instant. Bots resolve to "bot". */
  orgOf: (login: string, at: string) => string;
  /**
   * The PERSON behind a login: the display slug, for rows the page links to, and
   * the identity every per-person rule below is keyed by. A login is an account,
   * not a person; one human with two accounts is one arrival, one reviewer, and
   * never an outside response to their own work.
   */
  slugOf: (login: string) => string;
  /**
   * How long silence has to last before it counts as silence. A pull request
   * opened yesterday with no reply is not being ignored, and counting it as
   * ignored would make the figure a function of when the data was pulled.
   */
  silentAfterDays?: number;
};

type Row = {
  /** "pr" | "issue" */
  k: string;
  r: string;
  n: number;
  t: string;
  /** author slug, and the author's org resolved AT THE ITEM DATE */
  a: string;
  o: string;
  d: string;
  e?: string;
  s: string;
  /** first recorded human response, absent when there was none */
  f?: string;
  /** silence outlasted the threshold */
  z?: 1;
  /** author's earliest pull request in the window */
  c?: 1;
};

export function heartbeat(input: HeartbeatInput) {
  const { items, events, orgOf, slugOf } = input;
  const silentAfterDays = input.silentAfterDays ?? 7;
  const isBot = (login: string, at: string) => orgOf(login, at) === "bot";
  const personOf = slugOf;

  const byKey = new Map<string, Item>();
  for (const it of items) byKey.set(`${it.repo}#${it.number}`, it);

  /**
   * `asOf` is the newest instant the data contains, not today's date. Ages and
   * silence are measured from it so that re-running derive without re-pulling
   * cannot age the backlog by itself — otherwise every figure below would drift
   * upward on a stale file and the page would report deterioration that never
   * happened.
   */
  let asOf = "";
  const seen = (at: string | undefined) => { if (at && at > asOf) asOf = at; };
  for (const it of items) { seen(it.at); seen(it.endedAt); }
  for (const e of events) seen(e.at);
  const asOfMs = Date.parse(asOf || new Date(0).toISOString());

  // Earliest human review per item. Routed through firstReviews so this inherits
  // the project's ONE definition of a review (self-reviews dropped, rounds
  // collapsed, earliest submission wins) rather than counting raw submissions —
  // the exact divergence that definition was extracted to prevent.
  const reviewAt = new Map<string, string>();
  // Per item, how many distinct REVIEWERS each organization supplied. This was a
  // `Set<string>` of organizations, which silently made every figure downstream
  // count PULL REQUESTS REVIEWED under a column that says "reviews": three people
  // from one employer reviewing one pull request scored 1. The site has exactly
  // one definition of a review -- a distinct (item, reviewer) pair -- and a page
  // that quietly used a second one understated the leading reviewer by 39%
  // (536 against 878) while its label claimed otherwise.
  const reviewerOrgs = new Map<string, Map<string, number>>();
  // firstReviews collapses by LOGIN. Collapse again by PERSON, earliest wins, so
  // two aliases of one reviewer are one reviewer and an author reviewing through
  // an alias is a self-review. Only this module's figures; the volume atom in
  // derive keeps its own definition.
  const personReviews = new Map<string, GitHubEvent>();
  for (const e of firstReviews(events).values()) {
    const it = byKey.get(`${e.repo}#${e.number}`);
    if (!it || !e.login) continue;
    const who = personOf(e.login);
    if (it.author && who === personOf(it.author)) continue;
    const k = `${e.repo}#${e.number}\u0000${who}`;
    const prev = personReviews.get(k);
    if (!prev || e.at < prev.at) personReviews.set(k, e);
  }
  for (const e of personReviews.values()) {
    const key = `${e.repo}#${e.number}`;
    const it = byKey.get(key);
    // Same-login self-reviews were dropped by firstReviews (`self`, set at pull
    // time); the person-level pass above adds only what a login cannot see,
    // aliases. Changing the definition of a review still moves this figure.
    if (!it || !e.login || isBot(e.login, e.at)) continue;
    const prev = reviewAt.get(key);
    if (!prev || e.at < prev) reviewAt.set(key, e.at);
    const org = orgOf(e.login, e.at);
    // Only real organizations, because "undisclosed reviewed google" is not a
    // cross-organization review — it is an unknown reviewing a known, and
    // counting it as cross-org inflates the one figure that answers whether
    // review is captured by a single vendor.
    if (isAttributed(org)) {
      let per = reviewerOrgs.get(key);
      if (!per) reviewerOrgs.set(key, (per = new Map()));
      per.set(org, (per.get(org) ?? 0) + 1);
    }
  }

  // Any recorded reply: a review or a comment, by someone other than the author,
  // excluding bots.
  //
  // What this CANNOT see: closing an item, applying a label, or replying in a
  // linked thread. A merge or a close is a response we can see the RESULT of but
  // not the actor for, which is why `quiet` below requires the item to be still
  // open rather than merely unreplied-to.
  const responseAt = new Map<string, string>();
  for (const e of events) {
    const key = `${e.repo}#${e.number}`;
    const it = byKey.get(key);
    // One rule for both kinds: not the author, as a PERSON. `self` is only set
    // on reviews and is login-level, so it cannot catch a reply through an alias.
    if (!it || !e.login) continue;
    if (it.author && personOf(e.login) === personOf(it.author)) continue;
    if (isBot(e.login, e.at)) continue;
    const prev = responseAt.get(key);
    if (!prev || e.at < prev) responseAt.set(key, e.at);
  }

  // A person's earliest pull request in the window. NOT "their first ever": the
  // window opens at the first commit this project recorded, so anyone active
  // before it is misfiled as an arrival. The page states the window for exactly
  // this reason.
  const firstPr = new Map<string, string>();
  for (const it of items) {
    if (it.kind !== "pr" || !it.author) continue;
    const who = personOf(it.author);
    const prev = firstPr.get(who);
    if (!prev || it.at < prev) firstPr.set(who, it.at);
  }

  const rows: Row[] = [];
  const pr = { first: [] as number[], review: [] as number[], land: [] as number[], decline: [] as number[] };
  const issue = { first: [] as number[], close: [] as number[] };
  const silent = { pr: 0, issue: 0 };
  const verdictNoReply = { pr: 0, issue: 0 };
  const withdrawn = { pr: 0, issue: 0 };
  const count = { pr: 0, issue: 0 };
  const arrival = {
    newcomer: { n: 0, first: [] as number[], silent: 0 },
    returning: { n: 0, first: [] as number[], silent: 0 },
  };
  type RepoAgg = { repo: string; prs: number; silent: number;
                   withdrawn: number;
                   first: number[]; land: number[]; decline: number[]; open: number[] };
  const byRepo = new Map<string, RepoAgg>();
  const matrix = new Map<string, number>();
  let reviewed = 0;
  let crossOrg = 0;
  let comparable = 0;
  // Ages of what is still open, kept PER KIND. A blended backlog reported 218
  // open items against 907 pull requests, so the reader could not make the
  // outcomes sum: 546 landed + 235 declined + 218 open is 999. Split, each kind's
  // outcomes account for exactly its own population.
  const open = { pr: [] as number[], issue: [] as number[] };

  for (const it of items) {
    // A deleted account leaves an item with no author: it can be neither
    // org-resolved nor classified as an arrival, and guessing would put a
    // fabricated row under a figure whose whole point is to be checkable.
    if (!it.author) continue;
    const authorOrg = orgOf(it.author, it.at);
    if (authorOrg === "bot") continue;

    const key = `${it.repo}#${it.number}`;
    const t0 = Date.parse(it.at);
    const f = responseAt.get(key);
    const fr = reviewAt.get(key);
    const isPr = it.kind === "pr";
    /**
     * Waiting, with nothing said and nothing done.
     *
     * `state === "open"` is load-bearing and was missing. Without it the figure
     * counted every item that got no review or comment, whatever became of it,
     * and the page published that under the heading "never answered": 130 of the
     * 212 rows had already reached a verdict, and two of them had been MERGED.
     * Being merged without discussion is not being ignored, it is the fastest
     * possible yes.
     *
     * The trap was that the measurement was defensible and the WORD was not. A
     * comment fifty lines up already said this module cannot see who closed an
     * item; the label on the page then made a claim that needed exactly that
     * fact. When a caveat lives only in the source, the page is free to overstate.
     *
     * So the population is deliberately the conservative one: still open, past
     * the threshold, nobody has said anything. Every one of those is a live
     * request a human can act on today, which is what makes the list a queue
     * rather than an accusation. The items excluded are counted and stated —
     * `verdictNoReply` below — because a figure that was measured and then
     * silently dropped is the other half of the same failure.
     */
    const quiet = !f && it.state === "open" && asOfMs - t0 > silentAfterDays * DAY;
    /**
     * Withdrawn: closed, unmerged, by the person who opened it.
     *
     * Not a verdict, and the whole reason `closedBy` is collected. 118 of the 246
     * closed-unmerged pull requests here are these, and blended into the declines
     * they halved the headline — 31 days mixed, 60.5 days once separated. The
     * noise was flattering us about how long a real rejection takes.
     *
     * Both logins are bareLogin-normalized at pull time, so this compares like
     * with like rather than "Some-User" against "some-user".
     *
     * The classification itself lives in `items.ts`, because `derive` needs the
     * same judgment to keep withdrawals out of the acceptance rate. Two copies of
     * "what counts as withdrawn" is exactly the shape of bug this codebase keeps
     * finding: one rule honoured at one site and skipped at the adjacent one.
     */
    const gaveUp = outcomeOf(it) === "withdrawn";
    if (gaveUp) withdrawn[isPr ? "pr" : "issue"]++;
    /**
     * Ended without merging and without a word, and not by the author's own hand.
     *
     * NOT reported as silence: it has an outcome, so it is not waiting for one.
     * Stated as its own figure so the reader knows the queue above is a floor.
     *
     * `landed` is excluded rather than lumped in with the rest of the verdicts.
     * Two pull requests here were merged with nothing said, and a merge is an
     * answer — the most favourable one available. Counting them alongside silent
     * closes would put the fastest yes in the project next to the cases where
     * somebody's work died quietly, under one heading, which is a smaller version
     * of the mistake this whole change is fixing.
     *
     * Withdrawals are excluded for the same reason: nobody owed an answer to a
     * pull request its own author took back.
     */
    if (!f && decided(it) && !gaveUp) verdictNoReply[isPr ? "pr" : "issue"]++;

    count[isPr ? "pr" : "issue"]++;
    if (quiet) silent[isPr ? "pr" : "issue"]++;
    if (it.state === "open") open[isPr ? "pr" : "issue"].push(asOfMs - t0);

    if (isPr) {
      const r = byRepo.get(it.repo)
        ?? byRepo.set(it.repo, { repo: it.repo, prs: 0, silent: 0, withdrawn: 0,
                                 first: [], land: [], decline: [], open: [] }).get(it.repo)!;
      r.prs++;
      if (quiet) r.silent++;
      if (gaveUp) r.withdrawn++;
      if (it.state === "open") r.open.push(asOfMs - t0);
      if (f) { pr.first.push(Date.parse(f) - t0); r.first.push(Date.parse(f) - t0); }
      if (fr) pr.review.push(Date.parse(fr) - t0);
      if (it.endedAt) {
        const d = Date.parse(it.endedAt) - t0;
        if (it.state === "landed") { pr.land.push(d); r.land.push(d); }
        // A withdrawal is not a decline. Its duration measures the AUTHOR's own
        // change of mind — which is also why no timing for it reaches the page:
        // this module measures the project, and nothing in it may become a figure
        // about a person.
        if (it.state === "declined" && !gaveUp) { pr.decline.push(d); r.decline.push(d); }
      }

      const bucket = firstPr.get(personOf(it.author)) === it.at ? arrival.newcomer : arrival.returning;
      bucket.n++;
      if (f) bucket.first.push(Date.parse(f) - t0);
      if (quiet) bucket.silent++;

      const orgs = reviewerOrgs.get(key);
      if (reviewAt.has(key)) reviewed++;
      // Only pull requests where both sides are known organizations can answer
      // "did someone outside the author's employer review this", so the
      // denominator is those, not all reviewed pull requests.
      if (orgs?.size && isAttributed(authorOrg)) {
        // `comparable` and `crossOrg` count PULL REQUESTS, deliberately: they answer
        // "was this reviewed from outside", which is a property of the item and is
        // true once however many people did it. `matrix` counts REVIEWS. Two units,
        // two questions, and the same loop -- so they are named apart here.
        comparable++;
        if ([...orgs.keys()].some((o) => o !== authorOrg)) crossOrg++;
        for (const [o, reviewers] of orgs) {
          const k = `${o}\u0000${authorOrg}`;
          matrix.set(k, (matrix.get(k) ?? 0) + reviewers);
        }
      }
    } else {
      if (f) issue.first.push(Date.parse(f) - t0);
      if (it.endedAt && !gaveUp) issue.close.push(Date.parse(it.endedAt) - t0);
    }

    rows.push({
      k: it.kind, r: it.repo, n: it.number, t: it.title,
      a: slugOf(it.author), o: authorOrg,
      d: it.at, ...(it.endedAt ? { e: it.endedAt } : {}), s: it.state,
      ...(f ? { f } : {}), ...(quiet ? { z: 1 as const } : {}),
      ...(isPr && firstPr.get(personOf(it.author)) === it.at ? { c: 1 as const } : {}),
    });
  }

  /**
   * What is still open, from one array of ages: the count, the age distribution,
   * and how much of it is past 90 days.
   *
   * An open item's wait is CENSORED — it is still running, so its age is a floor
   * on the time it will finally take, not a result. The page renders it with a
   * `>=` for that reason; the distinction is the difference between "decisions
   * take 28 days" and "these have been waiting 28 days so far".
   */
  const openStat = (ages: number[]) => ({
    n: ages.length,
    age: stat(ages),
    over90: ages.filter((ms) => ms > 90 * DAY).length,
  });

  return {
    asOf,
    silentAfterDays,
    /** Stated so the reader can discount the arrival split themselves. */
    window: { from: items.reduce((m, i) => (!m || i.at < m ? i.at : m), ""), to: asOf },
    pr: {
      n: count.pr,
      firstResponse: stat(pr.first),
      firstReview: stat(pr.review),
      silent: silent.pr,
      verdictNoReply: verdictNoReply.pr,
      toLand: stat(pr.land),
      toDecline: stat(pr.decline),
      /**
       * A count and no timing, deliberately.
       *
       * It is here so the outcomes reconcile against `n` and the reader can see
       * where the fast tail of the old decline figure went. How LONG someone took
       * to withdraw their own work is a fact about them, and this module measures
       * the project.
       */
      withdrawn: withdrawn.pr,
      open: openStat(open.pr),
    },
    issue: {
      n: count.issue,
      firstResponse: stat(issue.first),
      silent: silent.issue,
      verdictNoReply: verdictNoReply.issue,
      toClose: stat(issue.close),
      withdrawn: withdrawn.issue,
      open: openStat(open.issue),
    },
    arrival: {
      newcomer: { n: arrival.newcomer.n, firstResponse: stat(arrival.newcomer.first), silent: arrival.newcomer.silent },
      returning: { n: arrival.returning.n, firstResponse: stat(arrival.returning.first), silent: arrival.returning.silent },
    },
    review: {
      reviewed,
      comparable,
      crossOrg,
      /**
       * Per organization, not per PAIR.
       *
       * The pair was the wrong unit and no rendering could fix it. 77 pairs across
       * 36 organizations is 5.9% of the possible grid, so a heat map is 94% empty;
       * two organizations account for 91% of all review labour, so a node-link
       * graph is one hub, one spoke and a fringe of single edges. The distribution
       * is too skewed for any pairwise picture to carry information, and a reader
       * cannot aggregate 77 mostly-1 rows by eye either.
       *
       * What the pairs were hiding are two per-organization facts:
       *
       *   CONCENTRATION  who actually carries review labour, which the pair rows
       *                  scatter across up to 24 lines per reviewer.
       *   ASYMMETRY      given against received. One organization here receives
       *                  149 reviews and performs 1, which no pair row states and
       *                  every pair row contains.
       *
       * `partners` counts distinct OTHER organizations reviewed, so it reads as
       * reach rather than volume; an organization reviewing only itself has none.
       *
       * Rows include organizations that received reviews without giving any, which
       * is where the asymmetry actually shows. Their `given` is a measured zero,
       * not an absence.
       */
      byOrg: (() => {
        // An `ownOrg` count used to ship here and is deliberately gone. The site
        // rendered it as a cross-organization SHARE, which is maximised by having
        // no colleagues -- an organization giving one review, to a stranger,
        // scored a perfect 100% -- so it read as pluralism and measured its
        // opposite. Once the column went, the field was measured, serialised and
        // displayed nowhere, which this project treats as a defect in its own
        // right: shipping a number no page will answer for.
        type Agg = { org: string; given: number; received: number;
                     partners: Set<string> };
        const agg = new Map<string, Agg>();
        const at = (org: string) => agg.get(org)
          ?? agg.set(org, { org, given: 0, received: 0, partners: new Set() }).get(org)!;
        for (const [k, n] of matrix) {
          const [from, to] = k.split("\u0000") as [string, string];
          const f = at(from), t = at(to);
          f.given += n;
          t.received += n;
          if (from !== to) f.partners.add(to);
        }
        return [...agg.values()]
          .map(({ partners, ...r }) => ({ ...r, partners: partners.size }))
          .sort((a, b) => b.given - a.given || b.received - a.received);
      })(),
    },
    // Per repository, and the reason the site splits at all: the blended "31 days
    // to decline" hides a 17x spread — one repository closes what it will not take
    // in 4 days, another takes 67. First response, by contrast, is stable across
    // repositories (dropping the largest, 56% of all pull requests, moves the
    // blended median by one hour), so the split is published to let the reader see
    // that stability rather than be told about it.
    byRepo: [...byRepo.values()]
      .map((r) => ({
        repo: r.repo, prs: r.prs, silent: r.silent,
        firstResponse: stat(r.first), toLand: stat(r.land), toDecline: stat(r.decline),
        withdrawn: r.withdrawn,
        open: openStat(r.open),
      }))
      .sort((a, b) => b.prs - a.prs),
    items: rows.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0)),
  };
}
