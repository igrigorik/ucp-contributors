// Pure parsing of `git log` output.
//
// This lives in lib/ rather than in pull.ts for one reason: pull.ts clones
// repositories at module scope, so importing a function from it to test that
// function would run a network fetch. Parsers are the part most worth testing —
// they turn an untyped text format into every downstream number — so they need
// to be importable without side effects.
import type { Commit } from "./types.ts";

/**
 * `Co-authored-by: Name <email>` declarations.
 *
 * The source grammar is ONE physical line, anywhere in the message body:
 * `Co-authored-by:` at column 0 (any casing), optional spaces/tabs, a non-empty
 * name, optional spaces/tabs, `<email>`, optional trailing spaces/tabs, end of
 * line. Nothing may span a newline: `[ \t]` rather than `\s`, and the email
 * class excludes `\n`, so a broken line can never borrow the next line's text.
 *
 * Deliberately broader than Git's strict terminal-trailer parser: a squash merge
 * often stacks the branch's commit messages, so declarations sit mid-message,
 * not only in the final paragraph. Quoted (`> `), indented, and mid-sentence
 * text does not match. There is no Markdown parsing, so a standalone exact line
 * inside a fenced code block DOES match -- a known, accepted limitation.
 *
 * Only the email is kept: it is the identity key that joins to a contributor
 * record, whereas the display name is free text spelled differently per commit.
 */
const TRAILER = /^co-authored-by:[ \t]*(.+?)[ \t]*<([^>\n]+)>[ \t]*$/gim;

/**
 * The commit's subject line — the first line of the body, per git convention.
 *
 * Kept because the activity log needs something readable per commit: a bare sha
 * is a link with no reason to click it. The full body is deliberately NOT kept;
 * it can run to hundreds of lines and the log shows one row per event.
 */
export function subject(body: string): string {
  return (body ?? "").split("\n", 1)[0]!.trim();
}

export function coauthors(body: string): string[] {
  // A Set because a trailer duplicated in one body must credit one person once.
  // Lowercased for the same reason emails are lowercased at every other
  // boundary: `A@b.com` and `a@b.com` are one identity, and treating them as two
  // would split a person's credits across two records.
  const found = new Set<string>();
  // The group is only optional to the type system — TRAILER cannot match without
  // it. Skipping rather than asserting means editing that regex can never turn a
  // credit into a crash mid-run, which for a pipeline that walks six repos is
  // the difference between one lost trailer and no output at all.
  for (const [, , email] of body.matchAll(TRAILER)) {
    if (email) found.add(email.trim().toLowerCase());
  }
  return [...found];
}

/**
 * Flatten one repository's `git log` output into commits.
 *
 * The record separator is NUL and the field separator is SOH. Git forbids NUL,
 * but SOH can occur in metadata; exact field-count validation therefore makes
 * that case fail closed instead of shifting fields into plausible wrong data.
 */
export function parseLog(repo: string, out: string): Commit[] {
  const commits: Commit[] = [];

  // Each record: <header fields>\x01<numstat lines>. slice(1) drops the empty
  // leading field produced by the format's own leading NUL.
  for (const record of out.split("\x00").slice(1)) {
    const fields = record.split("\x01");
    if (fields.length !== 6) {
      throw new Error(`git log SOH framing error in ${repo}: expected 6 fields, got ${fields.length}`);
    }
    const [sha, email, name, iso, body, stats = ""] = fields;
    const co = coauthors(body ?? "");
    const cur: Commit = {
      repo,
      sha: sha!.slice(0, 12),
      email: (email ?? "").toLowerCase(),
      name: name ?? "",
      date: (iso ?? "").slice(0, 10),
      subject: subject(body ?? ""),
      added: 0,
      deleted: 0,
      files: 0,
      // Omitted rather than an empty array so the raw file stays small and the
      // absence of co-authorship is absence, not an empty measurement.
      ...(co.length ? { coauthors: co } : {}),
    };
    for (const line of stats.split("\n")) {
      if (!line.trim()) continue;
      // "added<TAB>deleted<TAB>path". Binary files report "-" for both counts,
      // which parses to NaN, so `|| 0` keeps the file counted while its churn
      // contributes nothing. A NaN here would poison every sum downstream.
      const [a, d] = line.split("\t");
      cur.files += 1;
      cur.added += Number.parseInt(a ?? "0", 10) || 0;
      cur.deleted += Number.parseInt(d ?? "0", 10) || 0;
    }
    commits.push(cur);
  }
  return commits;
}
