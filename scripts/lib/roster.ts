// The public governance roster: parse MAINTAINERS.md, then project it onto
// contributor records through explicit identity aliases. Pure, so the parser,
// the derive projection and verify's recomputation are one implementation.
//
// WHAT IS PUBLISHED, AND WHAT IS NOT
//
// Only what MAINTAINERS.md states: its `##` headings, the names and company
// labels in their tables, and its `*` marker. Nothing here describes a group's
// lifecycle, approval, chair or charter, and nothing is curated by hand — a new
// seat, a new heading, a removal or a changed company reaches the site on the
// next pull with no edit to this repository.
//
// The only hand-maintained input is `rosterNames` in data/contributors.json5:
// the exact roster spellings that are a given person, recorded like an email.
// It says WHO a name is, never WHICH councils they sit on.
import type { CouncilSeat, RawCouncil } from "./types.ts";

/** A roster parse that cannot be trusted. Thrown, never repaired. */
export class RosterError extends Error {}

const cellsOf = (line: string): string[] =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim());

/**
 * Parse every `| Name | Company |` table under a `##` heading.
 *
 * Hand-written rather than a markdown dependency because the shape is narrow
 * and every departure from it must FAIL: a silently dropped row is a person
 * missing from a public roster.
 *
 *   - A `##` heading opens a council; any other heading level closes it.
 *   - A table is recognized by a header row whose cells are `Name` and
 *     `Company`. Its next line must be the alignment row, and every row after
 *     it until the table ends must have exactly two non-empty cells.
 *   - `Open` in the name cell is a vacant seat. It is skipped — recording it
 *     would invent a contributor called "Open" — but the heading is kept, so a
 *     council whose every seat is vacant still appears with no names.
 *   - A trailing `*` (escaped `\*` in the source) is recorded as `marked`,
 *     verbatim. Its meaning is the source's footnote, not ours.
 *   - A heading or a name repeated within a heading is an error.
 *
 * `councils` lists every heading that carries a roster table, in source order.
 */
export function parseRoster(text: string): Pick<RawCouncil, "councils" | "seats"> {
  const councils: string[] = [];
  const seats: CouncilSeat[] = [];
  const headings = new Set<string>();
  let council: string | null = null;
  let state: "none" | "align" | "rows" = "none";
  const lines = text.split("\n");
  let tableRows = 0;
  const finishTable = (at: string) => {
    if (state === "align") throw new RosterError(`${at}: expected the table alignment row`);
    if (state === "rows" && tableRows === 0) {
      throw new RosterError(`${at}: roster table has no rows; vacancies must be explicit Open rows`);
    }
    state = "none";
  };

  lines.forEach((raw, i) => {
    const at = `MAINTAINERS.md:${i + 1}`;
    const line = raw.trim();
    const tableLine = line.includes("|");
    if (state === "align" && !tableLine) {
      throw new RosterError(`${at}: expected the table alignment row`);
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      finishTable(at);
      council = heading[1] === "##" ? heading[2]! : null;
      if (council !== null) {
        if (headings.has(council)) throw new RosterError(`${at}: duplicate heading "${council}"`);
        headings.add(council);
      }
      return;
    }
    if (!tableLine) {
      if (state === "rows" && line) {
        throw new RosterError(`${at}: expected a roster row or a blank line after the table`);
      }
      finishTable(at);
      return;
    }
    const cells = cellsOf(line);
    if (state === "none") {
      if (cells.length !== 2 || cells[0] !== "Name" || cells[1] !== "Company") {
        throw new RosterError(`${at}: unrecognized table header ${line}`);
      }
      if (council === null) throw new RosterError(`${at}: roster table outside a "##" heading`);
      if (!councils.includes(council)) councils.push(council);
      tableRows = 0;
      state = "align";
      return;
    }
    if (state === "align") {
      if (cells.length !== 2 || !cells.every((c) => /^:?-+:?$/.test(c))) {
        throw new RosterError(`${at}: expected the table alignment row, got ${line}`);
      }
      state = "rows";
      return;
    }
    if (cells.length !== 2 || !cells[0] || !cells[1]) {
      throw new RosterError(`${at}: malformed roster row ${line}`);
    }
    tableRows++;
    let name = cells[0];
    const company = cells[1];
    if (/^open$/i.test(name)) return;
    const marked = /\\?\*$/.test(name);
    name = name.replace(/\\?\*$/, "").trim();
    if (!name || name.includes("*")) throw new RosterError(`${at}: unparseable name cell ${line}`);
    if (seats.some((s) => s.council === council && s.name === name)) {
      throw new RosterError(`${at}: "${name}" listed twice under "${council}"`);
    }
    seats.push({ name, company, council: council!, marked });
  });

  finishTable("MAINTAINERS.md:end");
  if (!councils.length) {
    throw new RosterError("parsed no roster tables from MAINTAINERS.md — the table format has changed");
  }
  return { councils, seats };
}

/**
 * Exact roster name -> contributor slug, from `rosterNames`.
 *
 * Exact after trimming, nothing looser: a display name is the weakest key this
 * pipeline sees, and one person's seat handed to another is worse than a name
 * left unlinked. An alias claimed by two people, or twice by one, is an error.
 */
export function rosterIndex(contributors: Record<string, { rosterNames?: string[] }>): Map<string, string> {
  const index = new Map<string, string>();
  for (const [slug, c] of Object.entries(contributors)) {
    if (c.rosterNames === undefined) continue;
    if (!Array.isArray(c.rosterNames)) throw new RosterError(`${slug}: rosterNames must be an array`);
    for (const raw of c.rosterNames) {
      const alias = typeof raw === "string" ? raw.trim() : "";
      if (!alias) throw new RosterError(`${slug}: empty rosterNames entry`);
      const owner = index.get(alias);
      if (owner) {
        throw new RosterError(
          owner === slug
            ? `${slug}: rosterNames repeats "${alias}"`
            : `rosterNames "${alias}" is claimed by both ${owner} and ${slug}`,
        );
      }
      index.set(alias, slug);
    }
  }
  return index;
}

/** Structural checks on a pulled roster, before anything is projected from it. */
export function rosterErrors(raw: RawCouncil): string[] {
  const errors: string[] = [];
  const s = raw?.source;
  if (!s || !s.repo || !s.file || !/^[0-9a-f]{40}$/.test(s.sha ?? "") || !s.at) {
    errors.push("raw/council.json: source must carry repo, file, full sha and author time");
  }
  if (!Array.isArray(raw?.councils)) {
    return [...errors, "raw/council.json: no `councils` heading list — re-run `bun run acquire`"];
  }
  if (!Array.isArray(raw.seats)) return [...errors, "raw/council.json: seats must be an array"];
  if (!raw.councils.length || raw.councils.some((name) => typeof name !== "string" || !name.trim())) {
    errors.push("raw/council.json: nonempty roster headings are required");
  }
  const headings = new Set(raw.councils);
  if (headings.size !== raw.councils.length) errors.push("raw/council.json: duplicate heading");
  const seen = new Set<string>();
  for (const seat of raw.seats) {
    if (!seat || typeof seat.name !== "string" || !seat.name.trim() ||
        typeof seat.company !== "string" || !seat.company.trim() || typeof seat.marked !== "boolean") {
      errors.push("raw/council.json: each seat needs a name, company, and boolean source marker");
      continue;
    }
    if (!headings.has(seat.council)) errors.push(`raw/council.json: seat under unlisted heading "${seat.council}"`);
    const key = `${seat.council}\u0000${seat.name}`;
    if (seen.has(key)) errors.push(`raw/council.json: "${seat.name}" twice under "${seat.council}"`);
    seen.add(key);
  }
  return errors;
}

/** Councils per contributor slug, in roster heading order. */
export function councilsBySlug(raw: RawCouncil, index: Map<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const council of raw.councils) {
    for (const seat of raw.seats) {
      if (seat.council !== council) continue;
      const slug = index.get(seat.name.trim());
      if (!slug) continue;
      const list = out.get(slug) ?? [];
      // Two aliases of one person both seated on one council is a conflicting
      // identity claim, not a double seat.
      if (list.includes(council)) {
        throw new RosterError(`${slug} matches two seats under "${council}"`);
      }
      list.push(council);
      out.set(slug, list);
    }
  }
  return out;
}

export type PublishedSeat = { name: string; company: string; marked: boolean; person: string | null };
export type PublishedGovernance = {
  source: { repo: string; file: string; sha: string; url: string; authoredAt: string; collectedAt: string };
  councils: { name: string; seats: PublishedSeat[] }[];
};

/** Immutable blob permalink for a github.com clone URL. */
export const permalink = (repo: string, sha: string, file: string) =>
  `${repo.replace(/\.git$/, "")}/blob/${sha}/${file}`;

/**
 * The Governance page's data: the raw roster verbatim, plus a person link where
 * an alias resolves to a contributor who has a profile page. Anyone else stays
 * listed, unlinked, and gains no activity row.
 */
export function projectGovernance(
  raw: RawCouncil,
  index: Map<string, string>,
  collectedAt: string,
  hasProfile: (slug: string) => boolean,
): PublishedGovernance {
  const errors = rosterErrors(raw);
  if (errors.length) throw new RosterError(errors.join("\n"));
  councilsBySlug(raw, index); // rejects conflicting claims before anything is published
  const { repo, file, sha, at } = raw.source;
  return {
    source: { repo, file, sha, url: permalink(repo, sha, file), authoredAt: at, collectedAt },
    councils: raw.councils.map((name) => ({
      name,
      seats: raw.seats
        .filter((s) => s.council === name)
        .map((s) => {
          const slug = index.get(s.name.trim());
          return { name: s.name, company: s.company, marked: s.marked, person: slug && hasProfile(slug) ? slug : null };
        }),
    })),
  };
}
