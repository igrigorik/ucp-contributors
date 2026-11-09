# UCP contributors tracker

Who contributes to the [Universal Commerce Protocol](https://github.com/Universal-Commerce-Protocol), on whose behalf, and how the project responds. This dashboard brings together authorship, collaboration, and outcomes across UCP's public repositories. Counts link back to the underlying GitHub activity.

## How we count

| Measure | What counts |
| --- | --- |
| **Commits** | Non-merge commits reachable from a repository's default branch. Pushing commits to an unmerged PR does not increase this count. |
| **Co-authored** | One credit per commit per person named in a `Co-authored-by` declaration. Self-credits and duplicate aliases are excluded; these credits stay separate from commits. |
| **Proposed** | Pull requests partitioned into **landed**, **open**, **withdrawn** (closed by their author), and **declined** (other closed-unmerged PRs). Landed includes merges into branches other than the default branch. |
| **Accepted** | `landed / (landed + declined)`. Open and withdrawn PRs are excluded. An unknown closer remains classified as declined. |
| **Reviewed** | Distinct pull request–reviewer pairs, excluding self-review. Repeated rounds on the same PR count once per person. |
| **Comments** | Timeline comments, inline review comments, and non-empty review bodies—including replies on the author's own items. |
| **Issues** | Issues filed, regardless of their eventual outcome. |
| **Lines and files** | Text-line additions, deletions, and file touches from counted commits, including generated files. These measure churn, not surviving code or unique files. |

PR detail pages reconstruct branch authorship separately, filtering replayed commits and generated paths. Those line counts are not interchangeable with default-branch churn; the [filtering rules](scripts/lib/branches.ts) are explicit.

Activity is not adoption: proposals and comments count before anything lands. Reviews and discussions matter, but volume alone does not establish their value. Heartbeat counts replies from other, non-bot participants; its waiting times are measured from the data snapshot, not the reader's clock.

For the technical model—commit-graph walks, child PRs, attribution, and verification—see [Architecture and invariants](docs/README.md).

## Identity and affiliation

[`data/contributors.json5`](data/contributors.json5) joins a person's emails and GitHub accounts into one identity. Recorded affiliation spans determine which organization receives credit at the event date; organization definitions live in [`data/orgs.json5`](data/orgs.json5).

Affiliations are **curated**, not automatically inferred from profile text or email domains. Public self-descriptions and declarations by contributors or maintainers with direct knowledge are accepted; a public reference is not required for a manual declaration. A person's correction to their own record takes precedence.

Unknown attribution, reviewed-but-undisclosed affiliation, confirmed personal-capacity participation, and automation remain distinct categories—not named organizations. Dates shown on profiles describe observed activity, not employment tenure. Incomplete employment histories are not filled in from today's profile.

## Run locally

Requires Bun 1.4.0 and git; full collection also requires an authenticated `gh`. Node is used for JavaScript syntax checks.

```sh
bun install --frozen-lockfile
bun run build:full
bun run serve
```

For a tokenless build, use `bun run build` instead. It includes git activity and the governance roster, but not GitHub collaboration or Heartbeat data.

## Correcting the data

Submit identity or affiliation corrections by pull request. [Contributing](docs/CONTRIBUTING.md) covers record formats, verification, pipeline commands, and deployment. Roster corrections belong upstream in `MAINTAINERS.md`; [governance documentation](docs/GOVERNANCE.md) explains the boundary.

## License

[Apache-2.0](LICENSE).
