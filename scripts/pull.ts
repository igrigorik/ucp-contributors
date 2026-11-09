#!/usr/bin/env bun
// Clone/refresh the measured repos and flatten their history into
// raw/commits.jsonl. Git only: no API, no token, no rate limit.
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { ensureDir, loadRepos, p } from "./lib/data.ts";
import { parseLog } from "./lib/gitlog.ts";
import type { Commit } from "./lib/types.ts";

const git = (args: string[], cwd?: string) =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

// A single log pass yields authorship and churn together. `C\t` prefixes the
// commit header so numstat rows (which have no prefix) parse unambiguously.
// --no-merges: merge commits aren't authorship. Squash-merges are ordinary
// commits, so merged-PR authorship is still captured.
//
// A note on what this can and cannot see. Every repository here is squash-only,
// so a pull request's branch commits are NOT reachable from the default branch —
// the squash commit has a single parent and the branch objects are orphaned. No
// git flag reaches them. That costs us nothing in volume, because the squash
// carries the full aggregate diff, but it would cost us every co-author if
// GitHub did not preserve them as trailers in the squash message. 29% of commits
// here carry one, so we parse them.
//
// Record separator is NUL and field separator SOH: the commit body is
// multi-line and contains tabs, so the previous tab-delimited single-line
// format could not carry it.
const LOG_ARGS = [
  "log",
  "--no-merges",
  "--format=%x00%H%x01%aE%x01%aN%x01%aI%x01%B%x01",
  "--numstat",
];

/**
 * `Co-authored-by: Name <email>` trailers, which is how a squash merge preserves
 * everyone who committed to the branch. Without this, a pull request with four
 * contributors credits exactly one — the squash author.
 *
 * Bots are kept rather than filtered: `derive` already resolves them to the
 * `bot` pseudo-org and excludes them from human coverage, and deciding what
 * counts as a bot is a judgment that belongs there, not here.
 */
const repos = loadRepos();
ensureDir(p("raw/repos"));
const all: Commit[] = [];

for (const { name, url } of repos) {
  const dir = p("raw/repos", `${name}.git`);
  if (existsSync(dir)) {
    process.stdout.write(`fetch  ${name} ... `);
    git(["fetch", "--prune", "--quiet", "origin", "+refs/heads/*:refs/heads/*"], dir);
  } else {
    process.stdout.write(`clone  ${name} ... `);
    git(["clone", "--bare", "--quiet", url, dir]);
  }

  const commits = parseLog(name, git(LOG_ARGS, dir));
  all.push(...commits);
  const authors = new Set(commits.map((c) => c.email)).size;
  console.log(`${commits.length} commits, ${authors} identities`);
}

all.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
writeFileSync(p("raw/commits.jsonl"), all.map((c) => JSON.stringify(c)).join("\n") + "\n");

const identities = new Set(all.map((c) => c.email)).size;
console.log(`\nwrote raw/commits.jsonl — ${all.length} commits, ${identities} identities`);
