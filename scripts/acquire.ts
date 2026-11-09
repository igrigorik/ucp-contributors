#!/usr/bin/env bun
// Run one acquisition and seal it. The only command whose output `derive` and
// `verify` will consume; the individual `pull:*` scripts remain for development,
// and anything they rewrite voids the seal instead of mixing into it.
//
//   bun run scripts/acquire.ts --git-only   git spine + council roster
//   bun run scripts/acquire.ts [--full]     github, git, branches, council
//
// Full mode runs GitHub BEFORE git, so the spine is never older than the
// overlay it is joined against; branches then walk the items just pulled over
// the mirrors just fetched, and record exactly which of each they read.
//
// raw/manifest.json is written LAST and only on success. A run that dies midway
// leaves the previous manifest in place, and the hashes it holds no longer match
// whatever was half-rewritten, so consumption fails closed. The last good site
// is whatever was last deployed; nothing here touches site/.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  LAYER_OUTPUTS, MANIFEST, MANIFEST_SCHEMA, MODE_LAYERS, REPOS_CONFIG, hashFile, newRunId, parseMode,
  validateManifest, writeManifest, type Layer, type LayerRecord, type Manifest, type Mode,
} from "./lib/acquisition.ts";
import { loadRepos, p } from "./lib/data.ts";

const SCRIPT: Record<Layer, string> = {
  github: "scripts/pull-github.ts",
  git: "scripts/pull.ts",
  branches: "scripts/pull-branches.ts",
  council: "scripts/pull-council.ts",
};

const die = (msg: string): never => {
  console.error(`acquire: ${msg}\nacquire: no manifest written; ${MANIFEST} (if any) is from an earlier run`);
  process.exit(1);
};

const mode: Mode = (() => {
  try {
    return parseMode(process.argv.slice(2)) ?? "full";
  } catch (e) {
    return die((e as Error).message);
  }
})();

const root = p();
const repoNames = loadRepos().map((r) => r.name);
const reposHash = hashFile(root, REPOS_CONFIG)!;
const runId = newRunId();
const startedAt = new Date().toISOString();

const head = (mirror: string) =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: p("raw/repos", `${mirror}.git`), encoding: "utf8" }).trim();
const heads = () => Object.fromEntries(repoNames.map((n) => [n, head(n)]));
const outputs = (layer: Layer) => {
  const o: Record<string, string> = {};
  for (const rel of LAYER_OUTPUTS[layer]) {
    const h = hashFile(root, rel);
    if (!h) die(`${layer} exited 0 but did not write ${rel}`);
    o[rel] = h!;
  }
  return o;
};

const layers: Manifest["layers"] = {};
console.log(`acquire: run ${runId}, mode ${mode}`);

for (const layer of MODE_LAYERS[mode]) {
  // Captured before the step so the record states what the walk was GIVEN; it is
  // re-read after, and any drift during the step is a concurrent writer.
  const before = layer === "branches"
    ? { items: hashFile(root, "raw/items.json"), heads: heads() }
    : null;

  console.log(`\n── ${layer} (${SCRIPT[layer]})`);
  const layerStart = new Date().toISOString();
  const res = spawnSync(process.execPath, ["run", p(SCRIPT[layer])], { stdio: "inherit", cwd: root });
  const layerEnd = new Date().toISOString();
  if (res.status !== 0) die(`${layer} failed (exit ${res.status ?? res.signal})`);

  const rec: LayerRecord = { runId, startedAt: layerStart, finishedAt: layerEnd, outputs: outputs(layer) };
  if (layer === "git") rec.heads = heads();
  if (layer === "branches") {
    const after = { items: hashFile(root, "raw/items.json"), heads: heads() };
    if (JSON.stringify(after) !== JSON.stringify(before)) die("items.json or a mirror head changed during the branch walk");
    rec.dependencies = { items: before!.items!, heads: before!.heads };
  }
  if (layer === "council") {
    const sha = JSON.parse(readFileSync(p("raw/council.json"), "utf8"))?.source?.sha;
    const gov = head("governance");
    if (sha !== gov) die(`raw/council.json names source ${sha} but the governance mirror is at ${gov}`);
    rec.sourceSha = sha;
  }
  layers[layer] = rec;
}

const manifest: Manifest = {
  schema: MANIFEST_SCHEMA, runId, mode, startedAt, finishedAt: new Date().toISOString(),
  config: { repos: reposHash }, layers,
};

// The same validator the consumers run, against the files as they are now: a
// seal that derive would reject must never be written in the first place.
const errors = validateManifest(manifest, { hash: (rel) => hashFile(root, rel), repoNames, now: new Date() });
if (errors.length) die(`refusing to seal:\n  ✗ ${errors.join("\n  ✗ ")}`);

const digest = writeManifest(root, manifest);
console.log(`\nacquire: sealed ${MANIFEST} ${digest.slice(0, 12)} — ${MODE_LAYERS[mode].join(", ")}`);
