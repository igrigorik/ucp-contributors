# Design system

The contributors site is an editorial ledger: serif type carries language, sans serif carries interface controls, and monospace carries measurements, dates, and identifiers. Reuse the semantic custom properties in [`site/style.css`](../site/style.css) rather than introducing local values.

The [architecture guide](README.md#presentation-contracts) describes the data and presentation contracts these components serve.

## Tokens

- Surfaces: `--bg`, `--surface`, and `--tooltip` distinguish paper, raised controls/cards, and definitions.
- Text and actions: `--fg`, `--muted`, `--faint`, `--link`, and `--focus` express content roles. Focus remains globally visible.
- Type roles: sections 17px, entities 32px, stat headings 16px, prose 14.5px, table text/metadata 13.5px, notes 13px, data 12.5px, and interface labels 11.5px each have a shared `--type-*` token.
- Rhythm: `--space-section`, `--space-heading-gap`, `--gutter`, and `--gutter-mobile` govern section spacing and page edges.
- Rules and states retain separate tokens because their meanings differ even when their colors are close.

## Reuse constraints

Create every h2 or h3 through `heading` in [`site/lib.js`](../site/lib.js); tables, stat panels, and standalone headings all use it. Section links use `?section=<id>`, preserving filters and sorting. Its `.section-heading` establishes the structural tier; entity and stat classes may override that tier. Keep `.heading-anchor` colorless and un-underlined in every state. The masked `.anchor-icon` must retain reserved space, revealing on heading hover/focus and remaining subtly visible on touch devices.

Do not merge tooltip, sticky-header, pinned-column, or responsive overflow rules without rechecking their documented clipping and stacking constraints. Keep the 1240/1239px measure pair synchronized, preserve media-query order, and recheck interaction states when changing the light palette or framework-free structure.
