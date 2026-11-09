#!/usr/bin/env bun
// Assert that the generated site data is internally consistent and safe to
// publish. Run after `derive`; exits non-zero on any failure.
//
// Why this exists as a script rather than as unit tests: these are invariants
// about the *real dataset*, and a fixture cannot catch real data drifting. The
// repositories are live — a total that was right an hour ago is wrong once
// someone pushes — so nothing here hardcodes an expected number. Every check
// either recounts from the raw layer or compares the output against itself.
//
// Why it is not folded into `derive`: derive already throws on the invariants it
// can check while building (span validity, reconciliation). These are checks on
// the finished artifact, including "does anything here leak internal state to a
// public page", which is a different question from "did the arithmetic add up".
import { existsSync, readFileSync } from "node:fs";
import { checkDerived, FULL_ONLY_GENERATED, loadSealed, parseMode, type Sealed } from "./lib/acquisition.ts";
import { loadContributors, loadCouncil, loadRepos, p } from "./lib/data.ts";
import { councilsBySlug, projectGovernance, rosterIndex, type PublishedGovernance } from "./lib/roster.ts";
import { firstReviews } from "./lib/events.ts";
import { outcomeOf } from "./lib/items.ts";
import { attribute, DESTS, isAvailable, UNAVAILABLE_REASONS, validateBranches } from "./lib/branches.ts";
import { BRANCH_KEY, castTotals, INTERNAL_ID, type CastRow } from "./lib/authors.ts";
import { noreplyLogin } from "./lib/names.ts";
import type { BranchRecord, GitHubEvent, Item } from "./lib/types.ts";
// The vocabulary the site itself renders from, so these checks cannot drift from
// what ships. Imported from vocab.js rather than lib.js because lib.js registers
// scroll and resize listeners at import time: a checker reaching into the view
// layer should not depend on the runtime happening to define `addEventListener`.
import { COLS, COL_PLAN, EVENT_KINDS, GH_FIELDS, isAttributed, PSEUDO_ORGS } from "../site/vocab.js";

const fails: string[] = [];
const check = (ok: boolean, msg: string) => {
  if (!ok) fails.push(msg);
};

const read = <T>(rel: string): T => JSON.parse(readFileSync(p(rel), "utf8")) as T;

const need = ["site/data/summary.json", "site/data/orgs.json", "site/data/people.json", "site/data/governance.json"];
for (const f of need) {
  if (!existsSync(p(f))) {
    console.error(`verify: ${f} is missing — run \`bun run derive\` first`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// 0. The output was derived from the seal that is on disk now.
//
// Re-validated rather than trusted from derive: a `pull:*` between derive and
// verify rewrites a raw file this script recounts from, and a recount against
// different bytes than derive read proves nothing.
// ---------------------------------------------------------------------------
let sealed: Sealed;
try {
  sealed = loadSealed(p(), loadRepos().map((r) => r.name), parseMode(process.argv.slice(2)));
} catch (e) {
  console.error(`verify: ${(e as Error).message}`);
  process.exit(2);
}
const mode = sealed.mode;

const shippedGovernance = read<PublishedGovernance>("site/data/governance.json");

type Row = Record<string, number | string | string[] | undefined>;
// people.json carries two fields this file reasons about by name rather than by
// metric, so they are typed rather than indexed out of the loose Row.
type PersonRow = Row & {
  slug: string; logins?: string[]; profileCompany?: string | null; councils?: string[];
  repos?: Array<Row & { repo: string }>;
};
const summary = read<{
  acquisition?: unknown;
  totals: Record<string, number>;
  github: unknown;
  people: number;
  repos: string[];
  repoClass?: Record<string, string>;
  coverage: { attributed: number; human: number; total: number; pct: number };
}>("site/data/summary.json");
for (const e of checkDerived(summary.acquisition, sealed)) fails.push(e);
if (mode === "git-only") {
  check(summary.github === null, "git-only seal but summary.json carries a GitHub overlay");
  for (const f of FULL_ONLY_GENERATED) {
    check(!existsSync(p("site/data", f)), `git-only seal but site/data/${f} exists — it is from an earlier full run`);
  }
} else {
  check(summary.github !== null, "full seal but summary.json has no GitHub overlay");
  for (const f of FULL_ONLY_GENERATED) {
    check(existsSync(p("site/data", f)), `full seal but site/data/${f} is missing`);
  }
}

const orgs = read<Row[]>("site/data/orgs.json");
const people = read<PersonRow[]>("site/data/people.json");
// One row per (repo, org). Read here rather than recomputed from `orgs`, because
// the review-eligibility check below needs a per-repository proposal total and
// the org rollup has already summed that dimension away.
const repoRows = read<Array<Row & { repo: string }>>("site/data/repos.json");

const n = (v: unknown) => (typeof v === "number" ? v : 0);
const sum = (rows: Row[], f: string) => rows.reduce((t, r) => t + n(r[f]), 0);

// ---------------------------------------------------------------------------
// 1. Independent recount against the raw layer.
//
// derive's own reconciliation compares its buckets against each other, so a
// systematic error would agree with itself. This recounts from the input file
// derive read, which is the only way to catch "derive dropped whole records" —
// the failure that discarded 1,242 of 2,877 review submissions once already.
// ---------------------------------------------------------------------------
if (existsSync(p("raw/commits.jsonl"))) {
  const lines = readFileSync(p("raw/commits.jsonl"), "utf8").split("\n").filter(Boolean);
  check(
    sum(orgs, "commits") === lines.length,
    `commit total ${sum(orgs, "commits")} != ${lines.length} raw commits`,
  );
  // Co-authorship is counted per (commit, canonical person), so the recount
  // resolves every declared address to a person before counting.
  //
  // Recomputed here from curated records and the sealed bridge, NOT through
  // derive's helper, so a regression in that helper disagrees with this count:
  // a declaration credits its person once per commit, never the commit's author
  // under any of their addresses, and never a second alias of someone already
  // credited. Unresolved addresses are people keyed by their normalized text.
  const contributorsForCo = loadContributors();
  const coEmail = new Map<string, string>();
  const coLogin = new Map<string, string>();
  for (const [slug, c] of Object.entries(contributorsForCo)) {
    for (const e of c.emails ?? []) coEmail.set(e.trim().toLowerCase(), slug);
  }
  const coBridge = mode === "full" && existsSync(p("raw/logins.json"))
    ? read<Record<string, string>>("raw/logins.json") : {};
  const strip = (l: string) => l.trim().toLowerCase().replace(/\[bot\]$/, "");
  for (const [e, l] of Object.entries(coBridge)) {
    const owner = coEmail.get(e.trim().toLowerCase());
    if (owner) coLogin.set(strip(l), owner);
  }
  for (const [slug, c] of Object.entries(contributorsForCo)) {
    for (const l of c.logins ?? []) coLogin.set(strip(l), slug); // explicit wins
  }
  const coPerson = (raw: string) => {
    const e = raw.trim().toLowerCase();
    const login = coBridge[e] ?? noreplyLogin(e);
    return coEmail.get(e) ?? (login ? coLogin.get(strip(login)) : undefined) ?? `email:${e}`;
  };
  const rawCo = lines.reduce((t, l) => {
    const c = JSON.parse(l) as { email: string; coauthors?: string[] };
    const author = coPerson(c.email);
    const people = new Set((c.coauthors ?? []).map(coPerson));
    people.delete(author);
    return t + people.size;
  }, 0);
  check(
    sum(orgs, "coauthored") === rawCo,
    `coauthored total ${sum(orgs, "coauthored")} != ${rawCo} per-person coauthor credits recounted from raw`,
  );
} else {
  console.warn("verify: raw/commits.jsonl absent — skipped the independent recount");
}

// ---------------------------------------------------------------------------
// 2. The two views of the same facts must agree.
// ---------------------------------------------------------------------------
for (const f of Object.keys(summary.totals)) {
  check(
    sum(orgs, f) === sum(people, f),
    `${f}: orgs sum ${sum(orgs, f)} != people sum ${sum(people, f)}`,
  );
  check(
    summary.totals[f] === sum(orgs, f),
    `${f}: summary total ${summary.totals[f]} != orgs sum ${sum(orgs, f)}`,
  );
}

// ---------------------------------------------------------------------------
// 3. Nothing internal or accidental reaches a public page.
//
// Every one of these has actually happened in this project: an internal pid
// rendered as a name, and a profile whose `name` field was an email address
// republished on a public page.
//
// An address as a display name is allowed in exactly one case, judged by where
// the row came from rather than by the character: an identity known ONLY by a
// git address (`email:` id) that is public in raw/commits.jsonl -- as an author or
// in a Co-authored-by trailer -- and that no source maps to an account. Anything
// else carrying an `@` is a profile field or a curated name republishing an
// address, which is the defect this check was written for. The blanket form
// failed the build on the first trailer-only co-author it met.
// ---------------------------------------------------------------------------
const named = people.filter((r) => typeof r.name === "string") as unknown as { name: string; id?: string; emails?: string[] }[];
{
  const gitEmails = new Set<string>();
  if (existsSync(p("raw/commits.jsonl"))) {
    for (const l of readFileSync(p("raw/commits.jsonl"), "utf8").split("\n")) {
      if (!l) continue;
      const c = JSON.parse(l) as { email: string; coauthors?: string[] };
      gitEmails.add(c.email);
      for (const e of c.coauthors ?? []) gitEmails.add(e);
    }
  }
  // The bridge is overlay data, so it is consulted only when the seal says the
  // overlay is part of this run.
  const bridge = mode === "full" && existsSync(p("raw/logins.json"))
    ? read<Record<string, string>>("raw/logins.json") : {};
  const why = (r: { name: string; id?: string; emails?: string[] }): string | null => {
    if (!r.name.includes("@")) return null;
    if (r.id !== `email:${r.name}`) return "not an address-only identity";
    if (r.emails?.length !== 1 || r.emails[0] !== r.name) return "row does not publish this address as its identity";
    if (!gitEmails.has(r.name)) return "address is not in raw/commits.jsonl";
    if (noreplyLogin(r.name) || bridge[r.name]) return "address maps to a GitHub login, which is the better label";
    return null;
  };
  const bad = named.map((r) => [r, why(r)] as const).filter(([, w]) => w);
  check(bad.length === 0,
    `${bad.length} display name(s) contain an email: ` +
    bad.slice(0, 3).map(([r, w]) => `${r.name} (${w})`).join(", "));
}
check(
  named.every((r) => !/^(email|login|pid):/.test(r.name)),
  `internal id leaked as a display name: ${named.filter((r) => /^(email|login|pid):/.test(r.name)).map((r) => r.name).slice(0, 3).join(", ")}`,
);

// ---------------------------------------------------------------------------
// 4. No row that says nothing.
//
// An org present in the table with zero of every metric is either a data-entry
// slip or an org invented from a "current employer" snapshot with no observed
// activity. Both mislead: the row implies participation that was never measured.
// ---------------------------------------------------------------------------
const metrics = Object.keys(summary.totals);
const empty = orgs.filter((r) => metrics.every((f) => n(r[f]) === 0));
check(empty.length === 0, `${empty.length} org row(s) are zero on every metric: ${empty.map((r) => r.org).join(", ")}`);

// The check above asks whether a row has any activity AT ALL. This one asks the
// harder question: whether the activity it has is activity the reader can SEE.
//
// A curated column set can silently delete people. `issues` was excluded from
// the tables as scan-view noise, which erased every contributor whose only
// contribution was a filed issue — 48 people and 12 orgs rendered as a row of
// blanks, indistinguishable from having done nothing, and it took a human
// asking "why is this org even in the list?" to notice. An unmeasured metric is
// hidden on purpose; a measured one rendered as nothing is a lie.
//
// COLS is imported rather than restated, because two copies of a display
// contract drift and the drift is invisible in exactly this way.
//
// The containment is asserted before it is used. `shown` filters COLS down to
// the measured fields, and a filter cannot tell "nothing to drop" from "dropped
// silently" -- so a column naming a field derive does not produce would shrink
// the denominator of the check below and weaken it, rather than failing. Two
// comments in the site already claimed this check existed; now it does.
//
// Contained against the columns ACTIVE in this mode, not every definition: a
// git-only build hides the overlay columns on purpose (the site drops any
// column not in summary.fields), so demanding them here failed every git-only
// verify. The overlay columns are exactly GH_FIELDS; a git-only build that
// measured one anyway is caught by the all-or-nothing overlay check (7).
const active = mode === "full" ? COLS : COLS.filter((f) => !GH_FIELDS.includes(f));
const unmeasured = active.filter((f) => !metrics.includes(f));
check(unmeasured.length === 0,
  `${unmeasured.length} column(s) active in ${mode} mode name a field derive does not ` +
  `measure: ${unmeasured.join(", ")}`);
const shown = active.filter((f) => metrics.includes(f));
for (const [rows, key, what] of [[orgs, "org", "org"], [people, "slug", "person"]] as const) {
  const invisible = rows.filter((r) =>
    shown.every((f) => n(r[f]) === 0) && metrics.some((f) => n(r[f]) > 0));
  check(invisible.length === 0,
    `${invisible.length} ${what} row(s) have activity but render blank in COLS ` +
    `(their only metrics are hidden): ${invisible.slice(0, 6).map((r) => r[key]).join(", ")}` +
    `${invisible.length > 6 ? ", …" : ""}`);
}

// ---------------------------------------------------------------------------
// 4b. Nobody reviewed more than they were eligible to review.
// ---------------------------------------------------------------------------
// A person cannot review their own pull request, so their review count can never
// exceed the repository's proposals MINUS their own. The site divides by that
// difference to state a review share, and a denominator smaller than its
// numerator would print a share above 100% -- which is the visible symptom. The
// invisible one is worse: if this ever breaks it means `reviews` has stopped
// being one-per-(item, reviewer), and every review figure on the site is then
// counting something other than what it says.
//
// Asserted per person-repository pair rather than in total, because totals can
// net out. Holds across all 142 pairs that carry any review today.
{
  const proposedIn = new Map<string, number>();
  for (const r of repoRows) {
    proposedIn.set(r.repo, (proposedIn.get(r.repo) ?? 0) + n(r.proposed));
  }
  // `p.repos ?? []` alone would be a dead guard: strip the breakdown from every
  // person and the loop iterates nothing, so the check passes on data that has
  // lost the entire per-repository layer the person page renders. Six of these
  // have already been found in this project. Assert the input is PRESENT, then
  // trust it.
  const noRepos = people.filter((r) => !Array.isArray(r.repos));
  check(noRepos.length === 0,
    `${noRepos.length} person row(s) carry no per-repository breakdown, which the ` +
    `person page renders and the eligibility check below would silently skip: ` +
    `${noRepos.slice(0, 4).map((r) => r.slug).join(", ")}`);

  const over = people.flatMap((p) =>
    (p.repos ?? [])
      .filter((r) => n(r.reviews) > (proposedIn.get(r.repo) ?? 0) - n(r.proposed))
      .map((r) => `${p.slug}/${r.repo}: ${n(r.reviews)} reviews but ` +
                  `${(proposedIn.get(r.repo) ?? 0) - n(r.proposed)} eligible`));
  check(over.length === 0,
    `${over.length} person-repository pair(s) review more than they could have: ` +
    `${over.slice(0, 4).join("; ")}${over.length > 4 ? ", …" : ""}`);
}

// ---------------------------------------------------------------------------
// 4c. Every repository names a valid class.
// ---------------------------------------------------------------------------
// `RepoClass` is a compile-time union and data/repos.json5 is parsed with a cast,
// so a typo or an omission survives both tsc and the parse: the field arrives
// undefined, JSON.stringify drops it, and the repository vanishes from every
// class-scoped view -- 132 commits and 55 proposals gone with nothing failing,
// while the shares of the repositories that remain still add to 100%. A silent,
// plausible-looking wrong number is this project's worst failure mode.
{
  const KNOWN = ["spec", "tooling", "impl"];
  const byClass = summary.repoClass ?? {};
  const bad = (summary.repos ?? []).filter((r) => !KNOWN.includes(byClass[r] ?? ""));
  check(bad.length === 0,
    `${bad.length} repositor${bad.length === 1 ? "y lacks" : "ies lack"} a valid class in ` +
    `data/repos.json5 (one of ${KNOWN.join(", ")}): ${bad.join(", ")} — they would ` +
    `silently disappear from every class-scoped view`);
}

// ---------------------------------------------------------------------------
// 4d. Branch attribution names a real destination, and only deliveries may sum.
// ---------------------------------------------------------------------------
// `dest` decides whether a pull request's lines may be added to a person, an
// organization or a repository. Get it wrong in one direction and a stack
// component's work is counted twice -- once inside the pull request that carried
// it to the default branch and once on its own; get it wrong in the other and a
// contributor's work vanishes from the only page that could show it. Both have
// already happened here, in that order, on ucp#589.
//
// The checks below are about the SHAPE that makes those errors possible, so they
// are asserted against the shipped file rather than recomputed from git: a
// re-walk would agree with itself.
if (existsSync(p("site/data/items.json"))) {
  const items = read<Record<string, {
    k: string; s: string; a?: string | null; d?: string; v?: string | number; u?: string; r?: number;
    w?: CastRow[];
  }>>("site/data/items.json");
  const rows = Object.entries(items);

  // Every author on an item page links to a published person, or is an explicit
  // branch-only row: a `branch-<digest>` key that is no person's slug, carrying a
  // public label. Anything else -- an internal `email:`/`login:` pid, a slug with
  // no row -- would print pipeline state as a name or render a dead link.
  const personSlugs = new Set(people.map((x) => x.slug));
  const badAuthor: string[] = [];
  for (const [k, i] of rows) {
    for (const w of i.w ?? []) {
      const label = w[4];
      const ok = w.length === 4
        ? personSlugs.has(w[0])
        : w.length === 5 && BRANCH_KEY.test(w[0]) && !personSlugs.has(w[0]) &&
          typeof label === "string" && label.trim() !== "" && !INTERNAL_ID.test(label);
      if (!ok) badAuthor.push(`${k} -> ${JSON.stringify(w[0])}`);
    }
  }
  check(badAuthor.length === 0,
    `${badAuthor.length} branch authors neither link to a person row nor are a labelled ` +
    `branch-only row: ${badAuthor.slice(0, 5).join(", ")}`);
  const internalOpener = rows.filter(([, i]) => i.a != null && !personSlugs.has(i.a));
  check(internalOpener.length === 0,
    `${internalOpener.length} items name an opener with no person row: ` +
    internalOpener.slice(0, 5).map(([k, i]) => `${k} -> ${i.a}`).join(", "));

  // Exactly one branch statement per landed pull request -- a destination OR a
  // stated absence -- and none on anything else. Missing both is how three
  // landed pull requests used to render as if nobody had written them.
  const landedRows = rows.filter(([, i]) => i.k === "pr" && i.s === "landed");
  const neither = landedRows.filter(([, i]) => (i.d === undefined) === (i.u === undefined));
  check(neither.length === 0,
    `${neither.length} landed pull requests carry neither or both of a destination and an ` +
    `unavailability reason: ${neither.slice(0, 5).map(([k]) => k).join(", ")}`);
  const stray = rows.filter(([, i]) => !(i.k === "pr" && i.s === "landed") && (i.d !== undefined || i.u !== undefined));
  check(stray.length === 0,
    `${stray.length} items that did not land carry branch status: ${stray.slice(0, 5).map(([k]) => k).join(", ")}`);
  const badReason = rows.filter(([, i]) => i.u !== undefined && !(UNAVAILABLE_REASONS as readonly string[]).includes(i.u));
  check(badReason.length === 0,
    `${badReason.length} items carry an unknown unavailability reason: ${badReason.slice(0, 5).map(([k]) => k).join(", ")}`);
  // An absence carrying lines, a carrier or replays is a measurement wearing an
  // absence label.
  const absentWithData = rows.filter(([, i]) => i.u !== undefined && (i.w !== undefined || i.v !== undefined || i.r !== undefined));
  check(absentWithData.length === 0,
    `${absentWithData.length} items are marked unavailable but carry branch data: ` +
    absentWithData.slice(0, 5).map(([k]) => k).join(", "));

  const badDest = rows.filter(([, i]) => i.d !== undefined && !(DESTS as readonly string[]).includes(i.d));
  check(badDest.length === 0,
    `${badDest.length} items carry an unknown branch destination ` +
    `(expected one of ${DESTS.join(", ")}): ${badDest.slice(0, 5).map(([k]) => k).join(", ")}`);

  // A component must name its carrier and a side branch its ref, or the page
  // says "not delivered to main" with no way for a reader to find where it went.
  const noVia = rows.filter(([, i]) => (i.d === "component" || i.d === "sidebranch") && i.v === undefined);
  check(noVia.length === 0,
    `${noVia.length} items are a component or side branch but name no carrier: ` +
    noVia.slice(0, 5).map(([k]) => k).join(", "));

  // The defect this exists for: two email addresses resolving to one person put
  // that person in one cast table twice, with their work split across the rows.
  const dupCast = rows.filter(([, i]) => {
    const slugs = (i.w ?? []).map((w) => w[0]);
    return new Set(slugs).size !== slugs.length;
  });
  check(dupCast.length === 0,
    `${dupCast.length} items list the same person twice in their branch attribution: ` +
    dupCast.slice(0, 5).map(([k]) => k).join(", "));

  // Negative lines are impossible from numstat, so a negative here means an
  // aggregation bug rather than surprising data.
  const negative = rows.filter(([, i]) => (i.w ?? []).some((w) => w[1] < 0 || w[2] < 0 || w[3] < 1));
  check(negative.length === 0,
    `${negative.length} items carry a negative line count or a zero-commit author: ` +
    negative.slice(0, 5).map(([k]) => k).join(", "));

  // An issue has no branch, so line attribution on one is a category error that
  // would silently credit code to a conversation.
  const issueLines = rows.filter(([, i]) => i.k === "issue" && (i.w?.length || i.d !== undefined));
  check(issueLines.length === 0,
    `${issueLines.length} issues carry branch attribution: ` +
    issueLines.slice(0, 5).map(([k]) => k).join(", "));

  const delivered = rows.filter(([, i]) => i.d === "main").length;
  check(delivered > 0, "no pull request is recorded as delivered to a default branch");

  // events.json ships the issue keys separately, because an event carries its own
  // kind and never the kind of the thing it happened on. That makes it a SECOND
  // statement of a fact items.json already holds, and two statements of one fact
  // are a thing that can disagree -- so they are checked against each other here.
  // Disagreement is silent by construction: the wrong link still resolves, it
  // just names the wrong kind of thing in the address bar.
  if (existsSync(p("site/data/events.json"))) {
    const ev = read<{ issueKeys?: string[] }>("site/data/events.json");
    const declared = new Set(ev.issueKeys ?? []);
    const actual = new Set(rows.filter(([, i]) => i.k === "issue").map(([k]) => k));
    const missing = [...actual].filter((k) => !declared.has(k));
    const extra = [...declared].filter((k) => !actual.has(k));
    check(missing.length === 0 && extra.length === 0,
      `events.json and items.json disagree about which items are issues: ` +
      `${missing.length} missing (${missing.slice(0, 3).join(", ")}), ` +
      `${extra.length} spurious (${extra.slice(0, 3).join(", ")})`);
  }
}

// ---------------------------------------------------------------------------
// 4e. Governance is exactly the pulled roster, and profiles agree with it.
// ---------------------------------------------------------------------------
// Recomputed from raw/council.json, contributor aliases and the seal, so a
// governance.json from a different roster or alias file fails here. Roster
// drift itself is NOT checked against anything: membership is whatever the
// source says today.
{
  const raw = loadCouncil();
  const collectedAt = sealed.manifest.layers.council?.finishedAt;
  if (!raw || !collectedAt) {
    fails.push("raw/council.json or its sealed council layer is missing — run `bun run acquire`");
  } else {
    try {
      const aliases = rosterIndex(loadContributors());
      const ids = new Set(people.map((x) => String(x.id)));
      const want = projectGovernance(raw, aliases, collectedAt, (slug) => ids.has(slug));
      check(JSON.stringify(shippedGovernance) === JSON.stringify(want),
        "site/data/governance.json is not the projection of raw/council.json + rosterNames — run `bun run derive`");
      const shippedSeats = shippedGovernance.councils.reduce((n, c) => n + c.seats.length, 0);
      check(shippedSeats === raw.seats.length && shippedGovernance.councils.length === raw.councils.length,
        `governance.json has ${shippedSeats} seats under ${shippedGovernance.councils.length} headings; ` +
        `raw has ${raw.seats.length} under ${raw.councils.length}`);
      // Person pages and the Governance page must state the same membership.
      const fromPage = new Map<string, string[]>();
      for (const c of shippedGovernance.councils) {
        for (const seat of c.seats) {
          if (!seat.person) continue;
          fromPage.set(seat.person, [...(fromPage.get(seat.person) ?? []), c.name]);
        }
      }
      const byRoster = councilsBySlug(raw, aliases);
      const bad: string[] = [];
      for (const person of people) {
        const page = (fromPage.get(String(person.id)) ?? []).join("|");
        const profile = (person.councils ?? []).join("|");
        const roster = (byRoster.get(String(person.id)) ?? []).join("|");
        if (page !== profile || profile !== roster) bad.push(`${person.slug}: page=[${page}] profile=[${profile}]`);
      }
      check(bad.length === 0, `${bad.length} profile council lists disagree with the roster: ${bad.slice(0, 4).join(", ")}`);
      // Zero links with a non-empty roster means the alias join broke, not that
      // nobody on the roster contributes.
      check(fromPage.size > 0, `raw/council.json holds ${raw.seats.length} seats but no alias links any of them`);
    } catch (e) {
      fails.push(`governance: ${(e as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Identity keys are unique in the output.
// ---------------------------------------------------------------------------
for (const [rows, key, what] of [
  [orgs, "org", "org"],
  [people, "slug", "person"],
] as const) {
  const ids = rows.map((r) => r[key]);
  const dupes = ids.filter((v, i) => ids.indexOf(v) !== i);
  check(dupes.length === 0, `duplicate ${what} row(s): ${[...new Set(dupes)].join(", ")}`);
}

// ---------------------------------------------------------------------------
// 6. Coverage arithmetic cannot exceed its own denominator.
//
// The headline percentage is the most quoted number the site produces and it is
// gated by a hand-maintained list of pseudo-orgs. If a pseudo-org were dropped
// from that list, attribution would silently inflate — and pass every other
// check here, because the sums would still reconcile.
// ---------------------------------------------------------------------------
const { attributed, human, total, pct } = summary.coverage;
check(attributed <= human, `attributed ${attributed} > human ${human}`);
check(human <= total, `human ${human} > total ${total}`);
check(pct >= 0 && pct <= 100, `coverage pct out of range: ${pct}`);

// Recomputed from the org rows rather than bounded by an inequality. The
// previous form asserted `attributed + row.commits <= human`, which holds by
// construction for any row small enough and therefore could not fail for the
// case it was written to catch: a pseudo-org dropped from the list inflates
// attribution by exactly that row, and the inequality stays true. Restating the
// three definitions makes each one falsifiable.
check(
  attributed === sum(orgs.filter((r) => isAttributed(String(r.org))), "commits"),
  `coverage.attributed ${attributed} != ${sum(orgs.filter((r) => isAttributed(String(r.org))), "commits")} ` +
    `commits on non-pseudo orgs — a pseudo-org may have dropped off PSEUDO_ORGS`,
);
check(
  human === sum(orgs.filter((r) => r.org !== "bot"), "commits"),
  `coverage.human ${human} != ${sum(orgs.filter((r) => r.org !== "bot"), "commits")} non-bot commits`,
);
check(total === sum(orgs, "commits"), `coverage.total ${total} != ${sum(orgs, "commits")} commits`);
// Every pseudo-org must be OUTSIDE the numerator, stated directly.
for (const pseudo of PSEUDO_ORGS) {
  check(!isAttributed(pseudo), `PSEUDO_ORGS lists "${pseudo}" but isAttributed() accepts it`);
}

// ---------------------------------------------------------------------------
// 7. The overlay is all-or-nothing.
//
// Yankability is a promise: delete the overlay and the site still works, with
// those columns absent rather than rendered as a measured zero. Absent and zero
// are different facts. This asserts the shape rather than trusting it.
// ---------------------------------------------------------------------------
const present = GH_FIELDS.filter((f) => f in summary.totals);
if (summary.github === null) {
  check(present.length === 0, `overlay is absent but gh fields are present: ${present.join(", ")}`);
  check(
    orgs.every((r) => GH_FIELDS.every((f) => !(f in r))),
    "overlay is absent but org rows carry gh keys — an unmeasured metric must be absent, not 0",
  );
} else {
  check(present.length === GH_FIELDS.length, `overlay is present but gh fields are missing: ${GH_FIELDS.filter((f) => !(f in summary.totals)).join(", ")}`);
}

// ---------------------------------------------------------------------------
// 8. The activity log decomposes into the aggregates, per org and in total.
//
// The log is emitted from inside derive's `record`, so by construction every
// event was counted and every count produced an event. This check is what makes
// that claim falsifiable rather than merely asserted — and it is the check that
// matters most for this view, because the log is the receipt a reader uses to
// disbelieve a number. A log that disagreed with the panel above it would
// discredit both.
//
// `landed`/`declined`/`open` are absent by design: they are verdicts reached
// later by other people, not acts on a date, so a proposal appears once.
// ---------------------------------------------------------------------------
if (existsSync(p("site/data/events.json"))) {
  const log = read<{ titles: Record<string, string>; events: { k: string; o: string; p: string; d: string; i?: number }[] }>(
    "site/data/events.json",
  );
  // Many-to-one: timeline and inline comments are separate kinds in the log and
  // one metric in the tables, so the reconciliation sums both against `comments`.
  // Read from the shared vocabulary so a new kind cannot be reconciled here and
  // simultaneously missing from the filter the view renders.
  const KIND_FIELD: Record<string, string> = Object.fromEntries(
    EVENT_KINDS.map((k: { kind: string; field: string }) => [k.kind, k.field]),
  );
  const FIELD_KINDS = new Map<string, string[]>();
  for (const [k, f] of Object.entries(KIND_FIELD)) {
    FIELD_KINDS.set(f, [...(FIELD_KINDS.get(f) ?? []), k]);
  }

  const byKind: Record<string, number> = {};
  const byOrgKind = new Map<string, number>();
  for (const e of log.events) {
    byKind[e.k] = (byKind[e.k] ?? 0) + 1;
    const k = `${e.o}\u0000${e.k}`;
    byOrgKind.set(k, (byOrgKind.get(k) ?? 0) + 1);
  }

  check(
    Object.keys(byKind).every((k) => k in KIND_FIELD),
    `activity log has unknown kinds: ${Object.keys(byKind).filter((k) => !(k in KIND_FIELD)).join(", ")}`,
  );

  for (const [field, kinds] of FIELD_KINDS) {
    if (!(field in summary.totals)) continue; // metric absent without the overlay
    const got = kinds.reduce((t, k) => t + (byKind[k] ?? 0), 0);
    check(
      got === summary.totals[field],
      `activity log has ${got} ${kinds.map((k) => `"${k}"`).join("+")} events but summary.totals.${field} is ${summary.totals[field]}`,
    );
  }

  // Per-org, because a total can reconcile while attribution is scrambled
  // between two orgs — the exact shape of the bug that hit three views.
  for (const row of orgs) {
    for (const [field, kinds] of FIELD_KINDS) {
      if (!(field in row)) continue;
      const got = kinds.reduce((t, k) => t + (byOrgKind.get(`${row.org}\u0000${k}`) ?? 0), 0);
      check(
        got === n(row[field]),
        `activity log: org ${row.org} has ${got} ${kinds.map((k) => `"${k}"`).join("+")} events but its row says ${field}=${n(row[field])}`,
      );
    }
  }

  // Every event must name a person the site can actually route to, and must not
  // leak an internal pid. This has been a real defect once already.
  const slugs = new Set(people.map((r) => String(r.slug)));
  const orphan = log.events.filter((e) => !slugs.has(e.p));
  check(orphan.length === 0,
    `${orphan.length} activity events name a person with no row: ${[...new Set(orphan.map((e) => e.p))].slice(0, 5).join(", ")}`);
  // Defence in depth for the next REST path someone adds: GitHub's REST API
  // suffixes App accounts with `[bot]` and its GraphQL API does not, which
  // silently split one bot into two identities.
  const suffixed = log.events.filter((e) => e.p.includes("[bot]"));
  check(suffixed.length === 0,
    `${suffixed.length} events name a "[bot]"-suffixed account, so one bot is recorded as two identities`);

  const leaked = log.events.filter((e) => /^(email|login|pid):/.test(e.p));
  check(leaked.length === 0, `${leaked.length} activity events leak an internal pid`);

  // Reviews and comments must carry GitHub's id for the exact one, or the log
  // links to the top of a pull request that may hold 90 of them. This fails
  // loudly because the failure is otherwise invisible: the link still WORKS, it
  // just quietly points at the container instead of the thing the row is about.
  const anchored = new Set(["review", "comment", "reviewcomment"]);
  const unanchored = log.events.filter((e) => anchored.has(e.k) && !e.i);
  check(
    unanchored.length === 0,
    `${unanchored.length} review/comment events have no GitHub id, so they link to the ` +
      `enclosing pull request instead of the exact comment (re-run \`bun run pull:github\`)`,
  );
}

// ---------------------------------------------------------------------------
// 9. summary.json's own headline counts.
//
// Nothing in the site reads these; they exist for whoever consumes the JSON
// directly, which makes them exactly the fields most likely to rot unnoticed.
// ---------------------------------------------------------------------------
check(summary.people === people.filter((r) => r.org !== "bot").length,
  `summary.people is ${summary.people} but people.json has ${people.filter((r) => r.org !== "bot").length} non-bot rows`);

// ---------------------------------------------------------------------------
// 10. The columns marked as a partition really are one.
//
// COL_PLAN marks landed/open/declined with `kid`, and the table draws a rule
// fusing them into one bracket beneath `proposed`. That rule is a claim about
// arithmetic: these three are the parts, and the column outside the bracket is
// the sum. If derive ever breaks the identity, the bracket becomes a lie that
// looks exactly like a correct table — nothing renders differently, the numbers
// simply stop adding up, and only a reader who bothers to sum three columns
// would ever notice.
//
// The parent and its parts are read from COL_PLAN rather than named here, so
// re-marking a column re-aims the check instead of leaving it asserting the old
// shape.
// ---------------------------------------------------------------------------
if (COLS.includes("proposed")) {
  const kids = COL_PLAN.filter((c: { kid?: boolean }) => c.kid).map((c: { f: string }) => c.f);
  const parentIdx = COL_PLAN.findIndex((c: { kid?: boolean }) => c.kid) - 1;
  const parent = COL_PLAN[parentIdx]?.f as string;
  // `?.` rather than `.`: the `&&` above already short-circuits when parentIdx is
  // -1, so this was safe, but only provably so to a reader who traces it. The
  // optional chain says it in the expression instead, and the check still fails
  // (rather than throwing) if COL_PLAN opens with a kid column.
  check(!!parent && !COL_PLAN[parentIdx]?.kid,
    `COL_PLAN marks ${kids.join("+")} as a partition but the column before them is not a plain parent`);

  for (const [rows, key, what] of [[orgs, "org", "org"], [people, "slug", "person"]] as const) {
    const bad = rows.filter((r) => n(r[parent]) !== kids.reduce((t, f) => t + n(r[f]), 0));
    check(bad.length === 0,
      `${bad.length} ${what} row(s) break the partition the header draws: ${parent} != ` +
      `${kids.join(" + ")} — ${bad.slice(0, 4).map((r) =>
        `${r[key]} ${n(r[parent])}≠${kids.reduce((t, f) => t + n(r[f]), 0)}`).join(", ")}` +
      `${bad.length > 4 ? ", …" : ""}`);
  }
}

// ---------------------------------------------------------------------------
// 11. Every group in the plan is contiguous.
//
// table() derives colspans by walking adjacent columns and merging equal group
// labels. A group appearing in two non-adjacent runs therefore renders as two
// separate header cells with the SAME label, which reads as a duplicated group
// rather than as the ordering mistake it is.
// ---------------------------------------------------------------------------
{
  const seen: string[] = [];
  for (const c of COL_PLAN as { group: string }[]) {
    if (seen[seen.length - 1] !== c.group) seen.push(c.group);
  }
  const dupes = seen.filter((g, i) => seen.indexOf(g) !== i);
  check(dupes.length === 0,
    `COL_PLAN group(s) ${[...new Set(dupes)].join(", ")} appear in more than one run, so the ` +
    `group header would render the same label twice`);
}

// ---------------------------------------------------------------------------
// 12. Per repository, the organization rollup and the person rollup agree.
//
// The repository page renders both of these side by side: "By organization" sums
// repos.json, "Contributors" sums org-people.json. Any drift between them shows
// up as two tables on one page that visibly disagree, with nothing to say which
// is right. Checks 2 and 8 only compare project-wide and per-organization
// figures, so a per-repository split would pass both.
//
// This is also the check that would have caught the affiliation-attribution
// defect the first of the three times it shipped: crediting a person's whole
// history to their latest employer moves totals between organizations without
// changing any project total.
// ---------------------------------------------------------------------------
{
  const repoOrgs = read<Row[]>("site/data/repos.json");
  const orgPeople = read<Row[]>("site/data/org-people.json");
  const repos = [...new Set(repoOrgs.map((r) => String(r.repo)))];
  check(repos.length > 0, "repos.json is empty");

  for (const repo of repos) {
    const a = repoOrgs.filter((r) => r.repo === repo);
    const b = orgPeople.filter((r) => r.repo === repo);
    for (const f of Object.keys(summary.totals)) {
      check(
        sum(a, f) === sum(b, f),
        `${repo}/${f}: organization rollup ${sum(a, f)} != contributor rollup ${sum(b, f)}`,
      );
    }
  }

  // Every contributor row must resolve to a person record, because the page
  // takes name and slug from it. An unresolved id renders a link to
  // #/person/undefined — a dead end that still looks like a working row.
  const byId = new Set(people.map((r) => String(r.id)));
  const orphan = [...new Set(orgPeople.map((r) => String(r.id)).filter((i) => !byId.has(i)))];
  check(orphan.length === 0,
    `${orphan.length} org-people id(s) have no person record: ${orphan.slice(0, 5).join(", ")}`);
}

// ---------------------------------------------------------------------------
// 13. Independent recount of the OVERLAY against the raw layer.
//
// Check 1 recounts the git spine, and until this existed that was the only
// independent recount in the suite — 759 of 8,395 measured events, or 9%. Every
// other figure was compared against derive's own output. Check 8 looks like it
// covers the overlay, but the activity log and the aggregates are emitted from
// the same `record()` call, so it agrees with itself by construction: the exact
// defect that once discarded 1,242 of 2,877 review submissions would have
// reconciled perfectly and shipped, because both sides of the comparison were
// derived from the same truncated read.
//
// So this recounts from the files derive READ, which is the only way to catch
// "derive dropped whole records" on the 91% of the data that arrives by API.
//
// On `reviews` it imports `firstReviews` rather than restating the collapse
// rule. That costs independence — this cannot catch the rule itself being wrong,
// only derive failing to apply it — and the alternative costs more: a third copy
// of "what counts as a review" is precisely the defect that once let `audit` and
// `derive` disagree, ranking a contributor whose twelve reviews were all
// self-reviews above everyone else. A fixture pins the semantic; only a recount
// catches drift. Same trade-off as the co-authorship recount above, same reason.
// ---------------------------------------------------------------------------
if (mode === "full" && summary.github !== null && existsSync(p("raw/github.jsonl"))) {
  if (!existsSync(p("raw/items.json"))) {
    fails.push("raw/github.jsonl exists but raw/items.json does not — the overlay is half-present");
  } else {
    const events = readFileSync(p("raw/github.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l) as GitHubEvent);
    const items = Object.values(read<Record<string, Item>>("raw/items.json"));

    // Reviews: distinct (PR, reviewer) pairs, self-reviews dropped.
    const rawReviews = firstReviews(events).size;
    // Comments: both objects count as commenting, so both raw kinds sum into one
    // metric. Named from the raw vocabulary (`review_comment`) rather than the
    // log's (`reviewcomment`) — they are deliberately different spellings and
    // conflating them here would silently count zero.
    //
    // A review's own body is the THIRD source and is counted here for the same
    // reason: it is prose somebody wrote. This check is what caught it going in
    // -- derive started counting 442 review bodies while this line still knew of
    // two kinds, and the totals parted by exactly 442.
    const rawComments = events.filter((e) =>
      e.kind === "comment" || e.kind === "review_comment" || (e.kind === "review" && e.chars)).length;
    // Authorship comes from the registry, one row per PR/issue. `!author` is
    // skipped exactly as derive skips it: a deleted account cannot be credited.
    const authored = items.filter((i) => i.author);
    const rawProposed = authored.filter((i) => i.kind === "pr").length;
    const rawIssues = authored.filter((i) => i.kind === "issue").length;

    const expect: Record<string, number> = {
      reviews: rawReviews, comments: rawComments,
      proposed: rawProposed, issues: rawIssues,
    };
    // A PR has exactly four outcomes and they must partition `proposed`. Recounted
    // from raw rather than trusting derive's split.
    //
    // Via `outcomeOf`, because raw carries GitHub's single closed state and the
    // withdrawal split is ours. That means this check cannot catch a bug in the
    // classifier itself -- both sides would be wrong together -- so the classifier
    // is pinned by unit tests, and the COL_PLAN partition check above independently
    // asserts that whatever the four columns hold still sums to `proposed`.
    for (const state of ["landed", "open", "declined", "withdrawn"]) {
      expect[state] = authored.filter((i) => i.kind === "pr" && outcomeOf(i) === state).length;
    }

    for (const [field, want] of Object.entries(expect)) {
      if (!(field in summary.totals)) continue;
      check(
        sum(orgs, field) === want,
        `${field} total ${sum(orgs, field)} != ${want} recounted from raw/ — derive may have ` +
          `dropped records, or the overlay is stale (re-run \`bun run pull:github\` then \`derive\`)`,
      );
    }

    // A pending review was never submitted, so it is not review labour — and
    // GitHub only returns pending reviews to their own author, which would make
    // the published review count a function of whose token ran the pull. Asserted
    // here because a re-pull with a different credential is exactly when it would
    // silently reappear.
    const pending = events.filter((e) => e.kind === "review" && !e.at).length;
    check(pending === 0,
      `${pending} review event(s) carry no submission time, so the overlay depends on whose token pulled it`);
  }
} else if (summary.github !== null) {
  console.warn("verify: overlay present in summary but raw/github.jsonl absent — skipped the overlay recount");
}

// ---------------------------------------------------------------------------
// 13b. Branch coverage, recounted from raw/.
//
// Every landed pull request in raw/items.json has exactly one record in
// raw/branches.jsonl, every walked record merged as the commit the item names,
// and the shipped page states the same destination or the same absence. Checked
// from the files derive read, because 4d only sees what derive chose to write:
// a record derive dropped would leave a landed row with neither field, and a
// record derive never received would leave no trace in site/data at all.
// ---------------------------------------------------------------------------
if (mode === "full") {
  if (!existsSync(p("raw/branches.jsonl")) || !existsSync(p("raw/items.json")) || !existsSync(p("site/data/items.json"))) {
    fails.push("full seal but raw/branches.jsonl, raw/items.json or site/data/items.json is missing");
  } else {
    const rawItems = read<Record<string, Item>>("raw/items.json");
    const records = readFileSync(p("raw/branches.jsonl"), "utf8").split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as BranchRecord);
    const errors = validateBranches(rawItems, records);
    check(errors.length === 0,
      `${errors.length} branch coverage error(s) in raw/: ${errors.slice(0, 5).join("; ")}`);

    const shipped = read<Record<string, { d?: string; v?: string | number; u?: string; w?: CastRow[] }>>("site/data/items.json");
    const disagree = records.filter((r) => {
      const row = shipped[`${r.repo}#${r.number}`];
      if (!row) return true;
      return r.status === "available"
        ? row.d !== r.dest || row.v !== (r.via ?? undefined) || row.u !== undefined
        : row.u !== r.reason || row.d !== undefined;
    });
    check(disagree.length === 0,
      `${disagree.length} items.json rows disagree with raw/branches.jsonl about where the work went: ` +
      disagree.slice(0, 5).map((r) => `${r.repo}#${r.number}`).join(", "));
    // No author silently dropped or invented in projection: each item's shipped
    // rows sum to exactly what the raw walk attributes.
    const lost = records.filter(isAvailable).filter((r) => {
      const raw = attribute(r).map((a) => [a.email, a.added, a.deleted, a.commits] as const);
      return castTotals(raw) !== castTotals(shipped[`${r.repo}#${r.number}`]?.w ?? []);
    });
    check(lost.length === 0,
      `${lost.length} items.json author tables do not sum to raw/branches.jsonl: ` +
      lost.slice(0, 5).map((r) => `${r.repo}#${r.number}`).join(", "));
    const unavailable = records.filter((r) => r.status === "unavailable").length;
    console.log(`verify: branch coverage ${records.length} landed pull requests, ${unavailable} unavailable`);
  }
}

// ---------------------------------------------------------------------------
// 14. Two sites that share a rule must agree on it.
//
// Every other check here reconciles ARITHMETIC: totals against recounts, sums
// against summaries. That class of check cannot see the failure mode that has
// now produced six bugs in this codebase — one rule applied correctly at one
// site and skipped at an adjacent one — because both sites are self-consistently
// wrong and everything still adds up.
//
// `profileCompany` is the sixth. derive published a person's effective logins
// from `loginsFor`, then derived the profile company from a `login` variable
// that is null for anyone holding a record, so the hint applied to nobody except
// the uncurated. It failed by ABSENCE: no error, no zero, no wrong figure, just
// a line that never appeared. Asserting the agreement is the only way to see it.
// Profiles are part of the github layer, so in git-only mode any file on disk is
// an unsealed leftover and must not be read.
if (mode === "full" && existsSync(p("raw/profiles.json"))) {
  const profiles = read<Record<string, { company?: string | null }>>("raw/profiles.json");
  const missing = people.filter((r) => {
    const want = (r.logins ?? []).map((l) => profiles[l.toLowerCase()]?.company).find(Boolean);
    return want && !r.profileCompany;
  });
  check(missing.length === 0,
    `${missing.length} people publish a GitHub company that people.json does not carry ` +
      `(e.g. ${missing.slice(0, 3).map((r) => r.slug).join(", ")}) — derive is reading a ` +
      `different set of logins than it publishes`);
} else if (mode === "full") {
  console.warn("verify: raw/profiles.json absent — skipped the profile-company agreement check");
}

// ---------------------------------------------------------------------------
if (fails.length) {
  console.error(`verify: ${fails.length} FAILED`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
// "rows", not "orgs" and "people". Unlike derive's line, the COUNTS here are
// right: reconciliation deliberately spans every row, bots and pseudo-orgs
// included, since a bot's commits have to balance too. Only the nouns were
// wrong, and fixing them by narrowing the numbers would have understated what
// the check actually covered.
console.log(
  `verify: ok — ${sum(orgs, "commits")} commits reconcile across ${orgs.length} org rows ` +
    `and ${people.length} person rows; overlay ${summary.github === null ? "absent" : "present"}`,
);
