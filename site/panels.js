// The stat panels that sit above every table: three metric groups, each with a
// lead count, its breakdown, and one derived note.
//
// Takes `fields` (what derive actually measured) and `summary` (the project
// totals a share divides by) as arguments rather than importing them, so this
// module holds no page state and a test can render a panel from a fixture.
import { el, fmt, heading, pct } from "./lib.js";

/**
 * Acceptance rate over DECIDED PRs only: landed / (landed + declined).
 *
 * Two exclusions, for two different reasons, and the shape of the formula hides
 * both — so they are stated here.
 *
 * OPEN pull requests are excluded because counting them against an author lets
 * slow review masquerade as low quality: with open PRs in the denominator a small
 * contributor here reads as 17%, and 50% without, purely because four of six
 * proposals have never been ruled on.
 *
 * WITHDRAWN pull requests are excluded because they are not a verdict at all, and
 * this is a newer fix than it looks. They used to live inside `declined`, so an
 * author who opened a pull request, thought better of it and closed it themselves
 * was recorded as having been REJECTED. 118 of 246 closed pull requests here are
 * that case, and the project-wide rate read 71.5% when the honest figure is
 * 82.8%. The formula did not change; `declined` stopped lying.
 *
 * The denominator ships with the number so "100% (2)" cannot pass itself off as
 * "100% (200)".
 */
export const acceptance = (r) => {
  const decided = (r.landed ?? 0) + (r.declined ?? 0);
  return { decided, pct: decided ? (r.landed / decided) * 100 : null };
};

/** "1 commits" reads as a bug in the renderer even when the number is right. */
export const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);

/**
 * Metric groups, replacing a flat row of undifferentiated boxes.
 *
 * Three tiers, deliberately distinct, because the flat version rendered all of
 * them at identical weight:
 *
 *   lead   the headline count for the group
 *   rows   real counts that break the lead down, or sit beside it
 *   note   a DERIVED figure — a rate or a share, not a count
 *
 * Conflating `rows` and `note` was the readability bug: "17.2% of project" sat
 * mid-stack among "+53,510 added" as though a percentage of the project were the
 * same kind of thing as a line count. Every group now carries exactly one note,
 * in the same slot, which is what surfaced the missing review share.
 *
 * Order is editorial. In a specification project what someone proposed and what
 * they reviewed carries more signal than how many commits they landed, so
 * authorship comes last.
 *
 * `need` gates the whole group: when the overlay was never pulled, the proposed
 * and reviewed groups disappear instead of rendering zeros. That is the
 * yankability guarantee expressed at the presentation layer.
 *
 * `holds` is a different question — need asks "did we measure this family",
 * holds asks "did this scope do any of it". Conflating them would hide a genuine
 * measured zero behind the same silence we use for unmeasured data.
 *
 * Every ROW carries its own `need` for the same reason the group does: `fmt`
 * renders an absent field as the empty string, so an ungated row printed a label
 * with no number beside it — an unmeasured metric shown as nothing at all,
 * which is the mirror image of the zero this page refuses to print. A row with
 * no `need` is dropped rather than guessed at, so the list stays exhaustive.
 */
export const GROUPS = [
  {
    // "initiated", not "proposed": the group holds two different objects, and
    // you file an issue rather than propose one. Naming the ACT rather than one
    // of its objects is also what lets the column beneath keep the label
    // `proposed` without the group echoing it.
    title: "initiated", need: "proposed", holds: ["proposed", "issues"], none: "none opened",
    lead: (r) => [fmt(r.proposed), plural(r.proposed, "pull request")],
    rows: (r) => [
      { v: fmt(r.landed), k: "landed", need: "landed" },
      { v: fmt(r.open), k: "open", need: "open" },
      { v: fmt(r.declined), k: "declined", need: "declined" },
      // Its own row rather than folded into `declined`, because it is the one
      // outcome here nobody else decided. Withdrawing your own work is often good
      // practice — superseded by a better pull request, most often — so this is
      // not a demerit, and it is excluded from the acceptance rate below.
      { v: fmt(r.withdrawn), k: "withdrawn", need: "withdrawn" },
      // Filing an issue initiates; it does not engage with anything. This row
      // sat under the reviewing group from the start, which put raising a
      // problem in the same bucket as answering one. It comes after the three
      // states because those partition the lead and this is a sibling of it.
      { v: fmt(r.issues), k: `${plural(r.issues, "issue")} filed`, need: "issues" },
    ],
    // "of 123 decided" was coined vocabulary that read as a fragment. The
    // headline stays plain; the definition and the denominator move to hover,
    // which is where a derived figure should explain itself.
    note: (r) => {
      const { decided, pct } = acceptance(r);
      // "no verdict yet" was coined vocabulary for a plain condition: nothing has
      // landed and nothing has been declined, so the ratio has no denominator.
      if (pct == null) {
        return { text: "none resolved yet",
                 help: `All ${fmt(r.open)} are still open. Nothing has landed or been ` +
                       `declined, so there is no acceptance rate to report — which is ` +
                       `not the same as an acceptance rate of zero.` };
      }
      return {
        text: `${pct.toFixed(0)}% accepted`,
        help: `${fmt(r.landed)} of ${fmt(decided)} resolved pull requests landed. ` +
              `The ${fmt(r.open)} still open are excluded: a pending review is not a rejection.`,
      };
    },
  },
  {
    // "engaged", not "reviewed": two thirds of the people counted here never
    // submitted a formal review. 132 commented without reviewing, against 8 who
    // reviewed without saying anything, so naming the group after the narrower
    // of its two acts described a minority of its own membership.
    title: "engaged", need: "reviews", holds: ["reviews", "comments"], none: "none",
    lead: (r) => [fmt(r.reviews), plural(r.reviews, "pull request")],
    rows: (r) => [
      { v: fmt(r.comments), k: plural(r.comments, "comment"), need: "comments",
        help: "Timeline and inline comments. Not a subset of the reviews above: " +
              "73% of reviews carry no inline comment, and 747 inline comments sit " +
              "on pull requests their author never formally reviewed." },
    ],
    // Sitting beside the commit share, this answers whether a group reviews more
    // than it writes — the question the project-level numbers made interesting.
    note: (r, { project, summary }) => project
      ? {
          text: `${summary.github.coverage.pct}% of human reviews attributed`,
          help: `${summary.github.coverage.pct}% of ${fmt(summary.github.coverage.human)} reviews by ` +
                `humans are mapped to an organization. Unattributed means the reviewer is not yet in ` +
                `data/contributors.json5, not that they have no employer. Bot reviews are excluded.`,
        }
      : {
          text: `${pct(r.reviews, summary.totals.reviews)} of project reviews`,
          help: `${fmt(r.reviews)} of ${fmt(summary.totals.reviews)} reviews across all repositories. ` +
                `Compare with the commit share to see whether this scope reviews more than it writes.`,
        },
  },
  {
    title: "authored", need: "commits", holds: ["commits", "coauthored"], none: "no commits",
    lead: (r) => [fmt(r.commits), plural(r.commits, "commit")],
    // Additions and deletions belong together, but as two rows rather than one
    // "+53,510 -17,651" string: combined, it is wide enough to stretch the
    // numeric column and strand the lead number away from its label.
    /**
     * Co-authorship sits ABOVE the rule, with the size stats below it.
     *
     * It is a different kind of number: added/removed/files describe how big
     * this scope's commits were, while co-authored counts commits it helped
     * write but is not the recorded author of. Rendering it as a fourth size
     * stat made a metric that recovers 151 lost credits read as noise.
     *
     * Position and weight carry the distinction; the tooltip states outright
     * that these are disjoint from the lead count rather than a subset of it.
     */
    rows: (r) => [
      r.coauthored > 0 && {
        v: fmt(r.coauthored), k: "co-authored", cls: "kin", need: "coauthored",
        help: "Commits where this scope appears in a Co-authored-by trailer but is " +
              "not the recorded author — squash-merge credits only one. Counted " +
              "separately, never added to the commit total, so the commit column " +
              "still sums to exactly what git log reports.",
      },
      { v: `+${fmt(r.added)}`, k: "added", need: "added" },
      { v: `\u2212${fmt(r.deleted)}`, k: "removed", need: "deleted" },
      { v: fmt(r.files), k: `${plural(r.files, "file")} touched`, need: "files" },
    ].filter(Boolean),
    note: (r, { project, summary }) => project
      ? {
          text: `${summary.coverage.pct}% of human commits attributed`,
          help: `${summary.coverage.pct}% of ${fmt(summary.coverage.human)} commits by humans are mapped ` +
                `to an organization. Unattributed means the author is not yet in ` +
                `data/contributors.json5, not that they have no employer. Bot commits are excluded.`,
        }
      : {
          text: `${pct(r.commits, summary.totals.commits)} of project commits`,
          help: `${fmt(r.commits)} of ${fmt(summary.totals.commits)} commits across all repositories. ` +
                `Counts landed authorship only; it says nothing about the size or significance of each change.`,
        },
  },
];

/**
 * A group whose every number is zero collapses to one muted line. Contributors
 * whose whole contribution is review labour otherwise get ten rows of zeros
 * around the three rows that matter - and they are precisely the people the
 * overlay exists to make visible.
 *
 * Collapsed, not hidden: "no commits" is a measurement, and dropping the group
 * silently would make it indistinguishable from a family we never measured.
 */
export const statGroups = (r, { fields, summary, project = false, sectionHref = null }) => {
  const num = (v) => el("span", { class: "v" }, v);
  // `help` hangs off the LABEL span, not the row: .row is display:contents so it
  // generates no box, and a ::after tooltip on it would silently never render.
  const lbl = (k, help) =>
    el("span", { class: help ? "k help" : "k", "data-help": help ?? null, tabindex: help ? "0" : null }, k);

  return el("div", { class: "groups" },
    GROUPS.filter((g) => fields.includes(g.need)).map((g) =>
      el("section", { class: "group" },
        heading(g.title, { id: `stat-${g.title}`, href: sectionHref?.(`stat-${g.title}`) ?? null, level: "h3" }),
        g.holds.every((f) => !r[f])
          ? el("p", { class: "none" }, g.none)
          : el("div", { class: "group-body" },
              el("div", { class: "rows" },
                el("div", { class: "row lead" }, num(g.lead(r)[0]), lbl(g.lead(r)[1])),
                g.rows(r).filter((row) => fields.includes(row.need))
                  .map(({ v, k, cls, help }) =>
                    el("div", { class: ["row sub", cls].filter(Boolean).join(" ") },
                      num(v), lbl(k, help)))),
              (({ text, help }) => el("p", { class: "note" },
                el("span", { class: "help", "data-help": help, tabindex: "0" }, text),
              ))(g.note(r, { project, summary }))))));
};
