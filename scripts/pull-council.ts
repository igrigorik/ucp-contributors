#!/usr/bin/env bun
// Record the elected governance roster from the .github repository's
// MAINTAINERS.md. Git only: the repository is public, so no token, no API, no
// rate limit — the same contract as `pull`.
//
// WHY THIS IS A SEPARATE REPOSITORY FROM THE MEASURED SIX
//
// data/repos.json5 deliberately excludes `.github`, because its 118 commits are
// lint config and a code of conduct and would rank beside specification work in
// every volume table. That exclusion is about COMMITS. This script reads one
// FILE out of the same repository and records no commits at all, so the two do
// not conflict: the roster is a fact about people, not a measurement of output.
//
// WHY THE ROSTER IS WORTH RECORDING
//
// Every other figure on this site counts something a person DID. Governance is
// the one contribution that leaves no commit, no review and no comment — an
// elected seat is work, and a site that measures only volume renders it as an
// empty row. Several elected members carry twenty reviews and zero commits; the
// roster is what distinguishes them from someone who wandered through.
//
// WHAT THIS DOES NOT DO
//
// It does not decide WHO these people are. MAINTAINERS.md offers a display name
// and a company and nothing else — no email, no login. A row reaches a
// contributor only through an exact `rosterNames` alias in
// data/contributors.json5, applied by derive. This file records the roster
// verbatim (scripts/lib/roster.ts) and stops.
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { ensureDir, p } from "./lib/data.ts";
import { parseRoster } from "./lib/roster.ts";
import type { RawCouncil } from "./lib/types.ts";

const REPO = "https://github.com/Universal-Commerce-Protocol/.github.git";
const FILE = "MAINTAINERS.md";

const git = (args: string[], cwd?: string) =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

const dir = p("raw/repos", "governance.git");
ensureDir(p("raw/repos"));
if (existsSync(dir)) {
  process.stdout.write("fetch  .github ... ");
  git(["fetch", "--prune", "--quiet", "origin", "+refs/heads/*:refs/heads/*"], dir);
} else {
  process.stdout.write("clone  .github ... ");
  git(["clone", "--bare", "--quiet", REPO, dir]);
}

const head = git(["rev-parse", "HEAD"], dir).trim();
const at = git(["log", "-1", "--format=%aI", "HEAD"], dir).trim();
const md = git(["show", `HEAD:${FILE}`], dir);

// Throws on any row, table or heading it does not recognize, including a parse
// that yields no seats: a dropped row is a person missing from a public roster.
const { councils, seats } = parseRoster(md);

// `source` is recorded so a reader can check the roster against the exact commit
// it came from. The roster changes by election, and a figure that moves with no
// visible cause is the thing provenance exists to prevent.
const out: RawCouncil = { source: { repo: REPO, file: FILE, sha: head, at }, councils, seats };
writeFileSync(p("raw/council.json"), JSON.stringify(out, null, 2) + "\n");

const people = new Set(seats.map((s) => s.name));
const empty = councils.filter((c) => !seats.some((s) => s.council === c));
console.log(
  `${seats.length} seats — ${people.size} names under ${councils.length} headings` +
    (empty.length ? ` (${empty.length} with no named seat)` : ""),
);
console.log(`wrote raw/council.json @ ${head.slice(0, 8)} ${at.slice(0, 10)}`);
