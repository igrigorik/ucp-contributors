// The git side of `pull-branches`: probes, the one recovery fetch, and the
// branch walk. Separate from lib/branches.ts, which is pure and imported by
// derive; separate from the script so each rule can be pinned against a real
// throwaway repository in a test.
//
// The distinction everything here preserves is between git answering "no" and
// git being broken. A missing object, a non-ancestor and a missing ref are
// expected answers and are returned quietly -- they used to print a `fatal:`
// line per pull request to stderr. Anything else throws with git's own words,
// because a broken mirror that reads as "absent" is how a walk silently records
// zero lines for work that exists.
import { execFileSync, spawnSync } from "node:child_process";
import { destPath } from "./branches.ts";
import type { BranchCommit } from "./types.ts";

const MAX_BUFFER = 512 * 1024 * 1024;

/** Run git and return stdout; throw, with stderr, on any non-zero exit. Never prints. */
export const git = (dir: string, args: string[]): string =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] });

/**
 * A yes/no git question. Exit 0 is yes and exit 1 is no -- the documented
 * contract of `rev-parse --verify --quiet` and `merge-base --is-ancestor` -- and
 * every other status is a real error, thrown rather than read as "no".
 */
export function probe(dir: string, args: string[]): boolean {
  const res = spawnSync("git", args, { cwd: dir, encoding: "utf8", maxBuffer: MAX_BUFFER });
  if (res.status === 0) return true;
  if (res.status === 1) return false;
  throw new Error(`git ${args.join(" ")} failed in ${dir} (exit ${res.status ?? res.signal}): ${res.stderr?.trim() || res.error?.message}`);
}

export const hasCommit = (dir: string, oid: string) => probe(dir, ["rev-parse", "--verify", "--quiet", `${oid}^{commit}`]);
export const hasRef = (dir: string, ref: string) => probe(dir, ["rev-parse", "--verify", "--quiet", ref]);
export const isAncestor = (dir: string, oid: string, ref: string) => probe(dir, ["merge-base", "--is-ancestor", oid, ref]);

/** The only origin a merge object is fetched from: a public GitHub repository over https. */
export const isPublicGitHubUrl = (url: string) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(url);

/**
 * What a server says when it does not have, or will not serve, an object by id.
 * Matched on git's message because the exit status (128) is the same one a DNS
 * failure or a refused connection produces, and those are not absences.
 */
const REFUSED = /not our ref|couldn't find remote ref|no such remote ref/i;

/**
 * One attempt to fetch a commit the mirror lacks, by full id, from `url`.
 *
 *   "fetched"  the object is now present.
 *   "refused"  the server answered that it has no such object to give.
 *   throws     anything else -- network, auth, a non-public URL, a fetch that
 *              claimed success and left no object -- because recording those as
 *              "unfetchable" would turn an outage into a permanent-looking fact.
 *
 * Anonymous by construction: global and system git config are bypassed (so no
 * credential helper and no `insteadOf` rewrite to ssh can apply) and prompting
 * is off. No ref is written, so nothing about the mirror's refs -- and nothing
 * the acquisition seal records about them -- changes.
 */
export function fetchCommit(
  dir: string, url: string, oid: string, allowUrl: (url: string) => boolean = isPublicGitHubUrl,
): "fetched" | "refused" {
  if (!/^[0-9a-f]{40}$/.test(oid)) throw new Error(`fetchCommit: ${oid} is not a full object id`);
  if (!allowUrl(url)) throw new Error(`fetchCommit: refusing to fetch from ${url}, which is not a public GitHub https URL`);
  const res = spawnSync("git", ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", url, oid], {
    cwd: dir, encoding: "utf8", maxBuffer: MAX_BUFFER,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  if (res.status === 0) {
    if (!hasCommit(dir, oid)) throw new Error(`fetch of ${oid} from ${url} succeeded but the commit is still absent`);
    return "fetched";
  }
  if (REFUSED.test(res.stderr ?? "")) return "refused";
  throw new Error(`fetch of ${oid} from ${url} failed (exit ${res.status ?? res.signal}): ${res.stderr?.trim() || res.error?.message}`);
}

/** The commit a squash was applied to. A merge commit without one cannot be walked. */
export function firstParent(dir: string, oid: string): string {
  const out = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${oid}^1`], { cwd: dir, encoding: "utf8" });
  if (out.status === 0) return out.stdout.trim();
  throw new Error(`${oid} has no resolvable first parent in ${dir} (exit ${out.status}): ${out.stderr?.trim()}`);
}

export const prRef = (number: number) => `refs/remotes/pr/${number}`;

/**
 * `git log -p | git patch-id --stable` emits one `<patch-id> <commit>` line per
 * commit in a single pass — 0.27s for 273 commits, against roughly four minutes
 * for a `git show | git patch-id` loop over the same set.
 *
 * A commit with an empty diff produces no line at all, so absence here means
 * "nothing to compare", never "no match". `pipefail`, because without it a
 * failing `git log` is masked by `patch-id` succeeding on empty input -- which
 * reads as "no replays" rather than as an error.
 */
export function patchIds(dir: string, revs: string[]): Map<string, string> {
  const out = execFileSync(
    "bash",
    ["-c", `set -o pipefail; git log -p --no-merges --format='%H' ${revs.map((r) => `'${r}'`).join(" ")} | git patch-id --stable`],
    { cwd: dir, encoding: "utf8", maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] },
  );
  const byCommit = new Map<string, string>();
  for (const line of out.split("\n")) {
    const [pid, commit] = line.split(" ");
    if (pid && commit) byCommit.set(commit, pid);
  }
  return byCommit;
}

const LOG_FORMAT = "%x00%H%x01%aE%x01%aN%x01%aI";

/**
 * One `git log` call per pull request; the numstat rows follow each header.
 *
 * Strict. The pull request's head ref must exist and the log must succeed: this
 * used to return `[]` on any failure, which recorded "this branch has no
 * commits" -- a measured zero -- for a branch that simply could not be read,
 * and for a delivery it also emptied the range that decides which other pull
 * requests are its components.
 */
export function branchCommits(dir: string, number: number, base: string): BranchCommit[] {
  const ref = prRef(number);
  if (!hasRef(dir, ref)) throw new Error(`#${number}: head ref ${ref} is missing in ${dir}, so its branch cannot be walked`);
  const out = git(dir, ["log", "--no-merges", `--format=${LOG_FORMAT}`, "--numstat", ref, "--not", base]);
  const commits: BranchCommit[] = [];
  for (const chunk of out.split("\0")) {
    if (!chunk.trim()) continue;
    const nl = chunk.indexOf("\n");
    const header = nl === -1 ? chunk : chunk.slice(0, nl);
    const fields = header.split("\x01");
    if (fields.length !== 4) {
      throw new Error(`#${number}: branch git log SOH framing error: expected 4 header fields, got ${fields.length}`);
    }
    const [sha, email, name, at] = fields;
    if (!sha) continue;
    const files: BranchCommit["files"] = [];
    for (const line of (nl === -1 ? "" : chunk.slice(nl + 1)).split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!m) continue;
      // A binary file has no line counts. Recording null keeps "not measurable"
      // distinct from "measured as zero".
      files.push([m[1] === "-" ? null : Number(m[1]), m[2] === "-" ? null : Number(m[2]), destPath(m[3]!)]);
    }
    commits.push({ sha: sha!, email: (email ?? "").toLowerCase(), name: name ?? "", at: at ?? "", files });
  }
  return commits;
}
