import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkDerived, hashFile, LAYER_OUTPUTS, loadSealed, MANIFEST, MANIFEST_SCHEMA, MODE_LAYERS, parseMode,
  pruneGenerated, REPOS_CONFIG, summarize, validateManifest, writeManifest,
  type Layer, type Manifest, type Mode,
} from "./acquisition.ts";
import { loadBranches, loadGitHub } from "./data.ts";

// A throwaway root holding every file any layer writes, so each test can seal a
// real tree and then break exactly one thing about it.
const REPOS = ["ucp", "js-sdk"];
const sha = (c: string) => c.repeat(40);
const HEADS = { ucp: sha("a"), "js-sdk": sha("b") };
const NOW = new Date("2026-09-01T12:00:00.000Z");
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "acq-"));
  roots.push(root);
  mkdirSync(join(root, "raw"), { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, REPOS_CONFIG), `[{ name: "ucp" }, { name: "js-sdk" }]`);
  for (const rel of Object.values(LAYER_OUTPUTS).flat()) writeFileSync(join(root, rel), `content of ${rel}\n`);
  return root;
}

/** A manifest that is valid for `root` as it stands. Times step one minute per layer. */
function sealFor(root: string, mode: Mode): Manifest {
  const runId = "run-1";
  const t = (min: number) => new Date(Date.UTC(2026, 8, 1, 10, min)).toISOString();
  const layers: Manifest["layers"] = {};
  MODE_LAYERS[mode].forEach((name: Layer, i) => {
    const outputs = Object.fromEntries(LAYER_OUTPUTS[name].map((rel) => [rel, hashFile(root, rel)!]));
    layers[name] = { runId, startedAt: t(1 + 2 * i), finishedAt: t(2 + 2 * i), outputs };
  });
  layers.git!.heads = { ...HEADS };
  layers.council!.sourceSha = sha("c");
  if (layers.branches) {
    layers.branches.dependencies = { items: hashFile(root, "raw/items.json")!, heads: { ...HEADS } };
  }
  return {
    schema: MANIFEST_SCHEMA, runId, mode, startedAt: t(0), finishedAt: t(30),
    config: { repos: hashFile(root, REPOS_CONFIG)! }, layers,
  };
}

const ctx = (root: string) => ({ hash: (rel: string) => hashFile(root, rel), repoNames: REPOS, now: NOW });
const errs = (root: string, m: unknown, req?: Mode) => validateManifest(m, ctx(root), req);

describe("validateManifest", () => {
  test("a freshly sealed tree is consumable in both modes", () => {
    const root = tree();
    expect(errs(root, sealFor(root, "full"))).toEqual([]);
    expect(errs(root, sealFor(root, "git-only"))).toEqual([]);
  });

  test("hash mismatch: a standalone pull after sealing voids the seal", () => {
    const root = tree();
    const m = sealFor(root, "full");
    writeFileSync(join(root, "raw/github.jsonl"), "re-pulled\n");
    expect(errs(root, m).join("\n")).toContain("raw/github.jsonl: hash mismatch");
  });

  test("missing output file fails", () => {
    const root = tree();
    const m = sealFor(root, "full");
    rmSync(join(root, "raw/branches.jsonl"));
    expect(errs(root, m).join("\n")).toContain("raw/branches.jsonl: missing");
  });

  test("mixed run: a layer recorded under another runId fails", () => {
    const root = tree();
    const m = sealFor(root, "full");
    m.layers.github!.runId = "run-0";
    expect(errs(root, m).join("\n")).toContain("layer github belongs to run run-0");
  });

  test("missing layer: full requires branches and council", () => {
    const root = tree();
    for (const gone of ["branches", "council"] as const) {
      const m = sealFor(root, "full");
      delete m.layers[gone];
      expect(errs(root, m).join("\n")).toContain(`layer ${gone} missing`);
    }
    const g = sealFor(root, "git-only");
    delete g.layers.council;
    expect(errs(root, g).join("\n")).toContain("layer council missing");
  });

  test("a layer outside the mode, or an output set that differs, fails", () => {
    const root = tree();
    const m = sealFor(root, "git-only");
    m.layers.github = sealFor(root, "full").layers.github;
    expect(errs(root, m).join("\n")).toContain("do not belong to mode git-only");
    const f = sealFor(root, "full");
    delete f.layers.github!.outputs["raw/profiles.json"];
    expect(errs(root, f).join("\n")).toContain("layer github outputs");
  });

  test("invalid dependency: branches walked other items or other heads", () => {
    const root = tree();
    const m = sealFor(root, "full");
    m.layers.branches!.dependencies!.items = "0".repeat(64);
    expect(errs(root, m).join("\n")).toContain("items.json other than the one sealed");
    const h = sealFor(root, "full");
    h.layers.branches!.dependencies!.heads = { ...HEADS, ucp: sha("d") };
    expect(errs(root, h).join("\n")).toContain("mirror heads other than");
    const none = sealFor(root, "full");
    delete none.layers.branches!.dependencies;
    expect(errs(root, none).join("\n")).toContain("branches dependencies missing");
  });

  test("heads must be full shas covering exactly the configured repos", () => {
    const root = tree();
    const short = sealFor(root, "git-only");
    short.layers.git!.heads = { ucp: "abc123", "js-sdk": sha("b") };
    expect(errs(root, short).join("\n")).toContain("not a full sha");
    const partial = sealFor(root, "git-only");
    partial.layers.git!.heads = { ucp: sha("a") };
    expect(errs(root, partial).join("\n")).toContain("git heads cover ucp");
    const council = sealFor(root, "git-only");
    council.layers.council!.sourceSha = "HEAD";
    expect(errs(root, council).join("\n")).toContain("council sourceSha");
  });

  test("invalid times: malformed, inverted, overlapping, after the run, future", () => {
    const root = tree();
    const bad = (mutate: (m: Manifest) => void, want: string) => {
      const m = sealFor(root, "full");
      mutate(m);
      expect(errs(root, m).join("\n")).toContain(want);
    };
    bad((m) => { m.layers.git!.startedAt = "2026-09-01"; }, "layer git has a malformed time");
    bad((m) => { m.layers.git!.finishedAt = m.startedAt; }, "layer git finished before it started");
    // git ran before github finished: the record was stitched from two executions.
    bad((m) => { m.layers.git!.startedAt = m.layers.github!.startedAt; }, "started before the previous step");
    bad((m) => { m.layers.council!.finishedAt = "2026-09-01T11:00:00.000Z"; }, "finished after the run");
    bad((m) => { m.finishedAt = "2027-01-01T00:00:00.000Z"; }, "in the future");
    bad((m) => { m.startedAt = "yesterday"; }, "startedAt");
  });

  test("schema, config and requested mode", () => {
    const root = tree();
    const m = sealFor(root, "git-only");
    expect(errs(root, { ...m, schema: 0 }).join("\n")).toContain("schema 0");
    expect(errs(root, m, "full").join("\n")).toContain("sealed mode is git-only but full was requested");
    expect(errs(root, sealFor(root, "full"), "git-only").join("\n")).toContain("sealed mode is full");
    writeFileSync(join(root, REPOS_CONFIG), `[{ name: "ucp" }]`);
    expect(errs(root, m).join("\n")).toContain(`${REPOS_CONFIG} changed`);
    expect(errs(root, { ...m, mode: "partial" })).toEqual(["unknown mode \"partial\""]);
  });

  test("mode ignores optional raw: git-only seal is unaffected by a stale overlay", () => {
    const root = tree();
    const m = sealFor(root, "git-only");
    writeFileSync(join(root, "raw/github.jsonl"), "stale overlay from last month\n");
    rmSync(join(root, "raw/branches.jsonl"));
    expect(errs(root, m)).toEqual([]);
    // Ignored, not deleted.
    expect(readFileSync(join(root, "raw/github.jsonl"), "utf8")).toContain("stale");
  });
});

describe("loadSealed / writeManifest", () => {
  test("round trip, with digest of the bytes written", () => {
    const root = tree();
    const digest = writeManifest(root, sealFor(root, "full"));
    const s = loadSealed(root, REPOS, undefined, NOW);
    expect(s.mode).toBe("full");
    expect(s.digest).toBe(digest);
    expect(s.digest).toBe(hashFile(root, MANIFEST)!);
    expect(existsSync(join(root, `${MANIFEST}.tmp`))).toBe(false);
  });

  test("no manifest: fails and names the command", () => {
    expect(() => loadSealed(tree(), REPOS, "git-only", NOW)).toThrow("acquire --git-only");
  });

  test("partial write: a run that died after rewriting one layer leaves the OLD manifest, which now fails", () => {
    const root = tree();
    writeManifest(root, sealFor(root, "full"));
    // The next run's github step wrote events, then died before items/logins.
    writeFileSync(join(root, "raw/github.jsonl"), "half of a new run\n");
    expect(() => loadSealed(root, REPOS, undefined, NOW)).toThrow("raw/github.jsonl: hash mismatch");
  });

  test("a corrupt manifest fails rather than being treated as absent", () => {
    const root = tree();
    writeFileSync(join(root, MANIFEST), "{ not json");
    expect(() => loadSealed(root, REPOS, undefined, NOW)).toThrow("not JSON");
  });
});

describe("checkDerived", () => {
  test("a summary derived from the current seal passes", () => {
    const root = tree();
    writeManifest(root, sealFor(root, "full"));
    const s = loadSealed(root, REPOS, undefined, NOW);
    expect(checkDerived(JSON.parse(JSON.stringify(summarize(s))), s)).toEqual([]);
    expect(summarize(s).heads).toEqual(HEADS);
    expect(summarize(s).councilSha).toBe(sha("c"));
  });

  test("derived digest stale: a re-acquire after derive is caught by verify", () => {
    const root = tree();
    writeManifest(root, sealFor(root, "full"));
    const published = summarize(loadSealed(root, REPOS, undefined, NOW));
    const next = sealFor(root, "full");
    next.runId = "run-2";
    for (const l of Object.values(next.layers)) l!.runId = "run-2";
    writeManifest(root, next);
    const errors = checkDerived(published, loadSealed(root, REPOS, undefined, NOW));
    expect(errors.join("\n")).toContain("was derived from manifest");
    expect(errors.join("\n")).toContain("runId");
  });

  test("a summary without an acquisition record fails", () => {
    const root = tree();
    writeManifest(root, sealFor(root, "git-only"));
    expect(checkDerived(undefined, loadSealed(root, REPOS, undefined, NOW))[0]).toContain("no acquisition record");
  });
});

describe("mode plumbing", () => {
  test("parseMode accepts only the two flags", () => {
    expect(parseMode([])).toBeUndefined();
    expect(parseMode(["--git-only"])).toBe("git-only");
    expect(parseMode(["--full"])).toBe("full");
    expect(() => parseMode(["--git-only", "--full"])).toThrow("exclusive");
    expect(() => parseMode(["--gitonly"])).toThrow("unknown argument");
  });

  test("git-only loaders return null without reading, whatever raw/ holds", () => {
    expect(loadGitHub("git-only")).toBeNull();
    expect(loadBranches("git-only")).toBeNull();
  });

  test("pruneGenerated removes exactly the outputs whose source was not consumed", () => {
    const dir = tree();
    const touch = () => { for (const f of ["items.json", "heartbeat.json", "summary.json"]) writeFileSync(join(dir, f), "{}"); };
    touch();
    expect(pruneGenerated(dir, { github: false, branches: false }).sort()).toEqual(["heartbeat.json", "items.json"]);
    expect(existsSync(join(dir, "summary.json"))).toBe(true);
    touch();
    expect(pruneGenerated(dir, { github: true, branches: false })).toEqual(["items.json"]);
    touch();
    expect(pruneGenerated(dir, { github: true, branches: true })).toEqual([]);
  });
});
