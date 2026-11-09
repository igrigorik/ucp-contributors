import { expect, test } from "bun:test";
import { orgAt, validateSpans, UNKNOWN } from "./lib/affiliation.ts";
import { attribute, destPath, isGenerated, validateBranches } from "./lib/branches.ts";
import { assertNoDuplicateKeys, validateRepos } from "./lib/data.ts";
import { firstReviews } from "./lib/events.ts";
import { heartbeat, quantile, stat } from "./lib/heartbeat.ts";
import { outcomeOf } from "./lib/items.ts";
import { coauthors, parseLog, subject } from "./lib/gitlog.ts";
import { addBridge, bareLogin, coauthorCredits, emailIndex, emailPerson, loginIndex, slugify } from "./lib/identity.ts";
import { displayName, noreplyLogin, type NameSources } from "./lib/names.ts";
import type { AvailableBranch, BranchRecord, Contributor, GitHubEvent, Item } from "./lib/types.ts";

const known = new Set(["acme", "globex", "initech", "independent"]);

const jobChanger: Contributor = {
  emails: ["g@example.com"],
  orgs: [
    { org: "acme", until: "2026-03-01" },
    { org: "globex", from: "2026-03-01" },
  ],
};

test("picks the span covering the date", () => {
  expect(orgAt(jobChanger, "2025-11-14")).toBe("acme");
  expect(orgAt(jobChanger, "2026-07-02")).toBe("globex");
});

test("`until` is exclusive and `from` is inclusive at the boundary", () => {
  expect(orgAt(jobChanger, "2026-02-28")).toBe("acme");
  expect(orgAt(jobChanger, "2026-03-01")).toBe("globex");
});

test("unbounded span matches any date", () => {
  const c: Contributor = { emails: [], orgs: [{ org: "initech" }] };
  expect(orgAt(c, "2019-01-01")).toBe("initech");
  expect(orgAt(c, "2030-01-01")).toBe("initech");
});

test("gap between spans yields unknown", () => {
  const c: Contributor = {
    emails: [],
    orgs: [
      { org: "acme", until: "2026-01-01" },
      { org: "globex", from: "2026-06-01" },
    ],
  };
  expect(orgAt(c, "2026-03-15")).toBe(UNKNOWN);
});

test("no record at all yields unknown", () => {
  expect(orgAt(undefined, "2026-03-15")).toBe(UNKNOWN);
});

test("record with no spans yields unknown", () => {
  expect(orgAt({ emails: ["x@y.z"] }, "2026-03-15")).toBe(UNKNOWN);
});

test("overlapping spans throw", () => {
  const c: Contributor = {
    emails: [],
    orgs: [{ org: "acme", until: "2026-05-01" }, { org: "globex", from: "2026-03-01" }],
  };
  expect(() => validateSpans("x", c, known)).toThrow(/overlapping/);
});

test("inverted span throws", () => {
  const c: Contributor = {
    emails: [],
    orgs: [{ org: "globex", from: "2026-05-01", until: "2026-03-01" }],
  };
  expect(() => validateSpans("x", c, known)).toThrow(/>=/);
});

test("unknown org reference throws", () => {
  const c: Contributor = { emails: [], orgs: [{ org: "bigco" }] };
  expect(() => validateSpans("x", c, known)).toThrow(/unknown org/);
});

test("canonical calendar dates, including leap day, pass", () => {
  const c: Contributor = {
    emails: [],
    orgs: [{ org: "acme", from: "2024-02-29", until: "2026-03-01" }],
  };
  expect(() => validateSpans("valid-person", c, known)).not.toThrow();
});

test("non-canonical span dates identify the contributor and value", () => {
  const c: Contributor = { emails: [], orgs: [{ org: "acme", from: "2026-3-01" }] };
  expect(() => validateSpans("malformed-person", c, known))
    .toThrow(/malformed-person: invalid from date "2026-3-01"/);
});

test("impossible span dates are rejected for either boundary", () => {
  for (const [bound, value] of [["from", "2026-13-01"], ["until", "2026-02-31"]] as const) {
    const c: Contributor = { emails: [], orgs: [{ org: "acme", [bound]: value }] };
    expect(() => validateSpans("impossible-person", c, known))
      .toThrow(new RegExp(`impossible-person: invalid ${bound} date "${value}"`));
  }
});

test("same email in two records throws", () => {
  expect(() =>
    emailIndex({
      a: { emails: ["dup@example.com"] },
      b: { emails: ["DUP@example.com"] },
    }),
  ).toThrow(/claimed by both/);
});

test("email matching is case-insensitive", () => {
  const idx = emailIndex({ a: { emails: ["Mixed@Case.COM"] } });
  expect(idx.get("mixed@case.com")).toBe("a");
});

test("slugify handles accents and punctuation", () => {
  expect(slugify("Ada Lovelace")).toBe("ada-lovelace");
  expect(slugify("Federico D'Amato")).toBe("federico-d-amato");
  expect(slugify("Muzaffer Şenkal")).toBe("muzaffer-senkal");
});

// A duplicated key is unrecoverable after JSON5.parse keeps the last one, so the
// check runs on raw text and is the only thing standing between a hand-edit slip
// and a silently wrong number.
test("duplicate top-level keys are rejected before parsing", () => {
  const dupe = `{\n  "ada-lovelace": { orgs: [{ org: "acme" }] },\n  "ada-lovelace": { orgs: [{ org: "globex" }] },\n}\n`;
  expect(() => assertNoDuplicateKeys("t.json5", dupe)).toThrow(/duplicate key.*ada-lovelace/);
});

test("duplicate record keys are rejected after space or tab indentation", () => {
  for (const indent of ["    ", "\t"]) {
    const dupe = `{\n${indent}"ada-lovelace": {},\n${indent}"ada-lovelace": {},\n}\n`;
    expect(() => assertNoDuplicateKeys("t.json5", dupe)).toThrow(/duplicate key.*ada-lovelace/);
  }
});

test("duplicate fields inside one record are rejected", () => {
  const dupe = `{
    "ada-lovelace": {
      emails: ["ada@example.com"],
      orgs: [{ org: "acme" }],
      orgs: [{ org: "globex" }],
    },
  }`;
  expect(() => assertNoDuplicateKeys("t.json5", dupe)).toThrow(/duplicate key.*orgs/);
});

test("the same nested key in different parent records passes", () => {
  const ok = `{\n  "ada-lovelace": { orgs: [{ org: "acme" }] },\n  "grace-hopper": { orgs: [{ org: "globex" }],\n                    name: "x" },\n}\n`;
  expect(() => assertNoDuplicateKeys("t.json5", ok)).not.toThrow();
});

test("repository allowlist accepts only exact public GitHub URLs tied to safe unique names", () => {
  const repo = (name: string, url = `https://github.com/Universal-Commerce-Protocol/${name}.git`) =>
    ({ name, url, class: "impl" as const });
  expect(validateRepos([repo("js-sdk")])).toHaveLength(1);
  for (const bad of [
    repo("../../outside"),
    repo("UPPER"),
    repo("ucp", "https://github.com/Universal-Commerce-Protocol/other.git"),
    repo("ucp", "https://user:token@github.com/Universal-Commerce-Protocol/ucp.git"),
    repo("ucp", "https://github.com/Universal-Commerce-Protocol/ucp.git?x=1"),
    repo("ucp", "https://evil.example/Universal-Commerce-Protocol/ucp.git"),
  ]) expect(() => validateRepos([bad])).toThrow();
  expect(() => validateRepos([repo("ucp"), repo("ucp")])).toThrow(/duplicate repository name/);
});

test("repository allowlist reserves the governance mirror name", () => {
  const governance = { name: "governance", url: "https://github.com/Universal-Commerce-Protocol/governance.git", class: "impl" as const };
  expect(() => validateRepos([governance])).toThrow(/reserved for the governance mirror/);
});

// "A review" has one definition because it used to have two that disagreed:
// derive collapsed rounds and dropped self-reviews, audit counted raw
// submissions, so audit's priority ranking contradicted the published numbers.
const rev = (login: string, number: number, at: string, self = false) =>
  ({ repo: "acme", kind: "review", login, number, at, self }) as GitHubEvent;

test("several review rounds on one PR count once", () => {
  const pairs = firstReviews([
    rev("ada", 1, "2026-01-05T00:00:00Z"),
    rev("ada", 1, "2026-01-06T00:00:00Z"),
    rev("ada", 1, "2026-01-07T00:00:00Z"),
  ]);
  expect(pairs.size).toBe(1);
});

test("the earliest submission wins, so latency stays computable", () => {
  const pairs = firstReviews([
    rev("ada", 1, "2026-01-09T00:00:00Z"),
    rev("ada", 1, "2026-01-02T00:00:00Z"),
  ]);
  expect([...pairs.values()][0]!.at).toBe("2026-01-02T00:00:00Z");
});

test("self-reviews are dropped entirely", () => {
  expect(firstReviews([rev("ada", 1, "2026-01-05T00:00:00Z", true)]).size).toBe(0);
});

test("distinct reviewers and distinct PRs stay distinct", () => {
  const pairs = firstReviews([
    rev("ada", 1, "2026-01-05T00:00:00Z"),
    rev("grace", 1, "2026-01-05T00:00:00Z"),
    rev("ada", 2, "2026-01-05T00:00:00Z"),
  ]);
  expect(pairs.size).toBe(3);
});

// ---------------------------------------------------------------------------
// Identity collisions. Two records claiming one identity key means one of them
// silently loses their activity, so both keys fail loudly instead.
// ---------------------------------------------------------------------------

test("same login in two records throws", () => {
  expect(() =>
    loginIndex({ a: { logins: ["dupe"] }, b: { logins: ["DUPE"] } }, {}),
  ).toThrow(/claimed by both/);
});

test("one record listing a login twice is not a collision", () => {
  expect(() => loginIndex({ a: { logins: ["x", "X"] } }, {})).not.toThrow();
});

test("bridge-derived login ownership conflicts fail before explicit overrides", () => {
  expect(() => loginIndex(
    { a: { emails: ["a@x.com"] }, b: { emails: ["b@x.com"], logins: ["shared"] } },
    { "a@x.com": "shared", "b@x.com": "SHARED[bot]" },
  )).toThrow(/multiple curated owners/);
});

test("one normalized email observed against multiple logins fails", () => {
  const bridge = new Map<string, string>();
  addBridge(bridge, " A@x.com ", "one");
  expect(() => addBridge(bridge, "a@X.com", "two")).toThrow(/multiple logins/);
  expect(() => addBridge(bridge, "a@x.com", "ONE[bot]")).not.toThrow();
});

test("an explicit login overrides the commit bridge", () => {
  // The bridge says this login belongs to whoever owns that email; the explicit
  // entry says otherwise and must win, because it is the documented escape hatch
  // for accounts the bridge maps wrongly.
  const idx = loginIndex(
    { a: { emails: ["a@x.com"] }, b: { logins: ["shared"] } },
    { "a@x.com": "shared" },
  );
  expect(idx.get("shared")).toBe("b");
});

// `unknown` must stay unassignable, which today holds only because orgs.json5
// does not declare it. That is a guarantee resting on an absence, so it is
// pinned here: anyone adding an `unknown` org entry to fix a display label
// breaks this test rather than silently making ignorance hand-assignable.
test("`unknown` cannot be hand-assigned as an org", () => {
  const c: Contributor = { emails: [], orgs: [{ org: UNKNOWN }] };
  expect(() => validateSpans("x", c, new Set(["acme", "independent"]))).toThrow(/unknown org/);
});

// ---------------------------------------------------------------------------
// git log parsing. These turn an untyped text format into every number the
// site publishes, and the format is chosen (NUL/SOH) precisely because commit
// bodies contain newlines and tabs.
// ---------------------------------------------------------------------------

const rec = (email: string, iso: string, body: string, stats = "") =>
  `\x00sha1234567890\x01${email}\x01Name\x01${iso}\x01${body}\x01${stats}`;

test("a co-authored-by trailer is found in a multi-line body", () => {
  expect(coauthors("Fix the thing\n\nDetail line.\n\nCo-authored-by: Grace Hopper <grace@example.com>\n"))
    .toEqual(["grace@example.com"]);
});

test("trailer matching is case-insensitive and emails are normalised", () => {
  expect(coauthors("x\n\nCO-AUTHORED-BY: A <Grace@Example.COM>")).toEqual(["grace@example.com"]);
});

test("a trailer repeated in one body credits once", () => {
  expect(coauthors("x\n\nCo-authored-by: A <a@b.com>\nCo-authored-by: A <a@b.com>")).toEqual(["a@b.com"]);
});

test("multiple distinct co-authors are all kept", () => {
  expect(coauthors("x\n\nCo-authored-by: A <a@b.com>\nCo-authored-by: B <c@d.com>").sort())
    .toEqual(["a@b.com", "c@d.com"]);
});

test("prose that merely mentions co-authorship is not a trailer", () => {
  expect(coauthors("Thanks to my co-authored-by pal <not@a.trailer> mid-sentence")).toEqual([]);
});

test("a body with no trailer yields nothing", () => {
  expect(coauthors("Ordinary commit message")).toEqual([]);
});

// 74 of 219 trailers in the live dataset name the commit's own author, because
// some tooling adds the trailer unconditionally. Counting those would inflate
// co-authorship by a third and credit one person twice for one commit. `derive`
// drops them; this pins the parser's half of that contract — the trailer is
// reported as-is, and the identity comparison happens downstream.
test("a self-naming trailer is parsed, not silently dropped by the parser", () => {
  expect(coauthors("x\n\nCo-authored-by: Me <me@example.com>")).toEqual(["me@example.com"]);
});

// Source grammar: one physical line, column 0, anywhere in the message.
test("a declaration never spans a newline", () => {
  // `\s` used to cross line breaks: an empty name, or an address split across
  // lines, borrowed text from the next line and invented a credit.
  expect(coauthors("x\n\nCo-authored-by:\nGrace <g@example.com>")).toEqual([]);
  expect(coauthors("x\n\nCo-authored-by: Grace\n<g@example.com>")).toEqual([]);
  expect(coauthors("x\n\nCo-authored-by: Grace <g@exa\nmple.com>")).toEqual([]);
  expect(coauthors("x\n\nCo-authored-by: Grace <g@example.com>\n\ntrailing prose")).toEqual(["g@example.com"]);
});

test("a declaration mid-message (stacked squash body) counts, in source order", () => {
  expect(coauthors("squash\n\n* one\n\nCo-authored-by: B <b@x.com>\n\n* two\n\nCo-authored-by: A <a@x.com>\n"))
    .toEqual(["b@x.com", "a@x.com"]);
});

test("quoted, indented and mid-sentence declarations do not count", () => {
  expect(coauthors("x\n\n> Co-authored-by: Q <q@x.com>")).toEqual([]);
  expect(coauthors("x\n\n    Co-authored-by: I <i@x.com>")).toEqual([]);
  expect(coauthors("x\n\nsee Co-authored-by: M <m@x.com>")).toEqual([]);
});

test("a standalone exact declaration inside a fenced block counts (documented limitation)", () => {
  expect(coauthors("x\n\n```\nCo-authored-by: F <f@x.com>\n```")).toEqual(["f@x.com"]);
});

// Coauthor credit unit: (commit, canonical person), author excluded.
const coPeople = {
  ada: { name: "Ada", emails: ["ada@work.com", "ada@home.com"], orgs: [{ org: "acme" }] },
  bob: { name: "Bob", emails: ["bob@work.com"], logins: ["bobby"], orgs: [{ org: "acme" }] },
  cy: { name: "Cy", emails: ["cy@work.com"], orgs: [{ org: "acme" }] },
} as Record<string, Contributor>;
const coBridge = { "cy@work.com": "cyhub", "bob-alt@x.com": "bobby" };
const coPerson = emailPerson(
  emailIndex(coPeople),
  loginIndex(coPeople, coBridge),
  (e) => (coBridge as Record<string, string>)[e] ?? noreplyLogin(e),
);
const pids = (author: string, declared: string[]) => coauthorCredits(author, declared, coPerson).map((c) => c.pid);

test("the person resolver uses curated emails, logins, the bridge and no-reply addresses", () => {
  expect(coPerson(" ADA@Home.com ")).toBe("ada");
  expect(coPerson("bob-alt@x.com")).toBe("bob"); // bridge -> explicit curated login
  expect(coPerson("1+bobby@users.noreply.github.com")).toBe("bob"); // no-reply -> curated login
  expect(coPerson("9+cyhub@users.noreply.github.com")).toBe("cy"); // no-reply -> bridge-derived login
  expect(coPerson("Stranger@X.com")).toBe("email:stranger@x.com");
});

test("an exact self-declaration is not a coauthor credit", () => {
  expect(pids("ada@work.com", ["ada@work.com"])).toEqual([]);
});

test("a self-declaration under another of the author's addresses is not a credit", () => {
  expect(pids("ada@work.com", ["ada@home.com", "1+bobby@users.noreply.github.com"])).toEqual(["bob"]);
  expect(pids("bob-alt@x.com", ["bob@work.com"])).toEqual([]);
});

test("two aliases of one coauthor credit them once, retaining the first address", () => {
  expect(coauthorCredits("cy@work.com", ["bob@work.com", "bob-alt@x.com", "1+bobby@users.noreply.github.com"], coPerson))
    .toEqual([{ pid: "bob", email: "bob@work.com" }]);
  expect(coauthorCredits("cy@work.com", ["bob-alt@x.com", "bob@work.com"], coPerson))
    .toEqual([{ pid: "bob", email: "bob-alt@x.com" }]);
});

test("a repeated declaration credits once and credits keep source order", () => {
  expect(pids("x@x.com", ["cy@work.com", "ada@home.com", "cy@work.com", "ada@work.com"])).toEqual(["cy", "ada"]);
});

test("unresolved accounts dedup by normalized address and stay distinct from each other", () => {
  expect(pids("ada@work.com", ["u@x.com", " U@X.com", "v@x.com"])).toEqual(["email:u@x.com", "email:v@x.com"]);
  expect(pids("U@x.com", ["u@x.com"])).toEqual([]); // unresolved author naming themself
});

test("SOH in a commit field fails closed instead of shifting framing", () => {
  expect(() => parseLog("acme", rec("a@b.com", "2026-01-01T00:00:00Z", "subject\x01private body")))
    .toThrow(/SOH framing error.*expected 6 fields, got 7/);
});

test("a commit body containing newlines and tabs does not break record parsing", () => {
  const commits = parseLog("acme", rec("a@b.com", "2026-03-04T10:00:00Z", "Subject\n\n\tindented\tbody\n"));
  expect(commits.length).toBe(1);
  expect(commits[0]!.date).toBe("2026-03-04");
  expect(commits[0]!.email).toBe("a@b.com");
});

test("binary files count as touched but contribute no churn", () => {
  // git reports "-" for both counts on a binary file; parseInt gives NaN, and a
  // single NaN would poison every sum downstream.
  const commits = parseLog("acme", rec("a@b.com", "2026-01-01T00:00:00Z", "x", "-\t-\tlogo.png\n4\t2\tsrc.ts"));
  expect(commits[0]!.files).toBe(2);
  expect(commits[0]!.added).toBe(4);
  expect(commits[0]!.deleted).toBe(2);
});

test("author email is lowercased so one person is not split in two", () => {
  expect(parseLog("acme", rec("Mixed@Case.COM", "2026-01-01T00:00:00Z", "x"))[0]!.email)
    .toBe("mixed@case.com");
});

test("absent co-authorship is absent, not an empty array", () => {
  expect(parseLog("acme", rec("a@b.com", "2026-01-01T00:00:00Z", "x"))[0]!.coauthors).toBeUndefined();
});

// The activity log's only readable field for a commit. A sha is a link with no
// reason to click it, so the subject is what makes the row worth showing.
test("the subject is the first line of the body, not the whole body", () => {
  expect(subject("feat: add thing\n\nA long explanation.\n\nCo-authored-by: X <x@y.com>"))
    .toBe("feat: add thing");
});

test("a one-line body is its own subject", () => {
  expect(subject("chore: bump")).toBe("chore: bump");
});

test("an empty body yields an empty subject, not undefined", () => {
  expect(subject("")).toBe("");
});

test("subject whitespace is trimmed", () => {
  expect(subject("  fix: spacing  \n\nbody")).toBe("fix: spacing");
});

test("parseLog carries the subject onto the commit", () => {
  const commits = parseLog("acme", rec("a@b.com", "2026-01-01T00:00:00Z", "feat: x\n\nbody"));
  expect(commits[0]!.subject).toBe("feat: x");
});

// Ordinary punctuation and Unicode survive the framing unchanged.
test("a subject containing quotes, commas and unicode survives parsing", () => {
  const line = 'fix: don\u2019t drop "x", y \u2014 caf\u00e9 \u2713';
  expect(parseLog("acme", rec("a@b.com", "2026-01-01T00:00:00Z", `${line}\n\nbody`))[0]!.subject)
    .toBe(line);
});

// GitHub's REST and GraphQL APIs disagree about App account names, which split
// one bot into two identities across a single raw file until this normalized.
test("the [bot] suffix REST adds is stripped so both APIs agree", () => {
  expect(bareLogin("gemini-code-assist[bot]")).toBe("gemini-code-assist");
  expect(bareLogin("dependabot[bot]")).toBe("dependabot");
});

test("login normalization lowercases, so one account is not counted twice", () => {
  expect(bareLogin("MixedCase")).toBe("mixedcase");
  expect(bareLogin("Dependabot[bot]")).toBe("dependabot");
});

test("a suffix only strips at the end, never mid-name", () => {
  expect(bareLogin("not[bot]real")).toBe("not[bot]real");
});

test("an ordinary login is returned unchanged", () => {
  expect(bareLogin("ada-lovelace")).toBe("ada-lovelace");
});

// ---------------------------------------------------------------------------
// Project responsiveness. Every figure here is a judgment about the project's
// own behaviour, so each judgment gets a test: what counts as a response, when
// silence becomes silence, who counts as an arrival, and when "cross-org" is a
// meaningful claim rather than an artefact of missing data.

const DAY = 864e5;
const iso = (msFromBase: number) => new Date(Date.parse("2026-06-01T00:00:00Z") + msFromBase).toISOString();

const pr = (number: number, author: string, at: string, extra: Partial<Item> = {}): Item =>
  ({ kind: "pr", repo: "acme", number, title: `pr ${number}`, author, at, state: "open", ...extra });

// Everyone is at acme unless the test says otherwise; `orgs` overrides per login.
const runBeat = (
  items: Item[],
  events: GitHubEvent[],
  orgs: Record<string, string> = {},
) => heartbeat({
  items,
  events,
  orgOf: (login) => orgs[login] ?? "acme",
  slugOf: (login) => login,
});

test("median of an even sample is the midpoint, not a neighbour", () => {
  expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
  expect(quantile([10, 20], 0.5)).toBe(15);
});

test("an empty sample measures nothing rather than zero", () => {
  // The site may not render a measured 0 for something never measured, so the
  // absence has to survive as null all the way to the JSON.
  expect(stat([])).toEqual({ n: 0, med: null, p75: null, p90: null });
});

test("every percentile the page prints comes from one interpolated definition", () => {
  // Four samples at 1, 2, 3 and 4 hours. Nearest-rank would answer 3 for both
  // the 75th and the 90th here, which is how a table ends up printing two
  // columns that cannot be compared: one interpolated, one not.
  const h = (n: number) => n * 36e5;
  expect(stat([1, 2, 3, 4].map(h))).toEqual({ n: 4, med: 2.5, p75: 3.3, p90: 3.7 });
  // A single sample is every percentile of itself — not null, and not zero.
  expect(stat([h(5)])).toEqual({ n: 1, med: 5, p75: 5, p90: 5 });
});

test("a merged item is not waiting for an answer, however quiet it was", () => {
  // The defect this page shipped with: silence was "no review and no comment",
  // with no regard for what became of the item, and the heading said "never
  // answered". A pull request merged without discussion is the fastest possible
  // yes, and it appeared in the queue of things nobody had answered.
  const r = runBeat([
    pr(1, "ada", iso(0), { state: "landed", endedAt: iso(2 * DAY) }),
    pr(2, "ada", iso(0), { state: "declined", endedAt: iso(2 * DAY) }),
    pr(3, "ada", iso(0)), // still open, still silent, still waiting
  ], [{ repo: "acme", kind: "comment", login: "grace", number: 9, at: iso(30 * DAY) } as GitHubEvent]);

  expect(r.pr.silent).toBe(1);
  expect(r.items.find((i) => i.n === 3)?.z).toBe(1);
  expect(r.items.find((i) => i.n === 1)?.z).toBeUndefined();
  expect(r.items.find((i) => i.n === 2)?.z).toBeUndefined();
  // Excluded, but COUNTED — and only the DECLINE. Dropping a measured population
  // silently is the same class of failure as overstating it, so the reader has to
  // be told the queue is a floor; but the merge does not belong in that figure
  // either, because "ended with no reply" is a concern for work that died quietly
  // and not for the fastest yes available.
  expect(r.pr.verdictNoReply).toBe(1);
});

test("a pull request its own author closed is not the project declining it", () => {
  // Withdrawals were half the closed-unmerged population in the live data (118 of
  // 246) and they close FAST, so blending them into the declines halved the
  // headline: 31 days mixed against 60.5 once separated. A figure that reads
  // "the project takes a month to say no" was mostly people changing their minds.
  const r = runBeat([
    pr(1, "ada", iso(0), { state: "declined", endedAt: iso(2 * DAY), closedBy: "ada" }),
    pr(2, "ada", iso(0), { state: "declined", endedAt: iso(40 * DAY), closedBy: "grace" }),
  ], []);

  // Only the maintainer's close is a verdict, and only its duration is timed.
  expect(r.pr.toDecline.n).toBe(1);
  expect(r.pr.toDecline.med).toBe(40 * 24);
  // The withdrawal is counted, never timed: how long someone took to give up on
  // their own work is a fact about them, and this module measures the project.
  expect(r.pr.withdrawn).toBe(1);
  expect(r.pr.n).toBe(2); // both were still real submissions
  // Nobody owed an answer to work its author took back.
  expect(r.pr.verdictNoReply).toBe(1);
  // The spread survives into the per-repository rows, which is where a reader
  // goes to check whether one repo is carrying the whole figure.
  expect(r.byRepo[0]?.withdrawn).toBe(1);
  expect(r.byRepo[0]?.toDecline.n).toBe(1);
});

test("an unknown closer stays a verdict rather than being called noise", () => {
  // The conservative direction. `closedBy` is absent for anything pulled before
  // the field existed, and for any close GitHub attributes to no actor. Guessing
  // "withdrawn" there would move real rejections into a bucket labelled noise and
  // quietly improve the project's own numbers -- exactly the wrong way to be
  // wrong.
  const r = runBeat([
    pr(1, "ada", iso(0), { state: "declined", endedAt: iso(10 * DAY) }),
  ], []);

  expect(r.pr.withdrawn).toBe(0);
  expect(r.pr.toDecline.n).toBe(1);
  expect(r.pr.verdictNoReply).toBe(1);
});

test("silence younger than the threshold is not yet silence", () => {
  // Both PRs have no response; only the older one has been waiting long enough.
  // Without this the figure would be a function of when the data was pulled.
  const r = runBeat([
    pr(1, "ada", iso(0)),
    pr(2, "ada", iso(9 * DAY)),
  ], [{ repo: "acme", kind: "comment", login: "grace", number: 3, at: iso(10 * DAY) } as GitHubEvent]);
  expect(r.pr.silent).toBe(1);
  expect(r.items.find((i) => i.n === 1)?.z).toBe(1);
  expect(r.items.find((i) => i.n === 2)?.z).toBeUndefined();
});

test("the author talking to themselves is not a response", () => {
  const r = runBeat(
    [pr(1, "ada", iso(0))],
    // Dated past the silence threshold so the PR is old enough for silence to
    // mean something; at +1 day it would be merely fresh, and the assertion
    // below would pass for the wrong reason.
    [
      { repo: "acme", kind: "comment", login: "ada", number: 1, at: iso(10 * DAY) } as GitHubEvent,
      { repo: "acme", kind: "review", login: "ada", number: 1, at: iso(10 * DAY), self: true } as GitHubEvent,
    ],
  );
  expect(r.pr.firstResponse.n).toBe(0);
  expect(r.pr.silent).toBe(1);
});

test("a bot replying does not count as the project answering", () => {
  const r = runBeat(
    [pr(1, "ada", iso(0)), pr(2, "ada", iso(0))],
    [
      { repo: "acme", kind: "comment", login: "helper", number: 1, at: iso(10 * DAY) } as GitHubEvent,
      { repo: "acme", kind: "comment", login: "grace", number: 2, at: iso(10 * DAY) } as GitHubEvent,
    ],
    { helper: "bot" },
  );
  expect(r.pr.firstResponse.n).toBe(1);
  expect(r.pr.silent).toBe(1);
});

test("first review inherits the review definition: rounds collapse, earliest wins", () => {
  const r = runBeat(
    [pr(1, "ada", iso(0))],
    [
      { repo: "acme", kind: "review", login: "grace", number: 1, at: iso(3 * DAY) } as GitHubEvent,
      { repo: "acme", kind: "review", login: "grace", number: 1, at: iso(DAY) } as GitHubEvent,
    ],
  );
  expect(r.pr.firstReview.n).toBe(1);
  expect(r.pr.firstReview.med).toBe(24);
});

// The discriminating half of the test above. Round-collapsing alone cannot show
// that firstReviews is doing the work, because taking the minimum per item
// collapses rounds anyway — a version that ignored the shared definition and
// filtered raw events passed identically. Self-review exclusion is the one
// behaviour only the shared definition provides.
test("reviewing your own pull request is not the project reviewing it", () => {
  const r = runBeat(
    [pr(1, "ada", iso(0))],
    [{ repo: "acme", kind: "review", login: "ada", number: 1, at: iso(DAY), self: true } as GitHubEvent],
  );
  expect(r.pr.firstReview.n).toBe(0);
  expect(r.review.reviewed).toBe(0);
});

test("cross-org needs two known orgs, so an undisclosed reviewer is not cross-org", () => {
  // The loose reading ("the two ids differ") counted an unknown reviewing a
  // known as cross-organization review, which inflates the one figure that
  // answers whether review is captured by a single vendor.
  const r = runBeat(
    [pr(1, "ada", iso(0)), pr(2, "ada", iso(0))],
    [
      { repo: "acme", kind: "review", login: "anon", number: 1, at: iso(DAY) } as GitHubEvent,
      { repo: "acme", kind: "review", login: "grace", number: 2, at: iso(DAY) } as GitHubEvent,
    ],
    { anon: "undisclosed", grace: "globex" },
  );
  expect(r.review.reviewed).toBe(2);
  expect(r.review.comparable).toBe(1);
  expect(r.review.crossOrg).toBe(1);
});

test("an arrival is the author's earliest pull request, and only that one", () => {
  const r = runBeat([pr(1, "ada", iso(0)), pr(2, "ada", iso(5 * DAY))], []);
  expect(r.arrival.newcomer.n).toBe(1);
  expect(r.arrival.returning.n).toBe(1);
  expect(r.items.find((i) => i.n === 1)?.c).toBe(1);
  expect(r.items.find((i) => i.n === 2)?.c).toBeUndefined();
});

// A login is an account, not a person. One human with two accounts (`kthota-g`
// and `kcthota` in the real data) must be one arrival, one reviewer, and never an
// outside response to their own work. Each assertion fails if the corresponding
// rule is keyed by raw login.
const aliasBeat = (items: Item[], events: GitHubEvent[], orgs: Record<string, string> = {}) => heartbeat({
  items, events,
  orgOf: (login) => orgs[login] ?? "acme",
  slugOf: (login) => ({ "ada-work": "ada", "ada-home": "ada", "bob-1": "bob", "bob-2": "bob" } as Record<string, string>)[login] ?? login,
});

test("an arrival is a person's earliest pull request, across their aliases", () => {
  const r = aliasBeat([pr(1, "ada-work", iso(0)), pr(2, "ada-home", iso(5 * DAY))], []);
  expect(r.arrival.newcomer.n).toBe(1);
  expect(r.arrival.returning.n).toBe(1);
  expect(r.items.find((i) => i.n === 1)?.c).toBe(1);
  expect(r.items.find((i) => i.n === 2)?.c).toBeUndefined();
});

test("an author replying or reviewing through an alias is not a response", () => {
  const r = aliasBeat([pr(1, "ada-work", iso(0))], [
    { repo: "acme", kind: "comment", login: "ada-home", number: 1, at: iso(DAY) } as GitHubEvent,
    // `self` is login-level, so pull time cannot have set it here.
    { repo: "acme", kind: "review", login: "ada-home", number: 1, at: iso(DAY) } as GitHubEvent,
    // A later real response, so asOf is past the silence threshold.
    { repo: "acme", kind: "comment", login: "grace", number: 9, at: iso(30 * DAY) } as GitHubEvent,
  ]);
  expect(r.pr.firstResponse.n).toBe(0);
  expect(r.pr.firstReview.n).toBe(0);
  expect(r.review.reviewed).toBe(0);
  expect(r.pr.silent).toBe(1);
});

test("two aliases of one reviewer are one reviewer in the organization matrix", () => {
  const r = aliasBeat([pr(1, "ada-work", iso(0))], [
    { repo: "acme", kind: "review", login: "bob-1", number: 1, at: iso(2 * DAY) } as GitHubEvent,
    { repo: "acme", kind: "review", login: "bob-2", number: 1, at: iso(DAY) } as GitHubEvent,
  ], { "bob-1": "globex", "bob-2": "globex" });
  expect(r.review.byOrg.find((o) => o.org === "globex")?.given).toBe(1);
  // Earliest event wins: the first review is at 24h, from bob-2.
  expect(r.pr.firstReview.med).toBe(24);
});

test("ages are measured from the newest instant in the data, not from today", () => {
  // Re-deriving a stale file must not age the backlog by itself, or the page
  // reports deterioration that never happened.
  const r = runBeat([pr(1, "ada", iso(0), { state: "open" })], [
    { repo: "acme", kind: "comment", login: "grace", number: 9, at: iso(20 * DAY) } as GitHubEvent,
  ]);
  expect(r.asOf).toBe(iso(20 * DAY));
  expect(r.pr.open.age.med).toBe(20 * 24);
});

test("open items are counted against their own kind, so outcomes sum", () => {
  // A blended backlog reported 218 open against 907 pull requests, which made
  // 546 landed + 235 declined + 218 open come to 999. The four outcomes PARTITION
  // the population -- landed, declined, withdrawn, still open -- and the table
  // prints all four, so the arithmetic has to close. This is the invariant that
  // catches a new outcome being carved out of an old one without being reported:
  // separating withdrawals out of the declines was exactly that change.
  const r = runBeat([
    pr(1, "ada", iso(0), { state: "landed", endedAt: iso(DAY) }),
    pr(2, "ada", iso(0), { state: "declined", endedAt: iso(2 * DAY), closedBy: "grace" }),
    pr(3, "ada", iso(0), { state: "declined", endedAt: iso(3 * DAY), closedBy: "ada" }),
    pr(4, "ada", iso(0), { state: "open" }),
    { ...pr(5, "ada", iso(0), { state: "open" }), kind: "issue" as const },
  ], []);
  expect(r.pr.toLand.n + r.pr.toDecline.n + r.pr.withdrawn + r.pr.open.n).toBe(r.pr.n);
  expect(r.issue.open.n).toBe(1); // the issue does NOT inflate the pull-request row
});

test("per-repository verdicts carry decline time, which is where the spread is", () => {
  // The blended median hid a 17x spread across repositories: this is the figure
  // the split exists to expose, so a repository row that dropped it would make
  // the whole per-repository table pointless.
  const r = runBeat([
    { ...pr(1, "ada", iso(0), { state: "declined", endedAt: iso(2 * DAY) }), repo: "acme" },
    { ...pr(2, "ada", iso(0), { state: "declined", endedAt: iso(40 * DAY) }), repo: "globex" },
  ], []);
  const at = (repo: string) => r.byRepo.find((x) => x.repo === repo)!;
  expect(at("acme").toDecline.med).toBe(2 * 24);
  expect(at("globex").toDecline.med).toBe(40 * 24);
  // And the blend sits between them, which is exactly why it is not enough.
  expect(r.pr.toDecline.med).toBe(21 * 24);
});

test("an item whose author is gone is dropped rather than guessed", () => {
  const r = runBeat([pr(1, "ada", iso(0)), { ...pr(2, "ada", iso(0)), author: null }], []);
  expect(r.pr.n).toBe(1);
  expect(r.items.length).toBe(1);
});

// ------------------------------------------------------------- outcomeOf()

test("a self-closed item is withdrawn, and someone else closing it is a verdict", () => {
  // The distinction the acceptance rate turns on. While both lived in `declined`,
  // an author closing their own pull request was recorded as having been rejected.
  const base = { kind: "pr", repo: "acme", number: 1, title: "t", at: iso(0) } as const;
  expect(outcomeOf({ ...base, author: "ada", state: "declined", closedBy: "ada" } as Item))
    .toBe("withdrawn");
  expect(outcomeOf({ ...base, author: "ada", state: "declined", closedBy: "grace" } as Item))
    .toBe("declined");
  // Conservative on absence: an unknown closer stays a real verdict rather than
  // being moved into the bucket the acceptance rate ignores, which would improve
  // the project's own numbers by guessing.
  expect(outcomeOf({ ...base, author: "ada", state: "declined" } as Item)).toBe("declined");
  // A merge is an answer, so it is never withdrawn even if the author merged it.
  expect(outcomeOf({ ...base, author: "ada", state: "landed", closedBy: "ada" } as Item))
    .toBe("landed");
  expect(outcomeOf({ ...base, author: "ada", state: "open" } as Item)).toBe("open");
  // Issues use GitHub's other closed state and split the same way.
  expect(outcomeOf({ ...base, kind: "issue", author: "ada", state: "closed", closedBy: "ada" } as Item))
    .toBe("withdrawn");
  expect(outcomeOf({ ...base, kind: "issue", author: "ada", state: "closed", closedBy: "grace" } as Item))
    .toBe("closed");
});

// -------------------------------------------------------- review.byOrg

test("every review has a giver and a receiver, so given and received both total it", () => {
  // The invariant that catches an aggregation counting one side twice or dropping
  // a self-review from only one of the two columns.
  const r = runBeat(
    // PR 3 is grace's: an unflagged review by the author is a self-review now
    // that the rule is person-level, and would drop out of both columns.
    [pr(1, "ada", iso(0)), pr(2, "grace", iso(0)), pr(3, "grace", iso(0))],
    [
      { repo: "acme", kind: "review", login: "grace", number: 1, at: iso(DAY) },
      { repo: "acme", kind: "review", login: "ada", number: 2, at: iso(DAY) },
      { repo: "acme", kind: "review", login: "ada", number: 3, at: iso(DAY) },
    ] as GitHubEvent[],
    { ada: "acme", grace: "globex" },
  );
  const given = r.review.byOrg.reduce((a, o) => a + o.given, 0);
  const received = r.review.byOrg.reduce((a, o) => a + o.received, 0);
  expect(given).toBe(3);
  expect(received).toBe(given);
});

test("two reviewers from one organization are two reviews, not one", () => {
  // The unit. `given`/`received` count REVIEWS -- distinct (item, reviewer) pairs,
  // the site's one definition -- while `comparable` counts PULL REQUESTS. They
  // were the same number here for as long as the reviewer set was a `Set` of
  // organizations, which is exactly how a column labelled "reviews" came to
  // report pull requests reviewed and nobody noticed: every fixture happened to
  // have one reviewer per organization per item, so both units agreed.
  const r = runBeat(
    [pr(1, "grace", iso(0))],
    [
      { repo: "acme", kind: "review", login: "ada", number: 1, at: iso(DAY) },
      { repo: "acme", kind: "review", login: "ada2", number: 1, at: iso(2 * DAY) },
      { repo: "acme", kind: "review", login: "hopper", number: 1, at: iso(3 * DAY) },
    ] as GitHubEvent[],
    { ada: "acme", ada2: "acme", hopper: "initech", grace: "globex" },
  );
  expect(r.review.byOrg.find((o) => o.org === "acme")!.given).toBe(2);
  expect(r.review.byOrg.find((o) => o.org === "initech")!.given).toBe(1);
  expect(r.review.byOrg.find((o) => o.org === "globex")!.received).toBe(3);
  // ONE pull request, reviewed from outside, once -- however many organizations
  // and however many people did it. Three reviews, two reviewing organizations,
  // one comparable item: the third reviewer is what makes these three numbers
  // differ, and without them a unit drift in either direction reads as green.
  expect(r.review.comparable).toBe(1);
  expect(r.review.crossOrg).toBe(1);
});

test("reviewing only your own colleagues is reach of zero, not one", () => {
  // `partners` counts OTHER organizations, so it reads as reach. Counting the org
  // itself would give every reviewer a floor of one and make the column useless
  // for the thing it exists to show.
  const r = runBeat(
    [pr(1, "ada", iso(0)), pr(2, "grace", iso(0))],
    [
      { repo: "acme", kind: "review", login: "ada2", number: 1, at: iso(DAY) },
      { repo: "acme", kind: "review", login: "ada2", number: 2, at: iso(DAY) },
    ] as GitHubEvent[],
    { ada: "acme", ada2: "acme", grace: "globex" },
  );
  const acme = r.review.byOrg.find((o) => o.org === "acme")!;
  expect(acme.given).toBe(2);
  // Two reviews, one of them inside acme, and `partners` counts the OTHER
  // organizations reached -- so it is 1, not 2. An own-organization review is
  // reach of zero; it is still counted in `given`, which is the volume.
  expect(acme.partners).toBe(1);
});

test("an organization that receives review without giving any still gets a row", () => {
  // Where the asymmetry lives: in this data one organization receives 149 reviews
  // and performs 1. Dropping the row would delete the finding, and its `given` is
  // a measured zero rather than an absence.
  const r = runBeat(
    [pr(1, "ada", iso(0))],
    [{ repo: "acme", kind: "review", login: "grace", number: 1, at: iso(DAY) }] as GitHubEvent[],
    { ada: "acme", grace: "globex" },
  );
  const acme = r.review.byOrg.find((o) => o.org === "acme")!;
  expect(acme).toEqual({ org: "acme", given: 0, received: 1, partners: 0 });
});

// ── branch attribution ──────────────────────────────────────────────────────
// Shapes below are copied from the corpus, not invented: the rename forms are
// real `git log --numstat` rows from ucp's default branch.

test("a rename with a braced middle segment resolves to the destination path", () => {
  // The reason this parse exists: with --no-renames a moved file counts as a
  // whole-file delete plus a whole-file add, which nearly doubled one author's
  // measured work on a pull request whose entire point was moving files.
  expect(destPath("docs/specification/payment/{ => extensions}/actions/three-ds-challenge.md"))
    .toBe("docs/specification/payment/extensions/actions/three-ds-challenge.md");
  expect(destPath("docs/specification/{ => payment/extensions}/ap2-mandates.md"))
    .toBe("docs/specification/payment/extensions/ap2-mandates.md");
});

test("a rename with no braces, and a path that merely contains an arrow", () => {
  expect(destPath("old/a.md => new/b.md")).toBe("new/b.md");
  // A brace that is not a rename marker must not be treated as one, or the path
  // is silently truncated and every file under it lands in the wrong surface.
  expect(destPath("docs/{weird}/name.md")).toBe("docs/{weird}/name.md");
  expect(destPath("plain/path.md")).toBe("plain/path.md");
});

test("generated output is excluded, hand-written neighbours are not", () => {
  expect(isGenerated("src/ucp_sdk/models/schemas/common/identity_linking.py")).toBe(true);
  expect(isGenerated("uv.lock")).toBe(true);
  expect(isGenerated("packages/core/dist/index.js")).toBe(true);
  // Sits directly beside the generated tree and is hand-written.
  expect(isGenerated("src/ucp_sdk/client.py")).toBe(false);
  expect(isGenerated("docs/specification/checkout.md")).toBe(false);
});

test("attribute drops replays and generated files, and never counts binary as zero", () => {
  const rec = {
    repo: "acme", number: 1, status: "available", merge: "m".repeat(40), dest: "main" as const, via: null,
    base: "b0",
    commits: [
      { sha: "a", email: "ada@acme.test", name: "Ada", at: "2026-01-02T00:00:00Z",
        files: [[10, 4, "docs/spec.md"], [900, 900, "uv.lock"], [null, null, "logo.png"]] },
      { sha: "b", email: "grace@globex.test", name: "Grace", at: "2026-01-03T00:00:00Z",
        files: [[7, 1, "docs/spec.md"]] },
      // A cherry-pick of work already counted where it first landed.
      { sha: "c", email: "ada@acme.test", name: "Ada", at: "2026-01-04T00:00:00Z",
        replay: true, files: [[500, 500, "docs/spec.md"]] },
    ],
  } as AvailableBranch;
  const rows = attribute(rec);
  expect(rows.map((r) => r.email)).toEqual(["ada@acme.test", "grace@globex.test"]);
  expect(rows[0]).toEqual({ email: "ada@acme.test", added: 10, deleted: 4, commits: 1, binary: 1 });
  expect(rows[1]!.added).toBe(7);
  // The replayed commit contributes neither lines nor a commit count.
  expect(rows[0]!.commits).toBe(1);
});

// ── branch coverage ─────────────────────────────────────────────────────────
// The rule pull-branches writes by, derive reads by and verify recounts by.

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);
const OID_C = "c".repeat(40);
const landedPr = (number: number, state: string, sha?: string): Item =>
  ({ kind: "pr", repo: "widgets", number, title: "t", author: "ada", at: "2026-01-01T00:00:00Z", state,
     ...(sha ? { sha } : {}) });
const delivered = (number: number, merge: string): BranchRecord =>
  ({ repo: "widgets", number, status: "available", merge, dest: "main", via: null, base: OID_C, commits: [] });
const COVERED: Record<string, Item> = {
  "widgets#1": landedPr(1, "landed", OID_A),
  "widgets#2": landedPr(2, "landed", OID_B),     // its merge object is gone
  "widgets#3": landedPr(3, "landed"),            // GitHub names no merge commit
  "widgets#4": landedPr(4, "declined"),          // no branch to walk, and no record
  "widgets#5": { ...landedPr(5, "open"), kind: "issue" },
};
const COVERING: BranchRecord[] = [
  delivered(1, OID_A),
  { repo: "widgets", number: 2, status: "unavailable", merge: OID_B, reason: "merge-commit-unfetchable" },
  { repo: "widgets", number: 3, status: "unavailable", merge: null, reason: "no-merge-commit" },
];

test("every landed pull request has exactly one branch record, walked or saying why not", () => {
  expect(validateBranches(COVERED, COVERING)).toEqual([]);

  // Skipping a record is the defect: three landed pull requests once vanished
  // from per-item attribution this way with no output at all.
  expect(validateBranches(COVERED, COVERING.filter((r) => r.number !== 2)))
    .toEqual(["widgets#2: landed pull request has no branch record"]);
  // Including the one with no merge commit: null sha is not "not landed".
  expect(validateBranches(COVERED, COVERING.filter((r) => r.number !== 3)))
    .toEqual(["widgets#3: landed pull request has no branch record"]);
  expect(validateBranches(COVERED, [...COVERING, delivered(1, OID_A)]))
    .toEqual(["widgets#1: more than one branch record"]);
  expect(validateBranches(COVERED, [...COVERING, delivered(4, OID_C)]))
    .toEqual(["widgets#4: branch record for something that is not a landed pull request"]);
});

test("a walked record merged as the commit its item names, by full id", () => {
  // Walking some other commit attributes some other branch's authors.
  expect(validateBranches(COVERED, [delivered(1, OID_C), ...COVERING.slice(1)]))
    .toEqual([`widgets#1: walked merge ${OID_C} but the item merged as ${OID_A}`]);
  // A 12-character id cannot be fetched when its object is missing, which is
  // the only case that matters, so raw data carrying one must be re-pulled.
  const short = { ...COVERED, "widgets#1": landedPr(1, "landed", OID_A.slice(0, 12)) };
  expect(validateBranches(short, COVERING)[0]).toContain("is not a full 40-hex id");
  // Records from before the union existed have no status and must not be read.
  const legacy = { repo: "widgets", number: 1, dest: "main", via: null, base: OID_C, commits: [] };
  expect(validateBranches(COVERED, [legacy as unknown as BranchRecord, ...COVERING.slice(1)])[0])
    .toContain("neither available nor unavailable");
});

test("an absence names its true cause and carries no lines", () => {
  // "No merge commit" on an item that names one would hide a fetch failure.
  const lying: BranchRecord = { repo: "widgets", number: 2, status: "unavailable", merge: null, reason: "no-merge-commit" };
  const errs = validateBranches(COVERED, [COVERING[0]!, lying, COVERING[2]!]);
  expect(errs.some((e) => e.includes("unavailable as no-merge-commit"))).toBe(true);
  const withLines = { ...COVERING[1]!, commits: [] } as unknown as BranchRecord;
  expect(validateBranches(COVERED, [COVERING[0]!, withLines, COVERING[2]!]))
    .toEqual(["widgets#2: unavailable record carries `commits`"]);
});

test("a component's carrier is a delivered pull request", () => {
  const items = { ...COVERED, "widgets#6": landedPr(6, "landed", "d".repeat(40)) };
  const component = (via: number): BranchRecord => ({
    repo: "widgets", number: 6, status: "available", merge: "d".repeat(40), dest: "component", via,
    base: OID_C, commits: [],
  });
  expect(validateBranches(items, [...COVERING, component(1)])).toEqual([]);
  expect(validateBranches(items, [...COVERING, component(2)]))
    .toEqual(["widgets#6: component of #2, which is not a delivered pull request"]);
});

// ── display names ───────────────────────────────────────────────────────────

test("a no-reply address names its login; any other address names nothing", () => {
  expect(noreplyLogin("3484527+ada-l--@users.noreply.github.com")).toBe("ada-l--");
  expect(noreplyLogin("Ada-L@users.noreply.github.com")).toBe("ada-l");
  expect(noreplyLogin("ada@example.invalid")).toBeNull();
  expect(noreplyLogin("3484527+ada@users.noreply.github.com.evil.invalid")).toBeNull();
});

const NAMES: NameSources = {
  curated: (slug) => ({ "ada-lovelace": "Ada Lovelace" } as Record<string, string>)[slug],
  votes: new Map([
    ["email:grace@example.invalid", new Map([["Grace H", 1], ["Grace Hopper", 3]])],
    ["ada-lovelace", new Map([["ada", 9]])],
  ]),
  loginOf: (email) => ({ "linus@example.invalid": "linus-t" } as Record<string, string>)[email]
    ?? noreplyLogin(email),
  slugOf: (login) => (login === "ada-l" ? "ada-lovelace" : undefined),
  profileName: (login) => ({ "linus-t": "Linus T", "mallory": "m@evil.invalid" } as Record<string, string>)[login],
};

test("display names keep their existing precedence for people with a record or a commit", () => {
  expect(displayName("ada-lovelace", NAMES)).toBe("Ada Lovelace");           // curated wins over votes
  expect(displayName("email:grace@example.invalid", NAMES)).toBe("Grace Hopper"); // most-used git name
  expect(displayName("login:linus-t", NAMES)).toBe("Linus T");
  expect(displayName("login:mallory", NAMES)).toBe("mallory");               // profile name is an address
});

test("a trailer-only address is labelled by the safest public name available", () => {
  // 1. a curated record that claims the login inside a no-reply address
  expect(displayName("email:1+ada-l@users.noreply.github.com", NAMES)).toBe("Ada Lovelace");
  // 2. the bridged login's self-reported profile name
  expect(displayName("email:linus@example.invalid", NAMES)).toBe("Linus T");
  // 3. the login, when its profile name is missing or is itself an address
  expect(displayName("email:9+nobody-here@users.noreply.github.com", NAMES)).toBe("nobody-here");
  expect(displayName("email:9+mallory@users.noreply.github.com", NAMES)).toBe("mallory");
  // 4. the address the trailer published, only when nothing maps it to anyone
  expect(displayName("email:someone@example.invalid", NAMES)).toBe("someone@example.invalid");
});

test("an internal id never becomes a display name", () => {
  expect(() => displayName("pid:x", NAMES)).toThrow();
  for (const pid of ["email:someone@example.invalid", "login:mallory", "email:9+x@users.noreply.github.com"]) {
    expect(displayName(pid, NAMES)).not.toMatch(/^(email|login|pid):/);
  }
});
