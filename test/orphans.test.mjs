// Portals whose id left the registry are dropped when the harvest starts (issue #21). Offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempIndexPath, buildFixtureIndex } from "./helpers.mjs";

const { dropPlan, runHarvest, portalRecord } = await import("../dist/harvest/run.js");
const { openDb, upsertPortal, writePortalDatasets, setPortalHarvest } = await import("../dist/db.js");
const { registry } = await import("../dist/registry.js");
const { mapSocrataAsset } = await import("../dist/harvest/socrata.js");

test("dropPlan: drop orphans; keep them all when the loaded registry is older than the index's", () => {
  const o = [{ portal_id: "nys-department-of-environmental-conservation", datasets: 834 }];
  assert.deepEqual(dropPlan([], "2026-11-13", "2026-11-05"), { drop: [], kept: [], kept_reason: null });
  assert.deepEqual(dropPlan(o, "2026-11-13", "2026-11-05").drop, [{ ...o[0], reason: "id no longer in the registry" }]);
  assert.deepEqual(dropPlan(o, "2026-11-13", "2026-11-13").drop.length, 1, "same registry date: drop");
  assert.deepEqual(dropPlan(o, "2026-11-13", null).drop.length, 1, "index with no recorded registry: drop");
  const kept = dropPlan(o, "2026-11-05", "2026-11-13");
  assert.deepEqual(kept.drop, []);
  assert.deepEqual(kept.kept, o);
  assert.match(kept.kept_reason, /older than the index's/);
});

/** A fixture index plus one portal under an id no registry has (standing in for DEC's old id), 3 synthetic datasets. */
const OLD = "retired-portal-id-for-tests";
async function withOrphan(indexRegistry) {
  const path = await buildFixtureIndex(tempIndexPath());
  process.env.NY_DATA_INDEX = path;
  const db = openDb(path);
  const old = { ...portalRecord(registry().sources.find((s) => s.source_id === "new-york-city")), id: OLD, entity: "Retired portal (test)" };
  upsertPortal(db, old);
  const run = Number(db.prepare("INSERT INTO harvest_runs(started_at) VALUES ('2026-11-05T00:00:00Z')").run().lastInsertRowid);
  const ds = ["dec-0001", "dec-0002", "dec-0003"].map((id) => mapSocrataAsset({ resource: { id, name: `SYNTHETIC DEC layer ${id}`, type: "dataset" }, classification: {} }, "example.test"));
  writePortalDatasets(db, old, ds, run, true);
  setPortalHarvest(db, old.id, { adapter: "agol-org", status: "ok", note: null });
  if (indexRegistry) db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('registry_generated', ?)").run(indexRegistry);
  db.close();
  return path;
}

const count = (path, sql, ...a) => {
  const db = openDb(path, { readOnly: true });
  try {
    return db.prepare(sql).get(...a).n;
  } finally {
    db.close();
  }
};

test("the harvest drops a portal whose id left the registry, with its datasets, columns and history, and says so", async () => {
  const path = await withOrphan("2026-11-05");
  const before = count(path, "SELECT COUNT(*) AS n FROM datasets WHERE removed_at IS NULL");
  const s = await runHarvest({ only: [], log: () => {} }); // read nothing: only the drop runs
  assert.deepEqual(s.dropped_portals, [{ portal_id: OLD, datasets: 3, reason: "id no longer in the registry" }]);
  assert.equal(s.dropped_datasets, 3);
  assert.deepEqual(s.orphan_portals_kept, []);
  const id = OLD;
  assert.equal(count(path, "SELECT COUNT(*) AS n FROM portals WHERE id = ?", id), 0);
  assert.equal(count(path, "SELECT COUNT(*) AS n FROM datasets WHERE portal_id = ?", id), 0);
  assert.equal(count(path, "SELECT COUNT(*) AS n FROM changes WHERE portal_id = ?", id), 0);
  assert.equal(count(path, "SELECT COUNT(*) AS n FROM datasets_fts WHERE dataset_id LIKE ?", `${id}:%`), 0);
  assert.equal(count(path, "SELECT COUNT(*) AS n FROM datasets WHERE removed_at IS NULL"), before - 3, "every other portal untouched");

  const again = await runHarvest({ only: [], log: () => {} });
  assert.deepEqual(again.dropped_portals, [], "safe to re-run");
});

test("the harvest keeps orphans when its registry is older than the index's (a failed refresh), and says why", async () => {
  const path = await withOrphan("2999-01-01");
  const s = await runHarvest({ only: [], log: () => {} });
  assert.deepEqual(s.dropped_portals, []);
  assert.deepEqual(s.orphan_portals_kept, [{ portal_id: OLD, datasets: 3 }]);
  assert.match(s.orphan_portals_kept_reason, /older than the index's \(2999-01-01\)/);
  assert.equal(count(path, "SELECT COUNT(*) AS n FROM datasets WHERE portal_id = ?", OLD), 3);
});
