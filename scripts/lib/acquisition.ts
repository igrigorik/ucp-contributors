// The acquisition seal: which raw/ files one successful `acquire` run produced,
// in which mode, from which sources — and the check that they are still those
// files before anything consumes them.
//
// WHY THIS EXISTS
//
// `build` used to refresh the git spine and then derive against whatever GitHub
// overlay happened to be lying in raw/ from an earlier run. Nothing recorded
// that the two layers came from different days, so the site published a review
// column from one snapshot beside a commit column from another, with no error
// and no visible seam. A file's presence is not evidence of which run wrote it.
//
// The rule is now: a raw file is consumable only if a manifest written LAST by a
// successful run names it and its current SHA-256 still matches. Any later
// rewrite — a standalone `pull:*`, a run that died halfway — changes a hash and
// voids the seal rather than mixing silently. Files a mode does not include are
// ignored, never deleted: a git-only run leaves an old overlay on disk untouched
// and unread.
//
// Deliberately NOT a general dependency framework: four fixed layers, one real
// cross-layer dependency (branches walk items.json against the git mirrors).
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST_SCHEMA = 1;
export const MANIFEST = "raw/manifest.json";
export const REPOS_CONFIG = "data/repos.json5";

export type Mode = "git-only" | "full";
export type Layer = "github" | "git" | "branches" | "council";

/** Execution order per mode, which is also the order the times must respect. */
export const MODE_LAYERS: Record<Mode, readonly Layer[]> = {
  "git-only": ["git", "council"],
  full: ["github", "git", "branches", "council"],
};

/** Every file a layer writes. A layer's outputs must be exactly this set. */
export const LAYER_OUTPUTS: Record<Layer, readonly string[]> = {
  github: ["raw/github.jsonl", "raw/items.json", "raw/logins.json", "raw/profiles.json"],
  git: ["raw/commits.jsonl"],
  branches: ["raw/branches.jsonl"],
  council: ["raw/council.json"],
};

/** Generated files that exist only when the full overlay was consumed. */
export const FULL_ONLY_GENERATED = ["items.json", "heartbeat.json"] as const;

export type LayerRecord = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  outputs: Record<string, string>;
  /** git: full HEAD sha per measured mirror after fetch. */
  heads?: Record<string, string>;
  /** branches: what the walk actually read. */
  dependencies?: { items: string; heads: Record<string, string> };
  /** council: the .github commit the roster was read from. */
  sourceSha?: string;
};

export type Manifest = {
  schema: number;
  runId: string;
  mode: Mode;
  startedAt: string;
  finishedAt: string;
  config: { repos: string };
  layers: Partial<Record<Layer, LayerRecord>>;
};

export type ValidationContext = {
  /** Current SHA-256 of a root-relative file, or null when it does not exist. */
  hash: (rel: string) => string | null;
  /** Names from data/repos.json5, which the git heads must cover exactly. */
  repoNames: readonly string[];
  now: Date;
};

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
// Clock skew tolerated between the acquiring host and the consuming one.
const FUTURE_SKEW_MS = 5 * 60 * 1000;

export const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

export function hashFile(root: string, rel: string): string | null {
  const file = join(root, rel);
  return existsSync(file) ? sha256(readFileSync(file)) : null;
}

export const newRunId = () => randomUUID();

/** A canonical ISO instant; `Date.parse` alone accepts "2026" and "Sept 1". */
const instant = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) && new Date(t).toISOString() === v ? t : null;
};

const sameKeys = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((k, i) => k === [...b].sort()[i]);

const sameMap = (a: Record<string, string>, b: Record<string, string>) =>
  sameKeys(Object.keys(a), Object.keys(b)) && Object.entries(a).every(([k, v]) => b[k] === v);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isStringMap = (v: unknown): v is Record<string, string> =>
  isRecord(v) && Object.values(v).every((x) => typeof x === "string");

/**
 * Every reason this manifest may not be consumed, or [] when it may. Pure: the
 * file system reaches it only through `ctx.hash`, so every failure is a fixture.
 *
 * `requested` is the mode the consumer was told to run in; undefined means
 * "whatever was sealed". An explicit mode must match exactly — a git-only
 * consumer of a full seal would publish a summary whose digest claims a full
 * run, and a full consumer of a git-only seal has no overlay to read.
 */
export function validateManifest(m: unknown, ctx: ValidationContext, requested?: Mode): string[] {
  const errors: string[] = [];
  const fail = (msg: string) => errors.push(msg);
  if (!isRecord(m)) return ["manifest is not an object"];

  if (m.schema !== MANIFEST_SCHEMA) fail(`schema ${String(m.schema)} is not ${MANIFEST_SCHEMA}`);
  if (typeof m.runId !== "string" || !m.runId) fail("runId missing");
  const mode = m.mode as Mode;
  if (!(mode in MODE_LAYERS)) return [...errors, `unknown mode ${JSON.stringify(m.mode)}`];
  if (requested && requested !== mode) fail(`sealed mode is ${mode} but ${requested} was requested`);

  const config = m.config;
  const reposHash = ctx.hash(REPOS_CONFIG);
  if (!isRecord(config) || config.repos !== reposHash) {
    fail(`${REPOS_CONFIG} changed since acquisition (sealed ${isRecord(config) ? String(config.repos) : "nothing"}, now ${reposHash})`);
  }

  const runStart = instant(m.startedAt);
  const runEnd = instant(m.finishedAt);
  if (runStart === null) fail(`startedAt ${JSON.stringify(m.startedAt)} is not an ISO instant`);
  if (runEnd === null) fail(`finishedAt ${JSON.stringify(m.finishedAt)} is not an ISO instant`);
  if (runStart !== null && runEnd !== null && runStart > runEnd) fail("run finishedAt precedes startedAt");
  if (runEnd !== null && runEnd > ctx.now.getTime() + FUTURE_SKEW_MS) fail("run finishedAt is in the future");

  const layers = isRecord(m.layers) ? m.layers : {};
  const expected = MODE_LAYERS[mode];
  const extra = Object.keys(layers).filter((l) => !expected.includes(l as Layer));
  if (extra.length) fail(`layers ${extra.join(", ")} do not belong to mode ${mode}`);

  let prevEnd = runStart;
  for (const name of expected) {
    const raw = layers[name];
    if (!isRecord(raw)) {
      fail(`layer ${name} missing — mode ${mode} requires ${expected.join(", ")}`);
      continue;
    }
    const layer = raw as unknown as LayerRecord;
    if (layer.runId !== m.runId) fail(`layer ${name} belongs to run ${String(layer.runId)}, not ${String(m.runId)}`);

    const s = instant(layer.startedAt);
    const e = instant(layer.finishedAt);
    if (s === null || e === null) fail(`layer ${name} has a malformed time`);
    else {
      if (s > e) fail(`layer ${name} finished before it started`);
      // Sequential by construction: acquire runs layers one after another, so
      // overlap means the record was assembled from different executions.
      if (prevEnd !== null && s < prevEnd) fail(`layer ${name} started before the previous step finished`);
      if (runEnd !== null && e > runEnd) fail(`layer ${name} finished after the run did`);
      prevEnd = e;
    }

    const outputs = isStringMap(layer.outputs) ? layer.outputs : {};
    if (!sameKeys(Object.keys(outputs), LAYER_OUTPUTS[name])) {
      fail(`layer ${name} outputs ${Object.keys(outputs).join(", ") || "(none)"} != ${LAYER_OUTPUTS[name].join(", ")}`);
    }
    for (const rel of LAYER_OUTPUTS[name]) {
      const sealed = outputs[rel];
      const now = ctx.hash(rel);
      if (!sealed || !SHA256.test(sealed)) fail(`${rel}: sealed hash malformed`);
      else if (now === null) fail(`${rel}: missing, sealed by run ${String(m.runId)}`);
      else if (now !== sealed) fail(`${rel}: hash mismatch — rewritten after run ${String(m.runId)} sealed it`);
    }
  }

  const git = layers.git as LayerRecord | undefined;
  if (isRecord(git)) {
    const heads = isStringMap(git.heads) ? git.heads : {};
    if (!sameKeys(Object.keys(heads), ctx.repoNames)) {
      fail(`git heads cover ${Object.keys(heads).join(", ") || "nothing"}, expected ${ctx.repoNames.join(", ")}`);
    }
    for (const [repo, sha] of Object.entries(heads)) {
      if (!GIT_SHA.test(sha)) fail(`git head for ${repo} is not a full sha: ${sha}`);
    }
  }

  const branches = layers.branches as LayerRecord | undefined;
  const github = layers.github as LayerRecord | undefined;
  if (isRecord(branches)) {
    const dep = branches.dependencies;
    if (!isRecord(dep) || typeof dep.items !== "string" || !isStringMap(dep.heads)) {
      fail("branches dependencies missing");
    } else {
      const items = isRecord(github) && isStringMap(github.outputs) ? github.outputs["raw/items.json"] : undefined;
      if (dep.items !== items) fail("branches walked an items.json other than the one sealed by the github layer");
      const heads = isRecord(git) && isStringMap(git.heads) ? git.heads : {};
      if (!sameMap(dep.heads, heads)) fail("branches walked mirror heads other than the ones sealed by the git layer");
    }
  }

  const council = layers.council as LayerRecord | undefined;
  if (isRecord(council) && (typeof council.sourceSha !== "string" || !GIT_SHA.test(council.sourceSha))) {
    fail(`council sourceSha is not a full sha: ${String(council.sourceSha)}`);
  }

  return errors;
}

export type Sealed = { manifest: Manifest; digest: string; mode: Mode };

/**
 * Read, hash and validate the seal under `root`, or throw naming every reason it
 * cannot be consumed. The digest is of the manifest bytes as written, so a
 * derived summary can prove which seal it was built from.
 */
export function loadSealed(root: string, repoNames: readonly string[], requested?: Mode, now = new Date()): Sealed {
  const file = join(root, MANIFEST);
  if (!existsSync(file)) {
    throw new Error(`${MANIFEST} missing — run \`bun run acquire${requested === "git-only" ? " --git-only" : ""}\` first`);
  }
  const bytes = readFileSync(file);
  let manifest: unknown;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${MANIFEST} is not JSON`);
  }
  const errors = validateManifest(manifest, { hash: (rel) => hashFile(root, rel), repoNames, now }, requested);
  if (errors.length) {
    throw new Error(`${MANIFEST} cannot be consumed:\n  ✗ ${errors.join("\n  ✗ ")}`);
  }
  const m = manifest as Manifest;
  return { manifest: m, digest: sha256(bytes), mode: m.mode };
}

/** Write via rename, so a crash leaves the previous seal or the new one, never half of either. */
export function writeManifest(root: string, manifest: Manifest): string {
  const body = JSON.stringify(manifest, null, 2) + "\n";
  const tmp = join(root, `${MANIFEST}.tmp`);
  writeFileSync(tmp, body);
  renameSync(tmp, join(root, MANIFEST));
  return sha256(body);
}

/** `--git-only` / `--full` / nothing. Anything else is an error, not a default. */
export function parseMode(argv: readonly string[]): Mode | undefined {
  let mode: Mode | undefined;
  for (const a of argv) {
    const m = a === "--git-only" ? "git-only" : a === "--full" ? "full" : null;
    if (!m) throw new Error(`unknown argument ${a} (expected --git-only or --full)`);
    if (mode && mode !== m) throw new Error("--git-only and --full are exclusive");
    mode = m;
  }
  return mode;
}

/** What derive publishes about the seal: public provenance only, no paths or hosts. */
export type AcquisitionSummary = {
  manifest: string;
  runId: string;
  mode: Mode;
  startedAt: string;
  finishedAt: string;
  heads: Record<string, string>;
  councilSha: string | null;
};

export const summarize = ({ manifest: m, digest }: Sealed): AcquisitionSummary => ({
  manifest: digest,
  runId: m.runId,
  mode: m.mode,
  startedAt: m.startedAt,
  finishedAt: m.finishedAt,
  heads: m.layers.git?.heads ?? {},
  councilSha: m.layers.council?.sourceSha ?? null,
});

/** Verify's side: the shipped summary must name the seal that is on disk now. */
export function checkDerived(published: unknown, sealed: Sealed): string[] {
  if (!isRecord(published)) return ["summary.json carries no acquisition record — re-run derive"];
  const want = summarize(sealed);
  const errors: string[] = [];
  if (published.manifest !== want.manifest) {
    errors.push(`summary.json was derived from manifest ${String(published.manifest)}, but the seal on disk is ${want.manifest} — re-run derive`);
  }
  for (const k of ["runId", "mode", "startedAt", "finishedAt", "councilSha"] as const) {
    if (published[k] !== want[k]) errors.push(`summary acquisition.${k} ${String(published[k])} != sealed ${String(want[k])}`);
  }
  if (!isStringMap(published.heads) || !sameMap(published.heads, want.heads)) {
    errors.push("summary acquisition.heads differ from the sealed git heads");
  }
  return errors;
}

/**
 * Remove generated files whose source was not consumed this run. Left behind,
 * a git-only derive would ship last week's per-item pages and heartbeat beside
 * this week's spine. Returns what it removed.
 */
export function pruneGenerated(outDir: string, consumed: { github: boolean; branches: boolean }): string[] {
  const stale = [
    ...(consumed.github && consumed.branches ? [] : ["items.json"]),
    ...(consumed.github ? [] : ["heartbeat.json"]),
  ];
  return stale.filter((f) => {
    const file = join(outDir, f);
    if (!existsSync(file)) return false;
    rmSync(file);
    return true;
  });
}
