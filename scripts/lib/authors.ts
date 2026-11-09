// Branch authors as an item page names them.
//
// Pure, so the resolution order and the public shape are pinned by a test rather
// than by whatever derive happens to print. derive supplies the lookups; nothing
// here reads a file.

import { createHash } from "node:crypto";
import type { Attribution } from "./branches.ts";

export type AuthorSources = {
  /** The curated record that lists this address. */
  curatedByEmail: (email: string) => string | undefined;
  /** The GitHub login an address belongs to: the overlay bridge, then the no-reply address. */
  loginOf: (email: string) => string | null;
  /** The curated record that claims a login. */
  curatedByLogin: (login: string) => string | undefined;
  /** The published person-row slug for an internal pid, if that pid has a row. */
  published: (pid: string) => string | undefined;
};

/**
 * `[key, added, deleted, commits]` for a published person, whose key is their
 * people.json slug; `[key, added, deleted, commits, label]` for an author known
 * only from a branch walk, whose key is `branch-<digest>` and links nowhere.
 */
export type CastRow = [string, number, number, number] | [string, number, number, number, string];

/** Public key for a branch-only author: stable per identity, never an internal pid. */
export const branchKey = (pid: string) =>
  `branch-${createHash("sha256").update(pid).digest("hex").slice(0, 12)}`;
export const BRANCH_KEY = /^branch-[0-9a-f]{12}$/;

/**
 * The identity one branch-commit address belongs to.
 *
 * Tried in order: the curated record listing the address; the curated record
 * claiming its login (bridge, then no-reply); the uncurated login; the address.
 * The first candidate with a published person row wins, so a known contributor
 * committing under an unlisted alias lands on their own row. With no row, the
 * most specific candidate is the identity -- branch-only authors are real and
 * are shown, but never given a fake zero-activity person row.
 */
export function authorPid(email: string, src: AuthorSources): string {
  const login = src.loginOf(email);
  const candidates = [
    src.curatedByEmail(email),
    login ? src.curatedByLogin(login) : undefined,
    login ? `login:${login}` : undefined,
    `email:${email}`,
  ].filter((c): c is string => Boolean(c));
  return candidates.find((c) => src.published(c) !== undefined) ?? candidates[0]!;
}

/**
 * One item's branch attribution, projected to public rows: one row per person
 * (two addresses resolving to one identity are merged), heaviest first.
 * `label` names a branch-only identity; it is not consulted for published ones.
 */
export function projectAuthors(
  rows: readonly Attribution[],
  src: AuthorSources,
  label: (pid: string) => string,
): CastRow[] {
  const out: CastRow[] = [];
  const at = new Map<string, CastRow>();
  for (const a of rows) {
    const pid = authorPid(a.email, src);
    const slug = src.published(pid);
    const key = slug ?? branchKey(pid);
    const prev = at.get(key);
    if (prev) { prev[1] += a.added; prev[2] += a.deleted; prev[3] += a.commits; continue; }
    const row: CastRow = slug
      ? [key, a.added, a.deleted, a.commits]
      : [key, a.added, a.deleted, a.commits, label(pid)];
    at.set(key, row);
    out.push(row);
  }
  return out.sort((x, y) => (y[1] + y[2]) - (x[1] + x[2]));
}

/** Internal pipeline prefixes that must never reach a public key or label. */
export const INTERNAL_ID = /^(email|login|pid):/;

/** `added/deleted/commits` summed over rows, so a projection can be checked against its input. */
export const castTotals = (xs: readonly (readonly [unknown, number, number, number, ...unknown[]])[]): string => {
  let added = 0, deleted = 0, commits = 0;
  for (const x of xs) { added += x[1]; deleted += x[2]; commits += x[3]; }
  return `${added}/${deleted}/${commits}`;
};
