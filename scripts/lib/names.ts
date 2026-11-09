// Display names: which public identifier a person's row is labelled with.
//
// Pure, so the precedence is pinned by a test rather than by whatever derive
// happens to print. derive supplies the sources; nothing here reads a file.

/**
 * The login inside a GitHub no-reply address, `<id>+<login>@users.noreply.github.com`
 * (or the older `<login>@users.noreply.github.com`).
 *
 * Not an inference: GitHub mints these addresses from the account, so the login
 * is part of the address itself. Three of the four identities known only from a
 * `Co-authored-by` trailer in one snapshot were no-reply addresses, and each was
 * published under the raw address while its login sat inside it.
 */
export function noreplyLogin(email: string): string | null {
  const m = /^(?:\d+\+)?([a-z0-9][a-z0-9-]*)@users\.noreply\.github\.com$/i.exec(email);
  return m ? m[1]!.toLowerCase() : null;
}

/** A name that may label a row: present, and not an address. */
const usable = (n: string | null | undefined): n is string => Boolean(n && n.trim() && !n.includes("@"));

export type NameSources = {
  /** Hand-written `name` on a curated record. */
  curated: (slug: string) => string | undefined;
  /** Git author names used per pid, by count. */
  votes: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** The GitHub login an address belongs to, if anything machine-stated says so. */
  loginOf: (email: string) => string | null;
  /** The curated record that claims a login, if any. */
  slugOf: (login: string) => string | undefined;
  /** The self-reported GitHub profile `name`, when the overlay was pulled. */
  profileName: (login: string) => string | null | undefined;
};

const topVote = (votes: ReadonlyMap<string, number> | undefined) =>
  votes?.size ? [...votes.entries()].sort((a, b) => b[1] - a[1])[0]![0] : undefined;

/**
 * Prefer an explicit override, then the git author name used most often, so a
 * readable "Example Contributor" beats a handle-like "contrib-dev"; people known
 * only by an account or an address fall back through the safest public label
 * the data establishes.
 *
 * For an identity known only from a `Co-authored-by` trailer there is no commit
 * and so no name vote. Its address is public -- it is in the trailer -- but it is
 * the worst label available, so it is used only when nothing better exists:
 *
 *   1. the curated record's name, when the address belongs to a login a curated
 *      record claims;
 *   2. the login's self-reported GitHub profile name, unless it is an address;
 *   3. the login itself;
 *   4. the address, exactly as the trailer published it.
 *
 * Never an internal pid: a `kind:` prefix is pipeline state, not a name.
 */
export function displayName(pid: string, src: NameSources): string {
  const slug = pid.includes(":") ? null : pid;
  if (slug) return src.curated(slug) ?? topVote(src.votes.get(slug)) ?? slug;

  const voted = topVote(src.votes.get(pid));
  if (voted) return voted;

  const viaLogin = (login: string): string => {
    const owner = src.slugOf(login);
    const curated = owner ? src.curated(owner) ?? topVote(src.votes.get(owner)) : undefined;
    if (usable(curated)) return curated;
    // Some people put an email address in GitHub's `name` field. Echoing it
    // would republish an address as a display name for no gain, since the login
    // identifies them just as well and is what their profile URL already shows.
    const profile = src.profileName(login);
    return usable(profile) ? profile : login;
  };

  if (pid.startsWith("login:")) return viaLogin(pid.slice(6));
  if (pid.startsWith("email:")) {
    const email = pid.slice(6);
    const login = src.loginOf(email);
    return login ? viaLogin(login) : email;
  }
  throw new Error(`displayName: ${pid} is not a slug, login: or email: id`);
}
