import { expect, test } from "bun:test";
import { authorPid, BRANCH_KEY, branchKey, castTotals, INTERNAL_ID, projectAuthors, type AuthorSources } from "./authors.ts";
import { displayName, noreplyLogin } from "./names.ts";
import type { Attribution } from "./branches.ts";

// ada: curated, address listed. bob: uncurated, published via a GitHub login.
const curatedEmail: Record<string, string> = { "ada@example.com": "ada" };
const curatedLogin: Record<string, string> = { "ada-gh": "ada" };
const bridge: Record<string, string> = { "ada.work@example.com": "Ada-GH" };
const rows: Record<string, string> = { ada: "ada", "login:bob": "_bob" };
const src: AuthorSources = {
  curatedByEmail: (e) => curatedEmail[e],
  loginOf: (e) => bridge[e]?.toLowerCase() ?? noreplyLogin(e),
  curatedByLogin: (l) => curatedLogin[l],
  published: (pid) => rows[pid],
};
const label = (pid: string) => displayName(pid, {
  curated: () => undefined,
  votes: new Map([["email:zed@example.com", new Map([["Zed Writer", 2]])]]),
  loginOf: src.loginOf,
  slugOf: (l) => curatedLogin[l],
  profileName: () => undefined,
});
const at = (email: string, added: number, deleted = 0, commits = 1): Attribution =>
  ({ email, added, deleted, commits, binary: 0 });

test("bridge and no-reply aliases merge into the known person's row", () => {
  expect(authorPid("ada.work@example.com", src)).toBe("ada");
  expect(authorPid("123+ada-gh@users.noreply.github.com", src)).toBe("ada");
  expect(authorPid("9+bob@users.noreply.github.com", src)).toBe("login:bob");
  const input = [at("ada@example.com", 10), at("ada.work@example.com", 5, 1), at("123+ada-gh@users.noreply.github.com", 1, 0, 2)];
  const out = projectAuthors(input, src, label);
  expect(out).toEqual([["ada", 16, 1, 4]]);
  expect(castTotals(out)).toBe(castTotals(input.map((a) => [a.email, a.added, a.deleted, a.commits] as const)));
});

test("an unknown branch-only author is labelled, keyed publicly, and links nowhere", () => {
  const out = projectAuthors([at("zed@example.com", 3), at("ada@example.com", 9), at("raw@example.com", 1)], src, label);
  expect(out[0]).toEqual(["ada", 9, 0, 1]);
  expect(out[1]).toEqual([branchKey("email:zed@example.com"), 3, 0, 1, "Zed Writer"]);
  // No name vote and no login: the public address itself, never a pid.
  expect(out[2]).toEqual([branchKey("email:raw@example.com"), 1, 0, 1, "raw@example.com"]);
  for (const row of out) {
    expect(INTERNAL_ID.test(row[0])).toBe(false);
    if (row.length === 5) {
      expect(row[0]).toMatch(BRANCH_KEY);
      expect(Object.values(rows)).not.toContain(row[0]);
      expect(INTERNAL_ID.test(row[4])).toBe(false);
    }
  }
});

test("a branch-only no-reply author is labelled by login and two aliases collapse", () => {
  const out = projectAuthors([at("1+carol@users.noreply.github.com", 2), at("carol@users.noreply.github.com", 4)], src, label);
  expect(out).toEqual([[branchKey("login:carol"), 6, 0, 2, "carol"]]);
});

test("branch keys are stable and distinct per identity", () => {
  expect(branchKey("email:a@x")).toBe(branchKey("email:a@x"));
  expect(branchKey("email:a@x")).not.toBe(branchKey("email:b@x"));
  expect(branchKey("email:a@x")).toMatch(BRANCH_KEY);
});
