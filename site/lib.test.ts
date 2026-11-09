// Tests for the rendered arithmetic: the sums, shares, colspans and sort state
// the browser modules compute. These files hold every number the reader actually
// sees, so an error here is published as a fact about someone's contribution.
//
// The modules are plain ES modules loaded directly by the browser, so they are
// imported here as-is — no build step, no bundler, no transpilation. What they
// do need is a DOM, and Bun's happy-dom registrator is a dependency this project
// does not take. So the handful of DOM methods `el()` uses are implemented below
// and installed as globals BEFORE the modules load: static imports evaluate
// before any top-level code, hence the dynamic imports.
//
// Fixtures are deliberately fictional. Naming a real organization or person as
// the subject of a statistical example is a project rule, and it applies to test
// data too — a fixture gets read as an illustration.
import { expect, test } from "bun:test";

const SCROLLED: string[] = [];

// ------------------------------------------------------------- fake DOM

/** Everything `el()` touches, plus enough introspection to assert on the tree. */
class FakeNode {
  tag: string;
  text: string | null;
  className = "";
  attrs: Record<string, string> = {};
  kids: FakeNode[] = [];
  events: Record<string, Array<(e: unknown) => void>> = {};
  /**
   * Derived from the href attribute, exactly as a real anchor derives it, because
   * the router now REWRITES nav hrefs to carry the active metric. Holding `hash`
   * as an independent field let the two drift: a test could assert on a stale
   * `.hash` while the attribute the browser actually navigates by said something
   * else. For these hrefs the whole value is the fragment, so it is the href.
   */
  get hash() { return this.attrs.href ?? ""; }
  classes = new Set<string>();
  /** Only `toggle` is used, by the router's nav highlighting. */
  classList = {
    toggle: (c: string, on: boolean) => {
      if (on) this.classes.add(c); else this.classes.delete(c);
    },
  };

  constructor(tag: string, text: string | null = null) {
    this.tag = tag;
    this.text = text;
  }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(k: string, fn: (e: unknown) => void) { (this.events[k] ??= []).push(fn); }
  append(n: FakeNode) { this.kids.push(n); }
  scrollIntoView() { SCROLLED.push(this.attrs.id ?? "<missing id>"); }
  replaceChildren(...n: FakeNode[]) { this.kids = n; }
  set textContent(v: string) { this.kids = []; this.text = v; }
  get textContent() { return txt(this); }
  /** Fire a listener the way a user would; `el()` registers via `on*` keys. */
  fire(kind: string, ev: unknown = {}) {
    for (const fn of this.events[kind] ?? []) fn(ev);
  }
}

const els = new Map<string, FakeNode>();
const doc = {
  title: "",
  activeElement: null,
  createElement: (tag: string) => new FakeNode(tag),
  createTextNode: (t: string) => new FakeNode("#text", t),
  getElementById: (id: string) => {
    if (id === "view" || id === "sub") {
      if (!els.has(id)) els.set(id, new FakeNode("div"));
      return els.get(id)!;
    }
    return [...els.values()].flatMap((root) => walk(root)).find((n) => n.attrs.id === id) ?? null;
  },
  // syncStuck() asks for ".tablewrap", which has no answer without layout, and an
  // empty list is the honest one. "nav a" is different: the nav is static markup
  // in index.html, so it can be modelled exactly, and until it was the router's
  // highlighting was the one branch of render() no test could reach.
  //
  // Read the current nav children, matching the browser DOM.
  querySelectorAll: (sel: string) => (sel === "nav a" ? NAV_EL.kids : []) as FakeNode[],
  querySelector: (sel: string) => (sel === "nav" ? NAV_EL : null),
};

/** The static nav from index.html, in order. */
const NAV_EL = new FakeNode("nav");
for (const h of ["#/orgs", "#/repos", "#/people", "#/heartbeat", "#/governance"]) {
  const a = new FakeNode("a");
  a.setAttribute("href", h);
  NAV_EL.append(a);
}
const NAV = NAV_EL.kids;
const lit = () => NAV.filter((a) => a.classes.has("on")).map((a) => a.hash);

(globalThis as Record<string, unknown>).Node = FakeNode; // el() does `kid instanceof Node`
(globalThis as Record<string, unknown>).document = doc;
(globalThis as Record<string, unknown>).requestAnimationFrame = (fn: () => void) => fn();

/** Registered by lib.js (scroll/resize) and app.js (hashchange). */
const listeners: Record<string, Array<() => void>> = {};
(globalThis as Record<string, unknown>).addEventListener =
  (k: string, fn: () => void) => { (listeners[k] ??= []).push(fn); };

// -------------------------------------------------------------- helpers

/** Rendered text of a subtree, in document order. Cells may hold bare strings. */
const txt = (n: FakeNode | string): string =>
  typeof n === "string" ? n : (n.text ?? n.kids.map(txt).join(""));

const walk = (n: FakeNode, out: FakeNode[] = []): FakeNode[] => {
  out.push(n);
  for (const k of n.kids) walk(k, out);
  return out;
};
const all = (n: FakeNode, tag: string) => walk(n).filter((x) => x.tag === tag);
const first = (n: FakeNode, pred: (x: FakeNode) => boolean) => walk(n).find(pred);

/** thead/tbody of the single table inside a `.tablewrap`. */
const parts = (wrap: FakeNode) => {
  // Asserted rather than `!`-ed because every table test funnels through here: a
  // render that produced no table, or a table missing a section, should say which
  // of the three it was instead of surfacing as `undefined.kids` at whichever
  // call site happened to run first.
  const table = all(wrap, "table")[0];
  if (!table) throw new Error("no <table> inside the .tablewrap");
  const [thead, tbody] = table.kids;
  if (!thead || !tbody) throw new Error(`table has ${table.kids.length} sections, expected thead+tbody`);
  return { thead, tbody, headRows: thead.kids.filter(Boolean), bodyRows: tbody.kids };
};
const cells = (tr: FakeNode) => tr.kids.map(txt);

/** A header's own label, with the sort arrow the sorted column carries removed. */
const label = (th: FakeNode) => txt(th).replace(/\s*[\u2193\u2191]\s*$/, "");
const headCells = (wrap: FakeNode) => parts(wrap).headRows.at(-1)!.kids;
/** Column position by label, so a test names a column rather than an index. */
const colAt = (wrap: FakeNode, name: string) =>
  headCells(wrap).findIndex((c) => label(c) === name);
const valueAt = (wrap: FakeNode, tr: FakeNode, name: string) => {
  // A name that matches no header makes colAt return -1, and reading index -1
  // yields undefined — so without this a renamed column would fail as "expected
  // undefined to be '40 (53.3%)'", blaming the assertion instead of the lookup.
  const i = colAt(wrap, name);
  if (i < 0) throw new Error(`no column labelled "${name}"`);
  return cells(tr)[i]!;
};
/** The count in a cell, which for the active metric leads its inlined share. */
const count = (cell: string) => Number(cell.split(" ")[0]!.replaceAll(",", ""));

/**
 * The URL as a table sees it, wired the way app.js wires it.
 *
 * Writing a param REDRAWS -- setParam() rewrites the address bar and then calls
 * render() -- so `table()` must not also call its own rerender on a header click.
 * That is why the rerender passed alongside this throws in the sort tests: two
 * draws, the first from the stale address bar, is the bug the wiring prevents.
 */
const urlFor = () => {
  const params = new Map<string, string>();
  const self = {
    params,
    draws: 0,
    query: {
      get: (ns: string, id: string) => params.get(`${ns}.${id}`) ?? "",
      set: (ns: string, id: string, v: string) => {
        if (v) params.set(`${ns}.${id}`, v); else params.delete(`${ns}.${id}`);
        self.draws++;
      },
    },
  };
  return self;
};

// The modules under test. Dynamic so the globals above are installed first.
const { fmt, heading, pct, rollup, sectionHref, tableFor } = await import("./lib.js");
const { acceptance, plural, statGroups } = await import("./panels.js");
const { acceptCol, metricCols } = await import("./cols.js");
const { COLS, EVENT_KINDS, hintWorthShowing, isAttributed, sameOrg } = await import("./vocab.js");

test("section permalinks preserve filters/sorts and replace only the target", () => {
  const hash = "#/org/acme/widgets?q.org-people=Ada&s.org-people=-reviews&section=old";
  const link = sectionHref(hash, "org-people");
  const [path, query] = link.split("?");
  expect(path).toBe("#/org/acme/widgets");
  const params = new URLSearchParams(query);
  expect(params.get("q.org-people")).toBe("Ada");
  expect(params.get("s.org-people")).toBe("-reviews");
  expect(params.getAll("section")).toEqual(["org-people"]);
  expect(sectionHref("", "summary")).toBe("#/orgs?section=summary");
  expect(new URLSearchParams(sectionHref("#/governance", "council-経済%20Council").split("?")[1]).get("section"))
    .toBe("council-経済%20Council");
});

test("one heading structure preserves tiers and supplies an accessible decorative anchor", () => {
  const h = heading("Initiated", { id: "stat-initiated", href: "#/orgs?section=stat-initiated", level: "h3" });
  expect(h.tag).toBe("h3");
  expect(h.className).toBe("section-heading");
  expect(h.attrs.id).toBe("stat-initiated");
  const link = all(h, "a")[0]!;
  expect(link.className).toBe("heading-anchor");
  expect(link.attrs["aria-label"]).toBeUndefined(); // visible heading text is the accessible name
  expect(link.attrs.title).toBe("Link to this section");
  expect(txt(link)).toBe("Initiated");
  const icon = first(link, (n) => n.className === "anchor-icon")!;
  expect(icon.attrs["aria-hidden"]).toBe("true");
  expect(txt(icon)).toBe("");
  expect(heading("Ada", { class: "report-name" }).className).toBe("section-heading report-name");
});

// ------------------------------------------------------------ rollup()

test("rollup sums the named fields per key and leaves everything else out", () => {
  const rows = [
    { org: "acme", repo: "widgets", commits: 40, reviews: 5, added: 100 },
    { org: "acme", repo: "gadgets", commits: 15, reviews: 2, added: 40 },
    { org: "globex", repo: "widgets", commits: 20, reviews: 9, added: 7 },
  ];
  const out = rollup(rows, (r: any) => r.org, ["commits", "reviews"]);

  expect(out.map((r) => r._key)).toEqual(["acme", "globex"]); // first-seen order
  expect(out[0]).toEqual({ _key: "acme", commits: 55, reviews: 7 });
  expect(out[1]).toEqual({ _key: "globex", commits: 20, reviews: 9 });
  // `added` was not requested, so it must not appear: a field that silently
  // rides along would be summed on some pages and absent on others.
  expect("added" in out[0]).toBe(false);
});

test("rollup treats a missing or non-numeric field as zero, not NaN", () => {
  // A row from a git-only build has no `reviews` at all. NaN would propagate
  // through every share and total on the page.
  const out = rollup(
    [{ k: "a", commits: 3 }, { k: "a", commits: undefined, reviews: "x" }],
    (r: any) => r.k, ["commits", "reviews"],
  );
  expect(out[0]).toEqual({ _key: "a", commits: 3, reviews: 0 });
});

test("rollup of an empty set is an empty set, not a zero row", () => {
  expect(rollup([], (r: { k: string }) => r.k, ["commits"])).toEqual([]);
});

// ------------------------------------------------- table(): group runs

const NAME = { key: "name", label: "Organization" };
const grouped = [
  NAME,
  { key: "people", label: "Contributors", n: true },
  { key: "proposed", label: "proposed", n: true, group: "initiated" },
  { key: "landed", label: "landed", n: true, group: "initiated", kid: true },
  { key: "reviews", label: "reviewed", n: true, group: "engaged" },
  { key: "comments", label: "comments", n: true, group: "engaged" },
  { key: "commits", label: "commits", n: true, group: "authored" },
];
const ROWS = [
  { name: "acme", people: 2, proposed: 10, landed: 8, reviews: 5, comments: 30, commits: 55 },
  { name: "globex", people: 1, proposed: 4, landed: 3, reviews: 9, comments: 12, commits: 30 },
  { name: "initech", people: 0, proposed: 1, landed: 0, reviews: 0, comments: 2, commits: 10 },
];

test("group runs are computed from column order, never declared", () => {
  const table = tableFor(() => {});
  const { headRows } = parts(table(grouped, ROWS, "t"));
  expect(headRows.length).toBe(2); // group row + column row

  const group = headRows[0]!;
  // Each LABELLED group spans exactly its adjacent members. A hand-maintained
  // colspan is a second definition of the column order and goes stale the first
  // time a column moves.
  //
  // The leading ungrouped columns are emitted one cell per column and carry NO
  // colspan, which is load-bearing rather than cosmetic: the sticky first column
  // below 1240px pins `th:first-child` in every head row, so a spacer spanning
  // the first two columns pinned an opaque cell wider than the column it was
  // masking and painted over the first group label ("INITIATED" read as "ATED").
  // The two leading cells here are what keeps the pin one column wide.
  expect(group.kids.map((th) => th.attrs.colspan)).toEqual([undefined, undefined, "2", "2", "1"]);
  expect(group.kids.map(txt)).toEqual(["", "", "initiated", "engaged", "authored"]);
  // Only the labelled runs open with a rule.
  expect(group.kids.map((th) => th.className))
    .toEqual(["", "", "gstart", "gstart", "gstart"]);
  // The guard that actually matters, stated as an invariant rather than implied
  // by the array above: the first head cell of EVERY row covers one column.
  for (const row of headRows) expect(row.kids[0]!.attrs.colspan).toBeUndefined();
});

test("the vertical group rule marks the first column of each run, by identity", () => {
  const table = tableFor(() => {});
  const { headRows, bodyRows } = parts(table(grouped, ROWS, "t2"));
  const gstart = headRows[1]!.kids.map((th) => th.className.includes("gstart"));
  expect(gstart).toEqual([false, false, true, false, true, false, true]);
  // Body cells carry the same rule, so the channel is continuous down the table.
  expect(bodyRows[0]!.kids.map((td) => td.className.includes("gstart"))).toEqual(gstart);
});

// ------------------------------------------------------- row sections

const SECTIONED = [
  { s: "totals", name: "everything", commits: 100 },
  { s: "by org", name: "acme", commits: 55 },
  { s: "by org", name: "globex", commits: 30 },
  { s: "by org", name: "initech", commits: 10 },
];
const NUM = { key: "commits", label: "Commits", n: true };
/** A table over one fake URL, so a header click can be followed by a redraw. */
const sectionedTable = () => {
  const t = tableFor(() => {}, urlFor().query);
  return (name: string) => t([NAME, NUM], SECTIONED, name,
    { sections: (r: { s: string }) => r.s });
};
const sectioned = (name: string) => sectionedTable()(name);
/** Body rows as `"section"` labels and `name=commits` data rows, in order. */
const shape = (wrap: FakeNode) => parts(wrap).bodyRows.map((r) =>
  r.className === "sect" ? `─ ${txt(r)}` : `${cells(r)[0]}=${cells(r)[1]}`);

test("a section label opens each run, and section order comes from the input", () => {
  const wrap = sectioned("s1");
  expect(shape(wrap)).toEqual([
    "─ totals", "everything=100",
    "─ by org", "acme=55", "globex=30", "initech=10",
  ]);
  // The label spans the whole table rather than sitting in the first column: a
  // colspan short of the column count leaves a stray empty cell to its right.
  const label = parts(wrap).bodyRows[0]!;
  expect(label.kids.length).toBe(1);
  expect(label.kids[0]!.attrs.colspan).toBe("2");
});

test("rows never sort across a section, only within one", () => {
  // THE invariant. These sections are overlapping populations — on the
  // responsiveness page first-time plus returning authors sum to all pull
  // requests, and so do the per-repository rows — so a single ranked list would
  // sit a subset next to its own superset and present them as peers.
  //
  // Redrawn after each click because `rerender` is a stub here: a click writes to
  // the sort store and the tree in hand is a stale snapshot. Asserting twice on
  // one tree made the first expectation pass for the wrong reason.
  const table = sectionedTable();
  let wrap = table("s2");
  // Commits descending is already the default, so `everything=100` is the largest
  // value in the table and stays alone in its own section rather than heading the
  // org run.
  expect(shape(wrap)).toEqual([
    "─ totals", "everything=100",
    "─ by org", "acme=55", "globex=30", "initech=10",
  ]);
  clickHeader(wrap, "Commits"); // reverse it: 100 is now the largest value LAST
  wrap = table("s2");
  expect(shape(wrap)).toEqual([
    "─ totals", "everything=100",
    "─ by org", "initech=10", "globex=30", "acme=55",
  ]);
});

test("a section the search emptied renders nothing, not a heading over no rows", () => {
  // Same rule as never printing an unmeasured metric as zero: a label with no
  // rows under it reads as "this section has no data", which is a different and
  // false claim from "your filter excluded it".
  const url = urlFor();
  const table = tableFor(() => {}, url.query);
  const draw = () => table([NAME, NUM], SECTIONED, "s3", { sections: (r: any) => r.s });
  url.params.set("q.s3", "globex");
  expect(shape(draw())).toEqual(["─ by org", "globex=30"]);
  // And when nothing survives at all, the no-match row stands alone — no labels.
  url.params.set("q.s3", "nonesuch");
  const empty = parts(draw()).bodyRows;
  expect(empty.length).toBe(1);
  expect(txt(empty[0]!)).toContain("No match");
});

test("a table with no grouped columns has no group row at all", () => {
  const table = tableFor(() => {});
  const { headRows } = parts(table([NAME, { key: "d", label: "Date" }], [{ name: "a", d: "x" }],
                                   "log", { dflt: { key: "d", dir: -1 } }));
  expect(headRows.length).toBe(1);
});

test("a conditional column dropped inline does not shift the group runs", () => {
  // Call sites gate optional columns with `cond && col`; the falsy entry must
  // vanish before spans are counted, or every colspan to its right is wrong.
  const table = tableFor(() => {});
  // `false as const`, not a bare `false`: TypeScript widens the latter to
  // `boolean` in an array literal, and `true` is not a column.
  const cols = [NAME, false as const, ...grouped.slice(2)];
  const { headRows } = parts(table(cols, ROWS, "t3"));
  // One leading column survives, so the unlabelled run is a single plain cell;
  // the spans to its right are unchanged, which is the point of the test.
  expect(headRows[0]!.kids.map((th) => th.attrs.colspan)).toEqual([undefined, "2", "2", "1"]);
  expect(headRows[0]!.kids[0]!.attrs.colspan).toBeUndefined();
});

// ------------------------------------------------- table(): sort state

/** The arrow is rendered only on the sorted column, so it locates the sort. */
const arrow = (wrap: FakeNode) => {
  const th = headCells(wrap).find((c) => c.kids.some((k) => k.className === "ind"));
  return th ? { label: label(th), dir: txt(th).includes("↓") ? -1 : 1 } : null;
};
const clickHeader = (wrap: FakeNode, name: string) => {
  headCells(wrap).find((c) => label(c) === name)!.fire("click");
};

/**
 * A table over one fake URL. The rerender callback throws on purpose: a header
 * click must reach the page only through the URL write, never by also calling
 * rerender, or every sort renders twice -- the first time from the address bar
 * it is in the middle of replacing.
 */
const sortable = (cols: any[] = grouped, rows: any[] = ROWS) => {
  const url = urlFor();
  const t = tableFor(() => { throw new Error("a header click must not call rerender"); },
                     url.query);
  return { url, draw: (name = "sortable", opts = {}) => t(cols, rows, name, opts) };
};

test("sorting: numeric columns start descending and a second click reverses", () => {
  const { url, draw } = sortable();
  expect(parts(draw()).bodyRows.map((r) => cells(r)[0])).toEqual(["acme", "globex", "initech"]);

  clickHeader(draw(), "reviewed");
  expect(url.draws).toBe(1); // the write triggers exactly one redraw
  expect(parts(draw()).bodyRows.map((r) => cells(r)[0])).toEqual(["globex", "acme", "initech"]);
  expect(arrow(draw())).toEqual({ label: "reviewed", dir: -1 });

  clickHeader(draw(), "reviewed");
  expect(parts(draw()).bodyRows.map((r) => cells(r)[0])).toEqual(["initech", "acme", "globex"]);
  expect(arrow(draw())).toEqual({ label: "reviewed", dir: 1 });
});

test("the sort is addressable, and the default keeps the URL empty", () => {
  // The reason the store moved out of memory: a sorted view has to be a link you
  // can send. And exactly one link -- writing `-commits` when `-commits` is what
  // an untouched table already does would give every view two addresses.
  const { url, draw } = sortable();
  clickHeader(draw(), "reviewed");
  expect([...url.params]).toEqual([["s.sortable", "-reviews"]]);
  clickHeader(draw(), "reviewed");
  expect([...url.params]).toEqual([["s.sortable", "reviews"]]); // ascending: no minus
  clickHeader(draw(), "commits");
  expect([...url.params]).toEqual([]); // back to the default, so back to a bare URL
});

test("a sort arriving from the URL is honoured without a click", () => {
  const { url, draw } = sortable();
  // The KEY, which the label need not match: this is a column identity, not
  // display text.
  url.params.set("s.sortable", "reviews");
  expect(arrow(draw())).toEqual({ label: "reviewed", dir: 1 });
  expect(parts(draw()).bodyRows.map((r) => cells(r)[0])).toEqual(["initech", "acme", "globex"]);
});

test("each table's sort is its own, addressed by the id it already owns", () => {
  const { url, draw } = sortable();
  clickHeader(draw("a"), "reviewed");
  expect(arrow(draw("b"))).toEqual({ label: "commits", dir: -1 });
  expect([...url.params]).toEqual([["s.a", "-reviews"]]);
});

test("a table with no query cannot be sorted by clicking, and says so by not moving", () => {
  // Not a silent no-op to hunt down later: without a URL there is nowhere to put
  // the sort, and the alternative -- a hidden in-memory copy -- is exactly the
  // second source of truth this design removed.
  const t = tableFor(() => {});
  const wrap = t(grouped, ROWS, "nourl");
  expect(() => clickHeader(wrap, "reviewed")).not.toThrow();
  expect(arrow(t(grouped, ROWS, "nourl"))).toEqual({ label: "commits", dir: -1 });
});

// The repro the healing exists for: sort #/people by Organization, then pick an
// organization — the column that named the sort is no longer meaningful and the
// view stops emitting it. Throwing there aborted render() before
// replaceChildren, freezing the DOM on the previous scope's rows under a stale
// header: a filtered page still showing every contributor.
const PEOPLE_COLS = (withOrg: boolean) => [
  { key: "name", label: "Name" },
  withOrg && { key: "orgName", label: "Organization" },
  { key: "commits", label: "commits", n: true },
];
const PEOPLE = [
  { name: "Ada Lovelace", orgName: "Acme", commits: 55 },
  { name: "Grace Hopper", orgName: "Globex", commits: 30 },
];

test("a vanished sort column heals to the view's default and moves the arrow", () => {
  const url = urlFor();
  const t = tableFor(() => {}, url.query);
  const draw = (withOrg: boolean) => t(PEOPLE_COLS(withOrg), PEOPLE, "people");
  clickHeader(draw(true), "Organization");
  expect(arrow(draw(true))).toEqual({ label: "Organization", dir: 1 });

  // Scope narrows: the Organization column is gone.
  let wrap!: FakeNode;
  expect(() => { wrap = draw(false); }).not.toThrow();
  expect(arrow(wrap)).toEqual({ label: "commits", dir: -1 });
  expect(parts(wrap).bodyRows.map((r) => cells(r)[0])).toEqual(["Ada Lovelace", "Grace Hopper"]);
});

test("a healed sort comes back when its column does", () => {
  // The behaviour that changed when the store moved into the URL, and the reason
  // the dead key is left there rather than rewritten: the old in-place heal
  // overwrote the reader's sort, so clearing the filter that hid the column did
  // not restore the order they had chosen. Render must not write the URL in any
  // case — the write redraws, so healing by writing would recurse.
  const url = urlFor();
  const t = tableFor(() => {}, url.query);
  clickHeader(t(PEOPLE_COLS(true), PEOPLE, "heal-back"), "Organization");
  expect(arrow(t(PEOPLE_COLS(false), PEOPLE, "heal-back"))).toEqual({ label: "commits", dir: -1 });
  expect(arrow(t(PEOPLE_COLS(true), PEOPLE, "heal-back"))).toEqual({ label: "Organization", dir: 1 });
});

test("healing survives a click, so it still works the second time a column goes", () => {
  // The hazard this pins down: a header click writes new sort state, and if that
  // write loses the way back to the default, healing throws the next time a
  // column disappears — a frozen page, one click later.
  const url = urlFor();
  const t = tableFor(() => {}, url.query);
  clickHeader(t(PEOPLE_COLS(true), PEOPLE, "click-then-heal"), "Organization");
  clickHeader(t(PEOPLE_COLS(true), PEOPLE, "click-then-heal"), "Organization"); // reverse too
  expect(arrow(t(PEOPLE_COLS(false), PEOPLE, "click-then-heal")))
    .toEqual({ label: "commits", dir: -1 });
});

test("a key from the URL that names no column heals instead of blanking the page", () => {
  // Hand-edited, or pasted from a view with different columns. Throwing here
  // aborted render() before replaceChildren and froze the DOM on the previous
  // rows under a stale header.
  const url = urlFor();
  const t = tableFor(() => {}, url.query);
  url.params.set("s.people", "-nonesuch");
  expect(arrow(t(PEOPLE_COLS(true), PEOPLE, "people"))).toEqual({ label: "commits", dir: -1 });
});

test("healing also works when the vanished column was the declared default", () => {
  const table = tableFor(() => {});
  const wrap = table([{ key: "name", label: "Name" }, { key: "d", label: "Date" }],
                     [{ name: "a", d: "2026-01-01" }], "log:x", { dflt: { key: "d", dir: -1 } });
  expect(arrow(wrap)).toEqual({ label: "Date", dir: -1 });
});

test("a DEFAULT sort key matching no column still throws", () => {
  // A programmer error, not a data condition — the caller's own default naming
  // nothing. It caught a real bug once, and healing everything would hide it.
  const table = tableFor(() => {});
  expect(() => table([NAME], ROWS, "typo", { dflt: { key: "nope", dir: -1 } }))
    .toThrow('default sort key "nope" is not a column');
});

test("bars are scaled by sortKey, so a computed column measures what it displays", () => {
  const table = tableFor(() => {});
  const cols = [NAME, { key: "commits", label: "commits", n: true, bar: true,
                        sortKey: (r: { commits: number }) => r.commits * 2 }];
  const { bodyRows } = parts(table(cols, ROWS, "bars"));
  const width = (tr: FakeNode) => all(tr, "i")[0]!.attrs.style;
  expect(width(bodyRows[0]!)).toBe("width:100%");          // acme, the max
  expect(width(bodyRows[2]!)).toBe(`width:${(10 / 55) * 100}%`); // initech
});

// -------------------------------------------------------- acceptance()

test("acceptance divides by decided PRs only, and ships its denominator", () => {
  expect(acceptance({ landed: 8, declined: 2, open: 40 })).toEqual({ decided: 10, pct: 80 });
});

test("acceptance of nothing decided is null, never zero", () => {
  // The distinction the whole function exists for: "nobody has ruled" is not
  // "the answer was no". A zero here would read as a rejection rate.
  expect(acceptance({ landed: 0, declined: 0, open: 6 })).toEqual({ decided: 0, pct: null });
  expect(acceptance({})).toEqual({ decided: 0, pct: null });
  expect(acceptance({ open: 3 })).toEqual({ decided: 0, pct: null });
});

test("the accepted column renders NA for an undefined ratio and sorts it apart", () => {
  const col = acceptCol();
  expect(txt(col.cell({ landed: 0, declined: 0, open: 6 }))).toBe("NA");
  expect(txt(col.cell({ landed: 3, declined: 1 }))).toBe("75% (4)");
  // -1 keeps NA out of the run of real rates instead of tying with 0%.
  expect(col.sortKey({ landed: 0, declined: 0 })).toBe(-1);
  expect(col.sortKey({ landed: 3, declined: 1 })).toBe(75);
});

test("plural picks the singular only at exactly one", () => {
  expect([0, 1, 2].map((n) => plural(n, "commit"))).toEqual(["commits", "commit", "commits"]);
  expect(plural(3, "repository", "repositories")).toBe("repositories");
});

test("fmt and pct never emit a fake number", () => {
  expect(fmt(1234567)).toBe("1,234,567");
  expect(fmt(undefined)).toBe("");        // absent, so nothing is printed
  expect(pct(1, 4)).toBe("25.0%");
  expect(pct(3, 0)).toBe("—");            // no denominator, no percentage
});

// ------------------------------------------ panels: unmeasured vs zero

const ALL_FIELDS = [
  "commits", "coauthored", "added", "deleted", "files",
  "proposed", "landed", "open", "declined", "reviews", "comments", "issues",
];
const SUMMARY_STUB = {
  totals: { commits: 100, reviews: 40 },
  coverage: { pct: 87.4, human: 90 },
  github: { coverage: { pct: 94.1, human: 38 } },
};
const panelText = (r: Record<string, number>, fields = ALL_FIELDS) =>
  txt(statGroups(r, { fields, summary: SUMMARY_STUB }));

test("every panel row is gated on the measured field list", () => {
  const r = { commits: 10, coauthored: 2, added: 5, deleted: 1, files: 3 };
  // A git-only build measures no PR fields, so those groups do not exist.
  const gitOnly = panelText(r, ["commits", "coauthored", "added", "deleted", "files"]);
  expect(gitOnly).toContain("authored");
  expect(gitOnly).not.toContain("initiated");
  expect(gitOnly).not.toContain("engaged");

  // Within a group, a field that was never measured must not leave its label
  // behind: fmt(undefined) is "", so an ungated row rendered "  files touched".
  const noSizes = panelText(r, ["commits", "coauthored"]);
  expect(noSizes).toContain("co-authored");
  expect(noSizes).not.toContain("added");
  expect(noSizes).not.toContain("touched");
});

test("a measured zero collapses to one stated line instead of a stack of zeros", () => {
  const reviewerOnly = { commits: 0, coauthored: 0, added: 0, deleted: 0, files: 0,
                         proposed: 0, landed: 0, open: 0, declined: 0,
                         reviews: 12, comments: 30, issues: 0 };
  const out = panelText(reviewerOnly);
  expect(out).toContain("no commits");   // measured, and said once
  expect(out).toContain("none opened");
  expect(out).toContain("12");           // the reviews that make this person visible
});

test("the project panel reports coverage; a scope panel reports its share", () => {
  const r = { commits: 25, coauthored: 0, added: 0, deleted: 0, files: 0,
              proposed: 4, landed: 3, open: 0, declined: 1, reviews: 10, comments: 5, issues: 0 };
  expect(panelText(r)).toContain("25.0% of project commits");
  expect(txt(statGroups(r, { fields: ALL_FIELDS, summary: SUMMARY_STUB, project: true })))
    .toContain("87.4% of human commits attributed");
});

// --------------------------------------------------------------- vocab

test("the activity-log filter is derived from the pipeline's own kind list", () => {
  // Restated, the two drifted: a new pipeline kind was counted in the log's
  // "all (N)" and missing from the filter that claims to list every kind.
  expect(EVENT_KINDS.map((k) => k.kind)).toContain("reviewcomment");
  expect(EVENT_KINDS.every((k) => typeof k.field === "string")).toBe(true);
  // Every candidate column is a real measured field name.
  expect(COLS).toContain("commits");
  expect(COLS).not.toContain("accepted"); // a rate, not a measured field
  expect([isAttributed("acme"), isAttributed("unknown"), isAttributed("bot")])
    .toEqual([true, false, false]);
});

test("metricCols marks exactly the active metric and inlines its share", () => {
  const cols = metricCols({
    cols: ["proposed", "landed", "commits"], active: "commits",
    share: { of: "project", total: () => 200 },
  });
  expect(cols.map((c) => c.key)).toEqual(["proposed", "landed", "commits"]); // plan order
  expect(cols.filter((c) => c.bar).map((c) => c.key)).toEqual(["commits"]);
  expect(cols.filter((c) => c.cls === "active-metric").map((c) => c.key)).toEqual(["commits"]);
  const active = cols.at(-1)!;
  // The share is inlined into the active metric's own cell: value first, derived
  // context in parentheses.
  expect(active.cell({ commits: 50 }).map(txt).join("")).toBe("50 (25.0%)");
  expect(active.help).toContain("share of the whole project");
});

test("metricCols splices `accepted` beside the states it divides, only when asked", () => {
  const opts = { cols: ["proposed", "landed", "declined"], active: "commits" };
  expect(metricCols(opts).map((c) => c.key)).toEqual(["proposed", "landed", "declined"]);
  expect(metricCols({ ...opts, accepted: true }).map((c) => c.key))
    .toEqual(["proposed", "landed", "declined", "accepted"]);
});

// ------------------------------------------------------- the whole app
//
// app.js owns the seven views and the router, and the invariants worth testing
// there are cross-view ones. It is imported against the fake DOM with `fetch`
// answering from fixtures, so these exercise the real render path.

const FIELDS = ALL_FIELDS;
const M = (o: Record<string, number> = {}) =>
  Object.fromEntries(FIELDS.map((f) => [f, o[f] ?? 0]));

// acme 55, globex 30, initech 10, independent 5 — grand total 100 commits, so
// acme's share is 55.0% and any denominator error shows up as a round number.
const row = (org: string, repo: string, m: Record<string, number>) => ({ org, repo, ...M(m) });
const REPO_ORGS = [
  row("acme", "widgets", { commits: 40, proposed: 12, landed: 9, declined: 3, reviews: 20,
                           comments: 40, issues: 4, added: 900, deleted: 100, files: 30,
                           coauthored: 2 }),
  row("acme", "gadgets", { commits: 15, proposed: 5, landed: 4, declined: 1, reviews: 6,
                           comments: 10, issues: 1, added: 200, deleted: 50, files: 8 }),
  row("globex", "widgets", { commits: 20, proposed: 8, landed: 6, open: 2, reviews: 11,
                             comments: 22, issues: 2, added: 300, deleted: 20, files: 12 }),
  row("globex", "gadgets", { commits: 10, proposed: 8, landed: 5, open: 3, reviews: 4,
                             comments: 6 }),
  row("initech", "widgets", { commits: 10, proposed: 14, landed: 1, declined: 1, open: 12,
                              reviews: 1, comments: 3 }),
  row("independent", "widgets", { commits: 5, proposed: 1, open: 1, comments: 1 }),
];

// Per-person, per-repo metrics, reconciling with REPO_ORGS above: ada is all of
// acme, grace is all of globex, and initech/independent have no mapped person.
const ADA_WIDGETS = { commits: 40, proposed: 12, landed: 9, declined: 3, reviews: 20,
                      comments: 40, issues: 4 };
const ADA_GADGETS = { commits: 15, proposed: 5, landed: 4, declined: 1, reviews: 6,
                      comments: 10, issues: 1 };
const GRACE_WIDGETS = { commits: 20, proposed: 8, landed: 6, open: 2, reviews: 11,
                        comments: 22, issues: 2 };
const GRACE_GADGETS = { commits: 10, proposed: 8, landed: 5, open: 3, reviews: 4, comments: 6 };
const FIXTURES: Record<string, unknown> = {
  summary: {
    fields: FIELDS,
    repos: ["widgets", "gadgets"],
    orgs: 4,
    people: 2,
    // Reconciles with REPO_ORGS above, and satisfies the same invariant `verify`
    // asserts over real data: nobody's review count may exceed the items they did
    // not author. The proposal counts here are what they are BECAUSE of it -- the
    // fixture previously credited ada with 20 reviews in a repository offering her
    // 11 eligible items, which is not a shape the pipeline can produce.
    totals: M({ commits: 100, proposed: 48, landed: 25, open: 18, declined: 5, reviews: 42,
                comments: 82, issues: 7, added: 1400, deleted: 170, files: 50, coauthored: 2 }),
    orgNames: { acme: "Acme", globex: "Globex", initech: "Initech", independent: "Independent" },
    range: { first: "2026-01-05", last: "2026-08-20" },
    generatedAt: "2026-08-28T00:00:00Z",
    coverage: { attributed: 95, human: 100, total: 100, pct: 95 },
    github: { coverage: { attributed: 41, human: 42, pct: 97.6 } },
    repoUrls: { widgets: "https://example.invalid/widgets",
                gadgets: "https://example.invalid/gadgets" },
    // Two repositories in two different classes, so a class scope is provably
    // narrower than the project and provably wider than nothing. Both in one
    // class would make every class assertion below pass against no filtering.
    repoClass: { widgets: "spec", gadgets: "impl" },
  },
  orgs: [
    { org: "acme", name: "Acme", people: 1, ...M({ commits: 55 }) },
    { org: "globex", name: "Globex", people: 1, ...M({ commits: 30 }) },
    { org: "initech", name: "Initech", people: 0, ...M({ commits: 10 }) },
    { org: "independent", name: "Independent", people: 0, ...M({ commits: 5 }) },
  ],
  repos: REPO_ORGS,
  people: [
    { id: "ada", slug: "ada-lovelace", name: "Ada Lovelace", org: "acme", orgName: "Acme",
      mapped: true, emails: ["ada@example.invalid"], logins: ["ada-lovelace"],
      councils: ["Widget Tech Council", "Gadget Tech Council"],
      spans: [{ org: "acme", activeFrom: "2026-01-05", activeTo: "2026-08-20" }],
      profileCompany: null, first: "2026-01-05", last: "2026-08-20",
      repos: [{ repo: "widgets", ...M(ADA_WIDGETS) }, { repo: "gadgets", ...M(ADA_GADGETS) }],
      ...M({ commits: 55, proposed: 17, landed: 13, declined: 4, reviews: 26, comments: 50,
             issues: 5, added: 1100, deleted: 150, files: 38, coauthored: 2 }) },
    // No recorded span, which is the majority case and its own render branch.
    { id: "grace", slug: "grace-hopper", name: "Grace Hopper", org: "globex", orgName: "Globex",
      mapped: true, emails: ["grace@example.invalid"], logins: ["grace-hopper"],
      spans: [], profileCompany: null, first: "2026-02-01", last: "2026-07-30",
      repos: [{ repo: "widgets", ...M(GRACE_WIDGETS) }, { repo: "gadgets", ...M(GRACE_GADGETS) }],
      ...M({ commits: 30, proposed: 16, landed: 11, open: 5, reviews: 15, comments: 28,
             issues: 2, added: 300, deleted: 20, files: 12 }) },
  ],
  "org-people": [
    { id: "ada", org: "acme", repo: "widgets", ...M(ADA_WIDGETS) },
    { id: "ada", org: "acme", repo: "gadgets", ...M(ADA_GADGETS) },
    { id: "grace", org: "globex", repo: "widgets", ...M(GRACE_WIDGETS) },
    { id: "grace", org: "globex", repo: "gadgets", ...M(GRACE_GADGETS) },
  ],
  // Shaped like the derived projection of MAINTAINERS.md: headings, names,
  // company labels, the `*` marker and an alias link -- nothing curated. Ada's
  // roster company deliberately differs from her contribution org.
  governance: {
    source: { repo: "https://github.com/x/.github.git", file: "MAINTAINERS.md", sha: "d".repeat(40),
              url: `https://github.com/x/.github/blob/${"d".repeat(40)}/MAINTAINERS.md`,
              authoredAt: "2026-11-05T07:00:03-08:00", collectedAt: "2026-11-08T17:40:05.216Z" },
    councils: [
      { name: "Widget Tech Council", seats: [
        { name: "Ada Lovelace", company: "Roster Co", marked: true, person: "ada" },
        { name: "Unlinked Person", company: "Globex", marked: false, person: null },
      ] },
      { name: "Gadget Tech Council", seats: [
        { name: "Ada Lovelace", company: "Roster Co", marked: false, person: "ada" },
      ] },
      { name: "Vacant Tech Council", seats: [] },
    ],
  },
  events: {
    events: [
      { d: "2026-02-01", k: "commit", r: "widgets", ref: "abc1234def",
        p: "ada-lovelace", o: "acme", t: "Add the widget" },
      { d: "2026-03-04", k: "proposed", r: "widgets", ref: 12, p: "grace-hopper", o: "globex" },
      { d: "2026-04-05", k: "review", r: "gadgets", ref: 13, p: "ada-lovelace", o: "acme", i: 99 },
    ],
    titles: { "widgets#12": "Tidy the gadget", "gadgets#13": "Rework the sums" },
  },
};

/** Every data file the app asked for, so a wrong filename is a failure not a 404. */
const FETCHED: string[] = [];
(globalThis as Record<string, unknown>).fetch = async (url: string) => {
  const name = String(url).replace("./data/", "").replace(".json", "");
  FETCHED.push(name);
  return name in FIXTURES
    ? { ok: true, status: 200, json: async () => FIXTURES[name] }
    : { ok: false, status: 404, json: async () => ({}) };
};
(globalThis as Record<string, unknown>).location = { hash: "#/orgs" };
// Modelled, not stubbed: the controls publish their state through replaceState,
// and the browser's behaviour that matters here is that it updates the URL
// WITHOUT firing hashchange — which is why app.js calls render() itself. A stub
// that dropped the write would have let every URL assertion below pass against a
// URL the controls never actually produced.
(globalThis as Record<string, unknown>).history = {
  replaceState: (_state: unknown, _title: string, url: string) => {
    (globalThis as { location: { hash: string } }).location.hash = url;
  },
};

await import("./app.js");

const view = doc.getElementById("view")!;
/** Navigate the way the browser does: set the hash, then fire hashchange. */
const go = (hash: string) => {
  (globalThis as { location: { hash: string } }).location.hash = hash;
  for (const fn of listeners.hashchange ?? []) fn();
  return view;
};
/**
 * The filter box, and typing into it — this is the control that had the bug.
 *
 * Addressed by table id, because every table now has its own box: one shared
 * `data-focus="filter"` would have made every assertion below read the topmost
 * table's input no matter which one it meant.
 */
const box = (id: string) => first(view, (n) => n.attrs["data-focus"] === `q.${id}`);
const filter = (q: string, id = "orgs") => {
  box(id)!.fire("input", { target: { value: q } });
};
const tables = () => walk(view).filter((n) => n.className === "tablewrap");
/** One table by its id, so a multi-table route can be asserted table by table. */
const tableById = (id: string) => {
  const wrap = first(view, (n) => n.attrs["data-table"] === id)!;
  return walk(wrap).find((n) => n.className === "tablewrap")!;
};
/**
 * DATA rows in one table.
 *
 * The no-match message is a body row too, so counting it made "one row matched"
 * and "nothing matched" indistinguishable — `toBe(1)` then passed against an
 * empty result. Caught by fault-injecting the search: the assertion held with
 * the mechanism removed, which is the definition of a check that is a comment.
 */
const rowsIn = (id: string) => parts(tableById(id)).bodyRows
  // Neither the no-match row nor a section LABEL is a data row. The `.empty` half
  // of this filter was added after a fault-injection run passed against a count
  // that was one too high; `.sect` is the same shape of mistake waiting for the
  // first sectioned table to appear on a route the harness can reach.
  .filter((r) => r.className !== "sect" && !first(r, (n) => n.className === "empty")).length;
const shareOf = (org: string) => {
  const tr = parts(tables()[0]!).bodyRows.find((r) => cells(r)[0] === org);
  return cells(tr!).at(-1);
};

// A share must not be a function of the search box: computing a total AFTER the
// row filter rewrote an organization's own share to 100.0% the moment you typed
// its name, while the tooltip promising "a share of every organization's…" was
// still on screen. The view that first carried that bug is gone; the rule it
// established is not, so it is pinned here on the view that survives.
test("the organizations table shares are filter-independent", () => {
  go("#/orgs");
  const cellFor = (org: string) =>
    cells(parts(tables()[0]!).bodyRows.find((r) => cells(r)[0] === org)!);
  const before = cellFor("Acme");
  filter("globex");
  // Asserted WHILE filtered, which is the only state that can exhibit the bug.
  // This used to re-navigate with go("#/orgs") first, and under the old
  // module-level filter state that kept the filter alive across the hashchange.
  // Now the URL is authoritative and a bare `#/orgs` means unfiltered, so
  // re-navigating here would assert against the full table and prove nothing.
  // The row count pins that down rather than trusting it.
  expect(parts(tables()[0]!).bodyRows.length).toBe(1);
  expect(cellFor("Globex").join(" ")).toContain("(30.0%)");
  filter("");
  expect(cellFor("Acme")).toEqual(before);
});

// --------------------------------------------------- controls live in the URL
//
// Four clauses, because each one failed independently before the URL became the
// single source of truth: the view is addressable, a pasted URL reproduces it, a
// stale value degrades instead of blanking, and a view-scoped filter does not
// follow the reader to another view.

const url = () => (globalThis as { location: { hash: string } }).location.hash;
/** Change a <select> the way a reader does. */
const choose = (name: string, value: string) => {
  const sel = first(view, (n) => n.attrs["data-focus"] === name)!;
  sel.fire("change", { target: { value } });
};
/** Sort a table the way a reader does: by clicking its header. */
const sortBy = (id: string, name: string) => {
  headCells(tableById(id)).find((c) => label(c) === name)!.fire("click");
};

test("a control writes its value into the URL, so the view is addressable", () => {
  go("#/orgs");
  expect(url()).toBe("#/orgs");
  sortBy("orgs", "landed");
  expect(url()).toBe("#/orgs?s.orgs=-landed");
  filter("acme");
  expect(url()).toBe("#/orgs?s.orgs=-landed&q.orgs=acme");
  // Emptying a control removes the parameter rather than writing `q.orgs=`, so
  // "unfiltered" has exactly one spelling.
  filter("");
  expect(url()).toBe("#/orgs?s.orgs=-landed");
  sortBy("orgs", "commits");
  expect(url()).toBe("#/orgs");
});

test("pasting a URL reproduces the view it describes", () => {
  // The direction that was impossible before: arriving cold at a filtered view.
  go("#/orgs?q.orgs=globex");
  expect(parts(tables()[0]!).bodyRows.length).toBe(1);
  expect(box("orgs")!.attrs.value).toBe("globex");

  // And a sorted one. The bar rides the sort, so arriving here reproduces both
  // the order and the emphasis -- which is the whole reason the metric dropdown
  // could be deleted rather than merely fixed.
  go("#/orgs?s.orgs=-landed");
  const head = headCells(tables()[0]!).find((c) => label(c) === "landed")!;
  expect(txt(head)).toContain("\u2193");
  expect(cells(parts(tables()[0]!).bodyRows[0]!)[0]).toBe("Acme");
});

test("an unrecognised control value degrades to unfiltered, not to an empty page", () => {
  const all = (() => { go("#/orgs"); return parts(tables()[0]!).bodyRows.length; })();

  // `files` IS measured but is deliberately not a column, which is the exact
  // value that once marked no column and left a share with no numerator. It now
  // arrives as a sort key rather than a metric, and must both heal the order and
  // withhold the bar -- shading a column the table is not sorted by is the defect
  // that motivated deleting the separate control.
  go("#/orgs?s.orgs=files");
  expect(parts(tables()[0]!).bodyRows.length).toBe(all);
  const heads = headCells(tables()[0]!);
  expect(txt(heads.find((c) => label(c) === "commits")!)).toContain("\u2193");
  expect(heads.some((c) => c.className?.includes("active-metric"))).toBe(false);
  // And nothing downstream may quietly adopt it either. The under-table note
  // totals the focused column, so a `files` focus with no `files` column prints
  // a number whose numerator appears nowhere in the table -- the same shape as
  // the share-with-no-column bug, one layer down. Count clause only.
  // Anchored on the sentence that follows, not on the metric name: the summary
  // panel above legitimately reports `files touched`, so a bare substring test
  // passed with the guard removed.
  // Three: `independent` is a display bucket, not an organization.
  expect(txt(view)).toContain("3 organizations. Click");

  go("#/org/acme?repo=deleted-repo");
  expect(txt(view)).toContain("Acme");
  go("#/orgs?org=no-such-org");
  expect(parts(tables()[0]!).bodyRows.length).toBe(all);
});

/**
 * A repository class scopes a page the way a single repository does.
 *
 * The whole reason the field exists is that one blended figure was telling two
 * different stories, so what has to hold is that a class scope changes the
 * numbers -- not merely that the control renders. Every assertion below is
 * anchored on ada's arithmetic: 55 commits across both repositories, 40 in
 * widgets (spec) and 15 in gadgets (impl). A filter that silently did nothing
 * would leave 55 everywhere and pass a weaker test.
 */
test("a repository class scopes a page like a repository does", () => {
  const adaCommits = () => {
    const row = parts(tables()[0]!).bodyRows.find((r) => cells(r)[0]?.includes("Ada"))!;
    const i = headCells(tables()[0]!).findIndex((c) => label(c) === "commits");
    return cells(row)[i];
  };

  go("#/people");
  expect(adaCommits()).toBe("55");
  go("#/people?class=spec");
  expect(adaCommits()).toBe("40");
  go("#/people?class=impl");
  expect(adaCommits()).toBe("15");
  // Summing per-repository rows must reconcile with the person's own total, or
  // the scoped and unscoped views are reading different books.
  go("#/people?repo=widgets");
  expect(adaCommits()).toBe("40");

  // A class names no repository the data knows: unfiltered, not empty. Same rule
  // the org and repo controls already follow.
  go("#/people?class=no-such-class");
  expect(adaCommits()).toBe("55");

  // The two controls can describe an EMPTY set -- gadgets is impl, so "spec"
  // plus "gadgets" agrees on nothing. The narrower one wins rather than
  // intersecting, because a filter pair that can render a blank page is a trap.
  go("#/people?class=spec&repo=gadgets");
  expect(adaCommits()).toBe("15");
});

/**
 * `accepted` is a RATE. Volume columns sum across repositories; a rate does not,
 * and the class scope sums. It was already withheld under `repo` -- this pins
 * that the newer, coarser scope did not reopen the hole.
 */
test("a rate column withdraws under a class scope, not just a repository one", () => {
  const hasAccepted = () =>
    headCells(tables()[0]!).some((c) => label(c).includes("accepted"));
  go("#/people");
  expect(hasAccepted()).toBe(true);
  go("#/people?repo=widgets");
  expect(hasAccepted()).toBe(false);
  go("#/people?class=spec");
  expect(hasAccepted()).toBe(false);
});

/**
 * Review share divides by what the person could REVIEW, not by every review.
 *
 * You cannot review your own pull request, so dividing by the repository's whole
 * review count charges an author for work they were disqualified from. On real
 * data the person who wrote 94% of a repository's lines scored 8.5% of its
 * reviews; against eligible items the same person is at 16%. The naive figure
 * reads as disengagement and is really just the arithmetic of having built it.
 *
 * Ada: 20 reviews in widgets, 12 of the repository's 35 proposals are hers, so
 * she was eligible for 23 -- 87.0%, not the 62.5% that 20-of-32-reviews gives.
 */
test("review share divides by eligible items, not by every review", () => {
  go("#/person/ada-lovelace?s.person-repos=-reviews");
  const t = tables().find((w) => headCells(w).some((c) => label(c) === "Repository"))!;
  // The FIELD is `reviews` and the COLUMN says `reviewed`; the sort parameter
  // takes the field, the header lookup takes the label.
  const i = headCells(t).findIndex((c) => label(c) === "reviewed");
  const widgets = parts(t).bodyRows.find((r) => cells(r)[0]?.includes("widgets"))!;
  expect(cells(widgets)[i]).toContain("20");
  expect(cells(widgets)[i]).toContain("87.0%");
  // The share this replaces. Named so the test fails loudly if the denominator
  // ever reverts, rather than merely failing to find the new number.
  expect(cells(widgets)[i]).not.toContain("62.5%");

  // Only the review column earns the special denominator: a commit share is a
  // share of commits, and nothing disqualifies anyone from committing.
  go("#/person/ada-lovelace?s.person-repos=-commits");
  const t2 = tables().find((w) => headCells(w).some((c) => label(c) === "Repository"))!;
  const j = headCells(t2).findIndex((c) => label(c) === "commits");
  const w2 = parts(t2).bodyRows.find((r) => cells(r)[0]?.includes("widgets"))!;
  // 40 of the 75 commits in widgets.
  expect(cells(w2)[j]).toContain("53.3%");
});

/**
 * A headline panel describes the scope it sits above, or it is a wrong number in
 * the largest type on the page.
 *
 * This summed the unscoped set while the table beneath it summed the scoped one,
 * so "83% accepted" stood unchanged over the specification, the tooling and the
 * implementations alike -- whose real rates are 81.6%, 81.3% and 84.4%. The rate
 * is safe to recompute because `acceptance()` derives it from the landed and
 * declined it is handed; only a STORED rate cannot be re-scoped.
 */
test("the headline panel counts the scope it sits above, not the whole project", () => {
  // Scoped to the PANEL, not the whole view: the table underneath was already
  // correct, so asserting over `view` passes on a wrong panel sitting above
  // right rows -- which is exactly the bug.
  const panel = () => {
    const g = first(view, (n) => n.className === "groups");
    // Thrown, not defaulted: an empty string would make every `not.toContain`
    // below pass on a page that renders no panel at all.
    if (!g) throw new Error("no .groups panel in the view");
    return txt(g);
  };

  go("#/orgs");
  expect(txt(view)).toContain("The project");
  expect(panel()).toContain("100"); // every commit in the fixture

  // gadgets is the fixture's only `impl` repository: acme 15 + globex 10 = 25.
  go("#/orgs?class=impl");
  expect(panel()).toContain("25");
  expect(panel()).not.toContain("100");
  // The heading has to move too. "The project" over a quarter of the project is
  // the same lie told in words instead of in digits.
  expect(txt(view)).toContain("Implementations");
  expect(txt(view)).not.toContain("The project");

  // widgets is `spec`: 40 + 20 + 10 + 5 = 75. Asserted as its own figure rather
  // than as "different from impl", because the HEADING already differs between
  // the two scopes -- a difference check passes on an unscoped panel.
  go("#/orgs?class=spec");
  expect(panel()).toContain("75");
  expect(panel()).not.toContain("100");
  expect(txt(view)).toContain("Specification");

  // A scoped panel takes the ordinary notes. The project-mode note states a
  // project-wide fact -- the share of all human reviews that are attributed --
  // which does not become true of a third of the repositories just because it
  // is printed above them.
  expect(panel()).toContain("of project reviews");
  expect(panel()).not.toContain("of human reviews attributed");
  go("#/orgs");
  expect(panel()).toContain("of human reviews attributed");
});

test("no scope is offered that would select nothing", () => {
  // `scopedRepos()` answers an unrepresented class with `[]`, and `[]` is truthy,
  // so every row is filtered out and the page renders empty -- from a control the
  // reader was invited to click. The repo/class precedence rule exists to stop a
  // filter PAIR describing the empty set; this is the same trap one level up.
  //
  // The fixture has spec and impl repositories and no tooling one.
  go("#/orgs");
  // Found by walking the fake tree. Written first as `view.querySelectorAll?.()
  // ?? []`, which is not a lookup but a dead guard: the stub has no such method,
  // so it returned [] and the assertion passed against nothing.
  const opts = all(view, "option").map(txt);
  expect(opts.length).toBeGreaterThan(0);
  expect(opts).toContain("Implementations");   // a class the fixture HAS
  expect(opts).not.toContain("Tooling");       // one it does not

  // And if one is reached by hand anyway, it degrades to unfiltered rather than
  // rendering a blank page, exactly as an unknown class does.
  go("#/orgs?class=tooling");
  expect(parts(tables()[0]!).bodyRows.length).toBeGreaterThan(0);
});

test("the repositories table names each repository's class", () => {
  go("#/repos");
  const i = headCells(tables()[0]!).findIndex((c) => label(c) === "Kind");
  expect(i).toBeGreaterThan(-1);
  const byRepo = Object.fromEntries(
    parts(tables()[0]!).bodyRows.map((r) => [cells(r)[0], cells(r)[i]]));
  expect(byRepo).toEqual({ widgets: "Specification", gadgets: "Implementations" });

  // On this page the class filter picks ROWS rather than narrowing what a row
  // sums, which is the one view where those differ.
  go("#/repos?class=impl");
  expect(parts(tables()[0]!).bodyRows.map((r) => cells(r)[0])).toEqual(["gadgets"]);
});

test("no view-scoped state follows a tab change", () => {
  go("#/orgs");
  sortBy("orgs", "landed");
  filter("acme");
  expect(parts(tables()[0]!).bodyRows.length).toBe(1);

  // Nav hrefs are static. The metric used to ride along here, being the one
  // control that meant the same thing on every view; now that the lens IS a
  // table's sort it is scoped like every other per-table param, and carrying it
  // would mean writing a sort for a table the destination may not render.
  const next = NAV.find((a) => a.getAttribute("href")!.startsWith("#/repos"))!;
  expect(next.getAttribute("href")).toBe("#/repos");
  go(next.getAttribute("href")!);
  expect(box("repos")!.attrs.value).toBe("");
  expect(parts(tables()[0]!).bodyRows.length).toBe(2);   // every repository, unfiltered
});

// ---------------------------------------------- one search box per table
//
// A report page carries three tables, so a single `q` could only ever address
// one of them. Each table is named by the id it already gives the sort store,
// and that name is the parameter. Five clauses, one per property the scheme
// needs to hold.

/** The log is fetched on demand, so the first render of a report says "Loading…". */
const goLog = async (hash: string) => {
  go(hash);
  await new Promise((r) => setTimeout(r, 0));
  return view;
};

test("each table filters only itself, and writes only its own parameter", async () => {
  await goLog("#/repo/widgets");
  expect(["repo-orgs", "repo-people", "log"].map((id) => !!box(id)))
    .toEqual([true, true, true]);

  const before = { orgs: rowsIn("repo-orgs"), people: rowsIn("repo-people"),
                   log: rowsIn("log") };
  filter("grace", "repo-people");

  expect(rowsIn("repo-people")).toBeLessThan(before.people);
  expect(rowsIn("repo-orgs"), "a sibling table must not move").toBe(before.orgs);
  expect(rowsIn("log"), "a sibling table must not move").toBe(before.log);
  expect(url()).toBe("#/repo/widgets?q.repo-people=grace");
});

// The property the whole scheme rests on. Two tables sharing an id would share a
// box and a parameter, and the failure is silent: typing in one filters both.
test("a table id is unique within a route", async () => {
  for (const hash of ["#/orgs", "#/repos", "#/people", "#/org/acme", "#/org/acme/widgets",
                      "#/repo/widgets", "#/person/ada-lovelace"]) {
    await goLog(hash);
    const ids = walk(view).map((n) => n.attrs["data-table"]).filter(Boolean);
    expect(ids.length, hash).toBeGreaterThan(0);
    expect(new Set(ids).size, hash).toBe(ids.length);
  }
});

// Four of the log's six columns render something the row does not contain, so
// searching the raw values would miss exactly the words on screen.
test("the log searches what it renders, not what the row stores", async () => {
  await goLog("#/repo/widgets");

  // Title lives in a side table keyed `repo#ref`; the event has no such string.
  filter("Tidy the gadget", "log");
  expect(rowsIn("log")).toBe(1);

  // Kind renders a label; "proposed" is the stored token and never displayed.
  filter("opened PR", "log");
  expect(rowsIn("log")).toBe(1);

  // Contributor renders a display name resolved from the slug on the event.
  filter("Ada Love", "log");
  expect(rowsIn("log")).toBe(1);

  // Both forms of a reference: the seven characters shown, and the whole id a
  // reader would actually have copied.
  filter("abc1234", "log");
  expect(rowsIn("log")).toBe(1);
  filter("abc1234def", "log");
  expect(rowsIn("log")).toBe(1);

  filter("", "log");
  expect(rowsIn("log")).toBe(2);
});

// An empty body under a full header reads as "this scope has no data", which is
// the same lie as printing an unmeasured metric as zero.
test("a search matching nothing says so, and stays clearable", () => {
  go("#/orgs");
  filter("no-such-organization");
  expect(rowsIn("orgs")).toBe(0);
  expect(txt(tableById("orgs"))).toContain("No match");
  expect(box("orgs")!.attrs.value, "the box must survive its own empty result")
    .toBe("no-such-organization");
  filter("");
  expect(rowsIn("orgs")).toBe(3);
});

// An email is an identity key here, not a column, so the default "search the
// columns" would have dropped the only way to find someone by the address on
// their commits.
test("a contributor is findable by an address that is not a column", () => {
  go("#/people?q.people=grace@example.invalid");
  expect(rowsIn("people")).toBe(1);
  expect(txt(tableById("people"))).toContain("Grace Hopper");
});

// The count sits beneath the rows it counts. Computed in the view it read the
// unfiltered set and said "4 organizations" over a single row.
test("the trailing count follows the rows the search left", () => {
  go("#/orgs");
  expect(txt(view)).toContain("3 organizations");
  filter("globex");
  expect(txt(view)).toContain("1 organization \u00b7 30 commits");
  expect(txt(view)).not.toContain("3 organizations");
});

test("every route renders rows, and a scope filter narrows them", () => {
  for (const [hash, expected] of [
    ["#/orgs", 3], ["#/repos", 2], ["#/people", 2],
  ] as Array<[string, number]>) {
    go(hash);
    expect(parts(tables()[0]!).bodyRows.length, hash).toBe(expected);
  }

  go("#/org/acme");
  expect(txt(view)).toContain("Acme");
  expect(parts(tables()[0]!).bodyRows.length).toBe(2);   // by repository
  expect(parts(tables()[1]!).bodyRows.length).toBe(1);   // its one contributor

  go("#/org/acme/widgets");
  expect(txt(view)).toContain("in widgets");

  go("#/repo/widgets");
  expect(parts(tables()[0]!).bodyRows.length).toBe(4);   // four rows: the detail view keeps the bucket

  go("#/person/ada-lovelace");
  expect(txt(view)).toContain("Ada Lovelace");
  expect(txt(view)).toContain("Council participation: Widget Tech Council and Gadget Tech Council");
  expect(txt(view)).not.toContain("Working-group");
  // The roster's company label never replaces the contribution affiliation.
  expect(txt(view)).toContain("Acme");
  expect(txt(view)).not.toContain("Roster Co");
  expect(parts(tables()[0]!).bodyRows.length).toBe(2);   // her two repositories

  go("#/governance");
  const page = txt(view);
  expect(page).toContain(`MAINTAINERS.md @ ddddddd, collected 2026-11-08`);
  expect(page).toContain("Vacant Tech Council");          // all-vacant heading stays visible
  expect(page).toContain("No named seats in the source.");
  expect(page).toContain("Ada Lovelace*");                 // the source's marker, literally
  expect(page).not.toMatch(/Manually curated|approved|chair|working group|Status/i);
  expect(parts(tables()[0]!).bodyRows.length).toBe(2);   // linked and unlinked roster names
  expect(all(view, "a").filter((a) => a.attrs.href === "#/person/ada-lovelace").length).toBe(2);
});

test("council headings are permalinks beside their own filters", () => {
  go("#/governance");
  const sections = all(view, "section");
  expect(sections).toHaveLength(3);
  const roster = FIXTURES.governance as { councils: Array<{ name: string; seats: unknown[] }> };
  for (const [i, council] of roster.councils.entries()) {
    const section = sections[i]!;
    const bar = first(section, (n) => n.className === "controls bar")!;
    const heading = all(bar, "h2")[0]!;
    expect(txt(heading)).toBe(council.name);
    const href = all(heading, "a")[0]!.attrs.href!;
    expect(href.split("?")[0]).toBe("#/governance");
    expect(new URLSearchParams(href.split("?")[1]).get("section")).toBe(`council-${encodeURIComponent(council.name)}`);
    expect(heading.attrs.id).toBe(`council-${encodeURIComponent(council.name)}`);
    expect(all(bar, "input")).toHaveLength(council.seats.length ? 1 : 0);
  }
  const ids = walk(view).map((n) => n.attrs["data-table"]).filter(Boolean);
  expect(new Set(ids).size).toBe(ids.length);
});

test("councils use the preferred presentation order without changing source data", () => {
  const roster = FIXTURES.governance as { councils: Array<{ name: string; seats: unknown[] }> };
  const original = roster.councils;
  const order = ["Governance Council", "Shopping Tech Council", "Payments Tech Council", "Lodging Tech Council", "Food Tech Council"];
  const sourceOrder = [...original, ...[...order].reverse().map((name) => ({ name, seats: [] }))];
  const expectedSource = sourceOrder.map((c) => c.name);
  roster.councils = sourceOrder;
  try {
    go("#/governance");
    expect(all(view, "section").map((n) => n.attrs["aria-label"]))
      .toEqual([...order, ...original.map((c: { name: string }) => c.name)]);
    expect(roster.councils.map((c) => c.name)).toEqual(expectedSource);
  } finally {
    roster.councils = original;
    go("#/orgs");
  }
});

test("council deep links scroll once and each filter changes only its own table", () => {
  const widget = "council-Widget%20Tech%20Council";
  const gadget = "council-Gadget%20Tech%20Council";
  go("#/orgs");
  SCROLLED.length = 0;
  go("#/governance/Widget%20Tech%20Council");
  expect(SCROLLED).toEqual([widget]);
  expect(lit()).toEqual(["#/governance"]);
  filter("Unlinked", widget);
  expect(parts(tableById(widget)).bodyRows).toHaveLength(1);
  expect(parts(tableById(gadget)).bodyRows).toHaveLength(1);
  expect(txt(tableById(gadget))).toContain("Ada Lovelace");
  headCells(tableById(widget)).find((n) => label(n) === "Company")!.fire("click");
  expect(SCROLLED).toEqual([widget]);
  go("#/governance/Gadget%20Tech%20Council");
  expect(SCROLLED).toEqual([widget, gadget]);
  go("#/governance/Not%20A%20Council");
  expect(SCROLLED).toEqual([widget, gadget]);
  expect(txt(view)).toContain("Widget Tech Council");
});

test("every view uses one heading component, with unique stable section targets", async () => {
  for (const route of ["#/orgs", "#/repos", "#/people", "#/org/acme", "#/repo/widgets",
                       "#/person/ada-lovelace", "#/governance"]) {
    go(route);
    await new Promise((r) => setTimeout(r, 0));
    go(route);
    const heads = [...all(view, "h2"), ...all(view, "h3")];
    expect(heads.length, route).toBeGreaterThan(0);
    expect(new Set(heads.map((h) => h.attrs.id)).size, route).toBe(heads.length);
    for (const h of heads) {
      expect(h.className.split(" "), route).toContain("section-heading");
      expect(h.attrs.id, route).toBeTruthy();
      const link = all(h, "a")[0]!;
      expect(link.className, route).toBe("heading-anchor");
      expect(new URLSearchParams(link.attrs.href!.split("?")[1]).get("section"), route).toBe(h.attrs.id!);
    }
  }
});

test("section links keep table controls and do not jump again while filtering", () => {
  go("#/orgs");
  SCROLLED.length = 0;
  go("#/people?section=people&q.people=Ada&s.people=-reviews");
  expect(SCROLLED).toEqual(["people"]);
  const link = all(view, "a").find((a) => a.className === "heading-anchor")!;
  const params = new URLSearchParams(link.attrs.href!.split("?")[1]);
  expect(params.get("q.people")).toBe("Ada");
  expect(params.get("s.people")).toBe("-reviews");
  filter("", "people");
  expect(SCROLLED).toEqual(["people"]);
});

test("exactly one nav tab is lit, and a report page lights its index", () => {
  go("#/orgs");
  expect(lit()).toEqual(["#/orgs"]);
  go("#/people");
  expect(lit()).toEqual(["#/people"]);
  go("#/governance");
  expect(lit()).toEqual(["#/governance"]);
  // A report page has no tab of its own and lights the index it belongs to.
  go("#/org/acme");
  expect(lit()).toEqual(["#/orgs"]);
  go("#/repo/widgets");
  expect(lit()).toEqual(["#/repos"]);
  expect(doc.title).toBe("UCP Contributor Stats — widgets");
  go("#/person/ada-lovelace");
  expect(lit()).toEqual(["#/people"]);
});

test("a link to a removed view degrades in the nav too, not just the page", () => {
  // `#/matrix` was a real route. The router already fell back to the
  // organizations index for an unknown head, but the nav highlight read the raw
  // hash, so the reader landed on a page every tab disowned. Both halves now
  // resolve the same way.
  go("#/matrix");
  expect(txt(view)).toContain("Organizations");
  expect(lit()).toEqual(["#/orgs"]);
  go("#/nonsense");
  expect(lit()).toEqual(["#/orgs"]);
});

test("Heartbeat is a permanent nav route without a query-string flag", async () => {
  expect((globalThis as { location: { search?: string } }).location.search ?? "").toBe("");
  const html = await Bun.file(new URL("./index.html", import.meta.url)).text();
  expect(html).toContain('<a href="#/heartbeat">Heartbeat</a>');
  expect(html.indexOf('href="#/heartbeat"')).toBeLessThan(html.indexOf('href="#/governance"'));
  expect(NAV.filter((a) => a.hash === "#/heartbeat")).toHaveLength(1);
  go("#/heartbeat");
  await new Promise((r) => setTimeout(r, 0));
  go("#/heartbeat");
  expect(txt(view)).toContain("Heartbeat");
  expect(txt(view)).toContain("No overlay data");
  expect(lit()).toEqual(["#/heartbeat"]);
  expect(FETCHED).toContain("heartbeat");
});

test("an unknown scope says so rather than rendering an empty report", () => {
  expect(txt(go("#/org/nope"))).toContain("No organization");
  expect(txt(go("#/repo/nope"))).toContain("No repository");
  expect(txt(go("#/person/nope"))).toContain("No contributor");
});

test("hash segments are percent-decoded, so an escaped slug still resolves", () => {
  // `location.hash` returns whatever escapes the address bar put in. Undecoded,
  // the segment matches no id and a person who is right there renders as absent.
  expect(txt(go("#/person/ada%2Dlovelace"))).toContain("Ada Lovelace");
  expect(txt(go("#/org/acme/wid%67ets"))).toContain("in widgets");
  // A malformed escape must degrade to the literal, not throw out of render().
  expect(() => go("#/person/%E0%A4%A")).not.toThrow();
  expect(txt(view)).toContain("No contributor");
});

test("a person with no recorded span still gets an affiliation and a range", () => {
  go("#/person/grace-hopper");
  const scope = walk(view).find((n) => n.className === "scope")!;
  expect(txt(scope)).toBe("Globex (02/26–07/26)");
});

test("panels reconcile with the table beneath them on an organization page", () => {
  go("#/org/acme");
  // The property the whole tool depends on: the panel's lead figure is the sum of
  // the rows below it. 40 + 15 = 55 commits, and the panel says 55.
  const wrap = tables()[0]!;
  const perRepo = parts(wrap).bodyRows.map((r) => count(valueAt(wrap, r, "commits")));
  expect(perRepo).toEqual([40, 15]);
  // The active metric's cell carries its share of the REPOSITORY here, not of
  // this organization: 40 of the 75 commits in widgets.
  expect(valueAt(wrap, parts(wrap).bodyRows[0]!, "commits")).toBe("40 (53.3%)");
  expect(perRepo.reduce((a, b) => a + b, 0)).toBe(55);
  const lead = walk(view).find((n) => n.className === "row lead")!;
  expect(txt(lead)).toBe("17pull requests"); // initiated leads the panels
  const authored = walk(view).filter((n) => n.className === "row lead").at(-1)!;
  expect(txt(authored)).toBe("55commits");
});

// ------------------------------------------------- profile-company hint gate

// Real shapes, de-named: these are the variant families actually on file. The
// gate exists because 116 of 124 hints restate the affiliation line above them.
test("a cosmetic variant of the recorded organization is not a disagreement", () => {
  for (const [profile, org] of [
    ["Acme Inc.", "Acme"],            // legal suffix
    ["Acme UK", "Acme"],              // regional arm
    ["Acme Research", "Acme"],        // division
    ["Acme Bank AB", "Acme"],         // full legal name
    ["@acmefin", "Acme"],             // handle, org is a prefix of it
    ["https://acme.group", "Acme"],   // URL instead of a name
    ["acme", "Acme"],                 // case only
  ]) expect(sameOrg(profile, org)).toBe(true);
});

test("a categorically different profile company is a disagreement", () => {
  expect(sameOrg("Msc. Data Science | Newcastle University", "Acme")).toBe(false);
  expect(sameOrg("Tech Entrepreneur", "Acme")).toBe(false);
  expect(sameOrg("", "Acme")).toBe(false);
  expect(sameOrg("Acme", "")).toBe(false);
});

// Unattributed pages are not special-cased; they fall out of the same rule,
// because a pseudo-org name never reads as agreement with a company name.
test("an unattributed page shows the hint without needing a clause of its own", () => {
  expect(hintWorthShowing("Primarily coding in private repos.", "Undisclosed")).toBe(true);
  expect(hintWorthShowing("own-handle", "Independent")).toBe(true);
  expect(hintWorthShowing("@acme", "Automation")).toBe(true);
});

test("the hint is suppressed where it would restate the line above it", () => {
  expect(hintWorthShowing("Acme Inc.", "Acme")).toBe(false);
  expect(hintWorthShowing(null, "Acme")).toBe(false);
  expect(hintWorthShowing(undefined, "Undisclosed")).toBe(false);
});

test("the hint shows when an attributed person's profile disagrees", () => {
  expect(hintWorthShowing("Globex", "Acme")).toBe(true);
});

// ------------------------------------------------------------ row picking

/**
 * A table bound to ONE `tableFor`, so a click can be followed by a redraw.
 *
 * Marks have to survive a re-render or the feature is pointless -- the reason to
 * mark three rows is to re-sort and watch where they go -- so every test here
 * asserts against the SECOND render, not the DOM the click touched.
 */
const pickable = (opts: Record<string, unknown> = {}) => {
  const url = urlFor();
  const t = tableFor(() => {}, url.query);
  return (name = "p") => t([NAME, NUM], ROWS, name,
    { rowKey: (r: { name: string }) => r.name, dflt: { key: "commits", dir: -1 }, ...opts });
};
const rowNamed = (wrap: FakeNode, n: string) =>
  parts(wrap).bodyRows.find((tr) => cells(tr)[0] === n)!;
const markedIn = (wrap: FakeNode) =>
  parts(wrap).bodyRows.filter((tr) => tr.className.includes("pick")).map((tr) => cells(tr)[0]);

test("a marked row is still marked after the table is rebuilt", () => {
  const draw = pickable();
  rowNamed(draw(), "globex").fire("click", { target: {} });
  // Second render, from the same store: the row the click landed on is gone.
  expect(markedIn(draw())).toEqual(["globex"]);
});

test("marks are identified by key, so re-sorting carries them to the new position", () => {
  // The whole reason the key is caller-supplied. Keyed by row index this passes
  // by accident while highlighting whichever row happens to land in that slot.
  const draw = pickable();
  const first = draw();
  expect(cells(parts(first).bodyRows[0]!)[0]).toBe("acme"); // commits desc
  rowNamed(first, "initech").fire("click", { target: {} });
  headCells(draw()).find((c) => label(c) === "Commits")!.fire("click"); // -> ascending
  const after = draw();
  expect(cells(parts(after).bodyRows[0]!)[0]).toBe("initech"); // moved to the top
  expect(markedIn(after)).toEqual(["initech"]);
});

test("clicking a marked row unmarks it", () => {
  const draw = pickable();
  rowNamed(draw(), "acme").fire("click", { target: {} });
  expect(markedIn(draw())).toEqual(["acme"]);
  rowNamed(draw(), "acme").fire("click", { target: {} });
  expect(markedIn(draw())).toEqual([]);
});

test("marks belong to one table, not to every table on the page", () => {
  // Two tables sharing a `tableFor` share the STORE but must not share the marks,
  // the same way they do not share a sort. `people` and `org-people` render the
  // same rows on different routes; one bleeding into the other would highlight
  // rows the reader never touched.
  const t = tableFor(() => {}, null);
  const draw = (name: string) =>
    t([NAME, NUM], ROWS, name, { rowKey: (r: { name: string }) => r.name });
  rowNamed(draw("left"), "acme").fire("click", { target: {} });
  expect(markedIn(draw("left"))).toEqual(["acme"]);
  expect(markedIn(draw("right"))).toEqual([]);
});

test("a click that lands on a link navigates and leaves no mark", () => {
  // Rows carry real navigation. One click cannot both mark a row and leave the
  // page, and leaving is what the reader asked for.
  const draw = pickable();
  rowNamed(draw(), "acme").fire("click", { target: { closest: (s: string) => (s.includes("a,") ? {} : null) } });
  expect(markedIn(draw())).toEqual([]);
});

test("a click that ends a text selection leaves no mark", () => {
  // Dragging across a cell to copy a figure ends in a click on the row. Without
  // this, reading a number marks the row, which reads as the page fighting back.
  const g = globalThis as Record<string, unknown>;
  g.getSelection = () => ({ isCollapsed: false });
  try {
    const draw = pickable();
    rowNamed(draw(), "acme").fire("click", { target: {} });
    expect(markedIn(draw())).toEqual([]);
  } finally { delete g.getSelection; }
});

test("without a rowKey a row carries no click handler at all", () => {
  // Stated, not inferred. A key guessed from the rendered text would break the
  // moment the reader switched metric; one guessed from the row index would
  // mis-address across routes sharing a table id. Both fail silently, so a table
  // that has not declared an identity does not get the feature.
  const t = tableFor(() => {}, null);
  const wrap = t([NAME, NUM], ROWS, "nokey");
  const tr = parts(wrap).bodyRows[0]!;
  expect(tr.events.click).toBeUndefined();
  expect(tr.className).toBe("");
});

test("the count appears only once something is marked, and clears everything", () => {
  // The count is the ONLY notice this feature exists -- rows are deliberately not
  // made to look clickable -- and the only bulk undo, since unmarking twelve rows
  // one click at a time is not an undo.
  const draw = pickable();
  const badge = (wrap: FakeNode) => first(wrap, (n) => n.className === "marks");
  expect(badge(draw())).toBeUndefined();
  rowNamed(draw(), "acme").fire("click", { target: {} });
  rowNamed(draw(), "globex").fire("click", { target: {} });
  expect(txt(badge(draw())!)).toBe("2 marked · clear");
  badge(draw())!.fire("click");
  expect(markedIn(draw())).toEqual([]);
  expect(badge(draw())).toBeUndefined();
});

test("a marked row keeps the class its view gave it", () => {
  // `rowCls` already means "this is the active scope" on report pages. The mark is
  // the reader's own act and the scope is a fact about the page; one must not
  // erase the other.
  const draw = pickable({ rowCls: (r: { name: string }) => (r.name === "acme" ? "sel" : null) });
  rowNamed(draw(), "acme").fire("click", { target: {} });
  expect(rowNamed(draw(), "acme").className).toBe("sel pick");
});

/**
 * A minimal but SHAPE-COMPLETE heartbeat payload.
 *
 * Every branch of the page reads it, so an absent sub-object is a crash rather
 * than a skipped assertion. The review figures are chosen so the two clauses of
 * the summary line cannot be mistaken for each other: cross-organization rate is
 * 2/3 = 66.7%, while the top two of three reviewing organizations perform
 * 18+9 of 30 = 90.0%. Equal numbers there would let either clause satisfy both
 * assertions.
 */
const STAT = { n: 3, med: 10, p75: 20, p90: 30 };
const OPEN = { n: 1, age: { n: 1, med: 40, p75: 40, p90: 40 }, over90: 0 };
// ------------------------------------------------------- the item page
//
// A landed pull request with no walked branch must SAY so. Without the note the
// page drops its line columns and the lines clause, which is exactly how a
// branch whose authors wrote nothing would render.

test("an item whose branch could not be walked states the absence, not zero", async () => {
  FIXTURES.items = {
    "widgets#12": { k: "pr", s: "landed", a: "grace-hopper", t: "2026-03-04", e: "2026-03-06",
                    d: "main", w: [["grace-hopper", 10, 2, 1]] },
    "widgets#16": { k: "pr", s: "landed", a: "ada-lovelace", t: "2026-03-10", e: "2026-03-11",
                    u: "merge-commit-unfetchable" },
    "widgets#17": { k: "pr", s: "landed", a: "ada-lovelace", t: "2026-03-12", e: "2026-03-13",
                    u: "no-merge-commit" },
    "gadgets#13": { k: "issue", s: "open", a: "ada-lovelace", t: "2026-04-01" },
  };
  await goLog("#/pr/widgets/16");
  await goLog("#/pr/widgets/16");
  const absent = txt(view);
  expect(absent).toContain("Branch not measured");
  expect(absent).toContain("no longer available from the public repository");
  expect(absent).toContain("unknown, not zero");
  // No line clause and no line columns: nothing was measured to print.
  expect(absent).not.toMatch(/\d+ lines? across/);
  const heads = headCells(tableById("item-cast")).map(label);
  expect(heads).toContain("Role");
  expect(heads).not.toContain("Added");

  await goLog("#/pr/widgets/17");
  expect(txt(view)).toContain("names no merge commit");

  // The walked item is unaffected: lines shown, no absence note.
  await goLog("#/pr/widgets/12");
  const walked = txt(view);
  expect(walked).toContain("12 lines across 1 contributor");
  expect(walked).not.toContain("Branch not measured");
  expect(headCells(tableById("item-cast")).map(label)).toContain("Added");
  for (const route of ["#/pr/widgets/12", "#/issue/gadgets/13"]) {
    await goLog(route);
    const heads = all(view, "h2");
    expect(heads.length).toBeGreaterThan(0);
    expect(new Set(heads.map((h) => h.attrs.id)).size).toBe(heads.length);
    for (const h of heads) {
      expect(all(h, "a")[0]!.className).toBe("heading-anchor");
    }
  }
});

// A historical item may not assert a later employer. Grace authored widgets#12
// at globex (the event row says so); she then changes job, so her LATEST
// affiliation -- the only org a cast row could read -- is initech. Rendering any
// organization on the cast would publish "Initech" against work done at Globex.
test("an item's cast names no employer, so a job change cannot rewrite history", async () => {
  const grace = (FIXTURES.people as Array<{ slug: string; org: string; orgName: string }>)
    .find((p) => p.slug === "grace-hopper")!;
  const was = { org: grace.org, orgName: grace.orgName };
  Object.assign(grace, { org: "initech", orgName: "Initech" });
  try {
    await goLog("#/pr/widgets/12");
    await goLog("#/pr/widgets/12");
    const cast = tableById("item-cast");
    expect(headCells(cast).map(label)).not.toContain("Organization");
    expect(txt(cast)).toContain("Grace Hopper");
    expect(txt(cast)).not.toContain("Initech");
  } finally {
    Object.assign(grace, was);
  }
});

// Automation and the display buckets, against the two repository figures and
// the organization ranking. Rows are added to the shared fixture for this test
// only: widgets gains 50 bot commits and 5 unknown commits. Named commits in
// widgets are 40+20+10 = 70; human commits 70+5+5 = 80, so attribution is 87.5%.
// Dividing by all activity prints 53.8%; counting buckets as organizations
// prints 5 where 3 are named.
test("attribution divides by human activity, and a bucket is never an organization", () => {
  const extra = [row("bot", "widgets", { commits: 50 }), row("unknown", "widgets", { commits: 5 })];
  REPO_ORGS.push(...extra);
  try {
    go("#/repos?s.repos=-commits");
    const repos = tableById("repos");
    const widgets = parts(repos).bodyRows.find((tr) => txt(tr).startsWith("widgets"))!;
    expect(valueAt(repos, widgets, "Attributed")).toBe("87.5%");
    expect(valueAt(repos, widgets, "Orgs")).toBe("3");

    go("#/orgs");
    const orgs = tableById("orgs");
    const ranked = parts(orgs).bodyRows.map((tr) => valueAt(orgs, tr, "Organization"));
    expect(ranked).toEqual(["Acme", "Globex", "Initech"]);
    expect(txt(view)).toContain("3 organizations");
    // Totals retain every bucket: 100 fixture commits + 55 added here.
    expect(txt(view)).toContain("155commits");
    // And each bucket stays reachable for audit.
    const links = walk(view).filter((n) => n.tag === "a").map((n) => n.getAttribute("href"));
    for (const b of ["independent", "unknown", "bot"]) expect(links).toContain(`#/org/${b}`);

    go("#/repo/widgets");
    // The detail view is an audit view: buckets are rows there.
    expect(parts(tableById("repo-orgs")).bodyRows.length).toBe(6);
  } finally {
    REPO_ORGS.splice(REPO_ORGS.length - extra.length, extra.length);
  }
});

const HEARTBEAT = {
  asOf: "2026-08-28T00:00:00Z",
  silentAfterDays: 14,
  window: { from: "2026-01-05", to: "2026-08-28" },
  pr: { n: 3, firstResponse: STAT, firstReview: STAT, silent: 1, verdictNoReply: 0,
        toLand: STAT, toDecline: STAT, withdrawn: 0, open: OPEN },
  issue: { n: 1, firstResponse: STAT, silent: 0, verdictNoReply: 0,
           toClose: STAT, withdrawn: 0, open: OPEN },
  arrival: { newcomer: { n: 1, firstResponse: STAT, silent: 0 },
             returning: { n: 2, firstResponse: STAT, silent: 1 } },
  review: {
    reviewed: 3, comparable: 3, crossOrg: 2,
    byOrg: [
      { org: "acme", given: 18, received: 6, partners: 2 },
      { org: "globex", given: 9, received: 12, partners: 1 },
      { org: "initech", given: 3, received: 12, partners: 1 },
      // Receives review and performs none. Its `given` is a measured zero, and it
      // must not be counted among the organizations that review at all.
      { org: "independent", given: 0, received: 5, partners: 0 },
    ],
  },
  byRepo: [
    { repo: "widgets", prs: 2, silent: 1, firstResponse: STAT, toLand: STAT,
      toDecline: STAT, withdrawn: 0, open: OPEN },
    { repo: "gadgets", prs: 1, silent: 0, firstResponse: STAT, toLand: STAT,
      toDecline: STAT, withdrawn: 0, open: OPEN },
  ],
  items: [
    { k: "pr", r: "widgets", n: 12, t: "Tidy the gadget", a: "grace-hopper",
      o: "globex", d: "2026-03-04T00:00:00Z", s: "landed", e: "2026-03-06T00:00:00Z" },
    { k: "pr", r: "widgets", n: 14, t: "Awaiting a word", a: "ada-lovelace",
      o: "acme", d: "2026-04-01T00:00:00Z", s: "open", z: 1 },
    { k: "issue", r: "gadgets", n: 15, t: "Rework the sums", a: "ada-lovelace",
      o: "acme", d: "2026-05-01T00:00:00Z", s: "open" },
  ],
};

// ---------------------------------------------- Heartbeat with overlay data
// Last because a fresh module instance resets the lazy loader's missing state;
// both instances answer hashchange, and the last registered listener renders last.
test("Heartbeat renders Reviews before the awaiting-reply queue without a flag", async () => {
  const before = NAV.length;
  expect((globalThis as { location: { search?: string } }).location.search ?? "").toBe("");
  FIXTURES.heartbeat = HEARTBEAT;
  // Start on an unloaded section: the jump must wait for the async data.
  (globalThis as { location: { hash: string } }).location.hash = "#/heartbeat?section=heartbeat-matrix";
  SCROLLED.length = 0;
  await import(`./app.js?${"heartbeat-ready"}`);
  await new Promise((r) => setTimeout(r, 0));
  expect(SCROLLED).toEqual(["heartbeat-matrix"]);
  go("#/heartbeat");
  await new Promise((r) => setTimeout(r, 0));
  go("#/heartbeat");
  expect(NAV.length).toBe(before);
  expect(lit()).toEqual(["#/heartbeat"]);
  expect(txt(view)).not.toContain("No overlay data");
  expect(all(view, "h2").map(txt)).toEqual([
    "Time to a first reply", "Time to a verdict", "Reviews", "Awaiting a first reply (1)",
  ]);
  expect(txt(view)).not.toContain("Who reviews whom");

  const byOrg = tables().find((w) =>
    headCells(w).some((c) => label(c) === "Reviews given"))!;
  const heads = headCells(byOrg).map(label);
  // Deleted, not renamed. The share it printed is MAXIMISED by having no
  // colleagues to review -- an organization that gives one review, to a
  // stranger, scored a perfect 100% -- so it read as pluralism and measured
  // its opposite. `partners` asks the same question in a unit that cannot be
  // gamed that way, and has to still be here for the deletion to be a
  // replacement rather than a loss.
  expect(heads).not.toContain("Outside own org");
  expect(heads).toContain("Orgs reviewed");

  // A cross-organization rate is unreadable without the concentration beside
  // it, for exactly the reason the deleted column failed: 100% is equally
  // consistent with broad participation and with one company reviewing
  // everyone. The fixture is built so the two clauses cannot be confused --
  // 2 of 3 pull requests cross an organization boundary (66.7%) while the top
  // two of three reviewing organizations perform 18+9 of 30 = 90.0% of the
  // reviews. Equal numbers would let either clause satisfy both assertions.
  //
  // Read off the whole view: `table()` renders a note as a SIBLING of the
  // wrapper, not inside it, so scoping this to `byOrg` silently found nothing.
  const note = txt(view);
  expect(note).toContain("66.7%");
  expect(note).toContain("3 organizations");
  expect(note).toContain("top two perform 90.0%");
  // The two clauses are counted in different units, and the sentence has to
  // say so: a reader who subtracts 66.7% from 90.0% has been misled by the
  // prose rather than by the data.
  expect(note).toContain("Counted as reviews rather than as pull requests");

  // The concentration is a claim about the rows on SCREEN, so it follows the
  // reader's filter. It previously announced three organizations above a
  // single visible row.
  go("#/heartbeat?q.heartbeat-matrix=globex");
  const one = txt(view);
  expect(one).toContain("Globex performs all of them");
  // "The top two" is unsayable with one row; printing it anyway asserted a
  // second organization that is not there.
  expect(one).not.toContain("top two");
  // The cross-organization rate is a property of the DATASET, not of the
  // filter, so unlike the clause above it must NOT move.
  expect(one).toContain("66.7%");

  // An organization that receives review and gives none is a measured zero.
  // It is not one of "the organizations that review", and counting it would
  // pad the denominator and understate the concentration.
  go("#/heartbeat?q.heartbeat-matrix=independent");
  expect(txt(view)).toContain("No organization shown here has given a review");
});

test("an activity permalink waits for rows rather than scrolling to its loading placeholder", async () => {
  const priorFetch = globalThis.fetch;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  (globalThis as Record<string, unknown>).fetch = async (url: string) => {
    if (String(url) === "./data/events.json") {
      await waiting;
      return { ok: true, status: 200, json: async () => FIXTURES.events };
    }
    return priorFetch(url);
  };
  try {
    (globalThis as { location: { hash: string } }).location.hash = "#/org/acme?section=log";
    SCROLLED.length = 0;
    await import(`./app.js?${"activity-pending"}`);
    expect(first(view, (n) => n.attrs.id === "log")?.attrs["data-section-pending"]).toBe("");
    expect(SCROLLED).toEqual([]);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(SCROLLED).toEqual(["log"]);
    expect(first(view, (n) => n.attrs.id === "log")?.attrs["data-section-pending"]).toBeUndefined();
  } finally {
    release();
    globalThis.fetch = priorFetch;
  }
});
