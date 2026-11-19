// Post-merge check (epic #33): nothing a tool returns carries a personal folder. The server runs
// here with a fake home folder whose name looks like an account and no index; every answer and
// error must show the home folder as "~" (src/paths.ts hideLocalPaths). The CLI may print full
// paths; tools may not. No network: NY_DATA_OFFLINE=1 (helpers.mjs) and no index download.
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ACCOUNT = "jdoe-acct-4821";
const HOME = join(mkdtempSync(join(tmpdir(), "nydr-home-")), "Users", ACCOUNT);
mkdirSync(HOME, { recursive: true });
// Before anything reads the home folder: HOME on macOS and Linux, USERPROFILE on Windows.
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
for (const k of ["NY_DATA_INDEX", "NY_DATA_CACHE_DIR", "NY_DATA_EXPORT_DIR"]) delete process.env[k];
process.env.NY_DATA_INDEX_AUTO_DOWNLOAD = "0"; // this file only: no first-run download
process.env.NY_DATA_EXPORT_DIR = join(HOME, ".cache", "betanyc", "ny-data-registry", "exports");

const { test } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
await import("./helpers.mjs");
const { hideLocalPaths } = await import("../dist/paths.js");
const { callTool, TOOLS } = await import("../dist/tools.js");
const { homedir } = await import("node:os");

const spellings = [HOME, realpathSync(HOME), HOME.replace(/\\/g, "/"), ACCOUNT];
const clean = (label, value) => {
  const s = JSON.stringify(value);
  for (const p of spellings) assert.ok(!s.includes(p), `${label} carries ${p}: ${s.slice(0, 300)}`);
};

test("the fake home folder is the one the server sees", () => {
  assert.equal(homedir(), HOME);
});

test("with no index, the five index tools say so without the home folder, and show it as ~", async () => {
  const calls = [
    ["search_datasets", { query: "parcels" }],
    ["list_topics", {}],
    ["get_dataset_columns", { dataset: "abcd-1234" }],
    ["find_joinable", { dataset: "abcd-1234" }],
    ["whats_new", { since: "2026-01-01" }],
  ];
  for (const [name, args] of calls) {
    const r = await callTool(name, args);
    assert.equal(r.isError, true, name);
    assert.match(r.content[0].text, /not installed yet \(looked for ~[\\/]\.cache[\\/]betanyc[\\/]ny-data-registry[\\/]ny-data-index\.sqlite\)/, name);
    clean(name, r);
  }
});

test("registry_info shows index.path and index_download.path with the home folder as ~", async () => {
  const r = await callTool("registry_info", {});
  assert.notEqual(r.isError, true, r.content[0].text);
  clean("registry_info", r);
  const b = JSON.parse(r.content[0].text);
  assert.match(b.index.path, /^~[\\/]\.cache[\\/]betanyc[\\/]/);
  assert.match(b.index_download.path, /^~[\\/]\.cache[\\/]betanyc[\\/]/);
});

test("every tool, called once, returns no personal folder", async () => {
  const args = {
    find_sources: { query: "health" }, list_sources_for_place: { place: "Erie County" }, how_to_query: { entity: "Nassau County" },
    check_source: { source_id: "nys-department-of-health" }, registry_info: {}, search_datasets: { query: "x" }, list_topics: {},
    get_dataset_columns: { dataset: "x" }, find_joinable: { dataset: "x" }, whats_new: { since: "2026-01-01" },
    whats_changed: {}, about_betanyc: {}, about_data: {},
  };
  for (const t of TOOLS) {
    assert.ok(t.name in args, `no call for ${t.name}`);
    clean(t.name, await callTool(t.name, args[t.name]));
  }
});

test("hideLocalPaths: home as ~, temp as <temp>, whole folders only, any slash; Windows ignores case", () => {
  const o = { home: "/Users/jdoe", temp: "/var/folders/ab/T" };
  assert.equal(hideLocalPaths("/Users/jdoe/.cache/x and '/Users/jdoe'", o), "~/.cache/x and '~'");
  assert.equal(hideLocalPaths("/Users/jdoe2/x", o), "/Users/jdoe2/x", "another folder that starts the same");
  assert.equal(hideLocalPaths("/var/folders/ab/T/x and /private/var/folders/ab/T/y", o), "<temp>/x and <temp>/y");
  const w = { home: "C:\\Users\\JDoe", temp: "C:\\Users\\JDoe\\AppData\\Local\\Temp", platform: "win32" };
  assert.equal(hideLocalPaths("c:\\users\\jdoe\\AppData\\Local\\Temp\\a; C:/Users/JDoe/.cache/b", w), "<temp>\\a; ~/.cache/b");
  assert.equal(hideLocalPaths("no paths here", o), "no paths here");
});
