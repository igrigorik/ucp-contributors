# Contributing

Most contributions here are corrections to who someone is or whom they worked for. Those live in hand-maintained files and are changed by pull request. The [overview](../README.md#identity-and-affiliation) explains attribution; [Architecture and invariants](README.md) documents the data pipeline, graph reconstruction, and verification contracts.

## Correcting a record

`data/contributors.json5` has one record per person:

```json5
"jane-doe": {
  name: "Jane Doe",                       // optional display-name override
  emails: ["jane@example.com", "jane.doe@acme.com"],
  logins: ["janedoe"],                    // GitHub logins the commit bridge cannot reach
  orgs: [
    { org: "acme", until: "2026-03-01" }, // `from` inclusive, `until` exclusive
    { org: "globex", from: "2026-03-01" },
  ],
},
```

- `emails` merge several git identities into one person. Personal addresses are fine.
- `logins` identify GitHub accounts the commit bridge cannot reach, including accounts belonging to people with no commit.
- `orgs` are dated spans, so work is credited to the employer at the time it happened. Dates are `YYYY-MM-DD`. Organization ids must exist in `data/orgs.json5`; `independent` and `undisclosed` classify human affiliations; `bot` identifies automation.
- Duplicate keys are rejected: JSON5 would otherwise silently keep only the last one.

Corrections that are always welcome: a missing email or login, a wrong or missing employer span, a wrong display name, `independent` where an employer was guessed, or `undisclosed` where you would rather not say. To be removed from attribution entirely, open an issue.

## Unknowns

Record what is actually known:

| state | meaning |
| --- | --- |
| no record | nobody has looked yet |
| `org: "undisclosed"` | looked; no public affiliation found |
| `org: "independent"` | looked; positively established as a personal-capacity contributor |

A personal email address does not establish `independent`. Ignorance is recorded as `undisclosed`, never as a positive claim, and an unmapped identity stays unmapped rather than being guessed.

## Evidence

Affiliations are manually curated from self-published information or declarations by contributors or maintainers with direct knowledge. A public reference is useful but is not required for a manual declaration. See the [counting principles](../README.md#how-we-count). In practice:

- Say where it came from in the pull request description, or in a trailing comment on the row (`// self-reported-profile; https://github.com/<login>; observed YYYY-MM-DD`).
- Profile `company` fields, email domains, and `bun run audit` output are hints for a human to confirm. They are never copied into the file automatically.
- Do not search other platforms by display name. That is an identity guess, and a wrong one puts a false employer on a public page.

### Manual curator attestations

A contributor or maintainer may declare an affiliation from direct knowledge even when no public reference exists. Say who is making the declaration and its basis in the pull request or a source comment; no additional evidence fields are required. This is reviewed curation, not automatic inference. Prefer `undisclosed` when unsure. A person's correction to their own affiliation takes precedence.

## Public data

Everything in `data/` and on the site is public. Commit author emails are already public in the git history of the measured repositories, so they are used as identity keys in `data/contributors.json5`. Do not add an address, link, or affiliation that the person has not published, other than an affiliation declaration as described above. Never add private or internal repositories to `data/repos.json5`; scope is an explicit allow list of public repositories.

## Verifying a change

Run these from the repository root before opening a pull request:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
for file in site/*.js; do node --check "$file"; done
bun run build      # git-only acquire + derive + verify; derive validates the data files
```

`pre-commit run --all-files` runs type checking, unit tests, and JavaScript syntax checks (see [the hook configuration](../.pre-commit-config.yaml)). `bun run build` clones/fetches the measured repositories into `raw/`, so it needs network access. CI runs the same checks on every pull request.

## Pipeline commands

| Command | Purpose |
| --- | --- |
| `bun run build` | Acquire, derive, and verify git activity and governance; no API token needed. |
| `bun run build:full` | Also collect GitHub collaboration and PR branch data; requires authenticated `gh`. |
| `bun run acquire` | Collect a full set of raw inputs and seal it with source revisions, times, and hashes. Add `--git-only` for the tokenless mode. |
| `bun run derive && bun run verify` | Rebuild and check the views after editing curated data, using an existing valid acquisition. |
| `bun run audit` | Print identity and affiliation suggestions for review; never edit records. |
| `bun run serve` | Preview `site/` on port 8080 or the next free port; override with `PORT=`. |
| `bun run stage` | Copy approved assets and generated JSON into `_site/`, excluding tests and unexpected files. |

Standalone `pull:*` commands are development tools, not complete acquisitions. Changes to raw files invalidate their previous hashes; run `acquire` before deriving from changed inputs.

## Publishing

The [deployment workflow](../.github/workflows/deploy.yml) runs on pushes to `main`, daily at 06:17 UTC, and on demand. Set GitHub Pages to use **GitHub Actions** as its source. The job runs checks and the full build, then uploads `_site/`. A failure stops publication; it does not fall back to a partial or git-only site.

The [PR workflow](../.github/workflows/pr.yml) tests the code and runs the git-only build. GitHub may disable scheduled workflows after 60 days without repository activity; check the workflow status if refreshes stop.

## Governance corrections

Council membership is not edited here: the Governance page and profile council lines follow the public `MAINTAINERS.md` on each daily refresh. To change a roster, change `MAINTAINERS.md` upstream. The one thing this repository records is identity: if a roster name is you but is not linked, add its exact spelling to `rosterNames` on your entry in `data/contributors.json5`, as you would an email (see [GOVERNANCE.md](GOVERNANCE.md)). A roster company label never rewrites contribution affiliation.

## Interface changes

Follow the shared [design system](DESIGN.md): use the heading, table, panel, and column helpers instead of route-specific markup or CSS. Reuse the semantic tokens in `site/style.css` and check desktop and phone layouts after changes.

## Changes to metrics

For changes to a metric, denominator, label, or population, state the counting unit and affected population, add regression tests, and check that the result reconciles with raw records. See [Verification and change boundaries](README.md#verification-and-change-boundaries).
