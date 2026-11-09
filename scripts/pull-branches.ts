#!/usr/bin/env bun
// Walk the branch behind every merged pull request and record who wrote what.
// Git only: `refs/pull/*/head` is fetchable without a token.
//
// WHY THIS EXISTS
//
// Every measured repository is squash-only, so a pull request reaches the
// default branch as one commit by one author. 197 of 275 commits on `ucp`'s
// default branch carry no `Co-authored-by` trailer, so for those the spine can
// name exactly one person no matter how many worked on the branch. ucp#589
// landed as "Jing Li, +2,616" over a branch of 51 commits by two people.
//
// WHAT "LANDED" TURNS OUT TO MEAN
//
// A pull request marked landed landed *somewhere*, and only 254 of `ucp`'s 299
// landed on the default branch. Conflating the rest is not a rounding error: it
// decides whether a person's work is counted once, twice, or not at all.
//
//   main        delivered to the default branch. The only class whose lines
//               roll up, because it is the only class whose lines reached it.
//   component   merged into another pull request's branch (a stack). Its lines
//               arrive inside the carrier, so counting them again here would
//               double them in every person and org total.
//   sidebranch  landed on some other branch — release or backport. The lines
//               are a replay of work counted elsewhere; the review is real.
//   unreachable reachable from no ref. On `ucp` these are 18 pull requests from
//               January 2026 whose merge commits were orphaned when history was
//               rewritten at publication; their content survives inside the
//               seed commit, where per-person authorship is unrecoverable. Also
//               ucp#223, #760 and #762: stacked onto branches since deleted,
//               whose carriers landed from a head that no longer contains them.
//
// This is recorded as a fact per pull request. Which classes roll up is a
// judgment, and belongs to `derive`.
//
// WHAT "NOT WALKED" MEANS
//
// Every landed pull request gets exactly one record. One that cannot be walked
// is recorded as `unavailable` with a reason, never skipped and never given an
// empty branch: skipping erased ucp#223, #760 and #762 from per-item attribution
// without a line of output, and an empty branch is a measured zero.
//
// A merge commit missing from the mirror is fetched ONCE, by full id, from the
// repository's public URL. Those three had merged into other pull requests'
// branches that were later rewritten, so no ref reaches them and no clone has
// them, but GitHub still serves them by id. Only when the server refuses the id
// is the record `unavailable`; a network or auth failure fails the walk.
//
// A walked pull request whose head ref or base cannot be read fails the walk
// rather than being recorded with an empty branch -- a measured zero. For a
// delivery it is worse: its range decides which other pull requests are its
// components, so a silently empty one reclassifies them. Zero of the 810 walked
// today hit this, so strictness costs nothing on current data.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { FULL_OID, validateBranches } from "./lib/branches.ts";
import {
  branchCommits, fetchCommit, firstParent, git, hasCommit, isAncestor, patchIds, prRef,
} from "./lib/branchgit.ts";
import { loadRepos, p } from "./lib/data.ts";
import type { BranchCommit, BranchDest, BranchRecord, Item, UnavailableBranch } from "./lib/types.ts";

const repos = loadRepos();
const items: Record<string, Item> = JSON.parse(readFileSync(p("raw/items.json"), "utf8"));
const records: BranchRecord[] = [];
let fetchedTotal = 0;

for (const { name, url } of repos) {
  const dir = p("raw/repos", `${name}.git`);
  // Not a skip: every landed pull request in this repository would then have no
  // record, which is the silent absence this script exists to prevent.
  if (!existsSync(dir)) throw new Error(`${name} is not cloned — run \`bun run pull\` first`);
  process.stdout.write(`walk   ${name} ... `);

  git(dir, ["fetch", "--prune", "--quiet", "origin", "+refs/pull/*/head:refs/remotes/pr/*"]);

  const head = git(dir, ["rev-parse", "HEAD"]).trim();
  const mainOrder = new Map(
    git(dir, ["rev-list", head]).split("\n").filter(Boolean).map((s, i) => [s, i] as const),
  );
  const mainPid = new Map<string, string>();          // patch-id -> commit on default branch
  for (const [commit, pid] of patchIds(dir, [head])) mainPid.set(pid, commit);

  // Every ref that is neither the default branch nor a synthesized pull-request
  // ref. Deliberately not a `release/*` pattern: naming conventions differ per
  // repository, and "landed somewhere that is not the default branch" is the
  // fact worth recording.
  const sideRefs = git(dir, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags"])
    .split("\n").filter((r) => r && !r.startsWith("refs/remotes/pr/") && git(dir, ["rev-parse", r]).trim() !== head);

  const landed = Object.values(items).filter((i) => i.repo === name && i.kind === "pr" && i.state === "landed");
  const byItem = new Map<Item, BranchRecord>();
  const resolved = new Map<Item, string>();
  let fetched = 0;
  for (const item of landed) {
    if (!item.sha) {
      byItem.set(item, { repo: name, number: item.number, status: "unavailable", merge: null, reason: "no-merge-commit" });
      continue;
    }
    // A 12-character id cannot be fetched, and resolving it against local objects
    // only works for the objects that were never the problem.
    if (!FULL_OID.test(item.sha)) {
      throw new Error(`${name}#${item.number}: raw/items.json carries merge ${item.sha}, not a full id — re-run pull:github`);
    }
    if (!hasCommit(dir, item.sha)) {
      if (fetchCommit(dir, url, item.sha) === "refused") {
        byItem.set(item, {
          repo: name, number: item.number, status: "unavailable", merge: item.sha, reason: "merge-commit-unfetchable",
        });
        continue;
      }
      fetched++;
    }
    resolved.set(item, item.sha);
  }
  fetchedTotal += fetched;

  // Deliveries first: their ranges reveal which pull requests are components.
  // Strict: a delivery whose head or base cannot be read throws, because an
  // empty range here silently turns its components into side branches.
  const carrier = new Map<string, number>();
  const ranges = new Map<number, BranchCommit[]>();
  const bases = new Map<number, string>();
  for (const [item, sha] of resolved) {
    if (!mainOrder.has(sha)) continue;
    const base = firstParent(dir, sha);
    const commits = branchCommits(dir, item.number, base);
    bases.set(item.number, base);
    ranges.set(item.number, commits);
    for (const c of commits) if (!carrier.has(c.sha)) carrier.set(c.sha, item.number);
  }

  for (const [item, sha] of resolved) {
    const base = bases.get(item.number) ?? firstParent(dir, sha);
    let dest: BranchDest;
    let via: string | number | null = null;
    if (mainOrder.has(sha)) dest = "main";
    else if (carrier.has(sha)) { dest = "component"; via = carrier.get(sha)!; }
    else {
      const ref = sideRefs.find((r) => isAncestor(dir, sha, r));
      if (ref) { dest = "sidebranch"; via = ref.replace(/^refs\/(heads|tags)\//, ""); }
      else dest = "unreachable";
    }

    const commits = ranges.get(item.number) ?? branchCommits(dir, item.number, base);

    // A branch commit whose patch already sits on the default branch at or
    // before this pull request's base is a replay — a cherry-pick or a rebase,
    // which rewrite the sha but not the content. ucp#433 replays 19 pull
    // requests; sha comparison finds none of them, patch-id finds all 19.
    const baseIdx = mainOrder.get(base);
    const branchPid = commits.length ? patchIds(dir, [prRef(item.number), `^${base}`]) : new Map<string, string>();
    for (const c of commits) {
      const pid = branchPid.get(c.sha);
      const prior = pid ? mainPid.get(pid) : undefined;
      if (prior === undefined) continue;
      if (baseIdx === undefined) {
        // The base is not on the default branch, so there is no position to
        // compare against. A backport branch carrying a patch that also exists
        // on the default branch is a replay wherever it sits in the order --
        // which is the whole point of a backport.
        c.replay = true;
      } else {
        // rev-list is newest-first, so a LARGER index is an older commit. The
        // patch must already have been there when this branch started; one that
        // lands later is someone else replaying THIS work, not the reverse.
        const priorIdx = mainOrder.get(prior);
        if (priorIdx !== undefined && priorIdx >= baseIdx) c.replay = true;
      }
    }

    byItem.set(item, { repo: name, number: item.number, status: "available", merge: sha, dest, via, base, commits });
  }

  // Registry order, so a re-walk of the same inputs writes the same bytes.
  for (const item of landed) records.push(byItem.get(item)!);

  const mine = records.filter((r) => r.repo === name);
  const n = (d: string) => mine.filter((r) => r.status === "available" && r.dest === d).length;
  const gone = mine.filter((r): r is UnavailableBranch => r.status === "unavailable");
  console.log(
    `${landed.length} landed — ${n("main")} main, ${n("component")} component, ` +
    `${n("sidebranch")} sidebranch, ${n("unreachable")} unreachable, ${gone.length} unavailable` +
    (fetched ? ` (${fetched} merge commit${fetched === 1 ? "" : "s"} fetched by id)` : "") +
    (gone.length ? `\n         unavailable: ${gone.map((r) => `#${r.number} ${r.reason}`).join(", ")}` : ""),
  );
}

// Refuse to write anything that derive would refuse to read.
const errors = validateBranches(items, records);
if (errors.length) {
  throw new Error(`branch records do not cover the landed pull requests exactly:\n  ✗ ${errors.slice(0, 20).join("\n  ✗ ")}` +
    (errors.length > 20 ? `\n  … ${errors.length - 20} more` : ""));
}

writeFileSync(p("raw/branches.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
const walked = records.filter((r) => r.status === "available");
const commits = walked.reduce((t, r) => t + r.commits.length, 0);
const replays = walked.reduce((t, r) => t + r.commits.filter((c) => c.replay).length, 0);
console.log(
  `\nwrote raw/branches.jsonl — ${records.length} pull requests (${records.length - walked.length} unavailable, ` +
  `${fetchedTotal} fetched by id), ${commits} branch commits, ${replays} replays`,
);
