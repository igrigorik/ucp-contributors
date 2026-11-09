#!/usr/bin/env bun
// Join the raw pulls against the hand-maintained data files and write the tables
// the site reads. Offline and deterministic: same inputs, same output.
//
// This is also the validation step. A bad hand-edit fails the build here rather
// than silently skewing a report, so CI just runs `derive`.
//
// Two metric families, deliberately kept distinguishable:
//   git    — commits, added, deleted, files          (always present)
//   github — prs, merged, reviews, comments, issues  (optional overlay)
// If the overlay was never pulled, its fields are absent rather than zero, and
// the site hides the columns. Zeros would be a lie about real review work.
import { writeFileSync } from "node:fs";
import { GH_FIELDS, GIT_FIELDS, isAttributed } from "../site/vocab.js";
import { orgAt, UNKNOWN, validateSpans } from "./lib/affiliation.ts";
import { heartbeat } from "./lib/heartbeat.ts";
import {
  ensureDir,
  loadCommits,
  loadBranches,
  loadContributors,
  loadCouncil,
  loadGitHub,
  loadOrgs,
  loadRepos,
  p,
} from "./lib/data.ts";
import { loadSealed, parseMode, pruneGenerated, summarize } from "./lib/acquisition.ts";
import { attribute, isAvailable, validateBranches } from "./lib/branches.ts";
import { authorPid, projectAuthors, type AuthorSources } from "./lib/authors.ts";
import { firstReviews } from "./lib/events.ts";
import type { GitHubEvent } from "./lib/types.ts";
import { outcomeOf } from "./lib/items.ts";
import { coauthorCredits, emailIndex, emailPerson, loginIndex, slugify } from "./lib/identity.ts";
import { displayName as nameFor, noreplyLogin } from "./lib/names.ts";
import { councilsBySlug, projectGovernance, rosterErrors, rosterIndex } from "./lib/roster.ts";

type Field = (typeof GIT_FIELDS)[number] | (typeof GH_FIELDS)[number];

const repos = loadRepos();
// The seal is validated BEFORE any raw file is read: `--git-only`/`--full` must
// match it, and with neither flag the sealed mode decides what is consumed.
const sealed = loadSealed(p(), repos.map((r) => r.name), parseMode(process.argv.slice(2)));
const mode = sealed.mode;
const orgs = loadOrgs();
const contributors = loadContributors();
// Governance is the public roster plus exact identity aliases, nothing curated.
// Both modes acquire the roster, so its absence is a broken seal, not "none".
const council = loadCouncil();
if (!council) throw new Error("raw/council.json is missing — run `bun run acquire`");
{
  const errors = rosterErrors(council);
  if (errors.length) throw new Error(errors.join("\n"));
}
const councilCollectedAt = sealed.manifest.layers.council?.finishedAt;
if (!councilCollectedAt) throw new Error("the seal records no council layer — run `bun run acquire`");
const rosterAliases = rosterIndex(contributors);
const councilsOf = councilsBySlug(council, rosterAliases);
const commits = loadCommits();
const github = loadGitHub(mode);
const branches = loadBranches(mode);
if (mode === "full" && !branches) throw new Error("full mode requires raw/branches.jsonl");
// One record per landed pull request, each either walked or saying why not. A
// gap here used to be silent: three landed pull requests simply had no
// attribution, and nothing on their pages said it was missing rather than empty.
if (github && branches) {
  const errors = validateBranches(github.items, branches);
  if (errors.length) {
    throw new Error(`raw/branches.jsonl does not cover the landed pull requests exactly:\n  ✗ ` +
      errors.slice(0, 20).join("\n  ✗ ") + (errors.length > 20 ? `\n  … ${errors.length - 20} more` : ""));
  }
}

const knownOrgs = new Set(Object.keys(orgs));
for (const [slug, c] of Object.entries(contributors)) validateSpans(slug, c, knownOrgs);
const byEmail = emailIndex(contributors);
const byLogin = github ? loginIndex(contributors, github.bridge) : new Map<string, string>();
// Canonical person for a git address, used for co-authorship. Curated logins
// (and, with the overlay, bridge-derived ones) join an unlisted address to its
// owner, so an author's alternate address is recognized as the author.
const personOfEmail = emailPerson(
  byEmail,
  github ? byLogin : loginIndex(contributors, {}),
  (email) => github?.bridge[email]?.toLowerCase() ?? noreplyLogin(email),
);

const FIELDS: Field[] = [...GIT_FIELDS, ...(github ? GH_FIELDS : [])];
type Metrics = Record<Field, number>;
const zero = () => Object.fromEntries(FIELDS.map((f) => [f, 0])) as Metrics;

/**
 * Fold `n` into one field of an accumulator.
 *
 * A bucket carries only the fields that were MEASURED: without the GitHub
 * overlay `FIELDS` omits every GH metric, so `zero()` really does return an
 * object with no `proposed` key. That is deliberate — an unmeasured metric is
 * absent, never zero — but it means a bare `m[f] += n` folds into `undefined`
 * and yields NaN. NaN is the worst possible carrier here: it survives arithmetic
 * silently, serializes to `null`, and renders as a blank cell that reads as
 * "not measured" while actually meaning "measured and corrupted".
 *
 * Starting an absent accumulator at 0 is the correct fold identity and is not
 * the same thing as REPORTING zero: what reaches the site is still governed by
 * `FIELDS`. The `?? 0` was already present at one read site and missing at the
 * three fold sites, which is the recurring shape of every bug in this file.
 */
const add = (m: Metrics, f: Field, n: number) => {
  m[f] = (m[f] ?? 0) + n;
};

// Keys joined with NUL so a separator can never collide with a repo name or slug.
const K = (...parts: string[]) => parts.join("\u0000");
const buckets = {
  org: new Map<string, Metrics>(),
  repoOrg: new Map<string, Metrics>(),
  person: new Map<string, Metrics>(),
  personRepo: new Map<string, Metrics>(),
  /**
   * Person x organization x repository, span-resolved at event date.
   *
   * The org page cannot derive its contributor list from `person.org`: that field
   * is the affiliation at the person's *latest* activity, so anyone who changed
   * employer carries their whole history to their newest org and vanishes from
   * the previous one. That put an empty contributor table under a non-zero panel
   * on one org page, and inflated another by exactly the amount it lost.
   *
   * Membership in an organization is "has activity attributed to it", which is
   * what this bucket answers. Summing over repos gives the org-scoped person row;
   * selecting one repo gives the repo-filtered view.
   */
  personOrgRepo: new Map<string, Metrics>(),
};
const orgPeople = new Map<string, Set<string>>();
const activeDates = new Map<string, { first: string; last: string }>();
/**
 * Activity bounds per (person, organization), so the report can show when
 * someone was contributing under each affiliation.
 *
 * The affiliation spans themselves almost never carry dates — they are
 * hand-entered and 118 of 120 are bare — so the only date range available per
 * affiliation is the one measured from events. Keyed by organization rather than
 * by span index: a contributor who left and later returned to the same employer
 * would have their two stints merged. No such case exists in the data, and
 * carrying a span index through `record` to support one costs more than it buys.
 */
const activeByOrg = new Map<string, { first: string; last: string }>();

const bound = (m: Map<string, { first: string; last: string }>, k: string, date: string) => {
  const b = m.get(k);
  if (!b) m.set(k, { first: date, last: date });
  else {
    if (date < b.first) b.first = date;
    if (date > b.last) b.last = date;
  }
};

const get = (m: Map<string, Metrics>, k: string) => {
  let v = m.get(k);
  if (!v) m.set(k, (v = zero()));
  return v;
};

/**
 * Fold one event into every rollup. Both metric families flow through here, so
 * a person's org is resolved at *event date* in both cases — the whole point of
 * spans is that a job change splits your own history correctly.
 */
/**
 * One row of the activity log: what a single event was, before attribution.
 *
 * `ref` is a PR/issue number or a short sha — whatever makes the event
 * addressable on GitHub. `title` is carried only for commits, whose subject is
 * unique per event; PR and issue titles are deduplicated into a separate
 * dictionary because 2,881 reviews land on ~900 pull requests and repeating each
 * title per review would triple the payload.
 */
type Ev = { k: string; ref: string | number; title?: string; id?: number };

/**
 * The activity log, emitted from inside `record` on purpose.
 *
 * `record` is the one place where (person, org, repo, date) are all resolved,
 * and the org in particular is resolved by reading the affiliation span active
 * on the event's own date. Building the log in a second pass would mean a second
 * implementation of that resolution, and the two would drift — the same defect
 * as defining "a review" twice. Emitting here makes the log and the aggregate it
 * decomposes into arithmetically incapable of disagreeing: every event pushed
 * here was counted, and every count came with an event.
 */
const events: { d: string; k: string; r: string; ref: string | number; t?: string; i?: number; p: string; o: string }[] = [];

function record(
  pid: string, org: string, repo: string, date: string, delta: Partial<Metrics>, ev?: Ev,
) {
  if (ev) {
    events.push({
      d: date, k: ev.k, r: repo, ref: ev.ref,
      ...(ev.title ? { t: ev.title } : {}),
      // Absent, not 0, when GitHub handed over no id — the log then links to the
      // pull request rather than the exact comment, a degraded link and not a
      // wrong one. Raw files pulled before ids existed still derive.
      ...(ev.id ? { i: ev.id } : {}),
      p: pid, o: org,
    });
  }
  for (const target of [
    get(buckets.org, org),
    get(buckets.repoOrg, K(repo, org)),
    get(buckets.person, pid),
    get(buckets.personRepo, K(pid, repo)),
    get(buckets.personOrgRepo, K(pid, org, repo)),
  ]) {
    for (const [f, n] of Object.entries(delta)) add(target, f as Field, n!);
  }

  if (!orgPeople.has(org)) orgPeople.set(org, new Set());
  orgPeople.get(org)!.add(pid);

  bound(activeDates, pid, date);
  bound(activeByOrg, K(pid, org), date);
}

const resolve = (pid: string) => (pid.includes(":") ? undefined : contributors[pid]);

for (const c of commits) {
  const slug = byEmail.get(c.email);
  const pid = slug ?? `email:${c.email}`;
  record(pid, orgAt(resolve(pid), c.date), c.repo, c.date, {
    commits: 1, added: c.added, deleted: c.deleted, files: c.files,
  }, { k: "commit", ref: c.sha, title: c.subject });

  /**
   * Co-authorship is its OWN metric, never folded into `commits`.
   *
   * Splitting a commit four ways would produce fractional commits, and giving
   * each co-author a full commit would make the org table stop summing to 529 —
   * which is the property that lets anyone check our arithmetic against
   * `git log`. A separate field keeps the spine exact and still surfaces 151
   * human credits on 29% of commits that previously went to nobody.
   *
   * Line counts are deliberately NOT attributed to co-authors: the trailer says
   * who worked on the branch, not who wrote which hunk.
   *
   * One credit per (commit, canonical person): the author is excluded under any
   * of their addresses, and two declarations of one person credit them once.
   */
  for (const { pid: cid } of coauthorCredits(c.email, c.coauthors ?? [], personOfEmail)) {
    record(cid, orgAt(resolve(cid), c.date), c.repo, c.date, { coauthored: 1 },
      { k: "coauthored", ref: c.sha, title: c.subject });
  }
}

// Unresolved GitHub logins, ranked later by `audit`. Kept visible rather than
// folded into a bucket: the overlay triples the participant count, so pretending
// they are all "unknown company" without saying so would be dishonest.
const unmappedLogins = new Map<string, Metrics>();

/** Attribute one login's activity at the moment it happened. */
function observe(who: string, repo: string, at: string, delta: Partial<Metrics>, ev?: Ev) {
  const slug = byLogin.get(who);
  const pid = slug ?? `login:${who}`;
  const date = at.slice(0, 10);
  record(pid, orgAt(resolve(pid), date), repo, date, delta, ev);
  if (!slug) {
    const m = unmappedLogins.get(who) ?? zero();
    for (const [f, n] of Object.entries(delta)) add(m, f as Field, n!);
    unmappedLogins.set(who, m);
  }
}

// The collapse itself lives in lib/events.ts so `audit` ranks with the same
// arithmetic. Raw submissions stay in pull-github.ts: revision cycles and
// time-to-first-review are only recoverable if every submission survives.
const firstReview = firstReviews(github?.events ?? []);

/**
 * Collapsed a SECOND time, by person rather than by login.
 *
 * `reviews` has to mean "distinct items this PERSON reviewed", because the site
 * now divides it by the items they did not author -- a numerator counted in
 * logins over a denominator counted in people is not a share of anything. Three
 * contributors here carry two GitHub logins, so one of them reviewing under both
 * would have scored two reviews of one pull request, and the eligibility
 * containment `verify` asserts would only have caught it at saturation.
 *
 * The same collapse catches a self-review that `pull` cannot see: `self` is
 * decided there by comparing login strings, so reviewing your own pull request
 * from your other account is invisible at that layer and only resolvable here,
 * where identity is known. Zero of either case exist in the data today -- this
 * is the unit being made true by construction rather than by luck.
 */
const pidOf = (login: string) => byLogin.get(login) ?? `login:${login}`;
const byPerson = new Map<string, GitHubEvent>();
for (const e of firstReview.values()) {
  const author = github?.items?.[`${e.repo}#${e.number}`]?.author;
  if (author && pidOf(author) === pidOf(e.login)) continue;
  const key = `${e.repo}#${e.number}:${pidOf(e.login)}`;
  const prev = byPerson.get(key);
  if (!prev || e.at < prev.at) byPerson.set(key, e);
}
for (const e of byPerson.values()) {
  observe(e.login, e.repo, e.at, { reviews: 1 }, { k: "review", ref: e.number, id: e.id });
}

// Both kinds of comment count as commenting. They are separate GitHub objects,
// but the distinction between typing "line 42 is wrong" in the timeline and
// clicking line 42 to type "this is wrong" is a habit of the interface, not a
// difference in the labour.
//
// Counting only timeline comments — which is what this did until the inline ones
// were pulled — was not merely narrow, it was biased in a direction: it scored
// the vague summary objection and ignored twenty specific line critiques. The
// ratio between the two runs from 0.5x to 15x across this project's reviewers,
// so excluding one did not scale the column, it reordered it, and one reviewer
// with 55 inline comments and no timeline comments rendered as having written
// nothing at all.
//
// They stay distinct KINDS in the activity log while summing into one metric, so
// the filter can still isolate line-level feedback — and its counts are the only
// place a reader can see the split.
//
// A REVIEW'S OWN BODY is the third source, and it was missing for the same
// reason the inline comments once were. GitHub wraps two different acts in one
// object: a design-level critique is a `bodyText` with no children, while a
// line-level review is an empty shell around N inline comments. We counted the
// children and ignored the body, so a 7,462-character critique measured exactly
// the same as clicking Approve. Same bias as above, one layer up -- it scored
// the reviewer who leaves twenty line notes and ignored the one who writes a
// design objection. On ucp alone: 373 reviews, 160,366 characters, invisible.
//
// Emitted as its own kind rather than folded silently into the review row,
// because the flattening already established for inline comments applies
// unchanged -- 1 review + N children -- and a body is a child of a different
// type. Every kind still maps to exactly one metric, so the log's kind counts
// continue to decompose `comments` exactly.
//
// NOT collapsed the way review PAIRS are: three review bodies on one pull
// request are three things written, exactly as three timeline comments would be.
// Self-reviews count here for the same reason a comment on your own pull request
// counts -- writing is writing, whoever opened the thing.
const COMMENT_KIND = { comment: "comment", review_comment: "reviewcomment" } as const;
for (const e of github?.events ?? []) {
  const k = COMMENT_KIND[e.kind as keyof typeof COMMENT_KIND];
  if (k) observe(e.login, e.repo, e.at, { comments: 1 }, { k, ref: e.number, id: e.id });
  else if (e.kind === "review" && e.chars) {
    observe(e.login, e.repo, e.at, { comments: 1 }, { k: "reviewnote", ref: e.number, id: e.id });
  }
}

// Authorship comes from the item registry, not the event stream: one row per
// PR/issue, carrying its verdict.
for (const item of Object.values(github?.items ?? {})) {
  if (!item.author) continue;
  // `outcomeOf`, not `item.state`: GitHub reports one closed state for both a
  // rejection and an author's own withdrawal, and counting the second as the
  // first put 118 pull requests on the wrong side of the acceptance rate.
  const delta: Partial<Metrics> = item.kind === "issue"
    ? { issues: 1 }
    : { proposed: 1, [outcomeOf(item)]: 1 };
  // Logged as "issue"/"proposed" rather than by state: the log records what
  // someone DID on a date, and "landed" is a verdict reached later by others.
  observe(item.author, item.repo, item.at, delta,
    { k: item.kind === "issue" ? "issue" : "proposed", ref: item.number });
}

// Name votes: every git author name each pid committed under. The precedence
// that turns these and the other public sources into one label is in
// lib/names.ts, where a test pins it.
const nameVotes = new Map<string, Map<string, number>>();
for (const c of commits) {
  const pid = byEmail.get(c.email) ?? `email:${c.email}`;
  if (!nameVotes.has(pid)) nameVotes.set(pid, new Map());
  const v = nameVotes.get(pid)!;
  v.set(c.name, (v.get(c.name) ?? 0) + 1);
}
// Display only, and deliberately NOT `byLogin` in git-only mode: there the
// overlay's bridge is unsealed and unread, but a login a curated record claims
// by hand is still that record's, so a no-reply address can still find its name.
const nameLogins = github ? byLogin : loginIndex(contributors, {});
const displayName = (pid: string) => nameFor(pid, {
  curated: (slug) => contributors[slug]?.name || undefined,
  votes: nameVotes,
  // The commit->account bridge first, as GitHub states it; then the login GitHub
  // minted into its own no-reply address.
  loginOf: (email) => github?.bridge[email]?.toLowerCase() ?? noreplyLogin(email),
  slugOf: (login) => nameLogins.get(login),
  profileName: (login) => github?.profiles[login]?.name,
});

// --- outputs ---------------------------------------------------------------

const orgName = (id: string) => orgs[id]?.name ?? id;
const metric = (row: object, field: Field): number =>
  (row as Record<string, number | undefined>)[field] ?? 0;
const sumField = (m: Map<string, Metrics>, f: Field, pred: (k: string) => boolean = () => true) =>
  [...m.entries()].filter(([k]) => pred(k)).reduce((n, [, v]) => n + (v[f] ?? 0), 0);

const coverageFor = (f: Field) => {
  const total = sumField(buckets.org, f);
  const human = total - (buckets.org.get("bot")?.[f] ?? 0);
  const attributed = sumField(buckets.org, f, isAttributed);
  return { attributed, human, total, pct: human ? Math.round((attributed / human) * 1000) / 10 : 0 };
};

const orgRows = [...buckets.org.entries()]
  .map(([org, m]) => ({ org, name: orgName(org), people: orgPeople.get(org)?.size ?? 0, ...m }))
  .sort((a, b) => metric(b, "commits") - metric(a, "commits"));

const repoOrgRows = [...buckets.repoOrg.entries()].map(([k, m]) => {
  const [repo, org] = k.split("\u0000");
  return { repo: repo!, org: org!, name: orgName(org!), ...m };
});

const personRepos = new Map<string, Record<string, string | number>[]>();
for (const [k, m] of buckets.personRepo) {
  const [pid, repo] = k.split("\u0000");
  if (!personRepos.has(pid!)) personRepos.set(pid!, []);
  personRepos.get(pid!)!.push({ repo: repo!, ...m });
}

// Flat rows; the site indexes them by org on load. Emitted separately from
// people.json so the org page's needs never bloat the person record.
const orgPeopleRows = [...buckets.personOrgRepo].map(([k, m]) => {
  const [pid, org, repo] = k.split("\u0000");
  return { id: pid!, org: org!, repo: repo!, ...m };
});

const loginsFor = new Map<string, string[]>();
for (const [who, slug] of byLogin) {
  if (!loginsFor.has(slug)) loginsFor.set(slug, []);
  loginsFor.get(slug)!.push(who);
}
for (const list of loginsFor.values()) list.sort();

const personRows = [...buckets.person.entries()]
  .map(([pid, m]) => {
    const slug = pid.includes(":") ? null : pid;
    const c = slug ? contributors[slug] : undefined;
    const span = activeDates.get(pid)!;
    const login = pid.startsWith("login:") ? pid.slice(6) : null;
    // Every login this person is known by, however it was matched. Read TWICE
    // below, and the two readings must agree: `profileCompany` used to derive
    // its own from `login`, which is null for anyone who has a record, so the
    // hint silently applied to nobody except the uncurated.
    const logins = loginsFor.get(pid) ?? (login ? [login] : []);
    return {
      id: pid,
      slug: slug ?? `_${slugify(login ?? pid.replace("email:", ""))}`,
      name: displayName(pid),
      mapped: Boolean(slug),
      // Evaluated at the person's most recent activity; the span list travels
      // with the record so the report view can show the whole history.
      org: orgAt(c, span.last),
      orgName: orgName(orgAt(c, span.last)),
      // Each span carries the measured activity window inside it. A span with no
      // window means the affiliation is recorded but nothing was contributed
      // during it; the report must not render that as a zero-length range.
      spans: (c?.orgs ?? []).map((sp) => {
        const b = activeByOrg.get(K(pid, sp.org));
        return b ? { ...sp, activeFrom: b.first, activeTo: b.last } : { ...sp };
      }),
      emails: c?.emails ?? (pid.startsWith("email:") ? [pid.slice(6)] : []),
      // Roster headings this person's exact aliases appear under, read from the
      // pulled roster every run, so an election reaches the page with no edit.
      // Absent rather than empty for the ~280 people who hold no seat.
      councils: slug ? councilsOf.get(slug) : undefined,
      // Effective logins, not just hand-written ones. Most people are matched
      // through the commit->account bridge and never need an explicit entry, so
      // reading `logins[]` alone showed them as having no GitHub account.
      logins,
      // Self-reported and point-in-time. Shown on the report as a hint, never
      // consumed as a span. First match wins: a person with several accounts
      // rarely fills the field on more than one.
      profileCompany: logins.map((l) => github?.profiles[l]?.company).find(Boolean) ?? null,
      first: span.first,
      last: span.last,
      repos: (personRepos.get(pid) ?? [])
        .sort((a, b) => Number(b.commits ?? 0) - Number(a.commits ?? 0)),
      ...m,
    };
  })
  .sort((a, b) =>
    metric(b, "commits") - metric(a, "commits") ||
    metric(b, "proposed") - metric(a, "proposed"),
  );

const summary = {
  generatedAt: new Date().toISOString(),
  // Which sealed acquisition these figures were derived from; verify compares
  // it against the seal on disk, so a summary older than its raw/ fails.
  acquisition: summarize(sealed),
  repos: repos.map((r) => r.name),
  // Web URLs for the activity log's outbound links, derived from the clone URLs
  // already in repos.json5. Emitted rather than hardcoded in the site: the
  // GitHub organization is configuration, and a stats tool that only works for
  // one organization is a worse tool.
  repoUrls: Object.fromEntries(repos.map((r) => [r.name, r.url.replace(/\.git$/, "")])),
  // What kind of work each repository holds, so the site can scope a figure to
  // one class. Emitted as a map rather than folded into `repos` (a name array)
  // because everything that consumes `repos` wants names and nothing else.
  repoClass: Object.fromEntries(repos.map((r) => [r.name, r.class])),
  // Full registry, not just orgs with activity: an affiliation span can name an
  // org that produced nothing here (a previous employer) and still needs a name.
  orgNames: {
    ...Object.fromEntries(Object.entries(orgs).map(([id, o]) => [id, o.name])),
    // Display-only. Deliberately NOT in orgs.json5: keeping it unwritable means
    // nobody can hand-assign "unknown" and blur it with "absent from the file".
    [UNKNOWN]: "Unknown (unmapped)",
  },
  fields: FIELDS,
  // null means the overlay was never pulled. The site must hide those columns,
  // not render them as zero.
  github: github
    ? {
        events: github.events.length,
        // Every distinct participant, including people who only ever authored a
        // PR or issue and never reviewed or commented.
        logins: new Set([
          ...github.events.map((e) => e.login),
          ...Object.values(github.items).map((i) => i.author).filter(Boolean) as string[],
        ]).size,
        unmappedLogins: unmappedLogins.size,
        coverage: coverageFor("reviews"),
        // Project-wide verdict split, so the banner can state the denominator
        // rule rather than leaving readers to infer it.
        prStates: Object.values(github.items).reduce(
          (a, i) => (i.kind === "pr" ? { ...a, [outcomeOf(i)]: (a[outcomeOf(i)] ?? 0) + 1 } : a),
          {} as Record<string, number>,
        ),
      }
    : null,
  totals: Object.fromEntries(FIELDS.map((f) => [f, sumField(buckets.org, f)])),
  people: personRows.filter((r) => r.org !== "bot").length,
  orgs: orgRows.filter((r) => isAttributed(r.org)).length,
  coverage: coverageFor("commits"),
  range: {
    first: commits.length ? commits[0]!.date : null,
    last: commits.length ? commits[commits.length - 1]!.date : null,
  },
};

const out = p("site/data");
ensureDir(out);
for (const f of pruneGenerated(out, { github: Boolean(github), branches: Boolean(branches) })) {
  console.log(`removed stale site/data/${f} (its source was not consumed in ${mode} mode)`);
}
/**
 * The person x org x repo bucket must reconcile in both directions, because the
 * site renders an organization's panel from one source and the contributor table
 * beneath it from the other. When those drifted, an organization page showed a
 * two-commit panel above an empty table and another over-counted by exactly the
 * amount the first had lost. That is a silent, plausible-looking wrong number —
 * the worst kind — so it fails the build rather than warning.
 */
for (const [label, other] of [
  ["organization", buckets.repoOrg] as const,
  ["person", buckets.person] as const,
]) {
  const lhs = new Map<string, Metrics>();
  for (const [k, m] of buckets.personOrgRepo) {
    const [pid, org, repo] = k.split("\u0000");
    const key = label === "person" ? pid! : K(repo!, org!);
    for (const [f, n] of Object.entries(m)) {
      const acc = get(lhs, key);
      add(acc, f as Field, n);
    }
  }
  for (const [key, want] of other) {
    const got = lhs.get(key);
    for (const f of FIELDS) {
      if ((got?.[f] ?? 0) !== want[f]) {
        throw new Error(
          `personOrgRepo does not reconcile by ${label} for "${key.replace("\u0000", " x ")}": ` +
          `${f} is ${got?.[f] ?? 0}, expected ${want[f]}`,
        );
      }
    }
  }
}

const write = (f: string, d: unknown) => writeFileSync(`${out}/${f}`, JSON.stringify(d, null, 1));

/**
 * The activity log, written as one file the site fetches ON DEMAND.
 *
 * Not sharded per person and per org, which would mean ~380 files: this is a
 * single fetch, cached by the browser for the session, and it serves both the
 * person and the org report from the same bytes because an org's log is its
 * members' events. Not folded into people.json either — that ships on first
 * paint, and per-item detail must not be on the critical path.
 *
 * Internal pids (`email:…`, `login:…`) are mapped to the display slugs the rest
 * of the site uses. A pid is an implementation detail that has leaked to the UI
 * once already; the log is not going to be the second time.
 */
const slugOf = new Map(personRows.map((r) => [r.id, r.slug]));
// PR and issue titles, deduplicated: ~1,100 titles serve ~4,400 events.
const titles: Record<string, string> = {};
// Which of those keys are ISSUES. Shipped because the log cannot work it out:
// an event carries its OWN kind (`comment`, `review`), never the kind of the
// thing it happened on, so a comment on an issue is indistinguishable from a
// comment on a pull request. Without this, every link built from an event has to
// guess, and the guess is wrong 221 times out of 1,221.
//
// A list of the minority rather than a field on every title: 221 keys against
// 1,221, and the shape stays a plain string map that the log already reads.
const issueKeys: string[] = [];
for (const item of Object.values(github?.items ?? {})) {
  const key = `${item.repo}#${item.number}`;
  titles[key] = item.title;
  if (item.kind === "issue") issueKeys.push(key);
}
const eventRows = events
  .map(({ p, ...e }) => ({ ...e, p: slugOf.get(p) ?? p }))
  .sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0)); // newest first

/**
 * Per-item facts and branch attribution, written ONLY when both overlays ran.
 *
 * One file rather than 1,221, for the reason events.json is one file: this is a
 * single on-demand fetch that the browser caches for the session, and per-item
 * detail must never sit on the critical path. Reviews and comments are NOT
 * repeated here — events.json already carries every one of them keyed by repo
 * and number, and duplicating them would create two counts of the same act that
 * could disagree.
 *
 * `d` is the load-bearing field and the reason this file exists in this shape.
 * See `scripts/pull-branches.ts` for what the four values mean; the short form
 * is that only `main` reached the default branch, so only `main` may have its
 * lines added to anything. The other three still get a page, because a review
 * on a stack component is a real review that would otherwise vanish.
 *
 * `u` replaces `d` on a landed pull request whose branch could not be walked,
 * naming why (see `BranchUnavailableReason`). Every landed pull request carries
 * exactly one of the two; `verify` asserts it against raw/.
 */
if (github && branches) {
  const byNumber = new Map(branches.map((b) => [`${b.repo}#${b.number}`, b]));
  // Branch authors resolve through the same public sources displayName uses,
  // and link only to a person row that exists. One with no default-branch or
  // overlay activity is shown under a public `branch-<digest>` key and a label,
  // and adds nothing to any population or total.
  const authorSrc: AuthorSources = {
    curatedByEmail: (email) => byEmail.get(email),
    loginOf: (email) => github.bridge[email]?.toLowerCase() ?? noreplyLogin(email),
    curatedByLogin: (login) => byLogin.get(login),
    published: (pid) => slugOf.get(pid),
  };
  // Git author names on branch commits, voted per identity, for labels only;
  // a pid with default-branch votes keeps those.
  const labelVotes = new Map(nameVotes);
  for (const b of branches.filter(isAvailable)) {
    for (const c of b.commits) {
      if (c.replay) continue;
      const pid = authorPid(c.email, authorSrc);
      if (nameVotes.has(pid)) continue;
      const v = labelVotes.get(pid) ?? new Map<string, number>();
      v.set(c.name, (v.get(c.name) ?? 0) + 1);
      labelVotes.set(pid, v);
    }
  }
  const branchLabel = (pid: string) => nameFor(pid, {
    curated: (slug) => contributors[slug]?.name || undefined,
    votes: labelVotes,
    loginOf: authorSrc.loginOf,
    slugOf: (login) => byLogin.get(login),
    profileName: (login) => github.profiles[login]?.name,
  });
  const itemRows: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(github.items)) {
    const branch = byNumber.get(key);
    const authorPid = item.author ? (byLogin.get(item.author.toLowerCase()) ?? `login:${item.author}`) : null;
    const row: Record<string, unknown> = {
      k: item.kind,
      s: item.state,
      a: authorPid ? (slugOf.get(authorPid) ?? authorPid) : null,
      t: item.at.slice(0, 10),
    };
    if (item.endedAt) row.e = item.endedAt.slice(0, 10);
    if (branch?.status === "unavailable") {
      // The absence and its cause, and nothing else: no destination, no cast, no
      // replays. A row with `w` absent alone would read exactly like a branch
      // whose authors wrote nothing.
      row.u = branch.reason;
    } else if (branch) {
      row.d = branch.dest;
      if (branch.via !== null) row.v = branch.via;
      // [slug, added, deleted, commits] or, for a branch-only author,
      // [branch-<digest>, added, deleted, commits, label]. Emitted for every
      // destination, because a component's page must show its own work; `d`
      // tells the reader and the rollup which of these may be summed. Two
      // addresses resolving to one person -- the GitHub web UI attaches a
      // `users.noreply` identity to a suggestion applied in the browser -- are
      // merged, since publishing that person twice is a visible defect.
      const wrote = projectAuthors(attribute(branch), authorSrc, branchLabel);
      if (wrote.length) row.w = wrote;
      const replays = branch.commits.filter((c) => c.replay).length;
      if (replays) row.r = replays;
    }
    itemRows[key] = row;
  }
  writeFileSync(`${out}/items.json`, JSON.stringify(itemRows));
}

write("summary.json", summary);
write("orgs.json", orgRows);
write("repos.json", repoOrgRows);
write("people.json", personRows);
write("org-people.json", orgPeopleRows);
// The same projection verify recomputes. Collection time is the sealed council
// layer's, never a hand-typed date; the person link only exists where a profile does.
const profiles = new Set(personRows.map((r) => r.id));
write("governance.json", projectGovernance(council, rosterAliases, councilCollectedAt, (slug) => profiles.has(slug)));
// Written compact, unlike every other output. The rest are pretty-printed to
// stay hand-diffable when a number moves; this one is 4,755 machine-read rows
// where a newline per field costs 175KB (708KB -> 533KB, 74KB gzipped).
writeFileSync(`${out}/events.json`, JSON.stringify({ titles, issueKeys, events: eventRows }));

/**
 * Project responsiveness, written ONLY when the overlay ran.
 *
 * Absent rather than empty, because latency is uncomputable from the git spine
 * (commits carry no clock) — an empty file would be a measured zero, and the
 * site would have to decide whether "0 hours" meant "instant" or "unknown". A
 * missing file cannot be misread. The Heartbeat page reports the absence and
 * stops.
 *
 * Compact for the same reason as events.json: the aggregates are worth eyeballing
 * but the ~1,200 item rows under them are not, and the console lines below print
 * the figures a human actually checks between runs.
 */
if (github) {
  const report = heartbeat({
    items: Object.values(github.items),
    events: github.events,
    // Resolved at the event instant, sliced to a calendar date the same way
    // `observe` does: spans are YYYY-MM-DD and compared lexicographically, so
    // handing them a full timestamp would work only by accident of prefixing.
    orgOf: (login, at) => orgAt(resolve(byLogin.get(login) ?? `login:${login}`), at.slice(0, 10)),
    slugOf: (login) => {
      const pid = byLogin.get(login) ?? `login:${login}`;
      return slugOf.get(pid) ?? pid;
    },
  });
  writeFileSync(`${out}/heartbeat.json`, JSON.stringify(report));
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "n/a");
  console.log(
    `responsiveness: pull requests ${report.pr.firstResponse.med}h to first response, ` +
      `${report.pr.silent} of ${report.pr.n} silent (${pct(report.pr.silent, report.pr.n)}); ` +
      `issues ${report.issue.firstResponse.med}h, ` +
      `${report.issue.silent} of ${report.issue.n} silent (${pct(report.issue.silent, report.issue.n)})`,
  );
  // Report the completed items excluded from the live awaiting-reply queue,
  // keeping its population inspectable without adding them back to the page.
  console.log(
    `  withdrawn by author   ${report.pr.withdrawn} PRs, ${report.issue.withdrawn} issues\n` +
      `  ended with no reply   ${report.pr.verdictNoReply + report.issue.verdictNoReply} ` +
      `(excluded from the queue: they have an outcome)`,
  );
}

// Reports the POPULATION, so it uses the same definitions the site reports —
// `summary.people` excludes bots, `summary.orgs` excludes the four pseudo-org
// buckets. It previously printed the raw row counts under those nouns, which
// claimed 6 bots were people and called `bot`/`unknown`/`independent`/
// `undisclosed` organizations; `independent` most absurdly, since it means the
// person has none. Both correct definitions already existed 80 lines above and
// were read by nobody.
console.log(
  `derived ${commits.length} commits` +
    (github ? ` + ${github.events.length} GitHub events` : " (no GitHub overlay)") +
    ` → ${summary.people} people (+${personRows.length - summary.people} bots), ` +
    `${summary.orgs} organizations (+${orgRows.length - summary.orgs} unattributed)`,
);
const c = summary.coverage;
console.log(`commits attributed: ${c.pct}% of ${c.human} human commits`);
if (github) {
  const r = summary.github!.coverage;
  console.log(`reviews attributed: ${r.pct}% of ${r.human} human reviews`);
  console.log(`unmapped logins: ${unmappedLogins.size} of ${summary.github!.logins} (run \`bun run audit\`)`);
}
