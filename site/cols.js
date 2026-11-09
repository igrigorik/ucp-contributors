// Metric columns for the scan-the-table views.
//
// `cols` (the metrics that actually have a column here) and `metric` (the one
// the reader selected) arrive as arguments rather than being read off page
// state, so a column set can be built and asserted without a page around it.
import { el, fmt, pct } from "./lib.js";
import { COL_PLAN } from "./vocab.js";
import { COL_HELP, COL_LABEL } from "./labels.js";
import { acceptance } from "./panels.js";

export const acceptCol = () => ({
  key: "accepted", label: "accepted", n: true,
  // At 349 characters this rendered six lines deep and was the largest thing on
  // the page obscuring the numbers it described. Two cuts, no loss: the sentence
  // explaining why open pull requests are excluded now lives on the `open`
  // column that owns it, and the ratio states itself more briefly than it reads.
  // The Simpson's-paradox guard stays in full — it was moved here from a
  // paragraph under the table precisely so it sits against the column it warns
  // about, and it guards an inversion measured in this data.
  help: "landed / (landed + declined) — open and withdrawn pull requests " +
        "excluded: neither is a verdict. Bracketed: the denominator. " +
        "Never read one blended rate as a finding: it spans repositories with " +
        "different stakes and reviewer pools. Open an organization for the " +
        "per-repository split.",
  sortKey: (r) => acceptance(r).pct ?? -1,
  cell: (r) => {
    const { decided, pct } = acceptance(r);
    return pct == null
      // NA, not 0% — an undefined ratio and a rejected pull request are different
      // facts and must not share a rendering.
      ? el("span", { class: "tag" }, "NA")
      : el("span", {}, `${pct.toFixed(0)}% `,
          el("span", { class: "muted" }, `(${decided})`));
  },
});

/**
 * Numeric columns for the curated set, in COL_PLAN order and carrying its groups.
 *
 * `active` is the column in focus: the one drawn with a bar and, given `share`, an
 * inlined proportion. It is the table's own sort key, resolved by the caller (see
 * `focus()` in app.js) rather than read from a control of its own. It may be null,
 * for a table ordered by a name or by a derived rate — neither of which is a share
 * of anything — in which case no column is emphasised.
 *
 * `share` inlines the proportion INTO the active column's own cell as a dimmed
 * `NN (P%)`, replacing a standalone `share` column. That column was a figure
 * floating several columns away from its own numerator, so it needed a marker on
 * the active header purely to stop readers attributing the percentage to whichever
 * column carried the sort arrow. Its sortKey was also byte-identical to the active
 * column's, so it was a redundant sort target. Attaching the number to its base
 * removes the ambiguity rather than annotating it, and follows the convention
 * `accepted` already set: primary value first, derived context in parentheses.
 *
 * The consequence to know: the table's width varies slightly with which column is
 * sorted, since the focused column widens. That is a re-render on an explicit user
 * action, and the worst case is inside budget.
 *
 * `accepted` is spliced by the plan rather than appended by callers, because it
 * must sit against the states it divides, not at the far right of the table.
 *
 * The option bag is annotated because TypeScript infers a JS destructure's type
 * from the properties that carry DEFAULTS: without this, `cols` and `metric`
 * vanish from the inferred signature and `share` narrows to `null`, so a caller
 * passing either was a type error in a file that is otherwise correct.
 *
 * @param {object} [o]
 * @param {string[]} [o.cols]   metric fields to render, filtered against COL_PLAN order
 * @param {string | null} [o.active] the focused column, drawn with a bar and its share
 * @param {(row: any, field: string) => number} [o.scope] reads a field, optionally repo-scoped
 * @param {{ of?: string, help?: string, total: (row: any) => number } | null} [o.share]
 *        inlines `NN (P%)` into the active cell. `of` names the whole in the
 *        default help sentence; `help` replaces that sentence outright, for a
 *        denominator that is not simply "the whole X" — see the review share on a
 *        person's page, which divides by what they were ELIGIBLE to review.
 * @param {boolean} [o.accepted] splice in the derived `accepted` rate column
 */
export const metricCols = ({
  cols = [], active: activeKey = null, scope = (r, f) => r[f], share = null, accepted = false,
} = {}) =>
  COL_PLAN
    .filter((c) => (c.f === "accepted" ? accepted : cols.includes(c.f)))
    .map((c) => {
      if (c.f === "accepted") return { ...acceptCol(), group: c.group };
      const active = c.f === activeKey;
      const val = (r) => scope(r, c.f);
      return {
        key: c.f, label: COL_LABEL[c.f], n: true, group: c.group, kid: c.kid,
        bar: active, cls: active ? "active-metric" : null,
        help: active && share
          ? [COL_HELP[c.f],
             share.help ?? `Bracketed: this scope's share of the whole ${share.of}.`]
              .filter(Boolean).join(" ")
          : (COL_HELP[c.f] ?? null),
        sortKey: val,
        cell: active && share
          ? (r) => [fmt(val(r)), el("span", { class: "sh" }, ` (${pct(val(r), share.total(r))})`)]
          : (r) => fmt(val(r)),
      };
    });
