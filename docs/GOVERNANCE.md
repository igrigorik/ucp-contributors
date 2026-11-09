# Governance roster

The site's **Governance** view is generated from one public source: [`MAINTAINERS.md`](https://github.com/Universal-Commerce-Protocol/.github/blob/main/MAINTAINERS.md) in the UCP `.github` repository. Roster contents are read from that file, not maintained separately here. The [architecture guide](README.md#identity-and-affiliation) explains how this projection stays separate from contribution attribution.

## What is shown

Each daily acquisition reads `MAINTAINERS.md` at the repository's current commit into `raw/council.json`, and `derive` publishes exactly:

- every `##` heading that carries a `| Name | Company |` table, in source order;
- each named row's name and company label, verbatim;
- the source's trailing `*` on a name, shown as `*` (its meaning is the source's own footnote); and
- the immutable commit permalink and the time the sealed acquisition collected it.

The page displays Governance, Shopping, Payments, Lodging, then Food, followed by any additional sections in source order. Each heading is a permalink and shares a row with its own filter. Heading links use the same `?section=` convention as the rest of the site and preserve filters and sort order; older `#/governance/<council-name>` links still work. This presentation order does not change the source data.

Open seats are not people and are not listed. A heading whose every seat is open is still shown, with no names. The page makes no claims about charters, lifecycle, approvals, chairs, nominations, or working groups.

A new seat, a new heading, a removal, or a changed company appears on the next refresh with no change to this repository. A table the parser recognizes but cannot read fails the refresh instead of dropping rows.

## Identity

`MAINTAINERS.md` offers a display name and a company, nothing else. A roster name links to a contributor's page only through an exact `rosterNames` alias on that contributor in `data/contributors.json5`:

```json5
{
  "ilya-grigorik": {
    name: "Ilya Grigorik",
    logins: ["igrigorik"],
    rosterNames: ["Ilya Grigorik"],
  },
}
```

An alias is identity data, like an email: it says who a roster name is, never which councils they sit on. Matching is exact after trimming. One alias belongs to one person; a conflicting claim fails the build. A matching display name alone links nothing. `bun run audit` lists unlinked roster names and suggests possible aliases for a human to confirm.

An unlinked person is shown as plain text. The pipeline does not create name-only contributors, assign activity, or infer a GitHub account from a name.

## Company labels

The company beside a roster name is the roster's label for the seat. It does not replace the contribution affiliation in `data/contributors.json5` and is never used to recalculate organization statistics.

## Contributors, membership, and GitHub teams

Recorded repository activity is not a claim that a person signed the CLA, holds a formal membership, or has voting rights. Those roles are distinct under the [UCP governance rules](https://github.com/Universal-Commerce-Protocol/.github/blob/ddd1b3fed1c6ecdb205d10f3fb8af992859f929d/GOVERNANCE.md). GitHub team membership is credential-dependent and not a reproducible public roster, so it does not feed this page.

## Corrections

- **A roster is wrong:** change `MAINTAINERS.md` upstream; this site follows on the next refresh.
- **A roster name is you but is not linked:** open a pull request adding its exact spelling to `rosterNames` on your entry, with evidence the identity is yours.
- **A link is wrong:** open an issue or pull request removing the alias.
