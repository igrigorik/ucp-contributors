// Shared shapes. Deliberately small — these types exist to catch typos in the
// hand-edited data files, not to model the domain exhaustively.

/** Affiliation interval. `from` inclusive, `until` exclusive, both optional. */
export type Span = {
  org: string;
  from?: string; // YYYY-MM-DD
  until?: string; // YYYY-MM-DD
};

/**
 * One human. `emails` collapses multiple git identities (work + personal) onto
 * a single record — this is the only reason the file needs to exist for people
 * whose affiliation we don't know.
 */
export type Contributor = {
  name?: string; // overrides the git-derived display name
  /** git identities. Optional: overlay-only people have never committed. */
  emails?: string[];
  /** GitHub logins. Wins over the commit-derived email->login bridge. */
  logins?: string[];
  orgs?: Span[];
  /**
   * Exact MAINTAINERS.md name spellings that are this person. Identity data,
   * like `emails`: it says who a roster name is, never which councils they sit
   * on -- that is read from the roster every run. Hand-confirmed, because the
   * roster's only key is a display name; `audit` suggests, a human writes it.
   * See scripts/lib/roster.ts.
   */
  rosterNames?: string[];
};

export type Org = {
  name: string;
  /** Read by `audit` only, to suggest assignments. `derive` never infers. */
  domains?: string[];
};

/**
 * What kind of work a repository holds. Hand-assigned in data/repos.json5,
 * because it is an editorial judgment and not a fact to be inferred.
 *
 * Deliberately a closed union: the whole point is that every repository lands in
 * exactly one class so a class-scoped figure has a complete denominator. A new
 * class is a considered edit to both this type and the file, not a free-text
 * value that silently creates a one-repository group nothing sums over.
 */
export type RepoClass = "spec" | "tooling" | "impl";

export type Repo = {
  name: string;
  url: string;
  class: RepoClass;
  /**
   * Commits that imported existing work rather than authoring it. Their lines
   * are counted but attributed to the import, never to whoever pushed it.
   * Full or abbreviated SHAs; matched by prefix.
   */
  seed?: string[];
};

/**
 * One collaboration event from the optional GitHub overlay (raw/github.jsonl).
 * Keyed by login, because that is all the API gives us; derive maps login ->
 * person via explicit `logins[]` or the raw/logins.json bridge.
 */
/**
 * A participation event: someone reviewed or commented on item `number`.
 *
 * Authorship is NOT here — PRs and issues live in the Item registry, because
 * they are one-per-number while reviews and comments are many-per-number.
 * Storing a PR title on each of ~3,700 comment events would duplicate it
 * endlessly; events reference `repo#number` and the registry resolves it.
 *
 * `at` is a full ISO timestamp, not a date: two events on one day must still
 * order correctly in a feed, or "landed #501" sorts above "opened #501".
 */
export type GitHubEvent = {
  repo: string;
  /**
   * `comment` is a timeline comment on a pull request or issue; `review_comment`
   * is a line-level one attached to a file. They are distinct GitHub objects
   * with distinct anchors, so the raw layer keeps them apart and derive decides
   * they both count as commenting.
   */
  kind: "review" | "comment" | "review_comment";
  login: string;
  at: string; // ISO 8601, of THIS event — not of the pull request it belongs to
  number: number;
  /**
   * Review on one's own pull request. Recorded rather than dropped at pull
   * time, because "does self-review count as review labour" is a judgment and
   * judgments belong in derive. Absent on comments.
   */
  self?: boolean;
  /**
   * Characters of prose in a REVIEW's own body, absent when there were none.
   *
   * GitHub wraps two different acts in one object. A design-level review is a
   * `bodyText` with no children; a line-level review is an empty shell around N
   * `review_comment`s. Counting only the children made the first act invisible:
   * a 7,462-character critique measured identically to clicking Approve, and the
   * loss fell entirely on people who review designs rather than lines.
   *
   * Length, never text. The measurement is that somebody wrote, and how much;
   * the words are theirs. derive folds a non-zero value into `comments` -- one
   * metric meaning "things this person wrote here" -- and does not currently
   * publish the magnitude, which stays here as a recorded fact so that answering
   * a question about review depth later needs no re-pull.
   */
  chars?: number;
  /**
   * GitHub's numeric id for this comment or review submission.
   *
   * Stored instead of the `url` GraphQL will also hand over, because the URL is
   * derivable from it (`<pr-url>#issuecomment-<id>` /
   * `<pr-url>#pullrequestreview-<id>`) and storing a derived value means keeping
   * two things in step. It is ~13 bytes per event against ~75 for the URL,
   * which on ~3,000 events is the difference between 39KB and 223KB.
   *
   * Optional because it did not exist before the activity log needed it, and
   * because a raw file pulled by an older version must still derive.
   */
  id?: number;
};

/** A PR or issue, keyed `repo#number` in raw/items.json. */
export type Item = {
  kind: "pr" | "issue";
  repo: string;
  number: number;
  title: string;
  author: string | null;
  at: string; // ISO 8601
  /**
   * pr: open | landed | declined · issue: open | closed
   *
   * Three PR states, because "not landed" is not one condition. The previous
   * boolean crushed 123 still-open PRs together with 224 closed-unmerged ones.
   * `open` is a pending verdict — it says more about the project's review
   * throughput than about the author — while `declined` is an actual verdict.
   * Conflating them lets slow review masquerade as low quality.
   */
  state: string;
  endedAt?: string; // ISO 8601, merged or closed
  /**
   * Who closed it, when it was closed without merging.
   *
   * The distinction this exists for is between an author withdrawing their own
   * work and a maintainer closing someone else's without a word. Both look
   * identical in `state: "declined"`, and they are opposite facts: one is a
   * no-op, the other is a contribution that died in silence.
   *
   * The cost of not having it was a blended figure. 79 of 235 declined pull
   * requests had no reply of any kind and a median time-to-decline of ZERO days
   * -- opened and closed the same day. Mixed into the rest they dragged the
   * headline from 51 days down to 31, so the noise was flattering us about how
   * long a real rejection actually takes.
   *
   * Absent on merged items: a merge is an answer, so who pressed the button
   * raises a different question (self-merge oversight) that nothing here asks.
   */
  closedBy?: string;
  /**
   * The merge commit's FULL 40-hex object id, as GitHub reports it; absent when
   * GitHub reports none.
   *
   * Full rather than the spine's 12-character form because an abbreviation can
   * be resolved only against objects already present, and the three landed pull
   * requests whose merge objects were missing from the mirror (ucp#223, #760,
   * #762) can be recovered only by fetching them by full id. Anything that joins
   * this against `Commit.sha` abbreviates at the join.
   */
  sha?: string;
};

/** One commit, as emitted by pull.ts into raw/commits.jsonl. */
export type Commit = {
  repo: string;
  sha: string;
  email: string;
  name: string;
  date: string; // YYYY-MM-DD
  /** First line of the commit body. Read by the activity log, not by any metric. */
  subject: string;
  added: number;
  deleted: number;
  files: number;
  /**
   * Emails from `Co-authored-by:` trailers — how a squash merge preserves the
   * other people who committed to the branch. Absent when there are none.
   */
  coauthors?: string[];
};

/**
 * One commit on a merged pull request's branch, as `pull-branches` found it.
 *
 * `files` is kept unaggregated because two judgments downstream need paths:
 * excluding machine-written output, and splitting prose from schema. Aggregating
 * here would make both unrecoverable without a re-walk.
 */
export type BranchCommit = {
  sha: string;
  email: string;
  name: string;
  at: string; // ISO 8601
  /**
   * `[added, deleted, path]`. Both counts are null for a binary file, which has
   * no lines to count — distinct from a text file measured at zero.
   */
  files: [number | null, number | null, string][];
  /**
   * This patch already sits on the default branch at or before this pull
   * request's base: a cherry-pick or a rebase. Matched by `git patch-id`, which
   * compares content, because both operations rewrite the sha.
   */
  replay?: boolean;
};

export type BranchDest = "main" | "component" | "sidebranch" | "unreachable";

/**
 * Why a landed pull request has no branch walk. A closed set, so every absence
 * names its cause and none can be mistaken for a measured zero.
 *
 *   no-merge-commit           GitHub reports the pull request merged but names
 *                             no merge commit, so there is nothing to walk.
 *   merge-commit-unfetchable  the merge commit is absent from the mirror and the
 *                             public repository refused it by id ("not our
 *                             ref"): the object is gone, not merely unfetched.
 */
export type BranchUnavailableReason = "no-merge-commit" | "merge-commit-unfetchable";

/**
 * Where a merged pull request's work actually went, and the branch behind it.
 *
 * `dest` is the load-bearing field. See the header of `scripts/pull-branches.ts`
 * for why "landed" alone is not enough to decide whether lines may be counted.
 */
export type AvailableBranch = {
  repo: string;
  number: number;
  status: "available";
  /** Full merge commit id; must equal the item's `sha`. */
  merge: string;
  dest: BranchDest;
  /**
   * For `component`, the pull request number carrying it to the default branch.
   * For `sidebranch`, the ref name it landed on. Null otherwise.
   */
  via: string | number | null;
  /** The commit the squash was applied to — this branch's exact starting point. */
  base: string;
  commits: BranchCommit[];
};

/** A landed pull request whose branch could not be walked, and why. No lines. */
export type UnavailableBranch = {
  repo: string;
  number: number;
  status: "unavailable";
  /** The item's `sha`, or null when GitHub named none. */
  merge: string | null;
  reason: BranchUnavailableReason;
};

/**
 * Exactly one per landed pull request, including one with no merge commit.
 * Before this was a union, a landed pull request whose merge object was missing
 * produced no record at all, and three of 810 vanished from per-item attribution
 * without a line of output.
 */
export type BranchRecord = AvailableBranch | UnavailableBranch;

/** Self-reported GitHub profile fields. Suggestion input for `audit` only. */
/**
 * `links` are URLs the person published on their own GitHub profile — the
 * `websiteUrl` field plus every entry in `socialAccounts`. They are recorded
 * because a link someone puts on their own profile is self-reported identity: it
 * is the person asserting "this other account is also me". That is categorically
 * different from a third party matching a display name on another platform, and
 * only the former can be walked without guessing.
 *
 * Like `company`, none of this is ever consumed automatically — it feeds `audit`
 * suggestions and a human decides.
 */
export type Profile = {
  name?: string | null;
  company?: string | null;
  location?: string | null;
  bio?: string | null;
  links?: string[];
};

/**
 * One named seat under one MAINTAINERS.md heading, verbatim. Vacancies are not seats.
 *
 * `name` and `company` are ALL the source offers -- no email, no login -- which
 * is why this type carries no person id. A seat reaches a contributor only
 * through that contributor's exact `rosterNames` alias.
 *
 * `company` is the roster's own text ("Google", "Shopify"). It is deliberately
 * NOT reconciled against orgs.json5 or used to derive affiliation: a person's
 * employer at the date they contributed is measured elsewhere, and a roster that
 * is updated by election would silently rewrite history if it were consulted.
 */
export type CouncilSeat = {
  name: string;
  company: string;
  council: string;
  /** The name carried the source's trailing `*`. Its meaning is the source's footnote. */
  marked: boolean;
};

/** raw/council.json, as written by pull-council. */
export type RawCouncil = {
  source: { repo: string; file: string; sha: string; at: string };
  /** Every `##` heading carrying a roster table, in source order — including all-vacant ones. */
  councils: string[];
  seats: CouncilSeat[];
};
