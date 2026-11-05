import { test } from "node:test";
import assert from "node:assert/strict";
import { tempIndexPath, buildFixtureIndex } from "./helpers.mjs";

const path = tempIndexPath();
process.env.NY_DATA_INDEX = path;
await buildFixtureIndex(path);
const { searchDatasets, getDatasetColumns, findJoinable, whatsNew, closeDb, NoIndexError, db } = await import("../dist/datasets.js");
const { openDb, writePortalDatasets } = await import("../dist/db.js");
const { mapSocrataAsset } = await import("../dist/harvest/socrata.js");
const { portalRecord } = await import("../dist/harvest/run.js");
const { registry } = await import("../dist/registry.js");

test("search_datasets finds a dataset by title and by column name, across platforms", () => {
  const z = searchDatasets({ query: "zoning" });
  assert.equal(z.results[0].dataset_id, "cortland-county:dea35a11cfbf4adeb083df6d63cf1f88");
  const byCol = searchDatasets({ query: "medicaid provider" });
  assert.equal(byCol.results[0].portal_id, "nys-department-of-health");
  assert.deepEqual(byCol.results[0].query_with.mcp, "socrata");
});

test("search_datasets filters by format and place; statewide portals cover every county", () => {
  assert.equal(searchDatasets({ query: "zoning", format: "shapefile" }).results.length, 1);
  assert.equal(searchDatasets({ query: "zoning", format: "csv" }).results.length, 1);
  assert.equal(searchDatasets({ query: "zoning", place: "Erie County" }).results.length, 0);
  assert.ok(searchDatasets({ query: "medicaid", place: "Erie County" }).results.length >= 1, "statewide DOH data covers Erie");
  assert.match(searchDatasets({ query: "zoning", place: "Narnia" }).place_error, /not a New York place/);
});

test("get_dataset_columns returns fields with provenance and distributions", () => {
  const r = getDatasetColumns("dea35a11cfbf4adeb083df6d63cf1f88");
  assert.equal(r.columns.length, 5);
  assert.ok(r.columns.some((c) => c.field === "ZONING"));
  assert.ok(r.distributions.some((d) => d.format === "GeoJSON" && d.provenance === "portal"));
  assert.equal(r.geometry_type, "esriGeometryPolygon");
  assert.match(getDatasetColumns("nope-nope").error, /no dataset/);
});

test("find_joinable groups by curated key and ignores generic names", () => {
  const r = findJoinable("data.cityofnewyork.us/test-0001".split("/")[1]);
  const keys = Object.fromEntries(r.keys.map((k) => [k.key, k]));
  assert.equal(keys.BBL.datasets_sharing_key, 1);
  assert.equal(keys.BBL.top[0].dataset_id, "new-york-city:test-0002");
  assert.equal(keys.borough.top[0].their_column, "borocode");
  assert.equal(keys.ZIP.top[0].their_column, "zipcode");
  assert.ok(!r.keys.some((k) => k.your_column === "unique_key"));
  assert.equal(findJoinable("test-0001", "BBL").keys.length, 1);
});

test("whats_new and the change lifecycle: added, changed, removed only on a complete harvest", () => {
  closeDb();
  const w = openDb(path);
  const nyc = portalRecord(registry().sources.find((s) => s.source_id === "new-york-city"));
  const mk = (id, name) => mapSocrataAsset({ resource: { id, name, type: "dataset", columns_field_name: ["bbl"] }, classification: {} }, "data.cityofnewyork.us");
  const run = 2;
  const partial = writePortalDatasets(w, nyc, [mk("test-0001", "SYNTHETIC 311 test rows (renamed)")], run, false);
  assert.equal(partial.changed, 1);
  assert.equal(partial.removed, 0, "a partial harvest never removes");
  const full = writePortalDatasets(w, nyc, [mk("test-0001", "SYNTHETIC 311 test rows (renamed)"), mk("test-0003", "SYNTHETIC new")], run, true);
  assert.equal(full.added, 1);
  assert.equal(full.removed, 1);
  w.close();
  const r = whatsNew("2000-01-01", "new-york-city");
  const c = Object.fromEntries(r.index_changes.map((x) => [x.change, x.n]));
  assert.equal(c.removed, 1);
  assert.ok(c.added >= 3);
  assert.ok(c.changed >= 1);
  assert.match(whatsNew("yesterday").error, /YYYY-MM-DD/);
  assert.equal(searchDatasets({ query: "pluto" }).results.length, 0, "removed datasets leave the search index");
});

test("phase 2 tools explain how to build a missing index", () => {
  closeDb();
  const saved = process.env.NY_DATA_INDEX;
  process.env.NY_DATA_INDEX = path + ".missing";
  try {
    assert.throws(() => db(), NoIndexError);
  } finally {
    process.env.NY_DATA_INDEX = saved;
    closeDb();
  }
});
