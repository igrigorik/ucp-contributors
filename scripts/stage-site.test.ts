import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REQUIRED_DATA, stageSite } from "./stage-site.ts";

let dir: string;
let src: string;
let dest: string;

const put = (rel: string, body = "x") => writeFileSync(join(src, rel), body);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stage-site-"));
  src = join(dir, "site");
  dest = join(dir, "_site");
  mkdirSync(join(src, "data"), { recursive: true });
  for (const f of ["index.html", "app.js", "lib.js", "style.css", "icon.svg"]) put(f);
  for (const f of REQUIRED_DATA) put(`data/${f}`, "{}");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const staged = () => [
  ...readdirSync(dest).filter((f) => f !== "data"),
  ...readdirSync(join(dest, "data")).map((f) => `data/${f}`),
].sort();

test("stages public assets and generated data, and never a test file", () => {
  put("lib.test.ts");
  put(".DS_Store");
  put("data/items.json", "[]");
  const { skipped } = stageSite(src, dest);
  expect(staged()).toEqual([
    "app.js", "icon.svg", "index.html", "lib.js", "style.css",
    ...[...REQUIRED_DATA, "items.json"].map((f) => `data/${f}`),
  ].sort());
  expect(skipped).toEqual([".DS_Store", "lib.test.ts"]);
});

test("refuses an unrecognized top-level file rather than publishing it", () => {
  put("notes.ts");
  expect(() => stageSite(src, dest)).toThrow(/unrecognized file notes\.ts/);
  expect(existsSync(dest)).toBe(false);
});

test("refuses hidden files and unknown subdirectories", () => {
  put(".env");
  expect(() => stageSite(src, dest)).toThrow(/\.env/);
  rmSync(join(src, ".env"));
  mkdirSync(join(src, "drafts"));
  expect(() => stageSite(src, dest)).toThrow(/drafts/);
});

test("refuses an unrecognized generated file", () => {
  put("data/raw-dump.json");
  expect(() => stageSite(src, dest)).toThrow(/data\/raw-dump\.json/);
});

test("refuses symlinks, which could point outside site/", () => {
  symlinkSync("/etc/hosts", join(src, "hosts.html"));
  expect(() => stageSite(src, dest)).toThrow(/not a regular file/);
});

test("fails when derive has not run", () => {
  rmSync(join(src, "data", "summary.json"));
  expect(() => stageSite(src, dest)).toThrow(/missing data\/summary\.json/);
});

test("replaces a previous stage instead of merging into it", () => {
  mkdirSync(dest);
  writeFileSync(join(dest, "stale.js"), "x");
  stageSite(src, dest);
  expect(existsSync(join(dest, "stale.js"))).toBe(false);
});

test("refuses a destination inside the source", () => {
  expect(() => stageSite(src, join(src, "out"))).toThrow(/overlap/);
});
