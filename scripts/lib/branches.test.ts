// The git side of the branch walk, against real throwaway repositories.
//
// A fixture cannot stand in for git here: what is under test is how git's own
// answers are read -- which exit status means "no" and which means "broken",
// and which fetch failure means "the object is gone" rather than "the network
// is down". Each repository is built in a temp directory and never touches the
// network; the public-URL guard is exercised separately.
import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  branchCommits, fetchCommit, firstParent, hasCommit, isAncestor, isPublicGitHubUrl, prRef,
} from "./branchgit.ts";

const root = mkdtempSync(join(tmpdir(), "branchgit-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.invalid",
  GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string, msg: string) => {
  sh(cwd, "commit", "--allow-empty", "-q", "-m", msg);
  return sh(cwd, "rev-parse", "HEAD");
};

// origin: main has root <- base; a pull request branch adds `work` on base; a
// second branch carries `orphan`, which is then deleted so no ref reaches it.
const origin = join(root, "origin");
sh(root, "init", "-q", "-b", "main", origin);
const rootCommit = commit(origin, "root");
const base = commit(origin, "base");
sh(origin, "checkout", "-q", "-b", "feature");
execFileSync("bash", ["-c", "printf 'a\\nb\\n' > f.md && git add f.md"], { cwd: origin, env: ENV });
const work = commit(origin, "work");
sh(origin, "checkout", "-q", "-b", "bad-framing", base);
execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "bad framing"], {
  cwd: origin,
  env: { ...ENV, GIT_AUTHOR_NAME: "Bad\x01Name", GIT_COMMITTER_NAME: "Bad\x01Name" },
});
const badFraming = sh(origin, "rev-parse", "HEAD");
sh(origin, "checkout", "-q", "-b", "gone", base);
const orphan = commit(origin, "orphan");
sh(origin, "checkout", "-q", "main");
sh(origin, "branch", "-q", "-D", "gone");
// GitHub serves an unreferenced object by id; a stock git server does not. The
// recovery path depends on the former, so the fixture server is told to behave
// like it.
sh(origin, "config", "uploadpack.allowAnySHA1InWant", "true");

// The mirror: a bare clone that has the pull request ref but never saw `orphan`.
const mirror = join(root, "mirror.git");
// `--no-local`, or git hardlinks the whole object store and the orphan comes too.
sh(root, "clone", "-q", "--bare", "--no-local", origin, mirror);
sh(mirror, "update-ref", prRef(7), work);
sh(mirror, "update-ref", prRef(9), badFraming);

const LOCAL = () => true;

test("absent and present are answers; a broken repository is an error", () => {
  expect(hasCommit(mirror, work)).toBe(true);
  expect(hasCommit(mirror, orphan)).toBe(false);
  expect(isAncestor(mirror, base, prRef(7))).toBe(true);
  expect(isAncestor(mirror, work, "refs/heads/main")).toBe(false);
  // Not a repository at all: must throw, never read as "not present".
  expect(() => hasCommit(root, work)).toThrow(/failed/);
});

test("a missing merge commit is fetched once by full id", () => {
  expect(fetchCommit(mirror, origin, orphan, LOCAL)).toBe("fetched");
  expect(hasCommit(mirror, orphan)).toBe(true);
  // No ref was written: the seal records refs, and this must not move them.
  expect(sh(mirror, "for-each-ref", "--contains", orphan)).toBe("");
});

test("an id the server refuses is unfetchable; any other failure throws", () => {
  const ghost = "0123456789abcdef0123456789abcdef01234567";
  expect(fetchCommit(mirror, origin, ghost, LOCAL)).toBe("refused");
  // An unreachable server is an outage, not a fact about the object.
  expect(() => fetchCommit(mirror, join(root, "no-such-origin"), ghost, LOCAL)).toThrow(/failed/);
  expect(() => fetchCommit(mirror, origin, ghost.slice(0, 12), LOCAL)).toThrow(/not a full object id/);
  // A fetch that succeeds but yields no COMMIT -- here, the id of a file -- is
  // not a recovered merge, and must not be walked as one.
  const blob = sh(origin, "rev-parse", `${work}:f.md`);
  expect(() => fetchCommit(mirror, origin, blob, LOCAL)).toThrow(/still absent/);
});

test("only a public GitHub https URL may be fetched from", () => {
  expect(isPublicGitHubUrl("https://github.com/Universal-Commerce-Protocol/ucp.git")).toBe(true);
  expect(isPublicGitHubUrl("git@github.com:Universal-Commerce-Protocol/ucp.git")).toBe(false);
  expect(isPublicGitHubUrl("https://github.example.invalid/x/y.git")).toBe(false);
  expect(isPublicGitHubUrl("https://user:token@github.com/x/y.git")).toBe(false);
  expect(() => fetchCommit(mirror, origin, work)).toThrow(/not a public GitHub https URL/);
});

test("a branch header containing SOH fails closed instead of shifting fields", () => {
  expect(() => branchCommits(mirror, 9, base)).toThrow(/SOH framing error.*expected 4 header fields, got 5/);
});

test("a branch walk with no head ref or no base fails instead of measuring zero", () => {
  const commits = branchCommits(mirror, 7, base);
  expect(commits.map((c) => c.sha)).toEqual([work]);
  expect(commits[0]!.files).toEqual([[2, 0, "f.md"]]);
  expect(() => branchCommits(mirror, 8, base)).toThrow(/head ref refs\/remotes\/pr\/8 is missing/);
  expect(firstParent(mirror, work)).toBe(base);
  expect(() => firstParent(mirror, rootCommit)).toThrow(/no resolvable first parent/);
});
