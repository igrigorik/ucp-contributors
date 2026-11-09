// Vocabulary shared by the pipeline and the site.
//
// Lives under site/ for one hard reason: `serve.ts` serves site/ as the web
// root, so this is the only place a module can sit and still be reachable by
// BOTH a browser `import` and a Bun script. The direction of the dependency is
// deliberate — these are the definitions of what ships, and `verify` asserts
// against the same list the view renders from, so neither can drift alone.
//
// Strictly side-effect-free: no DOM access, no listeners, no top-level work.
// `site/lib.js` registers scroll and resize listeners at import time, which made
// importing it from a script depend on Bun happening to define `addEventListener`
// — a real coupling that the split removes.

/**
 * Organization ids that are honest answers rather than employers.
 *
 * `unknown` means we never established one, `undisclosed` means the person is
 * public but their employer is not, `independent` means they contribute in a
 * personal capacity, and `bot` is not a person at all. None of them is
 * attribution, so none may enter the attributed numerator — otherwise coverage
 * inflates purely by relabelling ignorance.
 *
 * Was defined in four places (derive as an inequality chain, verify, audit and
 * app.js) and had already diverged: audit deliberately uses a two-element
 * subset, which is correct there but was indistinguishable from an omission.
 * ASSIGNABLE names the subset a human may actually write into contributors.json5.
 */
export const PSEUDO_ORGS = ["unknown", "undisclosed", "independent", "bot"];
export const ASSIGNABLE_PSEUDO = ["undisclosed", "independent"];
export const isAttributed = (org) => !PSEUDO_ORGS.includes(org);

/** Metrics measured from `git log` alone; present whether or not the overlay ran. */
export const GIT_FIELDS = ["commits", "coauthored", "added", "deleted", "files"];
/**
 * Metrics that exist only with the GitHub overlay.
 *
 * A PR has FOUR outcomes, not two: `proposed = open + landed + declined +
 * withdrawn`. Each split was the same discovery twice over.
 *
 * An earlier boolean lumped pending PRs together with declined ones, which is the
 * difference between "nobody has ruled" and "the answer was no". `withdrawn` then
 * split `declined`, which had been lumping an author taking back their own work
 * together with a maintainer rejecting it — 118 of 246 closed pull requests here
 * are the first kind, and while they sat in `declined` the acceptance rate
 * counted them as rejections of their own authors.
 */
export const GH_FIELDS = [
  "proposed", "landed", "open", "declined", "withdrawn", "reviews", "comments",
  "issues",
];

/**
 * Every event kind the pipeline emits, with the metric it aggregates into.
 *
 * One ordered list with three consumers: the activity-log filter, `verify`'s
 * per-kind reconciliation, and the log's own labels. Previously the filter
 * options lived in app.js and the kind→field mapping in verify.ts, so a new kind
 * would reconcile correctly in verify, be counted in the log's "all (N)", and
 * be missing from the filter that claims to list every kind — a filter hiding
 * its own alternatives.
 *
 * Many-to-one is intended: timeline and inline comments are separate acts and
 * one metric, because a reviewer with inline comments and no timeline comments
 * was otherwise rendered as having said nothing.
 *
 * `label` is omitted where the kind name already reads correctly in a sentence.
 */
export const EVENT_KINDS = [
  { kind: "commit", field: "commits" },
  { kind: "coauthored", field: "coauthored", label: "co-authored" },
  { kind: "proposed", field: "proposed", label: "opened PR" },
  { kind: "review", field: "reviews" },
  { kind: "reviewcomment", field: "comments", label: "inline comment" },
  // A review's own prose. GitHub wraps two different acts in one object: a
  // design-level critique is a body with no children, a line-level review is an
  // empty shell around N inline comments. We already flatten the second into
  // 1 review + N `reviewcomment` rows, so the first flattens the same way into
  // 1 review + 1 of these -- the body is simply a child of a different type.
  // Counting only the children made the design-level review invisible.
  { kind: "reviewnote", field: "comments", label: "review note" },
  { kind: "comment", field: "comments" },
  { kind: "issue", field: "issues", label: "filed issue" },
];

/**
 * Ordered plan for the metric columns: which appear, in what order, grouped how.
 *
 * The axis is initiating versus engaging, not object type. `proposed` and
 * `issues` are both acts of starting something; `reviews` and `comments` are
 * both acts of responding to someone else's. Grouping by object instead would
 * have split the two comment sources and produced a contradiction the moment
 * both existed. Authorship comes last for the reason recorded on GROUPS in
 * app.js — in a specification project what someone proposed and reviewed
 * carries more signal than commit count.
 *
 *   kid      partitions the column to its left. landed + open + declined +
 *            withdrawn equal proposed exactly in every derived row, so the four
 *            share a top rule marking them as parts rather than peers.
 *            `proposed` sitting OUTSIDE that rule is what identifies it as the
 *            sum, and `verify` asserts the identity from COL_PLAN itself.
 *   derived  a rate, not a measured field, and therefore excluded from COLS.
 *            `accepted` cannot be a row's only nonzero value — it has no meaning
 *            without landed and declined beside it — so the blank-row contract
 *            below does not apply to it.
 *
 * `engaged` carries no sub-structure because `comments` deliberately spans both
 * objects. A ragged tree is honest; forcing an object level would have required
 * re-splitting a metric that was merged precisely so a reviewer with inline
 * comments and no timeline comments stopped rendering as having said nothing.
 */
export const COL_PLAN = [
  { f: "proposed",   group: "initiated" },
  { f: "landed",     group: "initiated", kid: true },
  { f: "open",       group: "initiated", kid: true },
  { f: "declined",   group: "initiated", kid: true },
  { f: "withdrawn",  group: "initiated", kid: true },
  { f: "accepted",   group: "initiated", derived: true },
  { f: "issues",     group: "initiated" },
  { f: "reviews",    group: "engaged" },
  { f: "comments",   group: "engaged" },
  { f: "commits",    group: "authored" },
  { f: "coauthored", group: "authored" },
  { f: "added",      group: "authored" },
];

/**
 * Candidate metric columns, derived from the plan so order has one definition.
 *
 * `verify` asserts against this: a curated column set can silently delete
 * people, and the only way to catch that is for the checker and the view to read
 * the same list.
 *
 * The curation rule is NOT "drop the boring metrics". It is: **every metric that
 * can be a row's only nonzero value must appear.** `issues` was once excluded as
 * scan-view noise, which was true of issues filed alongside other work and false
 * of the 16% of contributors whose sole contribution is a filed issue — those
 * rows rendered completely blank and read as "this person did nothing", which is
 * worse than a wide table. `files`, `lines −` and the like stay out because they
 * are derived from commits and cannot stand alone.
 *
 * Callers filter this against the FIELDS actually present in summary.json, so an
 * absent metric is omitted rather than shown as zero.
 */
export const COLS = COL_PLAN.filter((c) => !c.derived).map((c) => c.f);

/**
 * Does a self-reported profile company say the same thing as the recorded org?
 *
 * Containment either way, on alphanumerics only, because the disagreements worth
 * a reader's attention are categorical, not cosmetic. "Google Inc.", "Google UK"
 * and "Google DeepMind" against `Google`, "Klarna Bank AB" against `Klarna`,
 * "@levrofin" against `Levro`, "https://zeepcode.group" against `Zeepcode` — 116
 * of the 124 hints on file are variants of this shape, and rendering "profile
 * says Google" directly beneath "Google" is duplication, not evidence.
 *
 * It deliberately does NOT try to be clever. A profile naming a second employer
 * alongside the recorded one ("DemandOps, Eccasion") reads as agreement here,
 * which is the acceptable direction to be wrong: a missed nuance costs a reader
 * nothing, while a false contradiction on a public page costs the contributor.
 */
export const sameOrg = (profile, orgName) => {
  const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const a = norm(profile), b = norm(orgName);
  return !!a && !!b && (a.includes(b) || b.includes(a));
};

/**
 * Show the profile-company hint only where it carries information the page does
 * not already state.
 *
 * Unattributed pages get it for free and need no clause of their own: no real
 * company name contains "Independent", "Undisclosed", "unknown" or "Automation",
 * so a pseudo-org can never read as agreement. An explicit `!isAttributed(org)`
 * leg was written first, measured against all 300 people, found to change
 * nothing, and deleted — the test that covered it could not fail either way.
 */
export const hintWorthShowing = (profileCompany, orgName) =>
  !!profileCompany && !sameOrg(profileCompany, orgName);
