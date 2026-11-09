// Display names and definitions for the measured fields. Pure reference data:
// no state, no DOM, no imports — so a view, a column and a panel can all read
// the same name for the same number without one of them owning the vocabulary.

// Column labels carry their own semantics, because a bare "merged" reads as
// "PRs this person merged" (maintainer authority) when it actually means "their
// PRs that got merged" (outcome). Pairing "opened" with "reviewed" and placing
// "of those, merged" adjacent makes the subset relationship self-evident.
export const LABEL = {
  commits: "commits", coauthored: "co-authored", added: "lines +", deleted: "lines −",
  files: "files touched",
  proposed: "proposed", landed: "landed", open: "open", declined: "declined",
  withdrawn: "withdrawn",
  reviews: "PRs reviewed", comments: "comments", issues: "issues filed",
};

// Column headers are scanned; prose is read. Where a metric's prose name is a
// noun phrase, the header only needs the distinguishing word — the surrounding
// columns already establish that the subject is pull requests. Kept as an
// override rather than renaming LABEL, because LABEL also feeds sentences like
// "36 organizations · 1,489 PRs reviewed" where the short form reads as nonsense.
// Shortened under a group header that already supplies the qualifier: "issues"
// under INITIATED can only mean issues opened, and the two abbreviations pay for
// the widened active-metric cell. Not shortened to the point of needing the
// group row to disambiguate them, because only the column row is sticky — every
// label here must still stand alone once the group row has scrolled away.
export const COL_LABEL = { ...LABEL, reviews: "reviewed", coauthored: "co-auth", issues: "issues" };

// Definitions that a column header cannot carry in three words. These are the
// structural facts a reader cannot recover from the numbers: what partitions
// what, and what is NOT a subset of what.
// Each entry states ONE thing a reader cannot get from the number, in at most
// two rendered lines. Kept deliberately short: a four-line definition is an
// overlay the size of a paragraph, and the evidence behind these claims belongs
// in README.md, not in a hover box on a stats page.
export const COL_HELP = {
  proposed: "Pull requests opened. Landed, open, declined and withdrawn sum to this.",
  landed: "Their pull requests that were merged — not ones this scope merged for others.",
  open: "Awaiting a verdict. A pending review is not a rejection.",
  declined: "Closed without merging, excluding author withdrawals. Includes closures with an unknown actor.",
  // States what it is NOT, because the number is easy to read as a demerit and
  // is often the opposite: the commonest case here is a pull request superseded
  // by a better one from the same person.
  withdrawn: "Closed by its own author. Not a rejection, and not counted in accepted.",
  issues: "Issues filed. An issue has no landed or declined state.",
  reviews: "Distinct pull requests reviewed. Repeat rounds count once; self-reviews excluded.",
  comments: "Timeline comments, inline comments and non-empty review bodies. " +
            "Includes replies on the author’s own items.",
};
