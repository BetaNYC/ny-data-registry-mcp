// Weekly cadence for self-hosted county ArcGIS servers (epic #7, decision D5). Offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempIndexPath } from "./helpers.mjs";

const { cadenceDays, cadenceDue, runHarvest } = await import("../dist/harvest/run.js");
const { readDataJson } = await import("../dist/paths.js");
const cfg = readDataJson("harvest-config.json").cadence;

test("county ArcGIS Enterprise servers are read weekly; Socrata, Hub and ArcGIS Online nightly", () => {
  assert.equal(cadenceDays("monroe-county", "enterprise", cfg), 7);
  for (const k of ["socrata", "hub", "agol-org"]) assert.equal(cadenceDays("x", k, cfg), 1);
  assert.equal(cadenceDays("x", "some-new-adapter", cfg), 1, "unknown adapters default to nightly");
  assert.equal(cadenceDays("monroe-county", "enterprise", { ...cfg, days_by_source: { "monroe-county": 3 } }), 3, "per-portal override");
  assert.equal(cadenceDays("x", "enterprise", { days_by_adapter: { enterprise: 0 } }), 1, "nonsense values fall back to nightly");
});

test("due: never read, or a week since the last read (6 hours early is fine)", () => {
  const now = new Date("2026-11-21T07:20:00Z");
  assert.deepEqual(cadenceDue(null, 7, now), { due: true });
  assert.deepEqual(cadenceDue("2026-11-20T07:40:00Z", 1, now), { due: true });
  assert.deepEqual(cadenceDue("2026-11-14T07:40:00Z", 7, now), { due: true }, "a late start last week does not slip a whole cycle");
  assert.deepEqual(cadenceDue("2026-11-18T07:40:00Z", 7, now), { due: false, next_due: "2026-11-25T01:40:00.000Z" });
  assert.deepEqual(cadenceDue("not a date", 7, now), { due: true });
});

test("a weekly portal read 2 days ago is not called, and the stats say why", async () => {
  process.env.NY_DATA_INDEX = tempIndexPath();
  const { openDb } = await import("../dist/db.js");
  const db = openDb();
  db.prepare("INSERT INTO portals(id, name, last_harvested, harvest_status) VALUES ('monroe-county', 'Monroe', ?, 'ok')").run(new Date(Date.now() - 2 * 86400000).toISOString());
  db.close();
  // NY_DATA_OFFLINE=1: a portal that is called fails with OfflineError, so "not-due" proves no call was made.
  const s = await runHarvest({ only: ["monroe-county", "livingston-county"], log: () => {} });
  const by = Object.fromEntries(s.portals.map((p) => [p.source_id, p]));
  assert.equal(by["monroe-county"].outcome, "not-due");
  assert.match(by["monroe-county"].reason, /^read every 7 days; last read .*; next due after /);
  assert.equal(by["livingston-county"].outcome, "failed", "never read before, so due (and offline here)");
  assert.equal(s.not_due, 1);
  assert.equal(s.portals_tried, 1);

  const all = await runHarvest({ only: ["monroe-county"], ignoreCadence: true, log: () => {} });
  assert.equal(all.portals[0].outcome, "failed", "--ignore-cadence reads it anyway");
});
