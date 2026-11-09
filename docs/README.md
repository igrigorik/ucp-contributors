# Architecture and invariants

How public repository history becomes the dashboard: acquisition, graph reconstruction, attribution, aggregation, and presentation. This describes the implementation, including its boundaries—not a proposed architecture.

The [root README](../README.md) is the public overview and counting guide. See [Contributing](CONTRIBUTING.md) for commands and record formats, [Governance](GOVERNANCE.md) for roster matching, and [Design](DESIGN.md) for the shared interface system.

- [Data flow and responsibilities](#data-flow-and-responsibilities)
- [Acquisition and provenance](#acquisition-and-provenance)
- [Walking the commit graph](#walking-the-commit-graph)
- [Identity and affiliation](#identity-and-affiliation)
- [Metric atoms and aggregation](#metric-atoms-and-aggregation)
- [Project responsiveness](#project-responsiveness)
- [Presentation contracts](#presentation-contracts)
- [Verification and change boundaries](#verification-and-change-boundaries)

## Data flow and responsibilities

```text
Public git ────────────────┐
GitHub API ────────────────┼─ acquire ─ raw records + manifest ─┐
Public MAINTAINERS.md ─────┘                                    │
                                                                ├─ derive ─ public JSON views
Curated identities, affiliations, repository scope ─────────────┘                   │
                                                                                 verify
                                                                                    │
Static HTML / CSS / ES modules ────────────────────────────────────────────────── stage
                                                                                    │
                                                                              GitHub Pages
```

There is no runtime database or server-side aggregation. The browser reads generated files; it does not query GitHub or decide affiliations.

The boundaries are deliberate:

- **Pull scripts preserve source facts.** Reviews remain individual submissions with their original timestamps; PR outcomes retain the closing actor; branch records retain per-file changes.
- **Derivation owns counting judgments.** It collapses review rounds, resolves identities and affiliations, classifies withdrawals, and builds the views.
- **Audit proposes; it does not write.** Profile text and domain hints can suggest curation but cannot change published attribution automatically.
- **Verification checks this acquisition.** It reconciles raw records, projections, and published totals. Fixture tests separately pin the rules.
- **The site presents measured fields.** It scopes and sorts existing views without inventing an alternative counting model.

### Inputs and outputs

| Location | Contents and owner |
| --- | --- |
| [`data/repos.json5`](../data/repos.json5) | Explicit public repository allowlist, URLs, and work classes. No runtime organization-wide discovery. |
| [`data/contributors.json5`](../data/contributors.json5) | Curated identities, affiliation spans, display names, and roster-name aliases. |
| [`data/orgs.json5`](../data/orgs.json5) | Organization names and suggestion-only domain hints. |
| `raw/repos/*.git` | Bare mirrors, including a separate governance mirror. |
| `raw/commits.jsonl` | Default-branch commit records. |
| `raw/github.jsonl` | Review submissions, timeline comments, and inline comments. |
| `raw/items.json` | PR/issue registry: author, creation, outcome, closing actor, and full merge OID where available. |
| `raw/logins.json`, `raw/profiles.json` | GitHub's commit-email/account associations and self-published profile hints. |
| `raw/branches.jsonl` | One branch reconstruction or explicit absence per landed PR. |
| `raw/council.json` | Source revision, roster headings, and named seats from `MAINTAINERS.md`. |
| `raw/manifest.json` | Successful acquisition's collection intervals, revisions, dependencies, and output hashes. |

Raw captures, mirrors, and generated views are ignored by git. The exact layer output sets live in [`acquisition.ts`](../scripts/lib/acquisition.ts); mirrors themselves are not content-hashed as output files.

Derive writes nine public views in full mode:

- `summary.json`: measured fields, totals, repository configuration, coverage, and acquisition provenance.
- `orgs.json`, `repos.json`, `people.json`, `org-people.json`: aggregated activity and the joins needed to scope it.
- `events.json`: the counted event ledger, deduplicated item titles, and issue keys.
- `items.json`: PR/issue facts and per-item branch attribution.
- `heartbeat.json`: project responsiveness and review statistics.
- `governance.json`: the source roster with confirmed profile links.

Git-only mode omits `items.json` and `heartbeat.json` and removes stale copies. It still includes the governance roster.

## Acquisition and provenance

[`acquire.ts`](../scripts/acquire.ts) is the supported collection entry point:

```text
git-only: git → council
full:     github → git → branches → council
```

GitHub is collected first; the default heads are fetched afterward. This avoids deliberately collecting the spine before the API observation. Branch reconstruction uses that item registry and those refreshed heads, and recovers missing merge objects separately by full OID. The order reduces one race; it does not freeze the remote sources.

Each layer records the common run ID, start/end times, and hashes of its exact output set. The git layer records full mirror `HEAD` OIDs. The council layer records its source SHA. Before and after the branch walk, acquisition checks the item-registry hash and default-head map; it seals those as the branch layer's dependencies.

The manifest is written **last**, through a temporary file and rename, only after validation succeeds. An interrupted run may replace some raw files, but it cannot install a successful seal for incomplete work. If rewritten files no longer match the old manifest, derive refuses them. This is detection of partial replacement, not a transaction that restores the previous raw directory.

Consumers validate the manifest's schema, mode, layer set, ordering/times, run IDs, repository configuration hash, output hashes, and dependency relationships. The recorded head IDs must be full OIDs covering the configured repositories. Derive does not re-fetch or require the local mirrors still to be at those heads; it consumes the sealed flat records. Verify also requires `summary.acquisition` to identify the current seal.

**Reproduction requires three things:** the sealed raw files, the curated data files, and the implementation revision. The seal binds raw bytes and repository configuration, not the code or curated identity files. Re-derivation should reproduce the measured values; generation timestamps are new metadata.

### Boundaries

- Collection spans an interval, not one atomic GitHub/git snapshot.
- PR heads, side branches, and tags read during reconstruction are not individually pinned in the manifest. The resulting branch records are hashed; only item-registry and default-head drift are checked during the walk. Acquisition therefore assumes a single writer to the mirrors.
- Git-only acquisition is **tokenless, not offline**: it still fetches public git and the roster. Derive and verify can run offline from a valid local acquisition.
- API connections are cursor-paginated. Counts, identities, and continuation progress are checked; incomplete pages, duplicate nodes, or material GraphQL errors fail acquisition. Profile lookup tolerates a specifically reported missing user, not arbitrary partial errors. See [`github.ts`](../scripts/lib/github.ts).
- Pending reviews are credential-private and have no submission time, so they are skipped and reported. Review bodies are reduced to character length before writing; their text is not retained. Profile company text and links remain affiliation-curation hints; profile names may label already-observed identities.

## Walking the commit graph

The system has **two measurement planes**. Keeping them separate is the central accounting decision.

### 1. Default-branch spine: aggregate authorship

[`pull.ts`](../scripts/pull.ts) maintains bare mirrors and runs:

```sh
git log --no-merges --numstat …
```

With no revision argument, this starts at the mirror's local `HEAD`. Non-merge commits reachable from it supply the dashboard's aggregate commits, added/deleted lines, and file touches. A squash commit is an ordinary single-parent commit and counts once. Merge commits are excluded; pushes that remain only on PR branches do not enter these totals.

[`gitlog.ts`](../scripts/lib/gitlog.ts) flattens each commit into abbreviated SHA, author identity/date, subject, aggregate numstat, and coauthor addresses. It does **not** retain per-file paths in `commits.jsonl`. Generated and vendored files count in spine churn. A binary change counts as a touched file but contributes no text-line quantity.

The local bare `HEAD` is assumed to name the current default branch. Fetch updates branch refs but does not independently re-check the remote's symbolic default after every run. Repository `seed` entries are currently metadata only: no measurement path consumes them, so imports receive ordinary spine attribution rather than being reassigned to an import identity.

### 2. PR branches: reconstructing work hidden by squash

A default-branch squash can collapse several people's branch commits into one author record. PR detail pages therefore use a separate graph reconstruction in [`pull-branches.ts`](../scripts/pull-branches.ts), backed by [`branchgit.ts`](../scripts/lib/branchgit.ts).

For every landed PR:

1. Fetch GitHub's public `refs/pull/<n>/head` into `refs/remotes/pr/<n>`.
2. Read the PR's **full merge OID** from the item registry. Abbreviations cannot recover missing objects.
3. If the object is absent locally, attempt one public HTTPS fetch by full OID. An explicit server refusal becomes `merge-commit-unfetchable`; no OID becomes `no-merge-commit`. Network/auth failures are errors, not evidence that the work is unavailable.
4. Set `base` to **the merge object's first parent**, `<merge>^1`—not a computed merge base.
5. Walk non-merge commits reachable from the PR head but not from that parent:

   ```sh
   git log --no-merges refs/remotes/pr/<n> --not <base> --numstat …
   ```

Missing heads, unreadable parents, or failed git commands abort the walk rather than produce a measured empty branch. The code does not assert that the current PR head descends from `base`; rewritten heads can change the reconstructed range.

### 3. Destination and carrier detection

Before classifying the other PRs, the walker builds:

- `mainOrder`: positions in `git rev-list HEAD`, covering the entire reachable graph, not only first parents.
- Stable patch IDs for non-merge commits on that graph.
- Side refs: local branches/tags whose tips differ from `HEAD`.
- A **carrier map** from every commit SHA in a default-delivered PR's walked range to that PR's number.

Available merge objects are classified in this order:

| Destination | Test | Meaning of `via` |
| --- | --- | --- |
| `main` | Merge OID is reachable from default `HEAD`. | None. |
| `component` | Otherwise, that exact OID occurs in a `main` PR's walked range. | Carrier PR number. |
| `sidebranch` | Otherwise, the OID is an ancestor of a side ref. | First matching branch/tag name. |
| `unreachable` | None of those relationships is found. | None. |

`unavailable` is separate from these destinations: the object could not be recovered or GitHub supplied no OID. It carries a reason, not an empty commit list or a guessed destination.

Reachability is not intent. `sidebranch` does not prove a backport; `unreachable` does not prove why history disappeared. If several carriers contain an OID, the first encountered wins. Only the first matching side ref is displayed.

### 4. What happens to child PRs

Consider a child PR squashed into a parent PR's branch:

```text
B---P               default branch (P: parent squash)
 \
  p1---C---p2       parent PR head (C: child squash)
    \
     c1---c2        child PR head
```

Lines show commit ancestry. Squashing creates a new commit; it does not preserve an ancestry edge from the PR head to its squash commit.

The parent's merge is `P`, whose first parent is `B`. Its PR-head walk contains `p1`, `C`, and `p2`, so `C` enters the carrier map under the parent. The child's merge OID is `C`; it is not on the default graph but is in that carrier range. The child is therefore a `component` pointing to the parent.

**Detection is not recursive inlining.** The parent page retains `C` as one commit credited to `C`'s author; it does not substitute `c1` and `c2`. The child page separately walks the child's head against `C`'s first parent (`p1`) and can show those original authors.

Carrier detection uses non-merge commits and exact OID containment, not PR titles, patch similarity, or recursive traversal of PR relationships. A true merge commit omitted by `--no-merges`, or a rewritten/nested squash whose OID no longer survives in a main carrier range, will not be recognized as a component by this mechanism.

### 5. Replays and branch churn

Commit SHAs change under cherry-pick or rebase, so replay detection uses `git patch-id --stable`:

- If a branch patch matches a default-graph patch and `base` is on that graph, the match must be at the same or an older position than `base` in the newest-first `rev-list` order.
- If `base` is not on the default graph, any matching default patch is marked replay.

This is a **patch-and-position heuristic**, not a timestamp or ancestry proof. One main commit is retained per patch ID; empty-diff commits have no patch ID. A replay is removed from branch authorship wholesale, including its commit count.

For non-replay commits, [`attribute`](../scripts/lib/branches.ts) increments author commit counts and sums text changes after resolving rename paths:

- Rename detection stays enabled; the generated-file test uses the destination path, including Git's brace-compressed rename notation.
- Generated paths contribute no branch lines. The patterns cover lockfiles, generated/build/vendor directories, known generated SDK schemas, protobuf/minified output, snapshots, and spelling metadata; `GENERATED` in the source is the exact rule set.
- Binary files retain null line counts in raw branch records. No text-line measurement is invented for them.
- A commit containing only generated files still counts as a branch commit, with zero eligible text lines.

**No PR-branch lines feed aggregate totals—not even `main` records.** All available destinations may show item-local authorship. Global/person/org/repository churn comes exclusively from the spine. Summing component pages with carriers would also count overlapping work twice; the separate planes avoid treating either reconstruction as an additional aggregate credit.

### 6. Graph invariants

[`validateBranches`](../scripts/lib/branches.ts) enforces one record per landed PR, no duplicates or non-landed extras, full matching merge OIDs, valid destination metadata, and a `main` carrier for every component. Unavailable records must carry the correct reason and no measured branch data.

Pull validates before writing; derive validates before projecting; verify rechecks coverage, destination/absence metadata, author-row uniqueness, and attributed line/commit totals. These establish consistent accounting of the reconstructed ranges, not proof that every historical ref survived or every heuristic recovers the original workflow.

## Identity and affiliation

### Identity is a separate join

[`identity.ts`](../scripts/lib/identity.ts) normalizes GitHub logins and builds ownership indexes. GitHub's commit-email/account bridge is source identity data, not employer inference. Bridge entries are considered first; explicit `logins` then override the mapping. Contradictory bridge ownership and two curated owners claiming one email or explicit login fail.

The current paths are not identical:

| Activity | Identity resolution |
| --- | --- |
| Spine commit author | Curated email owner; otherwise a separate unresolved email identity. |
| Coauthor | Curated email, then curated owner of the GitHub-bridged or no-reply login; otherwise unresolved normalized email. |
| GitHub activity | Login index, including explicit logins and usable bridge associations; otherwise unresolved login. |
| Branch writer | Try known email/account identities with an existing published person row; otherwise emit a stable branch-only key and public label. |

An unlisted commit-author email is not automatically merged through the broader coauthor resolver. Curation must add that alias to unify spine authorship. Branch-only writers stay visible on item pages without creating zero-activity people or inflating the active population. Their digest keys and labels are checked before publication; a truncated digest is not a proof against every possible collision.

### Affiliation is event-dated curation

[`affiliation.ts`](../scripts/lib/affiliation.ts) resolves recorded spans as `[from, until)`: inclusive start, exclusive end. Dates must be valid canonical calendar dates; overlapping/inverted spans and unknown organization references fail.

The organization is selected at each event's date, not from today's profile. A missing record **or a gap in recorded spans** yields `unknown`. `undisclosed`, confirmed personal-capacity `independent`, and `bot` remain separate display buckets. None is a named organization for attribution coverage.

Affiliation declarations from contributors or maintainers with direct knowledge are valid without public links. Profile company text and domains feed suggestions; derive does not turn them into employment spans. Public evidence is useful, but no mandatory evidence-field schema is imposed. A person's correction to their own affiliation takes precedence.

Organization membership means **has activity attributed to that organization**. It comes from event-dated aggregates, not `person.org`, which describes the latest activity. Profile date ranges are observed activity windows, not employment tenure; repeated stints at the same organization currently share one window.

Governance is a separate projection of `MAINTAINERS.md`. Exact `rosterNames` aliases connect known names to existing profiles; they do not store council assignments, create activity, or rewrite affiliations. Roster changes follow the next acquisition. See [Governance](GOVERNANCE.md).

## Metric atoms and aggregation

The [counting table](../README.md#how-we-count) names the public metrics. Their implementation units determine which operations are valid:

- **Coauthor credits:** one `(commit, person)` after alias deduplication and canonical-author exclusion; never an extra authored commit or line allocation. Standalone, case-insensitive `Co-authored-by: Name <email>` declarations count anywhere in a squash message, not only Git's terminal trailer block. Matching is single-line; quoted/indented mentions do not count. A literal matching line inside a code fence does count because no Markdown parser is applied.
- **Reviews:** raw submissions collapse first by PR/login, then by canonical person; retain the earliest submission and exclude self-review, including cross-account aliases. Attribution uses that counted submission's date.
- **Comments:** timeline objects, inline objects, and non-empty review bodies are separate writing events. They are not round-collapsed; authors' own replies count. One review body counts once regardless of length.
- **Proposals/outcomes:** one PR with `landed`, `open`, `declined`, or `withdrawn`. [`outcomeOf`](../scripts/lib/items.ts) identifies withdrawal by comparing the normalized closing and author logins, not a canonical-person join. An unknown closer remains declined. Acceptance excludes open and withdrawn items.
- **Issues:** one filing per issue, independent of its later outcome.

Authorless items remain in the raw registry but do not receive attributed proposal/outcome counts or enter Heartbeat cohorts. Reviews on their PRs can still be credited. Consequently the displayed review-share eligibility denominator—counted repository proposals minus the person's own proposals—can omit such PRs. A containment check prevents reviews exceeding eligibility; it does not establish a complete historical denominator.

### One fold, several views

[`record()`](../scripts/derive.ts) updates five additive views together and emits the corresponding ledger event:

```text
organization
repository × organization
person
person × repository
person × organization × repository
```

The last view is essential: it lets an organization report reconcile its panel and contributors even when people change employers. Deriving membership from each person's latest organization would move historical work to the wrong company.

Event kinds map to fields through [`site/vocab.js`](../site/vocab.js). PR titles are stored once in the ledger's title map, while comment/review IDs preserve links to their exact GitHub objects.

Counts and churn can be added across disjoint cells **after** the counting unit is resolved. Distinct people, organizations, partners, percentages, and quantiles must be recomputed for each population. A person active in several repositories or employers is not several project contributors; repository medians cannot be averaged into the project median.

## Project responsiveness

[`heartbeat.ts`](../scripts/lib/heartbeat.ts) measures the project's behavior, not individual performance:

- First reply is the earliest recorded event by another non-bot person. Applying a label or assigning an item is not collected as a reply.
- Awaiting first reply requires an item to remain open, unreplied-to, and older than seven days. A merged/closed item is not a live waiting-queue entry. Withdrawals are counted separately and not timed as project declines.
- `asOf` is the newest recorded item/event timestamp, not the wall clock or acquisition time. Re-deriving a fixed dataset therefore cannot age it. A quiet interval before acquisition can make this reference time lag collection.
- Open waits are censored: the observed wait is a lower bound on eventual resolution time, not a completed duration.
- Newcomer means the person's earliest PR in the collected window, not their first contribution anywhere. The reported window starts at the earliest collected PR/issue, not the first git commit.
- Response and outcome distributions use one R-7 interpolated quantile definition, with sample sizes and repository/cohort splits rather than a blended mean.

The Reviews table has two units. Given/received totals count distinct person–PR review pairs; cross-organization reach counts distinct partner organizations. The cross-organization share counts PRs with an outside reviewer. Only pairs where both sides have named organizations enter that comparison. Unknown affiliation is not evidence of crossing an organization boundary, and bot review is excluded.

## Presentation contracts

The browser loads six index files first: summary, organizations, repository/organization rows, people, organization/person rows, and governance. Activity, item details, and Heartbeat load their larger files on demand. Missing data produces an explicit loading/failure/unavailable state, not a blank table or fabricated zero.

`summary.fields` is the measurement contract. Git-only output omits GitHub fields; columns and panels gate on whether a field was measured. Within a measured family, a zero is a real count. Undefined ratios display `NA`.

Filters and sorts live in the hash URL. Repository/class/organization scope selects the population; text search narrows visible rows without changing the underlying share denominator. Ratios are recomputed from scoped counts. Review share uses eligible PRs, not all reviews by everyone. A prose or derived-column sort does not acquire a metric bar merely because it is sortable.

The shared [table, panel, column, and heading helpers](DESIGN.md) own reusable behavior. Table sections sort within their populations instead of mixing subsets with their supersets. Heading links preserve filters and sorting, use stable target IDs, and wait for lazy-loaded content; subsequent filtering does not repeatedly scroll the reader back.

Presentation cannot turn these counts into merit. Comments, PRs, commits, and lines are different units; none is combined into a weighted impact score. Per-repository classes and explicit denominators expose differences that a project-wide ranking can hide.

## Verification and change boundaries

The release gates answer different questions:

| Check | Contract |
| --- | --- |
| Typecheck and fixed fixtures | Shapes, definitions, and edge-case behavior. |
| Acquisition validation | Complete output sets, current hashes, coherent mode/run metadata, recorded dependency relationships. |
| Branch validation | Exactly one reconstruction or explained absence per landed PR. |
| Identity/span validation | Unambiguous ownership and non-overlapping valid recorded affiliations. |
| Derive/verify reconciliation | Additive person/org/repository views and the ledger agree; outcome partitions and measured-field plans hold. |
| Item verification | Public branch-author rows and totals agree with raw attribution; no internal identity prefixes or invented absence measurements. |
| Roster verification | Page rows and profile council annotations agree with the pulled roster and confirmed aliases. |
| Staging | Only approved assets and generated files enter the publication directory. |

A green gate proves the tested relationships, not that an affiliation declaration is historically complete, a replay heuristic captures every workflow, or an attractive ratio measures the right thing. Changes to a counting unit, denominator, or population need explicit definitions, regression coverage, and reconciliation against the raw records.

The [deployment workflow](../.github/workflows/deploy.yml) runs a full acquisition and these checks before uploading the staged site. Failed acquisition, derivation, verification, or staging leaves the previous deployment live—there is no automatic partial-data fallback.

When extending the system, keep the boundaries intact: collect enough source facts to reconsider judgments, define the unit before aggregating, make absence explicit, share vocabulary with consumers, and update raw projection, validation, public explanation, and presentation together.
