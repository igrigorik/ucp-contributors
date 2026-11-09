import { expect, test } from "bun:test";
import { councilsBySlug, parseRoster, projectGovernance, rosterErrors, rosterIndex } from "./roster.ts";
import type { RawCouncil } from "./types.ts";

const SHA = "d".repeat(40);
const table = (heading: string, rows: string[]) =>
  [`## ${heading}`, "", "Prose about the council.", "", "| Name | Company |", "| :--- | :------ |", ...rows, ""].join("\n");

// Shaped like MAINTAINERS.md: a `#` title, `*`-marked names, vacant seats, and
// an all-vacant heading that must survive with no names.
const MD = [
  "# UCP Maintainers", "",
  table("Shopping Tech Council", ["| Amit Handa\\* | Google |", "| Ilya Grigorik | Shopify |", "| Jordan Williams | Amazon |"]),
  table("Payments Tech Council", ["| Ilya Grigorik\\* | Shopify |", "| Open | to be elected |"]),
  table("Governance Council", ["| Ilya Grigorik | Shopify |", "| Amit Handa | Google |"]),
  table("Future Tech Council", ["| Open | to be elected |", "| Open | to be elected |"]),
].join("\n");

const rawOf = (md: string): RawCouncil => ({
  source: { repo: "https://github.com/Universal-Commerce-Protocol/.github.git", file: "MAINTAINERS.md", sha: SHA, at: "2026-11-05T07:00:03-08:00" },
  ...parseRoster(md),
});
const contributors: Record<string, { name?: string; rosterNames?: string[] }> = {
  "ilya-grigorik": { name: "Ilya Grigorik", rosterNames: ["Ilya Grigorik"] },
  "amit-handa": { rosterNames: ["Amit Handa"] },
  // Same display name as a roster entry, but no alias: must NOT link.
  "jordan-williams": { name: "Jordan Williams" },
};
const project = (raw: RawCouncil, c: Record<string, { rosterNames?: string[] }> = contributors) =>
  projectGovernance(raw, rosterIndex(c), "2026-11-08T17:40:05.216Z", () => true);
const names = (g: ReturnType<typeof project>, council: string) =>
  g.councils.find((c) => c.name === council)?.seats.map((s) => s.name);

test("parser records headings and named seats; vacancies are skipped, not people", () => {
  const { councils, seats } = parseRoster(MD);
  expect(councils).toEqual(["Shopping Tech Council", "Payments Tech Council", "Governance Council", "Future Tech Council"]);
  expect(seats).toHaveLength(6);
  expect(seats.some((s) => s.name === "Open")).toBe(false);
  expect(seats.find((s) => s.council === "Payments Tech Council")).toEqual(
    { name: "Ilya Grigorik", company: "Shopify", council: "Payments Tech Council", marked: true });
});

test("parser rejects malformed recognized tables instead of dropping rows", () => {
  const bad = (rows: string[]) => () => parseRoster(table("X Council", rows));
  expect(bad(["| Ada | Acme | extra |"])).toThrow(/malformed roster row/);
  expect(bad(["| Ada |"])).toThrow(/malformed roster row/);
  expect(bad(["| | Acme |"])).toThrow(/malformed roster row/);
  expect(bad(["| Ada | Acme |", "| Ada | Acme |"])).toThrow(/twice/);
  expect(() => parseRoster(table("X", ["| Ada | Acme |"]) + table("X", ["| Bob | Acme |"]))).toThrow(/duplicate heading/);
  expect(() => parseRoster("## X\n\n| Who | Where |\n| --- | --- |\n| Ada | Acme |\n")).toThrow(/unrecognized table header/);
  expect(() => parseRoster("## X\n\n| Name | Company |\n| Ada | Acme |\n")).toThrow(/alignment row/);
  expect(() => parseRoster("# Title\n\n| Name | Company |\n| --- | --- |\n| Ada | Acme |\n")).toThrow(/outside/);
  expect(() => parseRoster("# Maintainers\n\nNo tables yet.")).toThrow(/no roster tables/);
});

test("a truncated later table cannot silently disappear", () => {
  for (const ending of ["", "\n", "\n## Another heading"]) {
    expect(() => parseRoster(MD + "\n## Broken Council\n| Name | Company |" + ending))
      .toThrow(/alignment row/);
  }
  expect(() => parseRoster(MD + "\n## Broken Council\n| Name | Company |\n| --- | --- |\nAda Acme"))
    .toThrow(/expected a roster row/);
});

test("header-only tables do not masquerade as explicitly vacant councils", () => {
  for (const ending of ["", "\n", "\n## Next Council"]) {
    expect(() => parseRoster(MD + "\n## Broken Council\nName | Company\n--- | ---" + ending))
      .toThrow(/roster table has no rows/);
  }
});

test("table rows without optional outer pipes are parsed, not dropped", () => {
  const raw = rawOf("## Council\n\nName | Company\n--- | ---\nAda | Acme\n");
  expect(raw.seats).toEqual([{ name: "Ada", company: "Acme", council: "Council", marked: false }]);
});

test("an entirely vacant but valid source is distinct from an unparsed source", () => {
  const raw = rawOf(table("Future Council", ["| Open | to be elected |"]));
  expect(rosterErrors(raw)).toEqual([]);
  expect(project(raw).councils).toEqual([{ name: "Future Council", seats: [] }]);
});

test("malformed raw seats cannot become plausible source facts", () => {
  const raw = rawOf(MD);
  expect(rosterErrors({ ...raw, seats: [{ ...raw.seats[0]!, marked: undefined }] } as unknown as RawCouncil))
    .toContain("raw/council.json: each seat needs a name, company, and boolean source marker");
});

test("known person keeps three councils, derived from the roster alone", () => {
  const raw = rawOf(MD);
  expect(councilsBySlug(raw, rosterIndex(contributors)).get("ilya-grigorik"))
    .toEqual(["Shopping Tech Council", "Payments Tech Council", "Governance Council"]);
  const g = project(raw);
  expect(g.councils.find((c) => c.name === "Payments Tech Council")!.seats[0]).toEqual(
    { name: "Ilya Grigorik", company: "Shopify", marked: true, person: "ilya-grigorik" });
});

test("an all-vacant heading is published with no names", () => {
  const g = project(rawOf(MD));
  expect(g.councils.map((c) => c.name)).toContain("Future Tech Council");
  expect(names(g, "Future Tech Council")).toEqual([]);
});

test("an unmatched name stays listed and unlinked, even when a display name matches", () => {
  const seat = project(rawOf(MD)).councils[0]!.seats.find((s) => s.name === "Jordan Williams")!;
  expect(seat).toEqual({ name: "Jordan Williams", company: "Amazon", marked: false, person: null });
  expect(councilsBySlug(rawOf(MD), rosterIndex(contributors)).has("jordan-williams")).toBe(false);
});

test("a linked alias without a profile page stays unlinked", () => {
  const g = projectGovernance(rawOf(MD), rosterIndex(contributors), "t", (slug) => slug !== "amit-handa");
  expect(g.councils[0]!.seats[0]).toMatchObject({ name: "Amit Handa", person: null });
});

test("new seats, new headings, removals and company changes follow raw with no curation", () => {
  const before = project(rawOf(MD));
  const md2 = MD
    .replace("| Jordan Williams | Amazon |", "| Jordan Williams | Amazon |\n| New Person | Acme |")
    .replace("| Amit Handa | Google |", "")                       // left Governance Council
    .replace("| Ilya Grigorik | Shopify |\n| Jordan", "| Ilya Grigorik | Initech |\n| Jordan")
    + table("Brand New Council", ["| Ilya Grigorik | Shopify |"]);
  const after = project(rawOf(md2));
  expect(names(after, "Shopping Tech Council")).toContain("New Person");
  expect(names(after, "Governance Council")).toEqual(["Ilya Grigorik"]);
  expect(after.councils.at(-1)!.name).toBe("Brand New Council");
  expect(after.councils[0]!.seats.find((s) => s.name === "Ilya Grigorik")!.company).toBe("Initech");
  expect(councilsBySlug(rawOf(md2), rosterIndex(contributors)).get("amit-handa")).toEqual(["Shopping Tech Council"]);
  expect(councilsBySlug(rawOf(md2), rosterIndex(contributors)).get("ilya-grigorik")).toHaveLength(4);
  expect(after).not.toEqual(before);
});

test("ambiguous or conflicting aliases are rejected", () => {
  expect(() => rosterIndex({ a: { rosterNames: ["Ada"] }, b: { rosterNames: [" Ada "] } })).toThrow(/claimed by both/);
  expect(() => rosterIndex({ a: { rosterNames: ["Ada", "Ada"] } })).toThrow(/repeats/);
  expect(() => rosterIndex({ a: { rosterNames: [" "] } })).toThrow(/empty/);
  // Two aliases of one person seated twice under one heading is a conflicting claim.
  const two = { "ilya-grigorik": { rosterNames: ["Ilya Grigorik", "Jordan Williams"] } };
  expect(() => project(rawOf(MD), two)).toThrow(/two seats/);
});

test("published source is the immutable permalink and the sealed collection time", () => {
  const g = project(rawOf(MD));
  expect(g.source.url).toBe(`https://github.com/Universal-Commerce-Protocol/.github/blob/${SHA}/MAINTAINERS.md`);
  expect(g.source.collectedAt).toBe("2026-11-08T17:40:05.216Z");
  expect(g.source.authoredAt).toBe("2026-11-05T07:00:03-08:00");
  // Nothing curated rides along: no status, approval, chair or working group.
  expect(JSON.stringify(g)).not.toMatch(/status|approv|chair|working|asOf|summary|role/i);
});

test("a roster from before the heading list, or with a short sha, is refused", () => {
  const raw = rawOf(MD) as Partial<RawCouncil>;
  expect(rosterErrors({ ...raw, councils: undefined } as unknown as RawCouncil).join()).toMatch(/heading list/);
  expect(rosterErrors({ ...raw, source: { ...raw.source!, sha: "ddd1b3f" } } as RawCouncil).join()).toMatch(/full sha/);
  expect(rosterErrors({ ...raw, councils: ["Shopping Tech Council"] } as RawCouncil).join()).toMatch(/unlisted heading/);
});
