// Keeping an installed index current (issue #15). A local HTTP server on 127.0.0.1 plays the
// GitHub release, with files made by the real publish code (preparePublish: the .gz,
// SHA256SUMS and index.json). Nothing leaves the machine: NY_DATA_OFFLINE=1 stays on and
// loopback is the one exception.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tempIndexPath, buildFixtureIndex } from "./helpers.mjs";

const DAY = 24 * 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const NOW = Date.now();
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const SERVER = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const { preparePublish } = await import("../dist/publish/prepare.js");

/** A published release: the real publish code's files for a fixture harvested at `lastHarvest`. */
async function makeRelease(lastHarvest) {
  const src = tempIndexPath();
  await buildFixtureIndex(src, { lastHarvest });
  const dir = mkdtempSync(join(tmpdir(), "nydr-rel-"));
  const manifest = await preparePublish({ index: src, dir });
  const f = (n) => readFileSync(join(dir, n));
  return { manifest, sqlite: f("ny-data-index.sqlite"), gz: f("ny-data-index.sqlite.gz"), sums: f("SHA256SUMS"), json: f("index.json"), file: join(dir, "ny-data-index.sqlite") };
}

const OLD = await makeRelease(iso(NOW - 10 * DAY)); // installed copy, 10 days old
const NEW = await makeRelease(iso(NOW - 1 * DAY)); // published copy, 1 day old

// What the fake release serves. Each test sets it in beforeEach / its body.
let rel;
let hits;
const server = createServer((req, res) => {
  const name = req.url.split("/").pop();
  hits[name] = (hits[name] ?? 0) + 1;
  hits.all++;
  if (name === "index.json" && rel.json) return res.end(rel.json);
  if (name === "SHA256SUMS") return res.end(rel.sums);
  if (name === "ny-data-index.sqlite.gz") {
    if (rel.interrupt) {
      // Send half the file, then drop the connection.
      res.writeHead(200, { "Content-Length": rel.gz.length });
      res.write(rel.gz.subarray(0, Math.floor(rel.gz.length / 2)));
      return setTimeout(() => res.destroy(), 20);
    }
    return res.end(rel.gz);
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const URL_ = `http://127.0.0.1:${server.address().port}/releases/download/index-latest/ny-data-index.sqlite.gz`;
after(() => server.close());

const { checkForUpdate, fetchManifest, installedSum, UPDATE_EXIT_CODES } = await import("../dist/refresh.js");
const { installPendingIndex, downloadIndex } = await import("../dist/fetchindex.js");
const { updateConfig, ageDays, staleNote, pinnedSnapshot } = await import("../dist/indexage.js");

const ENV_KEYS = ["NY_DATA_INDEX", "NY_DATA_INDEX_AUTO_UPDATE", "NY_DATA_INDEX_URL", "NY_DATA_INDEX_AUTO_DOWNLOAD", "NY_DATA_INDEX_REFRESH_DAYS", "NY_DATA_INDEX_STALE_DAYS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  rel = { json: NEW.json, sums: NEW.sums, gz: NEW.gz, interrupt: false };
  hits = { all: 0 };
  for (const k of ENV_KEYS) delete process.env[k];
});
after(() => {
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
});

/** A folder with the OLD index installed as if by hand (no record beside it). */
function installedOld() {
  const p = join(mkdtempSync(join(tmpdir(), "nydr-up-")), "ny-data-index.sqlite");
  copyFileSync(OLD.file, p);
  return p;
}
const leftovers = (p) => readdirSync(dirname(p)).filter((f) => /\.(part|lock|next)/.test(f));

// ---- settings --------------------------------------------------------------------------

test("auto-update is on by default, with a 5-day refresh and a 14-day warning", () => {
  const c = updateConfig(URL_);
  assert.equal(c.auto, true);
  assert.equal(c.refresh_days, 5);
  assert.equal(c.stale_days, 14);
  assert.equal(c.check_hours, 24);
});

test("the opt-out switch turns automatic updates off", () => {
  process.env.NY_DATA_INDEX_AUTO_UPDATE = "0";
  const c = updateConfig(URL_);
  assert.equal(c.auto, false);
  assert.equal(c.off_reason, "NY_DATA_INDEX_AUTO_UPDATE=0");
});

test("pointing at your own index file turns automatic updates off", () => {
  process.env.NY_DATA_INDEX = "/somewhere/my-index.sqlite";
  const c = updateConfig(URL_);
  assert.equal(c.auto, false);
  assert.match(c.off_reason, /NY_DATA_INDEX is set/);
});

test("a URL that names a dated snapshot pins the index; a mirror of index-latest does not", () => {
  const pin = "https://github.com/BetaNYC/ny-data-registry-mcp/releases/download/index-2026-11-05/ny-data-index.sqlite.gz";
  assert.equal(pinnedSnapshot(pin), "index-2026-11-05");
  assert.equal(updateConfig(pin).auto, false);
  assert.match(updateConfig(pin).off_reason, /pins the snapshot index-2026-11-05/);
  assert.equal(pinnedSnapshot(URL_), null);
});

test("a bad setting falls back to its default and is reported", () => {
  process.env.NY_DATA_INDEX_REFRESH_DAYS = "soon";
  const c = updateConfig(URL_);
  assert.equal(c.refresh_days, 5);
  assert.match(c.warnings[0], /NY_DATA_INDEX_REFRESH_DAYS=soon/);
});

// ---- the age check ---------------------------------------------------------------------

test("age check: an automatic check under 5 days asks the network nothing; past 5 days it updates", async () => {
  const p = installedOld();
  const t0 = Date.parse(OLD.manifest.last_harvest);
  const young = await checkForUpdate({ path: p, url: URL_, now: t0 + 4.9 * DAY });
  assert.equal(young.outcome, "not-due");
  assert.equal(hits.all, 0);
  assert.deepEqual(readFileSync(p), OLD.sqlite);

  const due = await checkForUpdate({ path: p, url: URL_, now: t0 + 5.1 * DAY });
  assert.equal(due.outcome, "updated", due.message);
  assert.deepEqual(readFileSync(p), NEW.sqlite);
  assert.equal(due.installed_last_harvest, NEW.manifest.last_harvest);
  const rec = JSON.parse(readFileSync(`${p}.source.json`, "utf8"));
  assert.equal(rec.sqlite_sha256, NEW.manifest.sqlite_sha256);
  assert.equal(rec.url, URL_);
  assert.deepEqual(leftovers(p), []);
});

test("NY_DATA_INDEX_REFRESH_DAYS changes the threshold", async () => {
  process.env.NY_DATA_INDEX_REFRESH_DAYS = "20";
  const p = installedOld();
  const r = await checkForUpdate({ path: p, url: URL_ });
  assert.equal(r.outcome, "not-due");
  assert.equal(hits.all, 0);
});

test("ageDays reads ISO times and rejects junk", () => {
  assert.equal(ageDays("2026-11-01T00:00:00Z", Date.parse("2026-11-06T00:00:00Z")), 5);
  assert.equal(ageDays("not a date"), null);
  assert.equal(ageDays(null), null);
});

// ---- deciding --------------------------------------------------------------------------

test("the same file is current: the index itself is never requested", async () => {
  const p = installedOld();
  rel = { json: OLD.json, sums: OLD.sums, gz: OLD.gz };
  const r = await checkForUpdate({ path: p, url: URL_ });
  assert.equal(r.outcome, "current");
  assert.equal(hits["ny-data-index.sqlite.gz"], undefined);
  // The first check hashed the file and recorded it.
  assert.equal(JSON.parse(readFileSync(`${p}.source.json`, "utf8")).sqlite_sha256, OLD.manifest.sqlite_sha256);
  assert.equal(await installedSum(p), OLD.manifest.sqlite_sha256);
});

test("a schema the package cannot read is not downloaded", async () => {
  const p = installedOld();
  rel.json = Buffer.from(JSON.stringify({ ...NEW.manifest, schema_version: 99 }));
  const r = await checkForUpdate({ path: p, url: URL_ });
  assert.equal(r.outcome, "package-too-old");
  assert.match(r.message, /update the package/);
  assert.equal(hits["ny-data-index.sqlite.gz"], undefined);
  assert.deepEqual(readFileSync(p), OLD.sqlite);
});

test("an installed index as new as or newer than the published one is left alone (a self-built index)", async () => {
  const p = join(mkdtempSync(join(tmpdir(), "nydr-up-")), "ny-data-index.sqlite");
  copyFileSync(NEW.file, p);
  rel = { json: OLD.json, sums: OLD.sums, gz: OLD.gz };
  const r = await checkForUpdate({ path: p, url: URL_, manual: true });
  assert.equal(r.outcome, "kept-local");
  assert.equal(hits["ny-data-index.sqlite.gz"], undefined);
  assert.deepEqual(readFileSync(p), NEW.sqlite);
});

test("a release without index.json falls back to SHA256SUMS; an automatic check leaves a file it did not install alone", async () => {
  const p = installedOld();
  rel.json = null; // 404
  assert.equal(await fetchManifest(URL_), null);
  const auto = await checkForUpdate({ path: p, url: URL_ });
  assert.equal(auto.outcome, "kept-local");
  assert.deepEqual(readFileSync(p), OLD.sqlite);
  const manual = await checkForUpdate({ path: p, url: URL_, manual: true });
  assert.equal(manual.outcome, "updated", manual.message);
  assert.deepEqual(readFileSync(p), NEW.sqlite);
});

// ---- failures keep the old copy -------------------------------------------------------

test("checksum mismatch against index.json: the old copy is kept, byte for byte", async () => {
  const p = installedOld();
  rel.json = Buffer.from(JSON.stringify({ ...NEW.manifest, sqlite_sha256: "0".repeat(64) }));
  const r = await checkForUpdate({ path: p, url: URL_ });
  assert.equal(r.outcome, "failed");
  assert.match(r.error, /checksum mismatch for ny-data-index\.sqlite \(against index\.json\)/);
  assert.deepEqual(readFileSync(p), OLD.sqlite);
  assert.deepEqual(leftovers(p), []);
});

test("a .gz that does not match index.json's gz sum is refused too", async () => {
  const p = installedOld();
  rel.gz = OLD.gz; // the old file under the new manifest, as during a publish in progress
  const r = await checkForUpdate({ path: p, url: URL_, manual: true });
  assert.equal(r.outcome, "failed");
  assert.match(r.error, /checksum mismatch for ny-data-index\.sqlite\.gz/);
  assert.deepEqual(readFileSync(p), OLD.sqlite);
});

test("an interrupted download: the old copy is kept, nothing partial is left, and the next check works", async () => {
  const p = installedOld();
  rel.interrupt = true;
  const r = await checkForUpdate({ path: p, url: URL_ });
  assert.equal(r.outcome, "failed");
  assert.deepEqual(readFileSync(p), OLD.sqlite);
  assert.deepEqual(leftovers(p), []);
  rel.interrupt = false;
  const again = await checkForUpdate({ path: p, url: URL_ });
  assert.equal(again.outcome, "updated", again.message);
  assert.deepEqual(readFileSync(p), NEW.sqlite);
});

test("the manifest cannot be reached: the old copy is kept and the error recorded", async () => {
  const p = installedOld();
  const r = await checkForUpdate({ path: p, url: "http://127.0.0.1:9/releases/download/index-latest/ny-data-index.sqlite.gz" });
  assert.equal(r.outcome, "failed");
  assert.ok(r.error);
  assert.deepEqual(readFileSync(p), OLD.sqlite);
});

test("a manifest without both sums is refused", async () => {
  const p = installedOld();
  const { gz_sha256, ...rest } = NEW.manifest;
  rel.json = Buffer.from(JSON.stringify(rest));
  const r = await checkForUpdate({ path: p, url: URL_, manual: true });
  assert.equal(r.outcome, "failed");
  assert.match(r.error, /both SHA-256 sums/);
  assert.equal(hits["ny-data-index.sqlite.gz"], undefined);
});

// ---- the Windows rename fallback -------------------------------------------------------

for (const code of ["EBUSY", "EPERM", "EACCES"]) {
  test(`Windows rename fallback (${code}): the verified file waits as .next and installs when the index is free`, async () => {
    const p = installedOld();
    const blocked = (from, to) => {
      if (to === p) throw Object.assign(new Error(`${code}: resource busy or locked, rename`), { code });
      renameSync(from, to);
    };
    const r = await checkForUpdate({ path: p, url: URL_, rename: blocked });
    assert.equal(r.outcome, "ready-on-restart", r.message);
    assert.deepEqual(readFileSync(p), OLD.sqlite, "the old copy stays in place");
    assert.deepEqual(readFileSync(`${p}.next`), NEW.sqlite);
    assert.ok(existsSync(`${p}.next.source.json`));
    // Still in use: nothing moves.
    assert.equal(installPendingIndex(p, blocked), false);
    assert.deepEqual(readFileSync(p), OLD.sqlite);
    // Free: the next open installs it.
    assert.equal(installPendingIndex(p), true);
    assert.deepEqual(readFileSync(p), NEW.sqlite);
    assert.equal(JSON.parse(readFileSync(`${p}.source.json`, "utf8")).sqlite_sha256, NEW.manifest.sqlite_sha256);
    assert.deepEqual(leftovers(p), []);
  });
}

test("a rename error that is not 'in use' fails without leaving a .next", async () => {
  const p = installedOld();
  const broken = (from, to) => {
    if (to === p) throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    renameSync(from, to);
  };
  const r = await checkForUpdate({ path: p, url: URL_, rename: broken });
  assert.equal(r.outcome, "failed");
  assert.deepEqual(readFileSync(p), OLD.sqlite);
  assert.deepEqual(leftovers(p), []);
});

test("a .next without its record is treated as incomplete and removed", () => {
  const p = installedOld();
  writeFileSync(`${p}.next`, "half a file");
  assert.equal(installPendingIndex(p), false);
  assert.equal(existsSync(`${p}.next`), false);
  assert.deepEqual(readFileSync(p), OLD.sqlite);
});

test("this platform: updating an index another handle holds open (Windows takes the .next path)", async (t) => {
  const p = installedOld();
  const holder = new DatabaseSync(p, { readOnly: true });
  holder.prepare("SELECT count(*) FROM datasets").get();
  let r;
  try {
    r = await checkForUpdate({ path: p, url: URL_ });
  } finally {
    holder.close();
  }
  t.diagnostic(`${process.platform}: ${r.outcome}: ${r.message}`);
  assert.ok(["updated", "ready-on-restart"].includes(r.outcome), r.message);
  if (r.outcome === "ready-on-restart") {
    assert.deepEqual(readFileSync(p), OLD.sqlite);
    assert.equal(installPendingIndex(p), true);
  }
  assert.deepEqual(readFileSync(p), NEW.sqlite);
  assert.deepEqual(leftovers(p), []);
});

// ---- SQLite side files, and two checks at once ----------------------------------------

test("a 0-byte -wal and its -shm left by an older WAL-mode index are removed; a non-empty -wal is kept and reported", async () => {
  const p = installedOld();
  writeFileSync(`${p}-wal`, "");
  writeFileSync(`${p}-shm`, "x");
  assert.equal((await checkForUpdate({ path: p, url: URL_ })).outcome, "updated");
  assert.equal(existsSync(`${p}-wal`), false);
  assert.equal(existsSync(`${p}-shm`), false);
  const d = new DatabaseSync(p, { readOnly: true });
  assert.ok(d.prepare("SELECT count(*) AS n FROM datasets").get().n > 0);
  d.close();

  const q = installedOld();
  writeFileSync(`${q}-wal`, "unexpected writes");
  const r = await checkForUpdate({ path: q, url: URL_ });
  assert.equal(r.outcome, "updated");
  assert.match(r.message, /kept .*-wal/);
  assert.equal(readFileSync(`${q}-wal`, "utf8"), "unexpected writes");
});

test("two checks at once download the index once", async () => {
  const p = installedOld();
  const [a, b] = await Promise.all([checkForUpdate({ path: p, url: URL_, manual: true }), checkForUpdate({ path: p, url: URL_, manual: true })]);
  assert.equal(hits["ny-data-index.sqlite.gz"], 1);
  assert.deepEqual([a.outcome, b.outcome].sort(), ["busy", "updated"]);
  assert.deepEqual(readFileSync(p), NEW.sqlite);
});

// ---- the switches stop automatic checks before any request ------------------------------

test("opt-out switch: an automatic check makes no request; the manual update still works", async () => {
  process.env.NY_DATA_INDEX_AUTO_UPDATE = "0";
  const p = installedOld();
  const r = await checkForUpdate({ path: p, url: URL_ });
  assert.equal(r.outcome, "off");
  assert.equal(hits.all, 0);
  const m = await checkForUpdate({ path: p, url: URL_, manual: true });
  assert.equal(m.outcome, "updated");
});

test("custom index path: an automatic check makes no request", async () => {
  const p = installedOld();
  process.env.NY_DATA_INDEX = p;
  const r = await checkForUpdate({ path: p, url: URL_ });
  assert.equal(r.outcome, "off");
  assert.match(r.message, /NY_DATA_INDEX is set/);
  assert.equal(hits.all, 0);
  assert.deepEqual(readFileSync(p), OLD.sqlite);
});

test("offline mode refuses a real URL even for the manual update", async () => {
  const p = installedOld();
  const r = await checkForUpdate({ path: p, url: "https://github.com/BetaNYC/ny-data-registry-mcp/releases/download/index-latest/ny-data-index.sqlite.gz", manual: true });
  assert.equal(r.outcome, "failed");
  assert.match(r.error, /offline/);
});

// ---- the 14-day warning: dataset searches only ------------------------------------------

test("the 14-day warning appears in dataset-search replies only, and only past 14 days", async () => {
  const stale = tempIndexPath();
  await buildFixtureIndex(stale, { lastHarvest: iso(NOW - 15 * DAY) });
  const fresh = tempIndexPath();
  await buildFixtureIndex(fresh, { lastHarvest: iso(NOW - 13 * DAY) });
  const { callTool } = await import("../dist/tools.js");
  const { closeDb } = await import("../dist/datasets.js");
  const call = async (name, args) => {
    const r = await callTool(name, args);
    assert.notEqual(r.isError, true, r.content[0].text);
    return JSON.parse(r.content[0].text);
  };
  try {
    process.env.NY_DATA_INDEX = stale;
    const s = await call("search_datasets", { query: "zoning" });
    assert.match(s.index_note, /harvested 15 days ago/);
    assert.match(s.index_note, /ny-data-registry update/);
    assert.match(s.index_note, /Automatic updates are off \(NY_DATA_INDEX is set/);
    assert.match((await call("search_datasets", { query: "zoning", group_by: "portal" })).index_note, /15 days/);
    assert.equal(staleNote(iso(NOW - 15 * DAY)) !== null, true);
    for (const [name, args] of [
      ["get_dataset_columns", { dataset: "dea35a11cfbf4adeb083df6d63cf1f88" }],
      ["find_joinable", { dataset: "test-0001" }],
      ["whats_new", { since: "2020-01-01" }],
    ]) {
      assert.equal(JSON.stringify(await call(name, args)).includes("index_note"), false, `${name} has no age note`);
    }
    const info = await call("registry_info", {});
    assert.equal(info.index_status.stale, true);
    assert.equal(info.index_status.stale_after_days, 14);
    assert.equal(info.index_status.auto_update.on, false);

    process.env.NY_DATA_INDEX = fresh;
    assert.equal((await call("search_datasets", { query: "zoning" })).index_note, undefined);
    assert.equal((await call("registry_info", {})).index_status.stale, false);
  } finally {
    closeDb();
  }
});

// ---- an open handle notices a replaced file --------------------------------------------

test("an open handle reopens when the file is replaced (macOS and Linux)", { skip: process.platform === "win32" && "Windows does not allow renaming over an open file" }, async () => {
  const p = installedOld();
  process.env.NY_DATA_INDEX = p;
  const { db, closeDb, setIdentityCheckMs, searchDatasets } = await import("../dist/datasets.js");
  try {
    assert.equal(searchDatasets({ query: "zoning" }).index_last_harvest, OLD.manifest.last_harvest);
    const tmp = `${p}.incoming`;
    copyFileSync(NEW.file, tmp);
    renameSync(tmp, p);
    // Within the throttle the open handle keeps answering from the old file.
    assert.equal(searchDatasets({ query: "zoning" }).index_last_harvest, OLD.manifest.last_harvest);
    setIdentityCheckMs(0);
    assert.equal(searchDatasets({ query: "zoning" }).index_last_harvest, NEW.manifest.last_harvest);
    db();
  } finally {
    setIdentityCheckMs(60_000);
    closeDb();
  }
});

// ---- the update command ----------------------------------------------------------------

function cli(args, env = {}) {
  const e = { ...process.env, NY_DATA_INDEX_URL: URL_, NY_DATA_OFFLINE: "1", NY_DATA_REGISTRY_REFRESH: "0", ...env };
  for (const k of ["NY_DATA_INDEX", "NY_DATA_INDEX_AUTO_UPDATE"]) if (!(k in env)) delete e[k];
  // Async: the fake release runs in this process, so a blocking spawn would starve it.
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [CLI, "update", ...args], { env: e });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("error", reject);
    c.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("update command exit codes: 0 installed, current, updated; 4 newer available; 3 package too old; 1 failed; 2 usage", async () => {
  const cache = mkdtempSync(join(tmpdir(), "nydr-cli-"));
  const env = { NY_DATA_CACHE_DIR: cache };
  const p = join(cache, "ny-data-index.sqlite");

  rel = { json: OLD.json, sums: OLD.sums, gz: OLD.gz };
  let r = await cli([], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /installed .*checksums verified/);
  assert.deepEqual(readFileSync(p), OLD.sqlite);

  r = await cli([], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /already current/);

  rel = { json: NEW.json, sums: NEW.sums, gz: NEW.gz };
  hits = { all: 0 };
  r = await cli(["--check"], env);
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stdout, /a newer index is published/);
  assert.equal(hits["ny-data-index.sqlite.gz"], undefined, "--check downloads nothing");
  assert.deepEqual(readFileSync(p), OLD.sqlite);

  rel.json = Buffer.from(JSON.stringify({ ...NEW.manifest, schema_version: 99 }));
  r = await cli([], env);
  assert.equal(r.status, 3, r.stdout);

  rel.json = Buffer.from(JSON.stringify({ ...NEW.manifest, sqlite_sha256: "0".repeat(64) }));
  r = await cli([], env);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /checksum mismatch/);
  assert.deepEqual(readFileSync(p), OLD.sqlite);

  r = await cli(["--now-please"], env);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: ny-data-registry update \[--check\]/);

  // The age threshold and the opt-out apply to automatic checks, not to the command.
  rel.json = NEW.json;
  r = await cli([], { ...env, NY_DATA_INDEX_AUTO_UPDATE: "0", NY_DATA_INDEX_REFRESH_DAYS: "100" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /updated to the index harvested/);
  assert.deepEqual(readFileSync(p), NEW.sqlite);
});

test("update command exit code 5: verified but the index is in use", () => {
  assert.equal(UPDATE_EXIT_CODES["ready-on-restart"], 5);
  assert.equal(UPDATE_EXIT_CODES.busy, 1);
  assert.equal(UPDATE_EXIT_CODES["kept-local"], 0);
});

test("update command exit code 5 for real when another process holds the index (Windows only)", { skip: process.platform !== "win32" && "renaming over an open file succeeds on macOS and Linux" }, async () => {
  const cache = mkdtempSync(join(tmpdir(), "nydr-cli-"));
  const p = join(cache, "ny-data-index.sqlite");
  copyFileSync(OLD.file, p);
  const holder = new DatabaseSync(p, { readOnly: true });
  holder.prepare("SELECT count(*) FROM datasets").get();
  try {
    const r = await cli([], { NY_DATA_CACHE_DIR: cache });
    assert.equal(r.status, 5, r.stdout + r.stderr);
    assert.ok(existsSync(`${p}.next`));
  } finally {
    holder.close();
  }
  assert.equal(installPendingIndex(p), true);
  assert.deepEqual(readFileSync(p), NEW.sqlite);
});

// ---- the server -------------------------------------------------------------------------

test("the stdio server updates a 10-day-old index in the background and its next search answers from the new one", async () => {
  const cache = mkdtempSync(join(tmpdir(), "nydr-srv-"));
  const p = join(cache, "ny-data-index.sqlite");
  copyFileSync(OLD.file, p);
  const env = { ...process.env, NY_DATA_CACHE_DIR: cache, NY_DATA_INDEX_URL: URL_, NY_DATA_OFFLINE: "1", NY_DATA_REGISTRY_REFRESH: "0", NY_DATA_INDEX_CHECK_DELAY_SECONDS: "0" };
  delete env.NY_DATA_INDEX;
  delete env.NY_DATA_INDEX_AUTO_UPDATE;
  const client = new Client({ name: "refresh", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env }));
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  try {
    let status;
    for (let i = 0; i < 100; i++) {
      status = (await call("registry_info", {})).index_status;
      if (status.update === "updated" || status.update.startsWith("failed")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(status.update, "updated", JSON.stringify(status));
    assert.equal(status.auto_update.on, true);
    assert.equal(status.auto_update.refresh_after_days, 5);
    assert.equal(status.published_last_harvest, NEW.manifest.last_harvest);
    const s = await call("search_datasets", { query: "zoning" });
    assert.equal(s.index_last_harvest, NEW.manifest.last_harvest);
    assert.equal(s.index_note, undefined);
  } finally {
    await client.close();
  }
  assert.deepEqual(readFileSync(p), NEW.sqlite);
});

test("the stdio server with its own index path never checks", async () => {
  const p = installedOld();
  const env = { ...process.env, NY_DATA_INDEX: p, NY_DATA_INDEX_URL: URL_, NY_DATA_OFFLINE: "1", NY_DATA_REGISTRY_REFRESH: "0", NY_DATA_INDEX_CHECK_DELAY_SECONDS: "0" };
  const client = new Client({ name: "refresh-off", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env }));
  try {
    await new Promise((r) => setTimeout(r, 500));
    const info = JSON.parse((await client.callTool({ name: "registry_info", arguments: {} })).content[0].text);
    assert.match(info.index_status.update, /^off: NY_DATA_INDEX is set/);
    assert.equal(hits.all, 0);
  } finally {
    await client.close();
  }
  assert.deepEqual(readFileSync(p), OLD.sqlite);
});

test("the update timers do not keep a process alive", () => {
  const code = `import(${JSON.stringify(new URL("../dist/refresh.js", import.meta.url).href)}).then((m) => { m.startAutoUpdate(); console.log("started"); });`;
  const env = { ...process.env, NY_DATA_CACHE_DIR: mkdtempSync(join(tmpdir(), "nydr-t-")), NY_DATA_INDEX_URL: URL_ };
  delete env.NY_DATA_INDEX;
  delete env.NY_DATA_INDEX_AUTO_UPDATE;
  const t = Date.now();
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /started/);
  assert.ok(Date.now() - t < 15_000, "exited without waiting for the 5-minute check");
});

test("downloadIndex with expected sums verifies against them, not SHA256SUMS", async () => {
  const p = join(mkdtempSync(join(tmpdir(), "nydr-up-")), "ny-data-index.sqlite");
  rel.sums = Buffer.from("garbage\n");
  const r = await downloadIndex({ path: p, url: URL_, expect: { gz_sha256: NEW.manifest.gz_sha256, sqlite_sha256: NEW.manifest.sqlite_sha256, sqlite_bytes: NEW.manifest.sqlite_bytes } });
  assert.equal(r.sqlite_sha256, NEW.manifest.sqlite_sha256);
  assert.equal(hits.SHA256SUMS, undefined);
  assert.deepEqual(readFileSync(p), NEW.sqlite);
});
