#!/usr/bin/env bun
// Report what is still unmapped, ranked by activity, and propose assignments.
// Suggestions are PRINTED, never written — rules propose, humans confirm.
//
// Two suggestion sources, with different standing:
//   email domain   — a strong hint, but still a guess about employment
//   profile company— SELF-REPORTED, so better evidence than anything we infer,
//                    yet point-in-time and free-text ("Primarily coding in
//                    private repos." is a real value here), so it can never be
//                    turned into a span automatically.
import { ASSIGNABLE_PSEUDO } from "../site/vocab.js";
import { loadSealed, parseMode } from "./lib/acquisition.ts";
import { loadCommits, loadContributors, loadCouncil, loadGitHub, loadOrgs, loadRepos, p } from "./lib/data.ts";
import { rosterIndex } from "./lib/roster.ts";
import { firstReviews } from "./lib/events.ts";
import { emailIndex, loginIndex, slugify } from "./lib/identity.ts";

const repos = loadRepos();
// Validate the acquisition seal before reading any raw file. In git-only mode,
// an older GitHub overlay may remain on disk but is intentionally unconsumable.
const sealed = loadSealed(p(), repos.map((r) => r.name), parseMode(process.argv.slice(2)));
const mode = sealed.mode;
const orgs = loadOrgs();
const contributors = loadContributors();
const commits = loadCommits();
const github = loadGitHub(mode);
const byEmail = emailIndex(contributors);
const byLogin = github ? loginIndex(contributors, github.bridge) : new Map<string, string>();

const domainToOrg = new Map<string, string>();
for (const [id, org] of Object.entries(orgs))
  for (const d of org.domains ?? []) domainToOrg.set(d.toLowerCase(), id);

// Match a free-text profile company against known org names/ids. Fuzzy on
// purpose ("@Acme", "Acme Inc", "acme.com" all land), and it only ever
// produces a printed suggestion.
function guessOrg(company: string | null | undefined): string | null {
  if (!company) return null;
  const s = company.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!s) return null;
  for (const [id, org] of Object.entries(orgs)) {
    const name = org.name.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (s.includes(id) || (name.length > 2 && s.includes(name))) return id;
    for (const d of org.domains ?? []) if (s.includes(d.split(".")[0]!)) return id;
  }
  return null;
}

/**
 * Suggest an org from the login itself, e.g. "jane-acme" or "jsmith-goog".
 *
 * A username is chosen by the person and shown on every comment they leave, so
 * an employer token inside it is self-disclosure — stronger evidence than a
 * name lookup on another platform, and it needs no browsing. Anchored to token
 * boundaries so "shopkeeper" cannot match the "shop" prefix of an org.
 *
 * Suggestion only: a human still confirms, same as every other rule here.
 */
const loginTokens = new Map<string, string>();
for (const [id, org] of Object.entries(orgs)) {
  if (id.length > 3) loginTokens.set(id, id);
  for (const d of org.domains ?? []) {
    const label = d.split(".")[0]!;
    if (label.length > 3) loginTokens.set(label, id);
  }
}
function guessOrgFromLogin(login: string): string | null {
  const l = login.toLowerCase();
  for (const [tok, id] of loginTokens) {
    if (new RegExp(`(^|[-_])${tok}([-_]|$)`).test(l)) return id;
  }
  return null;
}

// ---------------------------------------------------------------- git side

type Ident = { email: string; names: Map<string, number>; commits: number };
const idents = new Map<string, Ident>();
for (const c of commits) {
  let i = idents.get(c.email);
  if (!i) idents.set(c.email, (i = { email: c.email, names: new Map(), commits: 0 }));
  i.commits += 1;
  i.names.set(c.name, (i.names.get(c.name) ?? 0) + 1);
}
const topName = (i: Ident) => [...i.names.entries()].sort((a, b) => b[1] - a[1])[0]![0];

const unmappedEmails = [...idents.values()]
  .filter((i) => !byEmail.has(i.email))
  .sort((a, b) => b.commits - a.commits);

const mappedCommits = commits.filter((c) => byEmail.has(c.email)).length;
console.log(
  `git    ${mappedCommits}/${commits.length} commits mapped ` +
    `(${((mappedCommits / commits.length) * 100).toFixed(1)}%), ` +
    `${idents.size - unmappedEmails.length}/${idents.size} identities\n`,
);

if (unmappedEmails.length) {
  console.log(`Unmapped git identities (${unmappedEmails.length}):`);
  for (const i of unmappedEmails) {
    const suggestion = domainToOrg.get(i.email.split("@")[1]?.toLowerCase() ?? "");
    console.log(`  ${String(i.commits).padStart(3)}  ${topName(i).padEnd(26)} ${i.email.padEnd(46)}` +
      (suggestion ? `  suggest: ${suggestion} (domain)` : ""));
  }
  console.log();
}

// ------------------------------------------------------------- github side

if (!github) {
  console.log("github  suggestions require a sealed full acquisition — run `bun run acquire --full`");
} else {
  type Act = { login: string; prs: number; reviews: number; comments: number; issues: number };
  const acts = new Map<string, Act>();
  const act = (who: string) => {
    let a = acts.get(who);
    if (!a) acts.set(who, (a = { login: who, prs: 0, reviews: 0, comments: 0, issues: 0 }));
    return a;
  };
  // Comments are raw activity; reviews are collapsed by the shared rule so this
  // ranking matches the published numbers instead of over-weighting whoever
  // left the most rounds on one PR.
  for (const e of github.events) {
    if (e.kind !== "review") act(e.login).comments += 1;
  }
  for (const e of firstReviews(github.events).values()) act(e.login).reviews += 1;
  // Authorship lives in the item registry, not the event stream. Reading only
  // events here undercounted the participant pool by ~30%, because people who
  // open PRs but never comment were invisible.
  for (const item of Object.values(github.items)) {
    if (!item.author) continue;
    const a = act(item.author);
    if (item.kind === "issue") a.issues += 1;
    else a.prs += 1;
  }
  const weight = (a: Act) => a.prs + a.reviews + a.comments + a.issues;

  const unmapped = [...acts.values()]
    .filter((a) => !byLogin.has(a.login))
    .sort((x, y) => weight(y) - weight(x));

  const totalActivity = [...acts.values()].reduce((n, a) => n + weight(a), 0);
  const unmappedActivity = unmapped.reduce((n, a) => n + weight(a), 0);

  console.log(
    `github ${acts.size - unmapped.length}/${acts.size} logins mapped, ` +
      `${(((totalActivity - unmappedActivity) / totalActivity) * 100).toFixed(1)}% of activity\n`,
  );

  if (unmapped.length) {
    // The long tail is real but weightless — show where the effort actually pays
    // off so nobody hand-maps 200 people who commented once.
    let running = 0;
    const worthIt = unmapped.filter((a) => {
      const before = running;
      running += weight(a);
      return before < unmappedActivity * 0.8;
    });

    console.log(
      `Unmapped logins: ${unmapped.length}, but the top ${worthIt.length} carry 80% of ` +
        `unmapped activity. Mapping just those closes most of the gap.\n`,
    );
    console.log(`  ${"pr/rev/com/iss".padEnd(16)} ${"login".padEnd(24)} profile company`);
    for (const a of worthIt) {
      const prof = github.profiles[a.login];
      const guess = guessOrg(prof?.company) ?? guessOrgFromLogin(a.login);
      // Links the person published on their own profile: the only affiliation
      // trail that can be followed without guessing at an identity.
      const links = prof?.links?.length ? ` links:${prof.links.length}` : "";
      console.log(
        `  ${`${a.prs}/${a.reviews}/${a.comments}/${a.issues}`.padEnd(16)} ${a.login.padEnd(24)}` +
          `${(prof?.company ?? "—").slice(0, 38).padEnd(40)}` +
          (guess ? `suggest: ${guess}` : "") + links,
      );
    }

    console.log(`\nStubs for data/contributors.json5:`);
    for (const a of worthIt) {
      const prof = github.profiles[a.login];
      const guess = guessOrg(prof?.company) ?? guessOrgFromLogin(a.login);
      const name = prof?.name ? `name: ${JSON.stringify(prof.name)}, ` : "";
      console.log(
        `  "${slugify(prof?.name || a.login)}": { ${name}emails: [], ` +
          `logins: ["${a.login}"], orgs: [{ org: "${guess ?? "undisclosed"}" }] },` +
          (prof?.company && !guess ? `  // profile: ${JSON.stringify(prof.company)}` : ""),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Recorded, but still not attributed.
  //
  // This section exists because its absence caused a real failure. "Needs
  // attention" was defined as "has no record", so the moment anyone was written
  // down as `undisclosed` they vanished from this report — including people who
  // publish a LinkedIn URL on their own GitHub profile. Two of them were found
  // by a human reading the site, not by the tool whose job that is.
  //
  // The bug was self-sealing: every person written off shrank the candidate
  // pool, which made the remaining gap look more exhausted than it was. A
  // pseudo-org is a status, not a conclusion, so attribution status decides who
  // appears here — never whether a row exists.
  // -------------------------------------------------------------------------
  // Only hand-assignable statuses belong here: `unknown` means no decision and
  // `bot` is derived, so neither should remain on a human-confirmation worklist.
  const assignablePseudo = new Set(ASSIGNABLE_PSEUDO);
  // Reverse the login index rather than reading `logins[]` off the record.
  //
  // A record can own a login it never lists: the email->login bridge attaches it
  // from the commit data. A record with only an email, an `independent` guess,
  // and a bridged profile naming an employer would otherwise go unexamined,
  // because scans of `logins[]` cannot see it. Reading the resolved index is the
  // only way to see a person the way `derive` sees them.
  const loginsOf = new Map<string, string[]>();
  for (const [login, slug] of byLogin) {
    if (!loginsOf.has(slug)) loginsOf.set(slug, []);
    loginsOf.get(slug)!.push(login);
  }

  const openLeads = Object.entries(contributors)
    .map(([slug, c]) => {
      const spans = c.orgs ?? [];
      if (!spans.length || !spans.every((s) => assignablePseudo.has(s.org))) return null;
      const profs = (loginsOf.get(slug) ?? []).map((l) => github.profiles[l]).filter(Boolean);
      const evidence = [
        ...profs.map((x) => x?.company).filter(Boolean).map((v) => `company=${JSON.stringify(v)}`),
        ...[...new Set(profs.flatMap((x) => x?.links ?? []))],
      ];
      if (!evidence.length) return null;
      const activity = (loginsOf.get(slug) ?? []).reduce((n, l) => n + weight(act(l)), 0);
      return { slug, status: spans.map((s) => s.org).join("/"), evidence, activity };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.activity - a.activity);

  if (openLeads.length) {
    console.log(
      `\nRecorded but unattributed, with self-disclosure on file (${openLeads.length}):\n` +
        `  Nothing in a record says whether its evidence was already examined, so\n` +
        `  every lead is listed every run. "Already checked" lives in git history.\n`,
    );
    for (const l of openLeads) {
      console.log(
        `  ${String(l.activity).padStart(3)}ev  ` +
          `${l.slug.padEnd(22)} ${l.status.padEnd(12)} ${l.evidence.join("  ").slice(0, 90)}`,
      );
    }
  }
}


// -------------------------------------------------------------- governance
/**
 * Report roster names no alias links, and suggest identity aliases.
 *
 * MAINTAINERS.md offers a display NAME and nothing else, so a suggestion here is
 * printed, never written. A confirmed one becomes an exact `rosterNames` entry on
 * the contributor -- an identity alias like an email. Which councils a person sits
 * on is never recorded by hand; derive reads it from the roster every run.
 *
 * Suggested only on an exact or case/punctuation-normalised display-name match.
 * No initials, no surname-only, no fuzzy distance: a wrong alias hands one
 * person another's seat, which is worse than an unlinked name a human can see.
 */
const council = loadCouncil();
if (council) {
  const aliases = rosterIndex(contributors);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
  const byName = new Map<string, string>();
  for (const [slug, c] of Object.entries(contributors)) {
    if (c.name) byName.set(norm(c.name), slug);
    byName.set(norm(slug.replace(/-/g, " ")), slug);
  }

  const names = new Map<string, { company: string; councils: string[] }>();
  for (const s of council.seats) {
    const rec = names.get(s.name) ?? { company: s.company, councils: [] };
    rec.councils.push(s.council);
    names.set(s.name, rec);
  }

  const suggest: string[] = [];
  const unmatched: string[] = [];
  for (const [name, rec] of [...names].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (aliases.has(name.trim())) continue;
    const slug = byName.get(norm(name));
    const line = `${rec.company.padEnd(18)} ${rec.councils.join(", ")}`;
    if (slug) suggest.push(`  ${slug.padEnd(24)} rosterNames: [${JSON.stringify(name)}]   ${line}`);
    else unmatched.push(`  ${name.padEnd(24)} ${line}`);
  }
  const stale = [...aliases].filter(([alias]) => !names.has(alias)).map(([alias, slug]) => `  ${slug.padEnd(24)} "${alias}"`);

  console.log(
    `\nGovernance roster: ${names.size} names, ${council.seats.length} seats under ` +
      `${council.councils?.length ?? "?"} headings @ ${council.source.sha?.slice(0, 8)} ${council.source.at?.slice(0, 10)}`,
  );
  if (suggest.length) {
    console.log(
      `\nPossible identity aliases (${suggest.length}). Confirm the person is the same, then add\n` +
        `  the exact spelling to that entry's \`rosterNames\`. Proposed by display name only.\n`,
    );
    for (const l of suggest) console.log(l);
  }
  if (unmatched.length) {
    console.log(
      `\nRoster names with no contributor record (${unmatched.length}). Listed unlinked on the\n` +
        `  Governance page; do NOT invent activity or a record for them.\n`,
    );
    for (const l of unmatched) console.log(l);
  }
  if (stale.length) {
    console.log(`\nAliases no current seat uses (${stale.length}). Harmless; the person left or was renamed.\n`);
    for (const l of stale) console.log(l);
  }
}
