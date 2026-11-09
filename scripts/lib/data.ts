// Runtime-portable loading: node: APIs only, so these scripts still run under
// plain `node` if Bun is unavailable.
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import type { Mode } from "./acquisition.ts";
import type { BranchRecord, Commit, Contributor, GitHubEvent, RawCouncil, Item, Org, Profile, Repo } from "./types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const p = (...parts: string[]) => join(ROOT, ...parts);

export const ensureDir = (dir: string) => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
};

const json5 = <T>(rel: string): T => JSON5.parse(readFileSync(p(rel), "utf8"));

/**
 * Throw on a duplicated object key BEFORE parsing.
 *
 * These files are hand-edited, and a JSON object cannot hold two entries under
 * one key: `JSON5.parse` silently keeps the last and destroys the evidence. That
 * is unrecoverable after the fact and produces exactly the failure mode this
 * project treats as worst-case — a plausible-looking wrong number with no error.
 * A real instance: one contributor gained a second record (they had both a
 * GitHub company and a corporate co-author email), the surviving copy lacked the
 * other copy's `emails[]`, and two commits silently became "unknown".
 *
 * Detection must follow JSON5's object structure rather than indentation: four
 * spaces and tabs are both valid formatting, so indentation-sensitive checks can
 * silently stop protecting the file after a reformat. Each object gets its own
 * key set because fields such as `orgs` legitimately recur in different records.
 */
export function assertNoDuplicateKeys(rel: string, text: string): void {
  let pos = 0;
  const dupes = new Set<string>();

  const skipTrivia = () => {
    for (;;) {
      while (/\s/.test(text[pos] ?? "")) pos++;
      if (text.startsWith("//", pos)) {
        const end = text.indexOf("\n", pos + 2);
        pos = end < 0 ? text.length : end + 1;
      } else if (text.startsWith("/*", pos)) {
        const end = text.indexOf("*/", pos + 2);
        pos = end < 0 ? text.length : end + 2;
      } else {
        return;
      }
    }
  };

  const readString = () => {
    const start = pos;
    const quote = text[pos++]!;
    while (pos < text.length) {
      const ch = text[pos++]!;
      if (ch === "\\") {
        if (text[pos] === "\r" && text[pos + 1] === "\n") pos += 2;
        else if (pos < text.length) pos++;
      } else if (ch === quote) {
        break;
      }
    }
    return text.slice(start, pos);
  };

  const readKey = () => {
    if (text[pos] === '"' || text[pos] === "'") {
      return JSON5.parse(readString()) as string;
    }
    const start = pos;
    while (pos < text.length && !/[\s:/]/.test(text[pos]!)) pos++;
    const raw = text.slice(start, pos);
    try {
      return Object.keys(JSON5.parse(`{${raw}: null}`) as object)[0] ?? raw;
    } catch {
      return raw;
    }
  };

  const scanValue = (): void => {
    skipTrivia();
    if (text[pos] === "{") {
      scanObject();
      return;
    }
    if (text[pos] === "[") {
      scanArray();
      return;
    }
    if (text[pos] === '"' || text[pos] === "'") {
      readString();
      return;
    }
    while (pos < text.length && !/[,}\]\s]/.test(text[pos]!)) {
      if (text.startsWith("//", pos) || text.startsWith("/*", pos)) break;
      pos++;
    }
  };

  const scanArray = (): void => {
    pos++;
    for (;;) {
      skipTrivia();
      if (text[pos] === "]" || pos >= text.length) {
        pos++;
        return;
      }
      scanValue();
      skipTrivia();
      if (text[pos] === ",") pos++;
      else if (text[pos] !== "]") return;
    }
  };

  const scanObject = (): void => {
    pos++;
    const seen = new Set<string>();
    for (;;) {
      skipTrivia();
      if (text[pos] === "}" || pos >= text.length) {
        pos++;
        return;
      }
      const key = readKey();
      skipTrivia();
      if (text[pos] !== ":") return;
      pos++;
      if (seen.has(key)) dupes.add(key);
      seen.add(key);
      scanValue();
      skipTrivia();
      if (text[pos] === ",") pos++;
      else if (text[pos] !== "}") return;
    }
  };

  scanValue();
  if (dupes.size) {
    throw new Error(
      `${rel}: duplicate key(s) ${[...dupes].map((d) => `"${d}"`).join(", ")} — ` +
        `JSON5 keeps only the last, so merge them into one record`,
    );
  }
}

const json5checked = <T>(rel: string): T => {
  const text = readFileSync(p(rel), "utf8");
  assertNoDuplicateKeys(rel, text);
  return JSON5.parse(text) as T;
};

const REPO_NAME = /^[a-z0-9][a-z0-9-]*$/;
const REPO_OWNER = "Universal-Commerce-Protocol";

/** Validate the public repository allowlist before any value reaches a path or network call. */
export function validateRepos(repos: Repo[]): Repo[] {
  if (!Array.isArray(repos)) throw new Error("data/repos.json5: expected an array");
  const seen = new Set<string>();
  for (const repo of repos) {
    if (!repo || typeof repo.name !== "string" || !REPO_NAME.test(repo.name)) {
      throw new Error("data/repos.json5: repository name must match ^[a-z0-9][a-z0-9-]*$");
    }
    // The `.github` governance repository is mirrored at raw/repos/governance.git
    // by pull-council and acquire, so an allowlisted repo of that name would share it.
    if (repo.name === "governance") {
      throw new Error('data/repos.json5: repository name "governance" is reserved for the governance mirror');
    }
    if (seen.has(repo.name)) throw new Error(`data/repos.json5: duplicate repository name "${repo.name}"`);
    seen.add(repo.name);

    let url: URL;
    try {
      url = new URL(repo.url);
    } catch {
      throw new Error(`data/repos.json5: ${repo.name} has a malformed URL`);
    }
    const expectedPath = `/${REPO_OWNER}/${repo.name}.git`;
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port ||
        url.username || url.password || url.search || url.hash || url.pathname !== expectedPath) {
      throw new Error(
        `data/repos.json5: ${repo.name} URL must be exactly https://github.com/${REPO_OWNER}/${repo.name}.git`,
      );
    }
  }
  return repos;
}

export const loadRepos = () => validateRepos(json5<Repo[]>("data/repos.json5"));
export const loadOrgs = () => json5checked<Record<string, Org>>("data/orgs.json5");
export const loadContributors = () =>
  json5checked<Record<string, Contributor>>("data/contributors.json5");

export function loadCommits(): Commit[] {
  const file = p("raw/commits.jsonl");
  if (!existsSync(file)) {
    throw new Error("raw/commits.jsonl missing — run `bun run pull` first");
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Commit);
}

const readJson = <T>(rel: string): T =>
  JSON.parse(readFileSync(p(rel), "utf8")) as T;

/**
 * The optional GitHub overlay. Returns null when it was never pulled, which
 * callers must treat as "unknown", never as zero: rendering an empty review
 * column as 0 would libel every reviewer in the project.
 */
/**
 * Branch walks, if `pull-branches` has run. An overlay on the overlay: the
 * GitHub pull can succeed without it, so absence is normal and means the site
 * omits per-person line attribution rather than reporting it as zero.
 */
export function loadCouncil(): RawCouncil | null {
  const file = p("raw/council.json");
  if (!existsSync(file)) return null;
  return readJson<RawCouncil>("raw/council.json");
}

/**
 * `mode` is the consumption mode. "git-only" returns null without looking: an
 * overlay left on disk by an earlier full run is stale relative to this run's
 * spine, and its presence is not evidence it belongs. It is ignored, not deleted.
 */
export function loadBranches(mode: Mode): BranchRecord[] | null {
  if (mode === "git-only") return null;
  const file = p("raw/branches.jsonl");
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function loadGitHub(mode: Mode): {
  events: GitHubEvent[];
  items: Record<string, Item>;
  bridge: Record<string, string>;
  profiles: Record<string, Profile>;
} | null {
  if (mode === "git-only") return null;
  const file = p("raw/github.jsonl");
  if (!existsSync(file)) {
    // Full mode was promised an overlay; silently degrading to git-only here is
    // exactly the mixed publication the seal exists to prevent.
    throw new Error("full mode requires raw/github.jsonl");
  }

  // Items and identity bridges are measured parts of one overlay snapshot, not
  // optional metadata. Treating either missing file as an empty object turns an
  // incomplete pull into plausible measured zeros; profiles alone are optional
  // because they feed human suggestions rather than published measurements.
  const required = ["raw/items.json", "raw/logins.json"];
  const missing = required.filter((rel) => !existsSync(p(rel)));
  if (missing.length) {
    throw new Error(
      `GitHub overlay is incomplete: ${missing.join(", ")} missing while raw/github.jsonl exists`,
    );
  }

  return {
    events: readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    items: readJson<Record<string, Item>>("raw/items.json"),
    bridge: readJson<Record<string, string>>("raw/logins.json"),
    profiles: existsSync(p("raw/profiles.json"))
      ? readJson<Record<string, Profile>>("raw/profiles.json")
      : {},
  };
}
