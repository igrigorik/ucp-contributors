// UCP contributors — contribution and governance views over derived JSON,
// hash-routed so an individual report is a linkable URL.
import { el, fmt, heading, pct, rollup, sectionHref, syncStuck, tableFor } from "./lib.js";
import { COLS as CANDIDATE_COLS, EVENT_KINDS, hintWorthShowing, isAttributed } from "./vocab.js";
import { LABEL } from "./labels.js";
import { plural, statGroups as buildStatGroups } from "./panels.js";
import { metricCols as buildMetricCols } from "./cols.js";

const view = document.getElementById("view");

const load = (f) =>
  fetch(`./data/${f}.json`).then((r) => {
    // fetch resolves for a 404 as readily as for a 200, so without this a
    // missing file arrives as a JSON parse error that names no file.
    if (!r.ok) throw new Error(`data/${f}.json — HTTP ${r.status}`);
    return r.json();
  });

// Everything the index views need, on first paint. `events` is deliberately
// absent: it is larger than all of these combined and only a report page wants
// it, so it is fetched on demand (see loadLog).
//
// A rejection has to be STATED. A top-level await that never resolves leaves
// the module unevaluated, so one failed file gives the reader a blank view under
// an empty header with the reason visible only in devtools. The rule the log
// below states applies to the first paint too — a spinner that never resolves is
// a worse lie than a stated failure — so the failure is written to the page
// before the throw that stops everything under it.
let loaded;
try {
  loaded = await Promise.all(
    ["summary", "orgs", "repos", "people", "org-people", "governance"].map(load),
  );
} catch (err) {
  view.replaceChildren(el("p", { class: "empty" },
    `Could not load the data (${err.message}). Nothing on this page can be rendered.`));
  // Rethrown, not swallowed: every line below needs all five files, and the
  // console trace is where the underlying cause survives.
  throw err;
}
const [summary, orgs, repoOrgs, people, orgPeople, governance] = loaded;

// Whatever derive actually produced. Without the GitHub overlay the collab
// fields are simply absent — never rendered as zero, which would read as "this
// person reviewed nothing" rather than "we did not measure it".
const FIELDS = summary.fields;
const METRICS = Object.fromEntries(FIELDS.map((f) => [f, LABEL[f]]));
// Curated column set. The list and its curation rule live in vocab.js so that
// `verify` can assert no row renders blank against it.
//
// `coauthored` sits next to `commits` deliberately. It was previously panel-only,
// which broke the property the rest of this tool depends on: every figure in a
// scope's panel decomposes into the rows beneath it and sums back. A number that
// appears once and reconciles against nothing is the same unverifiable shape as
// a composite score. It is adjacent to `commits` rather than merged into it —
// the two count different sets, and the commit column has to keep summing to
// exactly what `git log` reports.
const COLS = CANDIDATE_COLS.filter((f) => FIELDS.includes(f));

const DEFAULT_METRIC = "commits";

// Filter and metric state. DERIVED from the URL at the top of every render and
// never assigned anywhere else, so there is exactly one description of what the
// page is showing.
//
// It used to be a plain mutable object that controls wrote and views read, with
// nothing in the address bar. That cost two things, both from the one cause.
// Nothing was shareable: "organizations by landed PRs" had no link. Worse, the
// state outlived the view that set it — typing `ada` on #/people and then
// clicking Organizations left the filter applied, so `#/orgs` rendered 1 of 85
// rows while the address bar said only `#/orgs`, and RELOADING that same URL
// showed all 85. One URL, two different pages, and the only evidence was a
// filter box the reader had no reason to look at again.
//
// Declared with the singletons at the top because everything below closes over
// it, and a `const` read before its initialiser is a TDZ crash rather than
// `undefined`.
// `q` (search text) and `s` (sort) are maps of table id -> value, not single
// strings: a report page has three tables and one shared name could only ever
// address one of them.
const state = { q: {}, s: {}, org: "", repo: "", cls: "" };
let activeSectionKey = null;
let pendingSection = null;

// `#/org/acme/widgets?s.org-people=-landed&q.org-people=ada`. Scope stays in the path, where
// segments are classified by value (see render); controls go in a query string
// because they are orthogonal to scope and giving each one a positional slot
// would need placeholders for the ones you did not set.
const hashParts = () => {
  const raw = location.hash.replace(/^#\/?/, "");
  const cut = raw.indexOf("?");
  return {
    path: cut < 0 ? raw : raw.slice(0, cut),
    params: new URLSearchParams(cut < 0 ? "" : raw.slice(cut + 1)),
  };
};

/**
 * Write one control's value into the URL, then redraw.
 *
 * replaceState rather than assigning `location.hash`, because these controls
 * refine the view you are already on rather than navigate away from it: at one
 * history entry per keystroke, Back would need pressing once per letter typed
 * before it left the page. It also does not fire hashchange, which is why
 * render() is called here explicitly.
 *
 * A value equal to its default deletes the parameter rather than writing it, so
 * each view has exactly ONE canonical URL. Not cosmetic: `#/orgs` and
 * `#/orgs?s.orgs=-commits` rendering the same page means two strings to share,
 * compare and assert on.
 */
const PARAM_DEFAULT = { org: "", repo: "" };

// Per-table params are `<ns>.<table>`: `q.` for search text, `s.` for sort. Both
// are named by the id the table already uses for itself, because three tables on
// a report page cannot share one name, and the bare form sat one letter from the
// scope params it is unrelated to — `?org=` scopes the page to an organization
// while `?orgs=` would have searched the organizations table. Both default to
// empty, so clearing one deletes it from the URL via the truthiness check below.
const paramDefault = (key) => (/^[qs]\./.test(key) ? "" : PARAM_DEFAULT[key]);

const setParam = (key, value) => {
  // A user interacting with a loading view takes precedence over a pending jump.
  pendingSection = null;
  const { path, params } = hashParts();
  if (value && value !== paramDefault(key)) params.set(key, value);
  else params.delete(key);
  const qs = params.toString();
  history.replaceState(null, "", `#/${path}${qs ? `?${qs}` : ""}`);
  render();
};

// One wiring point for each module that needs page-level context: the redraw for
// table's own sort store, the measured field list and project totals for the
// panels, and the active metric for the columns. Bound once here so those
// modules keep no state of their own and every call site below reads as it did.
// Search lives on both sides of this boundary by role: lib.js owns tables and
// the DOM, this file owns what the URL means, so the reader/writer pair is
// injected rather than lib.js learning about location.hash.
const headingHref = (id) => sectionHref(location.hash, id);
const sectionHeading = (title, id, options = {}) =>
  heading(title, { id, href: headingHref(id), ...options });
const query = {
  sectionHref: headingHref,
  get: (ns, id) => state[ns]?.[id] ?? "",
  set: (ns, id, value) => setParam(`${ns}.${id}`, value),
};
const table = tableFor(render, query);
const statGroups = (r, project = false) =>
  buildStatGroups(r, { fields: FIELDS, summary, project, sectionHref: headingHref });
const metricCols = (opts) => buildMetricCols({ cols: COLS, ...opts });

/**
 * The measured field a table is currently sorted by, or null if it is sorted by
 * something that is not a measurement.
 *
 * This is what used to be `state.metric` and a dropdown beside the filters. The
 * dropdown never filtered: it moved a bar and an inline share onto one column,
 * which is what "sort by" means, and clicking a header already did that. Two
 * controls for one idea is how they came to disagree -- for ten of the eleven
 * metrics the bar sat on a column the table was not ordered by, so the bars ran
 * non-monotonically and the top row of `?metric=reviews` had no reviews.
 *
 * Prose and derived columns sort perfectly well and return null here: a bar is a
 * proportion of a project total, and neither a name nor an acceptance RATE has
 * one. A hand-mangled key lands here too, which is why the test is membership in
 * COLS rather than "not one of the few keys I know are prose": the table heals
 * its own sort to the default (see tableFor), and no emphasis is the only
 * degradation that cannot point at the wrong column.
 */
const focus = (id, dflt = DEFAULT_METRIC) => {
  const raw = state.s[id] ?? "";
  if (!raw) return dflt;
  const key = raw.replace(/^-/, "");
  return COLS.includes(key) ? key : null;
};

const orgName = (id) => summary.orgNames[id] ?? id;
// Membership test for validating `?org=` out of the URL, where the value is
// whatever someone pasted. Built from the same rows that populate the dropdown,
// so the control and the validator cannot disagree about what an org is.
const orgIds = new Set(orgs.map((o) => o.org));
const bySlug = new Map(people.map((p) => [p.slug, p]));
const byId = new Map(people.map((p) => [p.id, p]));

/**
 * People credited to an organization, with their metrics scoped to that
 * organization (and optionally one repository).
 *
 * Never filter on `person.org` for this: that field is the affiliation at the
 * person's *latest* activity, so anyone who changed employer disappears from
 * their former organization and carries that earlier work into the new one. It
 * put a zero-contributor table under a 2-commit panel on one org page and
 * inflated another by exactly the amount the first lost. The person x org x repo
 * bucket in derive.ts is span-resolved per event, so it reconciles both ways.
 */
// `repos` is a LIST or null, not a single name, so one organization's roster can
// be narrowed by a class as easily as by a repository. null means every
// repository; an EMPTY list would mean none, which is why callers pass
// `scopedRepos()` (null when unscoped) rather than a filtered array.
const membersOf = (org, repos = null) =>
  rollup(orgPeople.filter((r) => r.org === org && (!repos || repos.includes(r.repo))),
         (r) => r.id, FIELDS)
    .map((r) => ({ ...byId.get(r._key), ...r }));

// ------------------------------------------------------- activity log

/**
 * Event kinds, in the order they appear in the filter.
 *
 * `landed`/`declined`/`open` are deliberately absent: those are verdicts other
 * people reached later, not things the author did on a date. A proposal shows up
 * once, on the day it was proposed.
 *
 * Derived from EVENT_KINDS rather than restated. The order that list declares is
 * chronological within a change's life — written, proposed, reviewed, discussed,
 * reported — and `comment`/`reviewcomment` stay two kinds under one metric,
 * because a line-level comment and a timeline comment link to different places
 * and the split is worth being able to see. Restating them here meant a new
 * pipeline kind was counted in the log's "all (N)" and missing from the filter
 * that claims to list every kind: a filter hiding its own alternatives.
 */
const KINDS = EVENT_KINDS.map((k) => k.kind);
// The kinds that sum into the `comments` metric, derived from the one table that
// declares the kind->metric mapping.
const COMMENT_KINDS = new Set(EVENT_KINDS.filter((k) => k.field === "comments").map((k) => k.kind));
const KIND_LABEL = Object.fromEntries(
  EVENT_KINDS.filter((k) => k.label).map((k) => [k.kind, k.label]));

/**
 * The log ships as one file fetched ON DEMAND, not with the first paint.
 *
 * It is 865KB uncompressed (125KB gzipped) against 443KB (39KB gzipped) for
 * everything the index views need, so putting it on the critical path would
 * triple the bytes of a first paint — quadruple them over the wire — for detail
 * nobody has asked for yet. One shared file rather than ~390 per-scope shards
 * (83 organizations, 6 repositories, 300 people) because an organization's log
 * is exactly its members' events, so both report types read the same bytes, and
 * the browser caches it once for the session.
 *
 * render() is synchronous by design, so the first call returns a placeholder and
 * re-renders when the fetch settles. A failed fetch is recorded as an error
 * rather than retried forever: the aggregates above it are still valid, and a
 * spinner that never resolves is a worse lie than a stated failure.
 */
let log = null;
let logState = "idle"; // idle | loading | ready | failed
function loadLog() {
  if (logState !== "idle") return;
  logState = "loading";
  load("events").then((d) => {
    log = d;
    logState = "ready";
    render();
  }).catch(() => {
    logState = "failed";
    render();
  });
}

/**
 * Per-item facts and branch attribution, fetched on demand like the log.
 *
 * A second lazy file rather than a field on the log, because the two answer
 * different questions and only the item page wants both. Same failure contract:
 * a failed fetch is STATED, never retried forever behind a spinner.
 */
let items = null;
let itemState = "idle"; // idle | loading | ready | failed
function loadItems() {
  if (itemState !== "idle") return;
  itemState = "loading";
  load("items").then((d) => {
    items = d;
    itemState = "ready";
    render();
  }).catch(() => {
    itemState = "failed";
    render();
  });
}

/**
 * Build a report URL carrying both optional filter segments.
 *
 * Segments are classified by VALUE rather than by position (see the router), so
 * order is cosmetic — but it is kept stable here so a given filter state has one
 * canonical URL and the browser history does not fill with equivalents.
 */
const reportPath = (base, { repo = null, kind = null } = {}) =>
  // Nothing rides along. `metric` used to, being the one control that meant the
  // same thing on every view; now that the lens IS a table's sort, it is scoped
  // to a table like `q.*`/`org`/`repo` and carrying it would be the leak described
  // on `state` -- a sort for a table the destination may not even render.
  `#/${base}${repo ? `/${repo}` : ""}${kind ? `/${kind}` : ""}`;

/**
 * The activity log for one scope.
 *
 * `match` selects events; `base`/`repo` build the filter links. The counts in
 * the kind filter are computed BEFORE the kind filter is applied, so the control
 * shows what is available rather than what is selected — a filter that hides its
 * own alternatives is a dead end, which is the whole complaint this view answers.
 */
function activityLog({ match, base, repo, kind, showWho = false, showRepo = true }) {
  const head = sectionHeading("Activity", "log");
  if (logState !== "ready" && logState !== "failed") head.setAttribute("data-section-pending", "");
  if (logState === "failed") {
    return [head, el("p", { class: "empty" }, "Could not load the activity log.")];
  }
  if (logState !== "ready") {
    loadLog();
    return [head, el("p", { class: "empty" }, "Loading\u2026")];
  }

  const mine = log.events.filter(match);
  const counts = {};
  for (const e of mine) counts[e.k] = (counts[e.k] ?? 0) + 1;
  const rows = kind ? mine.filter((e) => e.k === kind) : mine;

  // A bare label, not a bar: table() renders it inside the bar it owns, beside
  // that table's search box, so the two controls that narrow this log sit
  // together.
  const kindPick =
    el("label", {}, "kind ",
      el("select", {
        "data-focus": "kind",
        onchange: (e) => {
          location.hash = reportPath(base, { repo, kind: e.target.value || null });
        },
      },
        el("option", { value: "", selected: kind ? null : "" }, `all (${fmt(mine.length)})`),
        ...KINDS.filter((k) => counts[k]).map((k) =>
          el("option", { value: k, selected: kind === k ? "" : null },
            `${KIND_LABEL[k] ?? k} (${fmt(counts[k])})`))));

  if (!rows.length) {
    // Wrapped here because there is no table to hold the bar, and the kind pick
    // has to stay reachable when it is what emptied the log.
    return [head, el("div", { class: "controls" }, kindPick),
            el("p", { class: "empty" }, "No activity recorded.")];
  }

  /**
   * Whether an event happened on an ISSUE, read from the item rather than from
   * the event.
   *
   * `e.k === "issue"` is the kind of the EVENT -- someone opened an issue -- and
   * says nothing about the thing a `comment` or `review` event landed on. Reading
   * it as the item's kind called every issue a pull request unless the row
   * happened to be its opening event: 221 of 1,221 items. GitHub redirects
   * between /pull and /issues so the outbound link survived that, which is
   * exactly why it went unnoticed until an inbound link -- which gets no
   * redirect -- was built from the same expression.
   */
  const issues = new Set(log.issueKeys ?? []);
  const isIssue = (e) => issues.has(`${e.r}#${e.ref}`);

  // GitHub's own anchor formats, which is why the id is stored and the URL is
  // not: `url` on the GraphQL node is exactly `<parent>#<this>-<databaseId>`,
  // so keeping the id costs ~13 bytes an event against ~75 for the full URL.
  const ANCHOR = {
    comment: "issuecomment",
    review: "pullrequestreview",
    // Same anchor as the review it belongs to, because it IS that review's body
    // -- GitHub gives the prose no id of its own. The two rows therefore land a
    // reader on the same place, which is correct: one submission, two acts.
    reviewnote: "pullrequestreview",
    reviewcomment: "discussion_r", // no dash: GitHub writes `#discussion_r123`
  };

  const url = (e) => {
    const b = summary.repoUrls?.[e.r];
    if (!b) return null;
    // A commit ref is a sha; everything else is a PR/issue number. GitHub
    // redirects between /pull and /issues, but sending each to its own path
    // avoids a redirect on every click.
    const base = e.k === "commit" || e.k === "coauthored" ? `${b}/commit/${e.ref}`
      : isIssue(e) ? `${b}/issues/${e.ref}`
      : `${b}/pull/${e.ref}`;
    // A review or comment lands on the exact one. Without this, clicking a
    // comment on a pull request carrying 90 reviews drops the reader at the top
    // and asks them to go hunting — the link points at the container, not the
    // thing the row is about. Falls back to the container when no id was pulled.
    if (!e.i || !ANCHOR[e.k]) return base;
    const a = ANCHOR[e.k];
    return `${base}#${a}${a.endsWith("_r") ? "" : "-"}${e.i}`;
  };
  const title = (e) => e.t ?? log.titles[`${e.r}#${e.ref}`] ?? null;

  // Every row is rendered, eagerly. On the largest log (#/repo/ucp, 5,190
  // events, ~41,500 nodes) that blocks the main thread for ~1.4s at 4x CPU
  // throttling — a mid-range laptop — and ~350ms unthrottled. Every other route
  // blocks 0ms. This is a known, bounded cost, left in deliberately, and the
  // two obvious fixes are both worse. Measured, so nobody has to re-derive it:
  //
  //   JS building the rows          273ms   (+155ms for the tables above it)
  //   view.replaceChildren           75ms
  //   browser style + layout        898ms   <- 64% of it
  //   syncStuck                       0ms
  //
  // So it is not this function's work, and not the insertion. It is the browser
  // styling and laying out ~41,500 fresh nodes in one pass. Scrolling the result
  // holds 74fps and the heap is 3MB, so SIZE is not the problem — the one-shot
  // style+layout pass is.
  //
  // Do not "fix" it by yielding between insertions. Chunking the append at 500
  // rows measured 3,354ms of total blocking against 131ms for a single append,
  // because each yield buys another style/layout/paint pass over a table that is
  // already 187,000px tall. More yielding, more jank — the cost splits the 428ms
  // that is not the problem and multiplies the 898ms that is.
  //
  // Do not fix it by capping the rows either. This log is the evidence layer
  // under the claim the rest of the tool rests on — that every figure decomposes
  // into rows beneath it and sums back. Rendering 200 of 5,190 is fast and cheap
  // to build, and it trades away the one property that makes the numbers
  // checkable.
  //
  // The real fix is to let the browser skip off-screen rows, which needs
  // `content-visibility: auto` — and that has no effect on table internals,
  // because they do not support size containment (verified: applied to `tr` and
  // to `tbody`, computed style `auto`, table height unchanged to the pixel). The
  // same 31,000 nodes as a grid of divs cost 160ms against 585ms as a table.
  // Column widths were also stable across chunk sizes, so a fixed-width grid
  // would not shift as rows arrive.
  //
  // That makes the fix structural, not a tweak: the log stops being a <table>,
  // needs role=table/row/cell to stay readable to a screen reader, and needs
  // sorting reimplemented against a grid. Worth doing, too big to smuggle in
  // here, and pointless to attempt without re-measuring the four numbers above.
  //
  // SEARCH pays the same cost, once per keystroke, because a filter is a
  // re-render. It is free everywhere the tables are ordinary — 4ms a keystroke on
  // #/orgs (85 rows), 3ms on #/repos, 3-33ms on #/people (300), ~20ms on a
  // 1,541-row log — and expensive only here: 327ms for the first character and
  // ~100ms after, or 1,490ms then ~420ms at 4x. Cost tracks MATCHED rows, so it
  // falls with every character typed; the worst case is one keystroke, not a
  // sustained state.
  //
  // Deliberately NOT debounced. To coalesce anything at a human typing rate of
  // 150-250ms a character the delay has to exceed ~250ms, which is perceptible
  // lag added to the five routes that filter in single-digit milliseconds, to
  // half-fix the one that does not — 1.5s is no more usable than 4s. The grid
  // conversion above removes this too, which is the second reason to do it and
  // the reason not to paper over it here.
  // Four of these six columns render something the row does not literally
  // contain — a kind label, a display name, a short sha, a title from a side
  // table — so without `text` a search would miss exactly the words on screen.
  // Declared once per column and used for both rendering and matching, so the
  // two cannot describe different strings.
  const who = (e) => bySlug.get(e.p)?.name ?? e.p;
  const ref = (e) => (typeof e.ref === "number" ? `#${e.ref}` : String(e.ref).slice(0, 7));

  /**
   * This site's own page for the item an event happened on, or null when there
   * is none. Mirrors the `issue` vs pull-request split that `url()` above already
   * makes against GitHub's paths, from the same field, so the inbound and
   * outbound links for one row cannot disagree about what kind of thing it is.
   */
  const itemPath = (e) =>
    e.k === "commit" || e.k === "coauthored" ? null
      : `#/${isIssue(e) ? "issue" : "pr"}/${e.r}/${e.ref}`;

  // No `head` here: the table renders its own title on the control bar, beside
  // the kind filter. The three states above still need a standalone one, because
  // there is no table to hang it on when the log is loading, failed or empty.
  return [
    table([
      { key: "d", label: "Date" },
      { key: "k", label: "Kind", text: (e) => KIND_LABEL[e.k] ?? e.k },
      // Constant on a repository page, where the name is already the heading.
      showRepo && { key: "r", label: "Repository" },
      showWho && { key: "p", label: "Contributor", text: who,
        cell: (e) => el("a", { class: "link", href: `#/person/${e.p}` }, who(e)) },
      // Searchable by BOTH forms: the cell shows seven characters of a sha, and
      // the thing a reader has on their clipboard is the whole one. "Search what
      // you see" would have made pasting a commit id find nothing.
      { key: "ref", label: "Reference", text: (e) => `${ref(e)} ${e.ref}`,
        cell: (e) => {
          const href = url(e);
          return href
            ? el("a", { class: "link", href, target: "_blank", rel: "noopener" }, ref(e))
            : ref(e);
        } },
      // The reason to click. A bare sha or PR number is a link with nothing
      // said for it; this is what makes a one-event organization page readable.
      //
      // Two destinations in one row, deliberately: the reference goes OUT to the
      // exact comment or review on GitHub, the title comes IN to this site's page
      // for the same item. Collapsing them would have to drop one, and both are
      // load-bearing -- the outbound link is the only route to the source, the
      // inbound one is the only route to the cast behind the number.
      //
      // A commit event has no item page, so it stays plain text rather than
      // linking somewhere that renders "No item".
      { key: "t", label: "Title", cls: "title", text: (e) => title(e) ?? "\u2014",
        cell: (e) => {
          const t = title(e);
          if (!t) return "\u2014";
          const path = itemPath(e);
          return path ? el("a", { class: "link", href: path }, t) : t;
        } },
    ].filter(Boolean), rows, `log:${base}`,
      // No single field identifies an event: `ref` repeats across kinds (a pull
      // request is proposed, reviewed and commented on under one number) and a
      // date repeats across everything. Keyed on what actually makes an event
      // distinct -- who did what to which thing, when.
      { rowKey: (e) => `${e.r}\u0000${e.k}\u0000${e.ref}\u0000${e.p}\u0000${e.d}`,
        title: "Activity", dflt: { key: "d", dir: -1 }, controls: [kindPick] }),
  ];
}

/**
 * Repository classes, in the order a reader should meet them: what UCP is, what
 * operates on it, what consumes it.
 *
 * Ordered here rather than sorted from the data, because alphabetical would open
 * with `impl` -- putting the consumers before the thing they consume.
 */
// Filtered against what the data actually holds. As a bare literal this offered
// the reader a class no repository carried, and `scopedRepos()` answered it with
// `[]` -- which is truthy, so every row was filtered out and the page rendered
// empty. That is the same trap the repo/class precedence rule below exists to
// avoid, left open one level up: a control may not offer a choice that selects
// nothing.
const CLASSES = ["spec", "tooling", "impl"]
  .filter((c) => summary.repos.some((r) => summary.repoClass?.[r] === c));
const CLASS_LABEL = { spec: "Specification", tooling: "Tooling", impl: "Implementations" };
const classOf = (repo) => summary.repoClass?.[repo] ?? null;

/**
 * The repositories the current filters select, or null for "all of them".
 *
 * null rather than the full list on purpose: an unscoped figure must read the
 * authoritative project-wide total, not a sum reconstructed from per-repository
 * rows. The two agree today; if they ever stop, the unscoped number should be
 * the one that is right.
 */
const scopedRepos = () =>
  state.repo ? [state.repo]
  : state.cls ? summary.repos.filter((r) => classOf(r) === state.cls)
  : null;

/** True when any repository filter is active, so a page-wide total is partial. */
const isScoped = () => !!(state.repo || state.cls);

/**
 * Read field `f` for a person under the current repository scope.
 *
 * Unscoped reads the person's own total. Scoped SUMS their per-repository rows,
 * which is why `repo` and `class` need no separate branches -- a single
 * repository is a set of one. Only additive volume fields may pass through here;
 * a rate cannot be summed, which is why `accepted` is dropped while scoped.
 */
const scopeBy = (p, f) => {
  const only = scopedRepos();
  if (!only) return p[f];
  return (p.repos ?? [])
    .filter((r) => only.includes(r.repo))
    .reduce((n, r) => n + (r[f] ?? 0), 0);
};

document.getElementById("sub").textContent =
  `${fmt(summary.totals.commits)} commits · ${summary.repos.length} repositories · ` +
  `${summary.range.first} → ${summary.range.last}`;

/**
 * The page-level picks, as a LIST of nodes rather than a bar.
 *
 * They are handed to table() and rendered inside the bar it owns, so a table and
 * its controls arrive together. The search box used to live here, which meant a
 * view could render a filter next to a table the filter did not address — and
 * with nine tables it eventually would have.
 */
function controls({ org = false, repo = false, cls = repo } = {}) {
  const pick = (label, value, options, set) =>
    el("label", {}, `${label} `,
      el("select", {
        "data-focus": label,
        // No render() here: set() writes the URL, and the URL is what render
        // reads. Redrawing from the old address bar and then again from the new
        // one would render twice, the first time with stale state.
        onchange: (e) => set(e.target.value),
      },
        ...options.map(([v, text]) =>
          el("option", { value: v, selected: value === v ? "" : null }, text))));

  // Only FILTERS live here. A `metric` dropdown used to sit first in this list,
  // and being next to two real filters is most of why it misread: it never
  // filtered anything: it moved a bar and an inline share onto one column, which
  // is what ordering a table by that column means. Clicking the header does that
  // and orders the rows too, so the dropdown was the same idea with half the
  // effect. See `focus()`.
  return [
    // orgName() is the single display-name lookup; reading o.name here instead
    // gave the pseudo-orgs a second, unstyled naming path.
    org && pick("org", state.org, [["", "all"], ...orgs.map((o) => [o.org, orgName(o.org)])],
      (v) => setParam("org", v)),
    // Class before repository, because it is the coarser cut and reading them in
    // that order describes a narrowing. Selecting a repository does not clear the
    // class control -- the address stays literally what the reader typed -- but
    // `scopedRepos()` lets the repository win, so what is shown always matches
    // the narrower of the two rather than an intersection that can be empty.
    cls && pick("class", state.cls,
      [["", "all"], ...CLASSES.map((c) => [c, CLASS_LABEL[c]])],
      (v) => setParam("class", v)),
    repo && pick("repo", state.repo, [["", "all"], ...summary.repos.map((r) => [r, r])],
      (v) => setParam("repo", v)),
  ].filter(Boolean);
}

// Org names are links everywhere they appear, so drilling from any table into
// "who, specifically?" is one click.
// `repo` scopes the destination. From a repository page, clicking an organization
// should land on that organization *within that repository* — which is the
// existing #/org/:id/:repo page, not a second cross-filter route rendering the
// same cross-product from the other side.
const orgCell = (row, repo = null) => {
  const label = row.name ?? orgName(row.org);
  const link = el("a", { class: "link", href: reportPath(`org/${row.org}`, { repo }) }, label);
  return isAttributed(row.org) ? link : el("span", { class: "tag pseudo" }, link);
};

/** `a`, `a and b`, `a, b and c` -- Oxford comma omitted, matching the site's prose. */
const listSentence = (xs) =>
  xs.length <= 1 ? (xs[0] ?? "")
    : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

const personLink = (p) =>
  el("a", { class: "link", href: `#/person/${p.slug}` }, p.name);

const repoTotal = (repo, field) =>
  repoOrgs.filter((x) => x.repo === repo).reduce((n, x) => n + x[field], 0);

/**
 * The `595 commits` clause of a table's note, or null when the table is sorted by
 * something that is not a measurement.
 *
 * Dropped rather than defaulted. The clause totals the column in FOCUS -- the one
 * carrying the bar -- and sorted alphabetically there is no focus column. Falling
 * back to commits would print a figure the reader did not ask for beside a table
 * that emphasises nothing, which is a quieter version of the bug this whole
 * change removes.
 */
const focusTotal = (m, rows, read = (r, f) => r[f]) =>
  m ? `${fmt(rows.reduce((n, r) => n + read(r, m), 0))} ${METRICS[m]}` : null;

/** `N things · M commits.` with the second clause omitted when there is no focus. */
const countAnd = (n, noun, total) =>
  `${[`${fmt(n)} ${plural(n, noun)}`, total].filter(Boolean).join(" \u00b7 ")}.`;

// ------------------------------------------------------------------- views

function orgsView() {
  const m = focus("orgs");
  const only = scopedRepos();
  const rows = repoOrgs.filter((r) => !only || only.includes(r.repo));
  const total = m ? rows.reduce((n, r) => n + r[m], 0) : 0;
  // Ranked rows are NAMED organizations only. Unknown, undisclosed, independent
  // and automation are display buckets, not organizations: they stay in the
  // project totals and the share denominator below, and keep their own report
  // pages (linked from the note), but a bucket is not ranked against employers.
  const all = rollup(rows, (r) => r.org, FIELDS);
  const buckets = all.filter((r) => !isAttributed(r._key)).map((r) => r._key);
  const merged = all.filter((r) => isAttributed(r._key)).map((r) => ({
    org: r._key,
    name: orgName(r._key),
    // Same trap the organization report page had: p.org is affiliation at latest
    // activity, so counting it here showed one organization as 0 contributors
    // next to its own 2 commits and 16 reviews. Membership means "has activity
    // attributed to this organization", which is what membersOf resolves per event.
    people: membersOf(r._key, only).length,
    ...r,
  }));

  // The project's own split was previously buried in a warning banner. It is
  // not a warning — it is the most informative row in the dataset, and it uses
  // exactly the same panels as every other scope.
  //
  // Summed from `rows`, which the scope has already narrowed, NOT from the whole
  // of `repoOrgs`. Reading the unscoped set here printed one unchanging headline
  // above a table that changed underneath it: "83% accepted" stood over the
  // specification, the tooling and the implementations alike, when their real
  // rates are 81.6%, 81.3% and 84.4%. The rate itself is safe to recompute
  // because `acceptance()` derives it from the landed/declined it is handed --
  // it is only a stored rate that cannot be re-scoped.
  const project = Object.fromEntries(
    FIELDS.map((f) => [f, rows.reduce((n, r) => n + r[f], 0)]));

  return [
    sectionHeading(state.repo ? state.repo
                   : state.cls ? CLASS_LABEL[state.cls] : "The project", "summary"),
    // Project-mode notes are project-wide claims -- "% of human reviews
    // attributed" is measured across every repository -- so a scoped panel takes
    // the ordinary notes, which state this scope's share OF the project and stay
    // true when the scope narrows.
    statGroups(project, !isScoped()),
    table([
      { key: "name", label: "Organization", cell: orgCell },
      { key: "people", label: "Contributors", n: true },
      ...metricCols({ active: m, accepted: !!summary.github,
        share: m && { of: "project", total: () => total } }),
    ], merged, "orgs", { rowKey: (r) => r.org,
      title: state.repo ? `Organizations in ${state.repo}`
           : state.cls ? `Organizations — ${CLASS_LABEL[state.cls].toLowerCase()}`
           : "Organizations",
      controls: controls({ repo: true }),
      // Both figures come from the shown rows, so the pair stays coherent under
      // search. The share column's denominator deliberately does NOT: it is
      // labelled a share of the project, and a denominator that moved with the
      // filter would make every percentage a different question.
      note: (shown) => [
        `${countAnd(shown.length, "organization", focusTotal(m, shown))} `,
        "Click an organization to see its contributors.",
        ...(buckets.length ? [
          " Not ranked, but counted in the totals above: ",
          ...buckets.flatMap((b, i) => [i ? ", " : "", orgCell({ org: b }, state.repo || null)]),
          ".",
        ] : []),
      ],
    }),
  ];
}

function reposView() {
  const m = focus("repos");
  // `Attributed` is a share OF something and needs a field even when the table is
  // sorted by a column that is not one. It follows the focus where there is one,
  // because a reader looking at reviews wants review attribution, and falls back
  // to the default otherwise. Which field it used was never stated before; the
  // help text below now names it, so the column cannot quietly change meaning.
  const am = m ?? DEFAULT_METRIC;
  // Class narrows which repositories are rows here, where every other view uses
  // it to narrow what a row SUMS. Same filter, and on this page the two happen to
  // be the same operation, because the row IS a repository.
  const rows = repoOrgs.filter((r) =>
    (!state.org || r.org === state.org) && (!state.cls || classOf(r.repo) === state.cls));
  const merged = rollup(rows, (r) => r.repo, FIELDS).map((r) => {
    const inRepo = repoOrgs.filter((x) => x.repo === r._key);
    const real = inRepo.filter((x) => isAttributed(x.org));
    const realTotal = real.reduce((n, x) => n + x[am], 0);
    // HUMAN activity, the published coverage denominator: automation is neither
    // attributed nor unattributed, so counting it here understated attribution
    // in any repository with a busy bot (99/160 printed where 99/110 is true).
    const repoTotal = inRepo.filter((x) => x.org !== "bot").reduce((n, x) => n + x[am], 0);
    return {
      repo: r._key, ...r,
      class: classOf(r._key),
      // Named organizations; a display bucket is not an organization.
      orgCount: new Set(real.map((x) => x.org)).size,
      attributed: pct(realTotal, repoTotal),
      // Sorting reads the ratio, never the rendered string: `attributed` is an
      // em-dash when the denominator is zero, and parseFloat("—") is NaN, which
      // sorts as a hole wherever it lands.
      attributedShare: repoTotal ? realTotal / repoTotal : 0,
    };
  });

  return [
    table([
      // Inward, not outward: this was the only table whose rows ejected the
      // reader to GitHub, leaving no way to ask who works on a repository. The
      // outbound link now lives on the repository page, as it does for a person.
      { key: "repo", label: "Repository",
        cell: (r) => el("a", { class: "link", href: `#/repo/${r.repo}` }, r.repo) },
      // Not a link: a class is a page filter, and the control above already sets
      // it. A second, differently-shaped way to reach the same state is how the
      // sort/filter confusion started.
      { key: "class", label: "Kind", text: (r) => CLASS_LABEL[r.class] ?? "\u2014",
        help: "Specification, the tooling that operates on it, or an " +
              "implementation that consumes it. Hand-assigned in data/repos.json5." },
      { key: "orgCount", label: "Orgs", n: true },
      ...metricCols({ active: m }),
      { key: "attributed", label: "Attributed", n: true, sortKey: (r) => r.attributedShare,
        help: `Share of human ${METRICS[am]} credited to a named organization. ` +
              "Independent, undisclosed and unknown count against it; automation is " +
              "excluded from both sides." },
    ], merged, "repos", { rowKey: (r) => r.repo,
      title: state.org ? `Repositories — ${orgName(state.org)} only` : "Repositories",
      // `repo: true` would be a control that filters this table to one of its own
      // rows, so only the class cut is offered here.
      controls: controls({ org: true, cls: true }) }),
  ];
}

function peopleView() {
  const m = focus("people");
  // With an organization selected, rows come from the span-resolved
  // person x org x repo bucket rather than `person.org` — filtering on that field
  // drops anyone who has since changed employer and credits their earlier work
  // to the new organization. See membersOf.
  const only = scopedRepos();
  const rows = (state.org ? membersOf(state.org, only) : people)
    // Someone with no row in ANY selected repository is not on this page. Written
    // against the resolved set so a class narrows the roster the same way a single
    // repository always has -- the bug the previous `state.repo` test would have
    // had was showing every contributor with a zero beside their name.
    .filter((p) => state.org || !only || p.repos.some((r) => only.includes(r.repo)));

  // With a repository scope active, every metric narrows to it rather than
  // showing project-wide numbers next to a scoped table. Rows from membersOf are
  // already repo-scoped, so they need no further narrowing.
  const scope = (p, f) => (!state.org ? scopeBy(p, f) : p[f]);
  return [
    table([
      // Searching an address finds the person: an email is an identity key here,
      // which is why one contributor can hold several. It is not a column, so the
      // default (search what the column shows) would have quietly dropped the
      // only way to look someone up by the address on their commits.
      { key: "name", label: "Name", cell: personLink,
        text: (p) => [p.name, ...p.emails].join(" ") },
      !state.org && { key: "orgName", label: "Organization",
        cell: (p) => orgCell({ org: p.org, name: p.orgName }) },
      // `accepted` is a RATE, and a rate cannot be summed across repositories the
      // way the volume columns can, so it leaves whenever a scope is on.
      ...metricCols({ active: m, scope, accepted: !!summary.github && !isScoped() }),
    ], rows, "people", { rowKey: (r) => r.slug, title: "Contributors",
      controls: controls({ org: true, repo: true }),
      note: (shown) => countAnd(shown.length, "contributor", focusTotal(m, shown, scope)),
    }),
  ];
}

function orgView(id, segs = []) {
  // Two tables, two sorts, two focus columns. This used to be one page-level
  // metric shading both, which meant one of them was always shaded by a column it
  // was not ordered by.
  const mRepos = focus("org-repos");
  const mPeople = focus("org-people");
  const all = repoOrgs.filter((r) => r.org === id);
  if (!all.length) return [el("p", { class: "empty" }, `No organization \u201c${id}\u201d.`)];

  // A stale or unknown repo segment degrades to the whole organization rather
  // than rendering an empty page.
  const sel = segs.find((s) => all.some((r) => r.repo === s)) ?? null;
  const kind = segs.find((s) => KINDS.includes(s)) ?? null;
  const rows = sel ? all.filter((r) => r.repo === sel) : all;

  // A path segment, so it is a single repository or nothing -- the class control
  // is page state and the report pages deliberately ignore page state.
  const members = membersOf(id, sel ? [sel] : null);
  const sum = (f) => rows.reduce((n, r) => n + r[f], 0);
  const totals = Object.fromEntries(FIELDS.map((f) => [f, sum(f)]));

  return [
    el("p", {}, el("a", { class: "link", href: "#/orgs" }, "\u2190 all organizations")),
    el("div", { class: "report-head" }, sectionHeading(orgName(id), "overview")),
    // Scope descriptors belong in the header, not the metric grid: "10 people"
    // answers "who is this", not "how much did they do".
    el("p", { class: "scope" },
      `${fmt(members.length)} ${plural(members.length, "contributor")} \u00b7 `,
      ...(sel
        // "in ucp x all repositories" read as a cross-product rather than a
        // clear affordance; the separator makes it a distinct item.
        ? [`in `, el("strong", {}, sel), " \u00b7 ",
           el("a", { class: "link", href: reportPath(`org/${id}`, { kind }) },
              "show all repositories")]
        : [`${all.length} ${plural(all.length, "repository", "repositories")}`])),
    statGroups(totals),

    // Always every repository, even when one is selected — filtering this table
    // to the selection would remove the only way to change it.
    table([
      { key: "repo", label: "Repository",
        // Selecting a repository scopes this entire page, panel included, so
        // every figure still decomposes into the rows beneath it. Scoping only
        // the contributor table would leave the panel silently disagreeing with
        // it, which is the defect this whole change exists to remove.
        cell: (r) => el("a", {
          class: "link",
          // Changing the repository preserves the kind filter, because the two
          // are independent scopes and dropping one on touching the other makes
          // the pair unusable together.
          href: reportPath(`org/${id}`, { repo: r.repo === sel ? null : r.repo, kind }),
        }, r.repo) },
      ...metricCols({
        active: mRepos,
        accepted: !!summary.github,
        share: mRepos && { of: "repo", total: (r) => repoTotal(r.repo, mRepos) },
      }),
    ], all, `org-repos:${id}`, { rowKey: (r) => r.repo, title: "By repository",
      controls: controls(),
      rowCls: (r) => (r.repo === sel ? "sel" : null),
    }),

    table([
      { key: "name", label: "Name", cell: personLink },
      ...metricCols({
        active: mPeople,
        accepted: !!summary.github,
        share: mPeople &&
          { of: sel ? `${orgName(id)} in ${sel}` : orgName(id), total: () => sum(mPeople) },
      }),
    ], members, `org-people:${id}`, { rowKey: (r) => r.slug, title: sel ? `Contributors in ${sel} (${members.length})` : `Contributors (${members.length})` }),

    // An organization's log is exactly its members' events, resolved the same
    // way the panel above is: by the affiliation active on each event's date.
    // So a person who changed employer mid-project appears here only for the
    // events that fall inside their span with this organization.
    ...activityLog({
      base: `org/${id}`, repo: sel, kind, showWho: true,
      match: (e) => e.o === id && (!sel || e.r === sel),
    }),
  ];
}

/**
 * One repository, pivoted: which organizations work on it, which people do, and
 * what happened. Mirrors the organization page, because the two are the same
 * question asked along different axes.
 *
 * The contributor table is deliberately NOT rolled up by person. Someone who
 * changed employer mid-project contributed to this repository under each of them,
 * and one row per (person, organization) is what the record actually says. It
 * also makes this table reconcile field-for-field with the organization table
 * above it. Rolling up would force a single label onto a person who genuinely had
 * two — the attribution defect that broke the organization pages three times.
 * `verify` asserts the two rollups agree, so a regression fails the build rather
 * than showing two tables that quietly disagree in public.
 *
 * Dropdown state (`state.org`, `state.repo`) is ignored on purpose: it lives in
 * memory rather than the URL, so honouring it here would let one address render
 * two different pages. Scope comes from path segments only, exactly as it does on
 * the organization and person pages. Sort is not dropdown state -- it is in the
 * URL -- so each table below reads its own.
 */
function repoView(id, segs = []) {
  const mOrgs = focus("repo-orgs");
  const mPeople = focus("repo-people");
  const all = repoOrgs.filter((r) => r.repo === id);
  if (!all.length) return [el("p", { class: "empty" }, `No repository \u201c${id}\u201d.`)];

  const kind = segs.find((s) => KINDS.includes(s)) ?? null;
  const totals = Object.fromEntries(
    FIELDS.map((f) => [f, all.reduce((n, r) => n + r[f], 0)]));

  const mine = orgPeople.filter((r) => r.repo === id);
  // Distinct heads, not rows: an organization's contributor count must not
  // double-count the one person who appears under two of them.
  const headsByOrg = new Map();
  for (const r of mine) {
    if (!headsByOrg.has(r.org)) headsByOrg.set(r.org, new Set());
    headsByOrg.get(r.org).add(r.id);
  }
  const orgRows = rollup(all, (r) => r.org, FIELDS)
    .map((r) => ({ org: r._key, ...r, people: headsByOrg.get(r._key)?.size ?? 0 }));

  // The person record supplies name and slug; the repo-scoped row overrides `org`
  // and every metric. Note the person record also carries `orgName` — their
  // LATEST employer — which is exactly the stale field that must not be rendered
  // here, so the organization cell resolves from `row.org` through orgName().
  const members = mine.map((r) => ({ ...byId.get(r.id), ...r }));
  const heads = new Set(members.map((r) => r.id)).size;

  // One per table: the denominator is the repository total of whichever field
  // that table is ordered by, and the two tables can now be ordered differently.
  const shareOf = (f) => f && { of: "repository", total: () => totals[f] };
  const url = summary.repoUrls?.[id];
  const orgCol = { key: "org", label: "Organization",
    sortKey: (r) => orgName(r.org), cell: (r) => orgCell({ org: r.org }, id) };

  return [
    el("p", {}, el("a", { class: "link", href: "#/repos" }, "\u2190 all repositories")),
    el("div", { class: "report-head" }, sectionHeading(id, "overview")),
    // Making the list cell navigate inward would otherwise silently delete the
    // only route to the source. Same placement as a person's @login.
    url && el("p", { class: "meta" },
      el("a", { class: "link", href: url, target: "_blank", rel: "noopener" },
        url.replace(/^https?:\/\/github\.com\//, ""))),
    el("p", { class: "scope" },
      `${fmt(heads)} ${plural(heads, "contributor")} \u00b7 ` +
      `${orgRows.length} ${plural(orgRows.length, "organization")}`),
    statGroups(totals),

    table([
      orgCol,
      { key: "people", label: "Contributors", n: true },
      ...metricCols({ active: mOrgs, accepted: !!summary.github, share: shareOf(mOrgs) }),
    ], orgRows, `repo-orgs:${id}`, { rowKey: (r) => r.org, title: "By organization", controls: controls() }),

    // Heads, not rows — see below.
    table([
      { key: "name", label: "Name", cell: personLink },
      orgCol,
      ...metricCols({ active: mPeople, accepted: !!summary.github, share: shareOf(mPeople) }),
    ], members, `repo-people:${id}`, { rowKey: (r) => r.slug, title: `Contributors (${fmt(heads)})`,
      // Only rendered when the two differ, which is one repository today. Without
      // it the same name twice reads as a de-duplication bug rather than as the
      // measurement it is. Recounted over the shown rows, because a search can
      // leave one row of a split person behind and then the caveat does not
      // apply to what is on screen.
      note: (shown) => {
        const shownHeads = new Set(shown.map((r) => r.id)).size;
        return shown.length > shownHeads
          ? `${fmt(shown.length)} rows for ${fmt(shownHeads)} contributors: affiliation is ` +
            `read at the date of each contribution, so changing employer mid-project splits ` +
            `a person across organizations.`
          : null;
      },
    }),

    ...activityLog({
      base: `repo/${id}`, repo: null, kind, showWho: true, showRepo: false,
      match: (e) => e.r === id,
    }),
  ];
}

/**
 * One pull request or issue: the receipt that makes every aggregate auditable.
 *
 * ONE combined cast table, not two. Writing, reviewing and commenting are three
 * ways of taking part in the same thing, and splitting them into three tables
 * makes the most interesting fact -- that one person did two of them -- something
 * the reader has to reconstruct by scanning for a repeated name. `role` carries
 * the booleans as text for the same reason: three tick columns render a matrix
 * the eye has to decode, where a comma-joined phrase reads in one pass.
 *
 * The cast is assembled from BOTH lazy files. events.json owns reviews and
 * comments -- it already counts them for every other page, and a second count
 * here could disagree with the first -- while items.json owns the item's facts
 * and the branch attribution that no other page can supply.
 */
function itemView(repo, segs = []) {
  const number = segs[0];
  const key = `${repo}#${number}`;

  // Both files or nothing: a half-loaded cast would show reviewers with no
  // writers, or writers with no reviewers, and neither reads as "still loading".
  if (itemState === "failed" || logState === "failed") {
    return [el("p", { class: "empty" }, "Could not load the item detail.")];
  }
  if (itemState !== "ready" || logState !== "ready") {
    loadItems(); loadLog();
    return [el("p", { class: "empty" }, "Loading\u2026")];
  }

  const it = items[key];
  if (!it) return [el("p", { class: "empty" }, `No ${repo === undefined ? "item" : `item \u201c${key}\u201d`}.`)];

  const isPr = it.k === "pr";
  const title = log.titles[key] ?? key;
  const url = summary.repoUrls?.[repo];
  const href = url ? `${url}/${isPr ? "pull" : "issues"}/${number}` : null;

  /**
   * `dest` is the whole reason this page can be trusted, so it is stated in
   * words rather than left implicit in a missing column.
   *
   * A pull request marked landed landed SOMEWHERE, and only 254 of ucp's 299
   * reached the default branch. The other three fates each have a page worth
   * rendering -- a review on a stack component is a real review -- but none of
   * them may contribute lines to any total, and a reader looking at a cast table
   * full of line counts deserves to know which of those they are reading.
   */
  const DEST_NOTE = {
    // The carrier is a LINK, not a bare "#589". It is the one place a reader can
    // go to see where this work actually ended up, and a page that names a
    // destination it will not take you to is the same defect as an event row
    // linking to the top of a 90-comment thread.
    component: (v) => ["Merged into ",
      el("a", { class: "link", href: `#/pr/${repo}/${v}` }, `#${v}`),
      ", not to the default branch. Its lines reach the default branch inside that pull " +
      "request and are counted there, so they are shown here but excluded from every total."],
    // A branch name, not an item, so there is nothing on this site to link to.
    sidebranch: (v) => [`Landed on ${v}, not the default branch. The lines replay work ` +
      `already counted where it first landed, so they are excluded from every total. The ` +
      `review is not a replay and is counted normally.`],
    // Two populations share this class: merges orphaned when history was rewritten
    // at publication, whose content survives inside the seed commit, and stack
    // components whose target branch was later deleted or rewritten. The note is
    // the sentence true of both.
    unreachable: () => ["Reachable from no branch. The history this merged into was later " +
      "rewritten or deleted, so its content reaches the default branch, if at all, only " +
      "inside other commits, where it cannot be split per person. Its lines are excluded " +
      "from every total."],
  };
  // A landed pull request whose branch could not be walked. Stated, because the
  // alternative is a page with no line columns that reads as "nobody wrote this".
  const ABSENT_NOTE = {
    "no-merge-commit": "Branch not measured: GitHub records this pull request as merged " +
      "but names no merge commit, so there is no branch to walk. Who wrote its lines is " +
      "unknown, not zero. Reviews and comments are counted normally.",
    "merge-commit-unfetchable": "Branch not measured: its merge commit is no longer " +
      "available from the public repository, so there is no branch to walk. Who wrote its " +
      "lines is unknown, not zero. Reviews and comments are counted normally.",
  };

  // Reviews are distinct (item, person) pairs -- the unit every other review
  // figure on this site uses. Counting review EVENTS here instead would give this
  // page a larger number than the person page for the same pull request.
  const cast = new Map();
  const at = (slug) => {
    if (!cast.has(slug)) {
      cast.set(slug, { slug, roles: [], added: 0, deleted: 0, commits: 0, reviewed: false, comments: 0 });
    }
    return cast.get(slug);
  };
  // A fifth element is the label of an author known only from this branch walk:
  // there is no person row to link to, so the row is named and left unlinked.
  for (const [slug, added, deleted, commits, label] of it.w ?? []) {
    Object.assign(at(slug), { added, deleted, commits }, label ? { label } : {});
    at(slug).roles.push("wrote");
  }
  if (it.a) at(it.a).roles.unshift("opened");
  for (const e of log.events) {
    if (e.r !== repo || String(e.ref) !== String(number)) continue;
    const row = at(e.p);
    if (e.k === "review") row.reviewed = true;
    // Every kind whose metric is `comments`, read from the shared vocabulary
    // rather than listed here -- a hand-written list is a second definition of
    // what counts as writing, and it went stale the moment `reviewnote` existed.
    else if (COMMENT_KINDS.has(e.k)) row.comments++;
  }
  for (const row of cast.values()) {
    if (row.reviewed) row.roles.push("reviewed");
    // A person who only ever spoke has no other role, and an empty cell here
    // would read as a rendering fault rather than as what they actually did.
    if (!row.roles.length && row.comments) row.roles.push("commented");
    row.role = row.roles.join(", ");
    const p = bySlug.get(row.slug);
    row.linked = Boolean(p);
    row.name = p?.name ?? row.label ?? row.slug;
    row.lines = row.added + row.deleted;
  }
  const rows = [...cast.values()];
  const wrote = rows.filter((r) => r.commits);
  const totalLines = wrote.reduce((n, r) => n + r.lines, 0);

  // The bar follows the sorted column, so the fallback here and the table's
  // `dflt` below must name the SAME key -- they are one default expressed twice,
  // and the first version left them disagreeing (`commits` here, `added` there),
  // which rendered a table sorted by a column carrying no bar.
  const dfltKey = wrote.length ? "added" : "comments";
  const m = focus("item-cast", dfltKey);
  const STATE_LABEL = { landed: "landed", declined: "declined", withdrawn: "withdrawn",
                        open: "open", closed: "closed" };

  return [
    el("p", {}, el("a", { class: "link", href: `#/repo/${repo}` }, `\u2190 ${repo}`)),
    el("div", { class: "report-head" }, sectionHeading(title, "overview")),
    el("p", { class: "meta" },
      href
        ? el("a", { class: "link", href, target: "_blank", rel: "noopener" },
            `${repo}#${number}`)
        : `${repo}#${number}`),
    el("p", { class: "scope" },
      [
        STATE_LABEL[it.s] ?? it.s,
        it.e && it.e !== it.t ? `${it.t} \u2192 ${it.e}` : it.t,
        `${rows.length} ${plural(rows.length, "participant")}`,
        // Never printed as zero: an issue has no branch, so the clause is absent
        // rather than claiming nobody wrote anything.
        wrote.length ? `${fmt(totalLines)} ${plural(totalLines, "line")} across ` +
          `${wrote.length} ${plural(wrote.length, "contributor")}` : null,
      ].filter(Boolean).join(" \u00b7 ")),
    it.d && DEST_NOTE[it.d] && el("p", { class: "note" }, ...DEST_NOTE[it.d](it.v)),
    // An unknown reason still says the branch is unmeasured rather than nothing.
    it.u && el("p", { class: "note" }, ABSENT_NOTE[it.u] ?? "Branch not measured. Who wrote its lines is unknown, not zero."),
    it.r && el("p", { class: "note" },
      `${fmt(it.r)} of this branch's commits ${it.r === 1 ? "replays" : "replay"} a patch ` +
      `already on the default branch and ${it.r === 1 ? "is" : "are"} excluded from the ` +
      `lines below.`),

    table([
      { key: "name", label: "Name", cell: (r) => (r.linked ? personLink(r) : r.name) },
      // No Organization column, deliberately. The only org a cast row could carry
      // is `p.org`, the person's affiliation at their LATEST activity, and on a
      // historical item that asserts an employer they may not have had then (one
      // reviewer here rendered as their later employer on 23 items reviewed
      // under the earlier one). Event-time affiliation per role is not in
      // items.json, and inventing it in the browser would be a second resolver.
      { key: "role", label: "Role", text: (r) => r.role || "\u2014" },
      // Line columns are omitted entirely for an item with no branch behind it,
      // rather than rendered as a column of dashes. An issue has no lines to
      // measure; a column of blanks would say it measured zero.
      // `cell` rather than the default numeric render, because a reviewer did not
      // write zero lines -- they did not write. This site's oldest rule is that an
      // unmeasured metric is never printed as zero, and the default `n: true` path
      // formats a real 0 that says the opposite. `n` is kept for the alignment.
      ...(wrote.length ? [
        { key: "added", label: "Added", n: true, bar: m === "added",
          cell: (r) => (r.commits ? fmt(r.added) : "\u2014") },
        { key: "deleted", label: "Removed", n: true,
          cell: (r) => (r.commits ? fmt(r.deleted) : "\u2014") },
        { key: "commits", label: "Commits", n: true,
          cell: (r) => (r.commits ? fmt(r.commits) : "\u2014") },
      ] : []),
      // A boolean, so it sorts on a number and prints a word. Not a tick: the
      // column has to say what the blank means, and an empty cell beside a ticked
      // one reads as missing data rather than as "did not review".
      //
      // Dropped for an issue, where it can only ever print one value and so
      // carries no information -- an issue has nothing to review. NOT dropped for
      // a pull request that nobody reviewed: there the empty column is the
      // finding, and hiding it would erase the fact that the change went in
      // unexamined.
      isPr && { key: "reviewed", label: "Reviewed", n: true,
        sortKey: (r) => (r.reviewed ? 1 : 0),
        cell: (r) => (r.reviewed ? "yes" : "\u2014") },
      { key: "comments", label: "Comments", n: true,
        cell: (r) => (r.comments ? fmt(r.comments) : "\u2014") },
    ], rows, `item-cast:${key}`, {
      rowKey: (r) => r.slug,
      title: "Who took part",
      dflt: { key: dfltKey, dir: -1 },
      controls: controls(),
    }),
  ];
}

function personView(slug, segs = []) {
  const p = bySlug.get(slug);
  if (!p) return [el("p", { class: "empty" }, `No contributor “${slug}”.`)];
  const mRepos = focus("person-repos");

  // Same contract as the organization page: selecting a repository scopes the
  // whole page, the selection lives in the URL, and an unknown segment degrades
  // to unfiltered rather than rendering an empty report.
  //
  // The affiliation line is deliberately NOT scoped. It answers "who is this
  // person", not "what did they do here" — the same reason the organization page
  // keeps its name in the header when filtered. Scoping its activity windows
  // would additionally need per-(person, org, repo) date bounds, which would grow
  // every person record to serve one contributor: only one of 300 has more than a
  // single affiliation span, and they touched exactly one repository.
  const sel = segs.find((s) => p.repos.some((r) => r.repo === s)) ?? null;
  const kind = segs.find((s) => KINDS.includes(s)) ?? null;

  /**
   * Affiliation sits on its own line under the name and shows only what the data
   * actually contains. Measured against site/data/people.json: 300 people hold
   * 192 spans between them — 109 people have none, 190 have exactly one, and one
   * has two. No single-span contributor has a span whose organization differs
   * from the one derived onto `p.org`. So this line is one organization and one
   * range for 299 of 300 people, which is why the old dedicated "Affiliation"
   * heading, timeline strip and "No affiliation recorded." empty state were pure
   * repetition — and why they split identity into two blocks separated by the
   * stat panels.
   *
   * Ranges are mm/yy because the boundary that matters is which month someone
   * changed employer; a day-precision date implies precision the source does not
   * have (it is hand-entered). The exact date stays available on hover.
   *
   * Two shapes, because every span carries an activity window (see below):
   *
   *   no spans     acme (01/26–08/26)                     the person's own range
   *   one span     acme (01/26–08/26)                     that span's range
   *   chained      globex (06/26–08/26) ← acme (02/26–05/26)
   */
  const mmyy = (d) => `${d.slice(5, 7)}/${d.slice(2, 4)}`;

  /**
   * The range beside each affiliation is measured ACTIVITY, not employment.
   *
   * It has to be: employment boundaries are hand-entered and only 4 of the 192
   * spans carry one at all, so for 188 of them there is no employment range to
   * print — while the activity window is measured for every single one. Because
   * the union of a person's windows is exactly their overall first..last (191
   * people with spans, zero exceptions), this one line subsumes the separate
   * "active X → Y" line it replaces.
   *
   * Known and accepted trade-off: a parenthetical after an employer name is CV
   * convention for employment dates, so "acme (01/26–08/26)" can be misread as
   * having left in August. The exact dates and an explicit disclaimer are on
   * hover. Do not "fix" this by relabelling without asking — the bare form is
   * deliberate.
   */
  const window_ = (from, to) => from && el("span", {
    class: "when help", tabindex: "0",
    "data-help": `Contributed here between ${from} and ${to}. These are activity ` +
      `dates measured from commits and reviews, not employment dates — the ` +
      `affiliation itself may well be ongoing.`,
  }, ` (${mmyy(from)}\u2013${mmyy(to)})`);

  const affiliation = p.spans.length === 0
    ? [orgCell({ org: p.org, name: p.orgName }), window_(p.first, p.last)]
    // Current affiliation first, so the line leads with what is true now and
    // the arrow reads "previously". Copied before reversing: `spans` belongs to
    // the loaded data and render() runs many times — reversing in place would
    // flip the order on every re-render.
    : [...p.spans].reverse().map((sp, i) => [
        i ? el("span", { class: "arrow" }, " ← ") : "",
        orgCell({ org: sp.org }),
        window_(sp.activeFrom, sp.activeTo),
      ]).flat();

  // Logins and emails are the same kind of thing — the identity keys that join a
  // git author to a GitHub account — so they share one line instead of the
  // emails leading and a "GitHub:" line trailing after the panels.
  //
  // A `users.noreply.github.com` address restates the login it encodes, so it is
  // dropped when that login is already shown. GitHub has issued two forms of it
  // (`login@` and `id+login@`), and merging both onto one person put three
  // spellings of the same identity on one line before this filter existed.
  const shown = new Set(p.logins.map((l) => l.toLowerCase()));
  const noreply = (e) => {
    const m = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(e);
    return m ? m[1].toLowerCase() : null;
  };
  const emails = p.emails.filter((e) => {
    const login = noreply(e);
    return !(login && shown.has(login));
  });
  const keys = [
    ...p.logins.map((l) =>
      el("a", { class: "link", href: `https://github.com/${l}`, target: "_blank", rel: "noopener" }, `@${l}`)),
    ...emails.map((e) => el("code", {}, e)),
  ];

  return [
    el("p", {}, el("a", { class: "link", href: "#/people" }, "← all people")),
    // Name owns its line; identity keys then scope stack beneath it.
    sectionHeading(p.name, "overview", { class: "report-name" }),
    keys.length > 0 && el("p", { class: "meta" },
      keys.map((n, i) => [i ? " · " : "", n]).flat()),

    el("p", { class: "scope" },
      ...affiliation.filter(Boolean)),
    /*
     * Roster headings (MAINTAINERS.md, joined by exact alias), on their own
     * line under affiliation.
     *
     * This is the one contribution on the site that leaves no commit, no review
     * and no comment, so it is the one fact a volume table structurally cannot
     * show. Several people here hold a seat and carry twenty reviews and zero
     * commits; without this line they read as marginal.
     *
     * Rendered as text rather than a metric: a seat is a binary fact about a
     * person, and counting seats would rank someone on four councils above
     * someone on one, which is a claim about neither work nor influence.
     *
     * Absent, never "none". 285 of 303 people hold no seat, and printing that on
     * every page would turn a fact about eighteen people into a hole on the other
     * 285 -- and would read identically to the roster never having been pulled.
     */
    p.councils && el("p", { class: "scope" },
      `Council participation: ${listSentence(p.councils)}`),
    // A point-in-time self-report with no history, so it cannot describe a job
    // change and is never consumed as a span. Compact, with the caveat on hover.
    //
    // Shown only where it is not restating the affiliation line directly above
    // it: 116 of the 124 on file are cosmetic variants of the recorded org.
    hintWorthShowing(p.profileCompany, p.orgName) && el("p", { class: "scope caveat" },
      el("span", { class: "help", tabindex: "0",
        "data-help": "Self-reported on their GitHub profile. A current claim with no " +
          "history attached, so it is shown as a hint and never used to compute spans." },
        `profile says “${p.profileCompany}”`)),
    sel && el("p", { class: "scope" },
      "in ", el("strong", {}, sel), " \u00b7 ",
      el("a", { class: "link", href: reportPath(`person/${slug}`, { kind }) },
         "show all repositories")),
    statGroups(sel ? p.repos.find((r) => r.repo === sel) : p),

    // Always every repository, even when one is selected — filtering this table
    // to the selection would remove the only way to change it.
    table([
      { key: "repo", label: "Repository",
        cell: (r) => el("a", {
          class: "link",
          href: reportPath(`person/${slug}`, { repo: r.repo === sel ? null : r.repo, kind }),
        }, r.repo) },
      // Was a hand-rolled copy of metricCols that had drifted: no active-metric
      // class and no sortKey, so this one table lost the marker every other view
      // had. One definition, six call sites.
      ...metricCols({
        active: mRepos,
        accepted: !!summary.github,
        // Review share divides by what this person COULD have reviewed, not by
        // every review in the repository. Nobody reviews their own pull request,
        // so the naive denominator punishes exactly the people who wrote the most:
        // the author of 94% of one repository's lines scores 8.5% of its reviews,
        // which reads as disengagement and is actually the arithmetic of having
        // written the thing. Against eligible items the same person is at 16%.
        //
        // The units line up because a person contributes at most one review pair
        // per item, so their `reviews` IS a count of distinct items reviewed --
        // the same unit as the item count it now divides by.
        share: mRepos && (mRepos === "reviews"
          ? { total: (r) => repoTotal(r.repo, "proposed") - r.proposed,
              help: "Bracketed: share of the pull requests this person did not " +
                    "author, which are the only ones they could review." }
          : { of: "repo", total: (r) => repoTotal(r.repo, mRepos) }),
      }),
    // `person-repos`, not `person`: this key is the table's identity and now names
    // it in the URL as `?q.person-repos=`. Every other key names its CONTENT
    // (`org-repos` is an organization's repositories); `person` named the scope,
    // so the param would have read as a search for a person.
    ], p.repos, `person-repos:${slug}`, { rowKey: (r) => r.repo, title: "By repository", rowCls: (r) => (r.repo === sel ? "sel" : null) }),

    // Matched on slug, not on org: this is everything this person did, including
    // events attributed to a previous employer. The org column is not shown
    // because the affiliation line above already carries that history.
    ...activityLog({
      base: `person/${slug}`, repo: sel, kind,
      match: (e) => e.p === slug && (!sel || e.r === sel),
    }),
  ];
}

// ------------------------------------------------------------- Heartbeat

/**
 * Fetched on demand, like the activity log and for the same reason: 240KB of
 * item-level rows must not sit on the critical path of a page nobody has asked
 * for. Absent file is a legitimate state, not an error to hide — derive writes
 * heartbeat.json only when the GitHub overlay ran, because latency is uncomputable
 * from the git spine (commits carry a date with no clock), and a fabricated zero
 * would be indistinguishable from an instant reply.
 */
let beat = null;
let beatState = "idle"; // idle | loading | ready | missing
function loadHeartbeat() {
  if (beatState !== "idle") return;
  beatState = "loading";
  // Two-argument `then`, then a SEPARATE `.then(render)`, so the rejection handler
  // covers the fetch and nothing else. Written as `.then(...).catch(...)` first,
  // which swallowed exceptions thrown by `render` itself and reported them as "No
  // overlay data" -- a bug in a column definition rendered as a confident
  // statement about the dataset. A render fault now reaches the console, which is
  // the correct place for a fault that is ours rather than the data's.
  load("heartbeat").then(
    (d) => { beat = d; beatState = "ready"; },
    () => { beatState = "missing"; },
  ).then(render);
}

// Hours in, one unit out. Mixing "159.5h" with "31d" in one column asks the
// reader to divide before they can compare two cells sitting on top of each other.
const dur = (h) => (h == null ? null : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);
/** A count and the share it represents, in one cell: `114 (12.6%)`. Shares go
 *  through the site's `pct`, which fixes one decimal: a local rounding helper
 *  printed "2%" beside "12.6%" in the same column. */
const withShare = (a, b) => (b ? `${fmt(a)} (${pct(a, b)})` : fmt(a));

function heartbeatView() {
  if (beatState === "idle") loadHeartbeat();
  const h2 = sectionHeading("Heartbeat", "overview");
  if (beatState === "missing") {
    return [h2, el("p", { class: "empty" },
      "No overlay data. Every figure on this page needs GitHub timestamps: " +
      "commits carry a date with no clock, so latency cannot be computed from git alone.")];
  }
  if (beatState !== "ready") return [h2, el("p", { class: "empty" }, "Loading…")];

  const h = beat;
  const day = (s) => s.slice(0, 10);
  const itemUrl = (i) => {
    const b = summary.repoUrls?.[i.r];
    return b ? `${b}/${i.k === "issue" ? "issues" : "pull"}/${i.n}` : null;
  };
  const repoLink = (r) => el("a", { class: "link", href: `#/repo/${r.repo}` }, r.repo);

  /*
   * The second clause used to explain that GitHub gives no actor for a close, so
   * a withdrawal could not be told from a silent rejection. That stopped being
   * true when `closedBy` started being collected, and a tooltip is the last place
   * a stale caveat should survive — it is the one piece of prose a reader trusts
   * to define the number they are looking at.
   *
   * The excluded count that used to sit under this table as a note lives in
   * the documentation. It is a caveat about a figure rather than a figure, and
   * the page is for the ones a reader can act on.
   */
  const SILENT_HELP =
    `Still open, and more than ${h.silentAfterDays} days after opening nobody but ` +
    `the author has reviewed or commented. Items with an outcome are excluded — a ` +
    `verdict is a response, and a merge is the fastest one available.`;

  /*
   * TWO TABLES, not a row of stat cards, and the sections are load-bearing.
   *
   * Cards were the first attempt and they lied twice. They asserted that six
   * unlike things were peers — a response-time distribution, an outcome timing, a
   * two-way comparison and a snapshot — and, at ~330px each, they wrapped every
   * prose label, so the lead figures did not even share a baseline. Worse, the
   * finding this page exists to show (first-time authors wait longer) was split
   * across two boxes at two sizes, leaving the reader to do the arithmetic.
   *
   * In a shared column it is four characters apart. That is the whole argument.
   *
   * The row sections are NOT decoration: within a section the rows are disjoint
   * and comparable, across sections they overlap. First-time plus returning
   * authors sum to all pull requests, and so do the six repository rows. A global
   * sort by median would therefore rank a subset against its own superset and
   * present them as peers, which is why table() scopes the sort inside a section.
   */
  const response = [
    { s: "all items", label: "Pull requests", ...h.pr.firstResponse,
      silent: h.pr.silent, n: h.pr.n },
    { s: "all items", label: "Issues", ...h.issue.firstResponse,
      silent: h.issue.silent, n: h.issue.n },
    // Published WITH the per-repository rows below on purpose. The blended 3.8x
    // gap is real in direction but not in size: it rests on one repository with
    // 102 first-time pull requests, while the other five hold 1 to 22 between
    // them. The reader who wants to discount it can see the n column.
    { s: "pull requests, by author", label: "First-time authors",
      ...h.arrival.newcomer.firstResponse,
      silent: h.arrival.newcomer.silent, n: h.arrival.newcomer.n },
    { s: "pull requests, by author", label: "Returning authors",
      ...h.arrival.returning.firstResponse,
      silent: h.arrival.returning.silent, n: h.arrival.returning.n },
    ...h.byRepo.map((r) => ({
      s: "pull requests, by repository", label: r.repo, repo: r.repo,
      ...r.firstResponse, silent: r.silent, n: r.prs,
    })),
  ];

  // Sectioned to match `response` above, row for row where the rows exist. Issues
  // sit in "all items" beside pull requests rather than in a section of their own:
  // a section label over a single row named "Issues" says the same word twice, and
  // the parallel with the first table is worth more than the extra heading.
  const verdict = [
    { s: "all items", label: "Pull requests", pr: true,
      land: h.pr.toLand, decline: h.pr.toDecline, withdrawn: h.pr.withdrawn,
      open: h.pr.open },
    // Issues cannot land and cannot be declined, so four cells here are
    // INAPPLICABLE rather than unmeasured, and an em-dash says so. Kept in this
    // table rather than dropped for tidiness: 41 of 92 open issues are past 90
    // days against 13 of 126 pull requests, and the blended backlog this replaced
    // hid that 4x difference behind a single 28-day median.
    { s: "all items", label: "Issues", pr: false, withdrawn: h.issue.withdrawn,
      open: h.issue.open },
    ...h.byRepo.map((r) => ({
      s: "pull requests, by repository", label: r.repo, repo: r.repo, pr: true,
      land: r.toLand, decline: r.toDecline, withdrawn: r.withdrawn, open: r.open,
    })),
  ];

  /**
   * Kinds here are OBJECTS, not acts.
   *
   * `KIND_LABEL` from the activity log was the obvious thing to reach for and the
   * wrong one: it is a vocabulary of events ("opened PR", "filed issue") keyed by
   * pipeline kind, so `pr` is not in it at all and printed raw, while `issue`
   * would have rendered a row of this table as "filed issue" — a verb phrase in a
   * column of nouns. Two entries, declared where they are used.
   */
  const ITEM_KIND = { pr: "Pull request", issue: "Issue" };

  const silent = h.items.filter((i) => i.z);
  /**
   * Three percentiles, not one.
   *
   * A median alone invites the reading "the usual case is fine", which is true
   * and incomplete: 19h at the median next to 22d at the 90th is a project where
   * most contributions move and a tenth fall down a hole. Two figures cannot show
   * that shape — the reader has no idea whether the tail turns at the 60th or the
   * 95th — and three is where the curve becomes legible without becoming a chart.
   *
   * Grouped under one header because they are one distribution measured at three
   * points. Three sibling columns reading MEDIAN / 75TH / 90TH would suggest three
   * separate metrics.
   */
  const pctile = (key, label, help) => ({
    key, label, n: true, group: "first reply",
    cell: (r) => dur(r[key]) ?? "—", ...(help ? { help } : {}),
  });
  const RESPONSE_COLS = [
    { key: "label", label: "Subject",
      cell: (r) => (r.repo ? repoLink(r) : r.label), text: (r) => r.label },
    pctile("med", "Median"),
    pctile("p75", "75th"),
    pctile("p90", "90th",
      "The slowest tenth. Carried because the tail IS the finding: a median says " +
      "the usual case is fine while a tenth of contributors wait an order of " +
      "magnitude longer."),
    // "Awaiting", not "never answered". The old label made a claim the measurement
    // could not support and the page printed merged pull requests under it.
    { key: "silent", label: "Awaiting reply", n: true,
      sortKey: (r) => (r.n ? r.silent / r.n : 0),
      cell: (r) => withShare(r.silent, r.n), help: SILENT_HELP },
    { key: "n", label: "Items", n: true },
  ];

  return [
    // Section AND label, because `label` alone is not unique across sections: a
    // repository name appears once here and "Pull requests" appears under a
    // heading of its own, but the sections are overlapping populations by design
    // (see `sections` in lib.js), so the same subject can legitimately recur.
    table(RESPONSE_COLS, response, "heartbeat-response",
      { rowKey: (r) => `${r.s}\u0000${r.label}`,
        // Named for what it measures, not for the page. It used to repeat the h2
        // verbatim, which read as a caption rather than a title and left its
        // sibling "Time to a verdict" looking like the only specific table here.
        title: "Time to a first reply", dflt: { key: "n", dir: -1 }, sections: (r) => r.s }),

    table([
      { key: "label", label: "Subject",
        cell: (r) => (r.repo ? repoLink(r) : r.label), text: (r) => r.label },
      // Grouped, because two columns labelled "Median" side by side is an
      // ambiguity the reader has to resolve by counting across to a header three
      // columns away. The group row carries the outcome and each column says only
      // what it measures, which is the same idiom the metric tables use.
      { key: "landed", label: "PRs", n: true, group: "landed",
        sortKey: (r) => r.land?.n ?? null,
        cell: (r) => (r.pr ? fmt(r.land.n) : "—") },
      { key: "landMed", label: "Median", n: true, group: "landed",
        sortKey: (r) => r.land?.med ?? null,
        cell: (r) => (r.pr ? dur(r.land.med) ?? "—" : "—") },
      { key: "landP90", label: "90th", n: true, group: "landed",
        sortKey: (r) => r.land?.p90 ?? null,
        cell: (r) => (r.pr ? dur(r.land.p90) ?? "—" : "—") },
      { key: "declined", label: "PRs", n: true, group: "declined",
        sortKey: (r) => r.decline?.n ?? null,
        cell: (r) => (r.pr ? fmt(r.decline.n) : "—") },
      { key: "declineMed", label: "Median", n: true, group: "declined",
        sortKey: (r) => r.decline?.med ?? null,
        cell: (r) => (r.pr ? dur(r.decline.med) ?? "—" : "—"),
        help: "Time from opening to being closed unmerged. This is the figure the " +
              "per-repository split exists for: the blended median hides a 17-fold " +
              "spread. A slow decline is not a strict review, it is a pull request " +
              "nobody closed." },
      { key: "declineP90", label: "90th", n: true, group: "declined",
        sortKey: (r) => r.decline?.p90 ?? null,
        cell: (r) => (r.pr ? dur(r.decline.p90) ?? "—" : "—") },
      /*
       * A count and no timing, in a table where every other outcome has both.
       *
       * The asymmetry is the point. How long somebody took to withdraw their own
       * work is a fact about that person, and this page measures the project; a
       * median beside it would be the one figure here pointed the wrong way.
       *
       * It earns a column rather than a footnote because it is half the closed
       * population — 118 of 246 pull requests — and because it is where the fast
       * tail of the old decline figure went. Without it the reader sees the median
       * jump from 31 days to 60 and has no way to find out why.
       */
      // "Items", not "PRs", because this column is the one outcome BOTH kinds
      // have: issues get withdrawn too, and 17 of them did. `still open` next to
      // it already solved exactly this and was the label to copy.
      { key: "withdrawn", label: "Items", n: true, group: "withdrawn",
        sortKey: (r) => r.withdrawn,
        cell: (r) => (r.withdrawn ? fmt(r.withdrawn) : "—"),
        help: "Closed, unmerged, by the person who opened it — so not a decision " +
              "the project made. Counted here because these close fast and used to " +
              "be blended into the declines, which halved that median: 31 days " +
              "mixed, 60 once separated." },
      // `cell` is not optional here even though `n: true` formats numbers: the
      // value lives at `r.open.n`, so the default `fmt(r[key])` rendered the whole
      // `{n, age, over90}` object as "[object Object]". A sortKey alone reads the
      // right number and displays the wrong thing.
      { key: "open", label: "Items", n: true, group: "still open",
        sortKey: (r) => r.open.n, cell: (r) => fmt(r.open.n) },
      { key: "openAge", label: "Median age", n: true, group: "still open",
        sortKey: (r) => r.open.age.med,
        // `>=` because an open item's wait is CENSORED: it is still running, so
        // the age is a floor on the time it will finally take, not a result.
        // Printing "41d" beside a landed median of "3d" in the same register would
        // claim two things were measured the same way.
        cell: (r) => (r.open.age.med == null ? "—" : `≥${dur(r.open.age.med)}`),
        help: "How long the still-open items have been waiting so far. Shown with " +
              "≥ because the wait has not finished: this is a floor on the eventual " +
              "time, not a measurement of it." },
      { key: "over90", label: "Over 90 days", n: true, group: "still open",
        sortKey: (r) => r.open.over90, cell: (r) => fmt(r.open.over90),
        help: "Still-open items opened more than 90 days ago. 41 of 92 open issues " +
              "against 13 of 126 open pull requests: the blended backlog figure this " +
              "replaced hid that difference behind a single median." },
    ], verdict, "heartbeat-verdict", { rowKey: (r) => `${r.s}\u0000${r.label}`, title: "Time to a verdict", dflt: { key: "open", dir: -1 }, sections: (r) => r.s }),

    // Per organization, because the pair was the wrong unit -- 77 pairs, 5.9% of
    // the possible grid, and mostly rows of one. `heartbeat.ts` records why in full.
    //
    // Sorted by reviews GIVEN, which is a statement about where review labour
    // lands and not about anyone's standing. Given and received sit adjacent for
    // the finding neither column holds alone: the organizations whose two numbers
    // cross over are being reviewed by the project rather than reviewing it.
    table([
      { key: "org", label: "Organization",
        cell: (r) => el("a", { class: "link", href: `#/org/${r.org}` }, orgName(r.org)),
        text: (r) => orgName(r.org) },
      { key: "given", label: "Reviews given", n: true,
        help: "Distinct pull requests this organization's members reviewed." },
      { key: "received", label: "Reviews received", n: true,
        help: "Reviews on pull requests this organization's members authored. " +
              "A zero here is measured, not missing." },
      { key: "partners", label: "Orgs reviewed", n: true,
        help: "Distinct other organizations reviewed — reach rather than volume. " +
              "Reviewing only your own colleagues counts none." },
      // An "Outside own org" share used to sit here and has been deleted, not
      // moved. It read as pluralism and measured the opposite: the ratio is
      // MAXIMISED by a monoculture that serves outsiders. The repository with the
      // fewest reviewing companies in the project -- two -- scored the highest
      // cross-organization rate at 84.6%, and an organization that gives exactly
      // one review, to a stranger, scores a perfect 100%.
      //
      // `partners` already answers the question the column was reaching for, and
      // answers it in a unit that cannot be gamed by having no colleagues: one
      // partner is one, not 100%.
    ], h.review.byOrg, "heartbeat-matrix", { rowKey: (r) => r.org, title: "Reviews",
      dflt: { key: "given", dir: -1 },
      // The summary rides under the rows it summarises rather than in a panel of
      // its own, so a reader who filters the rows still sees what the total was.
      // It is the project-wide value of the last column, which is why it stays on
      // the page when the excluded-items caveat moved to documentation: a note
      // that states a finding earns its place, one that states a limitation does not.
      // Cross-organization rate is only readable NEXT TO the concentration, for
      // the reason the deleted column above explains: on its own a high rate is
      // equally consistent with broad participation and with one company
      // reviewing everyone.
      //
      // Two sentences, not one, because they are counted in DIFFERENT UNITS. The
      // first is pull requests -- 378 of 562 -- and the second is reviews, of
      // which there are 1,204. Joined by a dash they read as a single
      // measurement, and invited subtracting 67.3% from 90.1%, which means
      // nothing. This project keeps that boundary explicit everywhere else;
      // `comparable` and `crossOrg` count ITEMS while `given` counts REVIEWS.
      //
      // The concentration clause recounts over `shown`, because unlike the
      // cross-organization rate it is a claim about the rows on the screen:
      // filtered to one organization, the old text still announced three.
      note: (shown) => {
        const active = shown.filter((r) => r.given > 0);
        const total = active.reduce((n, r) => n + r.given, 0);
        // Sorted by `given` at source, and re-sorted here anyway so the claim
        // survives the reader sorting the table by something else -- `table()`
        // sorts a copy, so `shown` arrives in whatever order they chose.
        const rank = [...active].sort((a, b) => b.given - a.given);
        // "The top two" is only sayable when there is a second.
        const lead = rank.length >= 2
          ? `the top two perform ${pct(rank[0].given + rank[1].given, total)}`
          : rank.length === 1 ? `${orgName(rank[0].org)} performs all of them` : null;
        return [
          `${fmt(h.review.crossOrg)} of ${fmt(h.review.comparable)} pull requests ` +
          `(${pct(h.review.crossOrg, h.review.comparable)}) were reviewed by an ` +
          `organization other than the author's. Both sides have to be a named ` +
          `organization to count, so this is measured over ${fmt(h.review.comparable)} ` +
          `of the ${fmt(h.review.reviewed)} pull requests that got any review at all. `,
          lead
            ? `Counted as reviews rather than as pull requests, ${fmt(total)} are shown ` +
              `here from ${fmt(active.length)} ${plural(active.length, "organization")}, ` +
              `and ${lead}.`
            : "No organization shown here has given a review.",
        ];
      },
    }),

    // The work queue, and the reason this page is not decoration: the figure
    // "212 never answered" is only actionable as the list of which ones.
    table([
      { key: "d", label: "Opened", n: true, cell: (i) => day(i.d), text: (i) => day(i.d) },
      { key: "k", label: "Kind", text: (i) => ITEM_KIND[i.k] ?? i.k },
      { key: "r", label: "Repository",
        cell: (i) => el("a", { class: "link", href: `#/repo/${i.r}` }, i.r) },
      { key: "n", label: "Reference", n: true,
        cell: (i) => {
          const u = itemUrl(i);
          return u ? el("a", { class: "link", href: u }, `#${i.n}`) : `#${i.n}`;
        },
        text: (i) => `#${i.n}` },
      { key: "a", label: "Contributor",
        cell: (i) => el("a", { class: "link", href: `#/person/${i.a}` }, i.a) },
      // No Outcome column. Every row here is open by definition now, so it could
      // only ever print one value, and a column with one value carries no
      // information. It existed because the old population was mixed — which is
      // exactly the bug: a reader could see "Landed" in a list of unanswered work.
      // `title`, the same class the activity log uses: prose wraps, capped at a
      // 50ch measure. `wrap` is the PAGE container class, and putting it on a cell
      // would hand a <td> a 1240px max-width and 80px of padding.
      { key: "t", label: "Title", cls: "title" },
    ], silent, "heartbeat-silent", { rowKey: (r) => `${r.r}#${r.n}`,
      title: `Awaiting a first reply (${fmt(silent.length)})`, dflt: { key: "d", dir: -1 } }),

  ];
}

// ------------------------------------------------------------------ router

// Presentation order only: the underlying roster retains the source's order.
const COUNCIL_ORDER = [
  "Governance Council", "Shopping Tech Council", "Payments Tech Council",
  "Lodging Tech Council", "Food Tech Council",
];
const councilRank = (name) => {
  const rank = COUNCIL_ORDER.indexOf(name);
  return rank < 0 ? COUNCIL_ORDER.length : rank;
};
// Encode the exact heading instead of slugifying it: distinct source names must
// keep distinct links and filter keys, including spaces, punctuation and Unicode.
const councilAnchor = (name) => `council-${encodeURIComponent(name)}`;

function governanceView() {
  const src = governance.source;
  const councils = [...governance.councils].sort((a, b) => councilRank(a.name) - councilRank(b.name));
  return [
    el("div", { class: "report-head" }, sectionHeading("Governance", "overview")),
    el("p", { class: "scope" },
      "From ", el("a", { class: "link", href: src.url, target: "_blank", rel: "noopener" }, src.file),
      ` @ ${src.sha.slice(0, 7)}, collected ${src.collectedAt.slice(0, 10)} UTC. `,
      "Open seats are not listed. * as marked in the source."),
    ...councils.map((council) => {
      const id = councilAnchor(council.name);
      return el("section", { class: "council", "aria-label": council.name },
        council.seats.length
          ? table([
              { key: "name", label: "Name", cell: (m) => {
                const person = m.person && byId.get(m.person);
                const name = m.marked ? `${m.name}*` : m.name;
                return person
                  ? el("a", { class: "link", href: `#/person/${person.slug}` }, name)
                  : name;
              } },
              { key: "company", label: "Company" },
            ], council.seats, id, {
              title: council.name,
              rowKey: (m) => m.name,
              dflt: { key: "name", dir: 1 },
            })
          : [el("div", { class: "controls bar" }, sectionHeading(council.name, id)),
             el("p", { class: "empty" }, "No named seats in the source.")]);
    }),
  ];
}

const ROUTES = {
  orgs: orgsView, repos: reposView, people: peopleView, governance: governanceView,
  heartbeat: heartbeatView,
};

function render() {
  const { path, params } = hashParts();
  const hash = path || "orgs";

  // Controls are read out of the URL here, before any view runs, so no view can
  // see state the address bar does not describe. Each FILTER is validated against
  // the same list that populates its control and an unrecognised one degrades to
  // unfiltered rather than to an empty page — the rule the path segments below
  // already follow, so `?org=deleted-co` renders the full view, not a blank one.
  const org = params.get("org");
  state.org = orgIds.has(org) ? org : "";
  const repo = params.get("repo");
  state.repo = summary.repos.includes(repo) ? repo : "";
  // A class is a SET of repositories, and `repo` is that set with one member, so
  // both resolve through `scopedRepos()` and neither gets its own code path. A
  // named repository wins over a class rather than intersecting with it: the two
  // controls would otherwise be able to describe an empty set (`ucp` + `impl`),
  // and a filter pair that can render nothing is a trap, not a feature.
  const cls = params.get("class");
  state.cls = CLASSES.includes(cls) ? cls : "";
  // Unvalidated on purpose, and safe for the same reason the segments above are:
  // a search for text nothing matches shows the no-match row, `q.bogus` names a
  // table this route does not render so nothing reads it, and a sort key naming
  // no column heals to the table's default. All three degrade to a legible page
  // rather than a blank one.
  //
  // Validating sort here instead would need this function to know each table's
  // column list, which is built inside the views below -- the table that owns the
  // columns is the only honest place to resolve a key against them. What this
  // file still guarantees is the OTHER half: `focus()` grants a bar only to a key
  // in COLS, so `?s.orgs=files` (measured, deliberately not a column) sorts by the
  // default and shades nothing, instead of leaving a share reading 37.2% with no
  // visible numerator anywhere in the table. `verify` asserts that containment.
  for (const ns of ["q", "s"]) {
    state[ns] = Object.fromEntries([...params]
      .filter(([k]) => k.startsWith(`${ns}.`))
      .map(([k, v]) => [k.slice(2), v]));
  }
  // Trailing segments are classified by VALUE, not by position: a report can be
  // scoped by repository, by event kind, or both, and requiring a placeholder
  // for the one you don't want (`#/org/acme/-/review`) is a worse URL than
  // letting each view recognise its own vocabulary. Unrecognised segments are
  // ignored, which keeps the existing guarantee that a stale link degrades to
  // the unfiltered report instead of an empty page.
  //
  // Decoded per segment: `location.hash` hands back whatever escapes the address
  // bar put in, and an encoded segment matches no id, so `#/person/ada%2Dlovelace`
  // rendered "No contributor" for a person who is right there. A malformed escape
  // degrades to the literal rather than throwing URIError out of render() and
  // freezing the page on the previous view.
  const seg = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const [head, arg, ...segs] = hash.split("/").map(seg);
  const DETAIL = { person: personView, org: orgView, repo: repoView,
                   pr: itemView, issue: itemView };
  // Legacy council paths remain valid; new links use the shared section query.
  const section = params.get("section") || (head === "governance" && arg ? councilAnchor(arg) : null);
  const sectionKey = `${hash}\u0000${section ?? ""}`;
  if (sectionKey !== activeSectionKey) {
    activeSectionKey = sectionKey;
    pendingSection = section;
  }
  const nodes = DETAIL[head] ? DETAIL[head](arg, segs) : (ROUTES[head] ?? orgsView)();

  // Controls live inside the subtree this replaces, so every keystroke in the
  // filter detached the input and dropped focus — typing four characters needed
  // four clicks. Carry focus and caret across the swap, keyed by name rather
  // than by node identity, because the node genuinely is a new element each
  // render.
  const live = document.activeElement;
  const keep = live?.dataset?.focus
    ? { key: live.dataset.focus, start: live.selectionStart, end: live.selectionEnd }
    : null;

  view.replaceChildren(...nodes.filter(Boolean));

  // Keep a lazy section pending until its heading exists. Once found, filters,
  // sorts and later asynchronous redraws must not pull the reader back to it.
  if (pendingSection) {
    const target = document.getElementById(pendingSection);
    if (target && target.getAttribute("data-section-pending") === null) {
      target.scrollIntoView({ block: "start" });
      pendingSection = null;
    }
  }

  if (keep) {
    const n = view.querySelector(`[data-focus="${keep.key}"]`);
    // preventScroll is the whole fix for "typing in the filter jumps to the top".
    // focus() scrolls its target into view by default, and these controls sit near
    // the top of the page, so restoring focus after each keystroke yanked the
    // reader back from wherever they were reading (measured — scrollY 1500 to 0 on
    // one keystroke, which made filtering while scrolled effectively unusable).
    // The swap itself is innocent: replaceChildren holds scroll exactly. Restoring
    // the offset afterwards would have hidden that and fought the browser for it.
    n?.focus({ preventScroll: true });
    // Absent on <select>; only text-like inputs expose a caret.
    if (keep.start != null) n?.setSelectionRange?.(keep.start, keep.end);
  }
  // Falls back the same way the view above does, and for the same reason: a link
  // to a view that no longer exists renders the organizations index, so lighting
  // no tab at all would leave the reader on a page the nav disowns. Reading
  // `head` raw was exactly that half-degrade.
  // An item page hangs off no index, so it lights NO tab rather than borrowing
  // one. Mapping it to `repos` would claim the reader navigated there from the
  // repository index, and mapping it to the fallback would light `orgs` on a page
  // that has nothing to do with organizations.
  const tab = { person: "people", org: "orgs", repo: "repos" }[head]
    ?? (head === "pr" || head === "issue" ? null
      : head in ROUTES ? head : "orgs");
  for (const a of document.querySelectorAll("nav a")) {
    // Read the base from the href with any query stripped, because this loop
    // rewrites that href below and would otherwise be comparing against its own
    // previous output.
    // Read the base with any query stripped so this comparison is stable even
    // though the hrefs are now static markup.
    const base = a.getAttribute("href").split("?")[0];
    a.classList.toggle("on", base === `#/${tab}`);
  }
  const label = head === "person" ? (bySlug.get(arg)?.name ?? arg)
    : head === "org" ? orgName(arg)
    : head === "repo" ? arg
    : head === "pr" || head === "issue" ? `${arg}#${segs[0] ?? ""}`
    : head;
  document.title = `UCP Contributor Stats — ${label}`;

  // Every table here is a new element, so the pinned-state class has to be
  // recomputed rather than inherited. Without this a re-render at depth — a
  // keystroke in the filter, a header click — leaves tables unmarked while
  // their headers are visibly pinned, and the first tooltip opens off-screen.
  syncStuck();
}

addEventListener("hashchange", render);
render();
