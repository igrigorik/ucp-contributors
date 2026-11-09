import type { Contributor } from "./types.ts";

/**
 * Normalizes an account name to one form, whichever GitHub API it arrived from.
 *
 * GitHub's two APIs disagree about App accounts: GraphQL reports
 * `gemini-code-assist`, REST reports `gemini-code-assist[bot]`. Pulling reviews
 * over GraphQL and inline comments over REST recorded one bot as two identities
 * in a single raw file, and the suffixed half resolved to nobody — so 29
 * comments were on their way to `unknown`.
 *
 * Stripping is safe rather than merely convenient: GitHub forbids `[` and `]` in
 * usernames, so the suffix cannot be part of a real one.
 *
 * Lives here, not in the pull script, so it is importable without running a pull
 * and can be pinned by a test.
 */
export const bareLogin = (l: string) => l.toLowerCase().replace(/\[bot\]$/, "");

/** Add one GitHub-observed email→login fact, rejecting contradictory observations. */
export function addBridge(
  bridge: Map<string, string>, email: string, login: string,
): void {
  const key = email.trim().toLowerCase();
  const value = bareLogin(login.trim());
  const prior = bridge.get(key);
  if (prior && prior !== value) {
    throw new Error(`identity bridge conflict: one email resolved to multiple logins`);
  }
  bridge.set(key, value);
}

/**
 * login -> slug. Explicit `logins[]` on a record wins; the rest comes from the
 * commit-derived email->login bridge, which is a machine-asserted identity fact
 * rather than an inference, so it needs no human confirmation.
 */
export function loginIndex(
  contributors: Record<string, Contributor>,
  bridge: Record<string, string>,
): Map<string, string> {
  const emails = emailIndex(contributors);
  const idx = new Map<string, string>();
  for (const [email, login] of Object.entries(bridge)) {
    const slug = emails.get(email.trim().toLowerCase());
    if (!slug) continue;
    const key = bareLogin(login.trim());
    const prior = idx.get(key);
    if (prior && prior !== slug) {
      throw new Error(`identity bridge conflict: one login resolves to multiple curated owners`);
    }
    idx.set(key, slug);
  }
  // Explicit logins are applied second so they override the bridge — that is the
  // documented escape hatch for accounts the commit bridge cannot reach.
  //
  // But two records both claiming one login is not an override, it is a
  // collision, and `set` would silently award the login to whichever record
  // happens to be parsed last. That is the same failure the duplicate-email
  // check exists to prevent, so it fails the same way instead of being an
  // asymmetry nobody remembers.
  const claimed = new Map<string, string>();
  for (const [slug, c] of Object.entries(contributors)) {
    for (const login of c.logins ?? []) {
      const key = bareLogin(login);
      const prior = claimed.get(key);
      if (prior && prior !== slug) {
        throw new Error(
          `login "${login}" claimed by both "${prior}" and "${slug}" — ` +
            `one account is one person, so merge the records`,
        );
      }
      claimed.set(key, slug);
      idx.set(key, slug);
    }
  }
  return idx;
}

/**
 * email -> slug. Throws on a duplicate claim, because two records owning one
 * email means every number downstream is quietly wrong.
 */
export function emailIndex(
  contributors: Record<string, Contributor>,
): Map<string, string> {
  const idx = new Map<string, string>();
  for (const [slug, c] of Object.entries(contributors)) {
    for (const email of c.emails ?? []) {
      const key = email.toLowerCase();
      const prev = idx.get(key);
      if (prev && prev !== slug) {
        throw new Error(`email ${email} claimed by both "${prev}" and "${slug}"`);
      }
      idx.set(key, slug);
    }
  }
  return idx;
}

/** Slugify a git author name into a stable key: "Ada Lovelace" -> "ada-lovelace". */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

/**
 * email -> canonical person id, through every curated identity fact we hold.
 *
 * Tried in order: the curated record listing the address; the curated record
 * owning the address's GitHub login (`loginOf`: the overlay's email->login
 * bridge, then the login GitHub minted into a no-reply address), where
 * `byLogin` already carries explicit `logins[]` and bridge-derived logins; the
 * bare normalized address as `email:<address>`. Exact raw strings are NOT
 * identity: two addresses of one curated person are one person, and one
 * unresolved address spelled with different casing/whitespace is one address.
 */
export function emailPerson(
  byEmail: ReadonlyMap<string, string>,
  byLogin: ReadonlyMap<string, string>,
  loginOf: (email: string) => string | null | undefined,
): (email: string) => string {
  return (raw) => {
    const email = raw.trim().toLowerCase();
    const curated = byEmail.get(email);
    if (curated) return curated;
    const login = loginOf(email);
    const owner = login ? byLogin.get(bareLogin(login.trim())) : undefined;
    return owner ?? `email:${email}`;
  };
}

/**
 * Coauthor credits on ONE commit: one per canonical person, author excluded.
 *
 * A declaration names a person, so the unit is (commit, canonical person), not
 * (commit, declared address). The commit author is resolved through the same
 * `person` function and excluded, including when the declaration uses one of
 * their other addresses. Repeated declarations of one person -- the same address
 * twice, or two of their aliases -- credit them once. The retained `email` is
 * the FIRST declaration of that person in source order, so output is
 * deterministic for identical input.
 */
export function coauthorCredits(
  author: string,
  declared: readonly string[],
  person: (email: string) => string,
): { pid: string; email: string }[] {
  const seen = new Set([person(author)]);
  const out: { pid: string; email: string }[] = [];
  for (const raw of declared) {
    const email = raw.trim().toLowerCase();
    const pid = person(email);
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push({ pid, email });
  }
  return out;
}
