// DOM + sortable-table helpers. No framework, no build step.
//
// Registers scroll and resize listeners at import time, so this module is for
// the browser only. Everything a Bun script needs lives in vocab.js, which is
// side-effect-free precisely so nothing outside the browser has to import this.

export const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return n;
};

/** Build a section permalink without losing this view's filters or sort. */
export function sectionHref(hash, id) {
  const raw = hash.replace(/^#\/?/, "");
  const cut = raw.indexOf("?");
  const path = (cut < 0 ? raw : raw.slice(0, cut)) || "orgs";
  const params = new URLSearchParams(cut < 0 ? "" : raw.slice(cut + 1));
  params.set("section", id);
  return `#/${path}?${params}`;
}

/**
 * Shared h2/h3 structure. Typography belongs to CSS roles, not individual views.
 * @param {string | Node} title
 * @param {{id?: string | null, href?: string | null, level?: "h2" | "h3", class?: string}} [options]
 */
export function heading(title, { id = null, href = null, level = "h2", class: extra = "" } = {}) {
  return el(level, { class: ["section-heading", extra].filter(Boolean).join(" "), id },
    href ? el("a", { class: "heading-anchor", href, title: "Link to this section" },
      title, el("span", { class: "anchor-icon", "aria-hidden": "true" })) : title);
}

export const fmt = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : (n ?? ""));
export const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");

/**
 * Sortable tables sharing one sort store, keyed by the view name each table
 * passes in.
 *
 * The store lives here rather than in the caller because a caller-owned sort
 * object has to name its key TWICE at each of the ten call sites — once to read
 * it (`sortFor(`org-repos:${id}`)`) and once to write it back
 * (`state.sort[`org-repos:${id}`] = st`). Mistype one and the table reads key A
 * and writes key B, so sorting silently never sticks: a bug class that exists
 * only because the key is named twice. Here the caller names it once and both
 * halves resolve it.
 *
 * `rerender` is taken once, at wiring time, rather than per call: every call site
 * otherwise passes the same `render` in the same closure.
 *
 * Returned as a factory rather than a module singleton so a test gets its own
 * store and cannot be ordered into another test's sort state.
 *
 * columns: { key, label, n?, bar?, cls?, help?, group?, kid?, cell?(row), sortKey?(row) }
 *   n     — numeric: right-aligned, tabular figures, sorts descending first
 *   bar   — draw a proportional in-cell bar (share of the column max)
 *   cls   — extra class on header and cells, e.g. to mark the active metric
 *   help  — definition surfaced on hover, so a derived column can carry its own
 *           meaning instead of relying on a page-level caveat block
 *   group — label for a second header row spanning adjacent columns that share
 *           it. Omitted on every column means no group row at all, which is how
 *           the activity log stays a plain table.
 *   kid   — this column partitions the one to its left. Drawn as a top rule
 *           that fuses across adjacent siblings, so a sum and its parts are
 *           distinguishable without a third header row.
 *
 * `sortKey` is the single source of truth for a column's numeric value: it
 * feeds sorting AND bar widths. Reading `row[key]` for bars instead was wrong
 * for any column whose displayed value is computed (e.g. repo-scoped metrics),
 * drawing a project-wide bar beside a repo-scoped number.
 *
 * `dflt` must name a column: falling back to "first numeric column" silently
 * sorted a wide table by its leftmost column instead of by its total. It doubles
 * as the heal target for a sort key that names nothing here — see the resolver
 * below for the two ways that happens and why healing beats throwing.
 *
 * Sort itself is NOT held here. It lives in `?s.<table>=`, read on every render,
 * so the address bar and the header arrow cannot disagree.
 */
/**
 * @typedef {object} Column
 * @property {string} key
 * @property {string} label
 * @property {boolean} [n]        Numeric: right-aligned, mono, never wrapped.
 * @property {boolean} [bar]      Render an in-cell proportion bar.
 * @property {string}  [cls]
 * @property {string}  [group]    Column group; adjacent columns sharing one merge.
 * @property {string}  [help]     Tooltip text.
 * @property {boolean} [kid]
 * @property {(r: any) => any}    [cell]    Rendered content.
 * @property {(r: any) => string} [text]    String for display AND search.
 * @property {(r: any) => any}    [sortKey] Value to sort by.
 *
 * @typedef {object} TableOptions
 * @property {string | Node} [title] Heading content, beside the filter on the control bar.
 * @property {{key: string, dir?: number}} [dflt]
 * @property {(r: any) => string | null}   [rowCls]
 * @property {any[]}                       [controls]
 * @property {(shown: any[]) => string | null} [note]
 * @property {(r: any) => string}          [sections] Row section label.
 * @property {(r: any) => string}          [rowKey]   Stable row identity; enables picking.
 *
 * `Query` is the whole of this module's knowledge of the URL: a namespaced
 * per-table key/value pair. `ns` is "q" for search text and "s" for sort, so
 * adding URL-backed state needs no new plumbing and cannot invent a second
 * naming scheme for a table.
 *
 * @typedef {{get: (ns: string, id: string) => string | undefined,
 *            set: (ns: string, id: string, value: string) => void,
 *            sectionHref?: (id: string) => string}} Query
 *
 * These are declared because the option callbacks are OPTIONAL with `null`
 * defaults, and TypeScript infers a destructured `sections = null` as type
 * `null` — so every callback a caller passed was, from the checker's point of
 * view, an error, and the first test to pass one was the first thing to notice.
 * Typed here rather than cast away at the call site: the callbacks are the part
 * of this signature most worth checking.
 *
 * The ROW parameter stays `any` on purpose. Rows are eleven different shapes
 * across the views, and a concrete type here is contravariant with every one of
 * them: a callback declared `(r: {commits: number})` is not assignable to one
 * declared over an index signature. What is worth checking is that a callback is
 * a function returning the right kind of thing, and that survives.
 *
 * @param {() => void} rerender
 * @param {Query | null} [query]
 */
export function tableFor(rerender, query = null) {
  /**
   * Decode `?s.<table>=` into a column key and a direction.
   *
   * There is deliberately NO in-memory sort store. There used to be one, keyed by
   * table name and initialised with `??=`, and it was the whole reason a table
   * could sit sorted by one column while another control claimed a different one
   * was the subject: `??=` reads the default exactly once, so nothing that
   * happened later could move it. A second copy of a value the URL should own is
   * a second thing to disagree with.
   *
   * `-` prefix is descending, bare is ascending, absent is the caller's default.
   * Explicit in both directions because the natural direction is per column --
   * numbers descend, names ascend -- so a bare key could not have meant "the
   * obvious one" without the reader knowing which obvious one applied.
   */
  const readSort = (id) => {
    const raw = query?.get("s", id) ?? "";
    return { key: raw.replace(/^-/, ""), dir: raw.startsWith("-") ? -1 : 1, set: !!raw };
  };
  /** The encoded form of a column+direction, for comparing against the default. */
  const encode = (key, dir) => `${dir < 0 ? "-" : ""}${key}`;

  /**
   * Rows the reader has marked, per table. A highlighter pen, not a filter.
   *
   * The one piece of table state deliberately NOT in the URL. Search and sort are
   * addressable because they change what the page reports; marks change nothing
   * about the data, so putting forty row labels in a query string would be a
   * permalink to somebody else's pen marks.
   *
   * Keyed by a caller-supplied `rowKey` rather than an index or a DOM node,
   * because the whole point is surviving a re-sort and a search, both of which
   * rebuild the body from scratch. An index would also mis-address across routes
   * that share a table id (`org-people` is one id over different people), which
   * is the failure mode worth avoiding: highlighting a row the reader never
   * touched, silently. A stale KEY matches nothing, which is safe and visible.
   */
  const picks = {};

  /**
   * Columns may contain falsy entries: call sites gate an optional column with
   * `cond && col`, and they are filtered out below before spans are counted.
   * @param {(Column | false | null | undefined)[]} columns
   * @param {any[]} rows
   * @param {string} name
   * @param {TableOptions} [options]
   */
  return function table(columns, rows, name,
                        { title = null, dflt = { key: "commits", dir: -1 }, rowCls = null,
                          controls = [], note = null, sections = null, rowKey = null } = {}) {
    // The table's identity, shared by its search param, its sort param and its
    // marks. Two names for one table is the failure this codebase keeps
    // repeating: rename one and the other silently addresses nothing. The id
    // drops the scope suffix (`log:repo/ucp` -> `log`) because the scope is
    // already in the path, and a param carrying it twice would have two ways to
    // disagree.
    const id = name.split(":")[0];
    const sort = readSort(id);

    // Callers gate optional columns inline with `cond && col`, so drop the falsy
    // ones rather than making every call site filter.
    columns = columns.filter(Boolean);

    // Searching the PROSE columns only. A numeric column matches digits that
    // appear in no label a reader can see — typing "40" hitting a commit count
    // reads as a broken filter, not a clever one — and the prose/numeric split
    // already exists in these column definitions.
    //
    // `text` is the same accessor the cell renders from, so display and search
    // can never drift apart. Where a column has BOTH (a name that renders as a
    // link), `text` supplies the string and `cell` builds the element from it.
    const q = (query?.get("q", id) ?? "").trim().toLowerCase();
    if (q) {
      const prose = columns.filter((c) => !c.n);
      rows = rows.filter((r) => prose.some((c) => {
        const v = c.text ? c.text(r) : r[c.key];
        return v != null && String(v).toLowerCase().includes(q);
      }));
    }
    // Healing, not throwing, for a key that names no column here. Two ways to
    // arrive at one: a hand-edited URL, and a CONDITIONAL column vanishing under
    // the very sort that names it -- sort #/people by Organization, then pick an
    // organization, and that column is gone. Throwing aborted render() before
    // replaceChildren, freezing the DOM on the previous scope's rows under its
    // stale header: the reader saw a filtered page that was in fact showing all
    // 300 contributors, and every later keystroke threw too.
    //
    // The dead key is left in the URL rather than rewritten, which is the one
    // behaviour that changed when the store moved here. It is the better one: a
    // column that comes back when you clear the filter brings your sort back with
    // it, where the old in-place heal destroyed it permanently. Render must not
    // write the URL in any case -- setParam redraws, so healing by writing would
    // recurse.
    let col = sort.set && columns.find((c) => c.key === sort.key);
    let dir = sort.dir;
    if (!col) {
      col = columns.find((c) => c.key === dflt.key);
      // The caller's OWN default naming nothing is a programmer error, not a bad
      // URL, and it has caught a real bug once.
      if (!col) throw new Error(`default sort key "${dflt.key}" is not a column`);
      dir = dflt.dir ?? (col.n ? -1 : 1);
    }

    const get = col.sortKey ?? ((r) => r[col.key]);
    // Section order is the order the sections first appear in the rows, taken
    // AFTER the search and before the sort. Both halves of that are load-bearing:
    //
    //   after the search  a section the filter emptied is not in this list, so it
    //                     cannot render a label over no rows. That needs no
    //                     explicit guard, and a guard written for it was dead code.
    //   before the sort   the hierarchy is the author's, not a by-product of
    //                     whichever column the reader happens to have sorted.
    const order = sections ? [...new Set(rows.map(sections))] : null;
    // Sorted GLOBALLY and rendered per section below, which is what keeps rows
    // from sorting across a section: the body is assembled by partitioning on
    // `order`, so a row cannot be emitted outside its own run however the
    // comparator ranks it. An explicit section clause in this comparator was the
    // first attempt and it changed no output at all.
    //
    // Scoping matters because these sections are OVERLAPPING populations —
    // first-time plus returning authors sum to all pull requests, and so do the
    // per-repository rows. A single ranked list would sit a subset next to its own
    // superset and present them as peers.
    rows = [...rows].sort((a, b) => {
      const x = get(a), y = get(b);
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "number" ? x - y : String(x).localeCompare(String(y))) * dir;
    });

    const valueOf = (c) => c.sortKey ?? ((r) => r[c.key]);
    const max = {};
    for (const c of columns.filter((c) => c.bar)) {
      const v = valueOf(c);
      max[c.key] = Math.max(1, ...rows.map((r) => Number(v(r)) || 0));
    }

    // Group runs, in column order: a maximal span of adjacent columns sharing a
    // `group`. Leading ungrouped columns (the entity name and its companions)
    // form a run with no label. Spans are COMPUTED, never declared: a
    // hand-maintained colspan is a second definition of the column order and goes
    // stale silently the first time a column moves.
    const runs = [];
    for (const c of columns) {
      const last = runs[runs.length - 1];
      if (last && last.group === (c.group ?? null)) last.span++;
      else runs.push({ group: c.group ?? null, span: 1, first: c });
    }
    // A LABELLED run is one cell spanning its columns. An UNLABELLED run is one
    // cell per column, not a spacer with a colspan.
    //
    // The distinction exists because of the sticky first column below 1240px,
    // which pins `th:first-child` in every row of the head. The leading
    // ungrouped run covers the entity name plus its companions, so as a single
    // colspan it made that pinned cell 263px of opaque background in front of a
    // column that is 158px wide. The surplus 105px travelled with the scroll and
    // painted over the first group label, which read as "ATED" instead of
    // "INITIATED" — a header silently eating its own text.
    //
    // Splitting only the unlabelled runs keeps spans computed rather than
    // declared (see above) and is visually identical, because these cells are
    // empty either way.
    const grouphead = !runs.some((r) => r.group) ? null
      : el("tr", { class: "grouphead" }, runs.flatMap((r) => r.group
          ? [el("th", { colspan: String(r.span), class: "gstart" }, r.group)]
          : Array.from({ length: r.span }, () => el("th", {}))));
    // A vertical rule opens each group — orthogonal to the horizontal rule that
    // marks a partition (`kid`), so the two structures never collapse into one
    // ambiguous device. Membership is by identity, not index, so reordering
    // columns cannot silently move the rule.
    const gstart = new Set(runs.filter((r) => r.group).map((r) => r.first));

    const head = el("tr", {}, columns.map((c) =>
      el("th", {
        class: [c.n ? "n" : null, c.cls, c.kid ? "kid" : null, gstart.has(c) ? "gstart" : null,
                c.help ? "help" : null].filter(Boolean).join(" ") || null,
        "data-help": c.help ?? null,
        tabindex: c.help ? "0" : null,
        onclick: () => {
          // Re-clicking the RESOLVED column flips it; `sort.key` cannot be used
          // here because a healed sort still carries the dead key.
          const next = col === c ? -dir : (c.n ? -1 : 1);
          const v = encode(c.key, next);
          // Written to the URL, never to a local variable, and no rerender():
          // set() redraws, and the URL is what the redraw reads. Doing both would
          // render twice, the first time from the stale address bar. Writing the
          // default as empty deletes the parameter, so a table at its default sort
          // has exactly one canonical address.
          query?.set("s", id, v === encode(dflt.key, dflt.dir ?? -1) ? "" : v);
        },
      }, c.label, col === c
        ? el("span", { class: "ind" }, dir < 0 ? " ↓" : " ↑")
        : null)));

    // No `rowKey`, no picking -- stated rather than inferred. A key guessed from
    // the rendered text would break the moment the reader switched metric (the
    // columns change, so the text changes, so every mark silently vanishes), and
    // one guessed from the row index would mis-address across routes sharing a
    // table id. Both failures are silent. A missing declaration is not.
    const picked = rowKey ? (picks[id] ??= new Set()) : null;

    const renderRow = (r) => {
      const key = rowKey?.(r);
      const on = picked?.has(key) || false;
      return el("tr", {
        class: [rowCls?.(r), on ? "pick" : null].filter(Boolean).join(" ") || null,
        onclick: !rowKey ? null : (e) => {
          // Three things a click on a row can already mean, and picking must yield
          // to all of them:
          //
          //   a link      rows carry real navigation. Marking a row AND leaving
          //               the page is never what one click meant.
          //   a selection dragging across a cell to copy a number ends in a click
          //               on the row. Without this the act of reading a figure
          //               toggles a mark, which reads as the page fighting back.
          //   a control   nothing in a body row today, but a checkbox or button
          //               added later would otherwise be swallowed here.
          if (e.target?.closest?.("a, button, input, select, label")) return;
          // `globalThis`, not `window`: in a browser they are the same object, and
          // off one they are not -- `window.getSelection` throws where `window`
          // does not exist, which would take the whole render down.
          if (globalThis.getSelection?.()?.isCollapsed === false) return;
          if (on) picked.delete(key); else picked.add(key);
          rerender();
        },
      }, columns.map((c) => {
        // `text` sits between `cell` and the raw value: a computed string column
        // declares it once and gets both rendering and searching from it, so the
        // two cannot describe different things.
        const content = c.cell ? c.cell(r)
          : c.n ? fmt(r[c.key])
          : c.text ? c.text(r)
          : r[c.key];
        const cls = (extra) => [extra, c.cls, gstart.has(c) ? "gstart" : null]
          .filter(Boolean).join(" ") || null;
        if (!c.bar) return el("td", { class: cls(c.n ? "n" : null) }, content);
        const w = ((Number(valueOf(c)(r)) || 0) / max[c.key]) * 100;
        return el("td", { class: cls("n bar") },
          el("i", { class: "fill", style: `width:${w}%` }),
          el("span", { class: "v" }, content));
      }));
    };

    const body = sections
      ? order.flatMap((s) => [
          el("tr", { class: "sect" }, el("th", { colspan: String(columns.length) }, s)),
          ...rows.filter((r) => sections(r) === s).map(renderRow),
        ])
      : rows.map(renderRow);

    // Stated, never silent. A search that matches nothing otherwise renders a
    // header over an empty body, which reads as "this scope has no data" — the
    // same lie as printing an unmeasured metric as zero. The bar above stays
    // rendered for the same reason: a filter the reader cannot see is a filter
    // the reader cannot clear.
    const nomatch = q && !rows.length
      ? el("tr", {}, el("td", { class: "empty", colspan: String(columns.length) },
          `No match for \u201c${(query?.get("q", id) ?? "").trim()}\u201d.`))
      : null;

    // Every table carries its own search, so the control and the rows it filters
    // are produced by the same call and addressed by the same id. A view that
    // rendered the box itself could name a table the box does not filter.
    //
    // `data-focus` is per-table because focus is restored across the re-render by
    // querying that attribute and taking the first match: nine boxes sharing one
    // name would send the caret to the topmost table on every keystroke typed
    // into any of the others.
    //
    // Reuses `.controls`, which already lays out a row of picks with a trailing
    // search box, rather than inventing a second bar that would drift from it.
    //
    // The TITLE renders here, inside the bar, for the same reason the search box
    // does: it belongs to this table. Left to the views it was a loose `h2`
    // sibling, which put a 15px small-caps caption on one line and its filter on
    // the next, ~44px of empty page between a heading and the control it labels.
    // Two siblings at different depths cannot be made to share a row by CSS, so
    // the fix is structural rather than a negative margin measured against a
    // line-height that will move.
    //
    // Still an `h2`: it is the same heading in the document outline, and the
    // routes that have no table still emit their own.
    // Marked rows have no other affordance: nothing on an unmarked row says it can
    // be marked, and rows are not made to look clickable on purpose, because they
    // contain real links and a pointer cursor over 5,190 of them would promise
    // navigation this click does not perform. So the count doubles as the only
    // notice that the feature exists, and it appears exactly when there is
    // something to notice.
    //
    // It also supplies the bulk undo. Clicking a marked row unmarks it, which is
    // enough for one row and hopeless for twelve.
    //
    // Placed AFTER the search box rather than before it: the search box is the
    // control readers aim at, and an element that appears on first mark ahead of
    // it would shift the box sideways under the cursor.
    const marked = picked?.size
      ? el("button", { class: "marks", onclick: () => { picked.clear(); rerender(); } },
          `${fmt(picked.size)} marked \u00b7 clear`)
      : null;
    const bar = (title || query || controls.length || marked)
      ? el("div", { class: "controls bar" },
          title ? heading(title, { id, href: query?.sectionHref?.(id) ?? null }) : null,
          ...controls, el("span", { class: "spacer" }),
          query && el("input", {
            type: "search", placeholder: "filter\u2026",
            value: query.get("q", id) ?? "", "data-focus": `q.${id}`,
            oninput: (e) => query.set("q", id, e.target.value),
          }),
          marked)
      : null;

    // Wrapped so an over-wide table scrolls within its own box. Unwrapped, the
    // widest view pushed 248px past the viewport and scrolled the whole document
    // horizontally, dragging the header and nav sideways with it. The bar sits
    // OUTSIDE that wrapper so it does not scroll away from the table it filters.
    // Rendered HERE, from the rows that survived the search, because it counts
    // and totals them. Left in the view it read from the unfiltered set: `#/orgs`
    // searched down to one row still said "85 organizations" — a wrong number
    // with a plausible provenance, which is this project's worst failure mode.
    // Whoever owns the rows owns the count. Returning null renders nothing, so a
    // note can be conditional on what the search left behind.
    const notes = note?.(rows);

    return el("div", { class: "table", "data-table": id }, bar,
      el("div", { class: "tablewrap" },
        el("table", {}, el("thead", {}, grouphead, head), el("tbody", {}, body, nomatch))),
      notes ? el("p", { class: "note" }, notes) : null);
  };
}

/**
 * Marks each table whose header is currently pinned, so the tooltip can open
 * away from the viewport edge instead of behind it.
 *
 * This exists because a pinned header and an upward tooltip are individually
 * right and jointly broken: at `top: 0` the tooltip's whole box sits above the
 * viewport (measured — 86px tall, placed at y=-91, entirely invisible), and a
 * definition that silently fails to appear is the same class of defect as a
 * number that is silently wrong. Unpinned it opens upward over empty margin and
 * covers no data; pinned it must open downward, because down is the only
 * direction left.
 *
 * CSS cannot ask whether a sticky element is currently stuck. `@container
 * scroll-state(stuck: top)` is exactly this question and is too new to rely on,
 * and its absence would fail in the invisible direction. So the fact is measured
 * here and published as a class.
 *
 * `rect.top <= 0.5` is the test rather than a scroll-offset threshold because
 * sticky clamps the pinned element to exactly 0: the browser has already done
 * the arithmetic, including the group row's height, so nothing about the header
 * height needs restating here. Queries the DOM fresh on each tick rather than
 * holding references, so it survives the full re-render that every route change
 * and keystroke performs without any per-render wiring to forget.
 */
export function syncStuck() {
  for (const wrap of document.querySelectorAll(".tablewrap")) {
    const th = wrap.querySelector("thead tr:last-child th");
    if (th) wrap.classList.toggle("stuck", th.getBoundingClientRect().top <= 0.5);
  }
}

let stuckQueued = false;
const onScroll = () => {
  if (stuckQueued) return;
  stuckQueued = true;
  // rAF-coalesced: the handler reads layout, and doing that synchronously per
  // scroll event is the standard way to make scrolling janky.
  requestAnimationFrame(() => { stuckQueued = false; syncStuck(); });
};
addEventListener("scroll", onScroll, { passive: true });
addEventListener("resize", onScroll, { passive: true });

/** Roll rows up by a key, summing the given numeric fields. */
export function rollup(rows, keyOf, fields) {
  const out = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    let acc = out.get(k);
    if (!acc) out.set(k, (acc = { _key: k, ...Object.fromEntries(fields.map((f) => [f, 0])) }));
    for (const f of fields) acc[f] += Number(r[f]) || 0;
  }
  return [...out.values()];
}
