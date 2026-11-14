// Tax parcel coverage for all 62 counties (issue #16, milestone 2). Offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, tempIndexPath } from "./helpers.mjs";
import { parseStateParcelCounties, buildParcelTable, countyRows, PARCEL_NAME } from "../dist/parcels.js";
import { loadBundled } from "../dist/registry.js";
import { readDataJson } from "../dist/paths.js";
import { places } from "../dist/places.js";

const reg = loadBundled();
const src = readDataJson("parcel-sources.json");
const svc = fixture("nys-tax-parcels-public-featureserver.json");

test("the State service's own list gives 38 counties, all matched, none guessed", () => {
  const p = parseStateParcelCounties(svc.serviceDescription);
  assert.equal(p.counties.length, 38, "the service says 'To date, 38 counties'");
  assert.deepEqual(p.unmatched, []);
  for (const c of ["Albany", "Kings", "New York", "Richmond", "St. Lawrence", "Wyoming", "Westchester"]) assert.ok(p.counties.includes(c), c);
  for (const c of ["Allegany", "Monroe", "Nassau", "Dutchess"]) assert.ok(!p.counties.includes(c), c);
  assert.match(svc.serviceDescription, /To date, 38 counties have provided/);
});

test("a name that matches no county is reported, not guessed; no list gives no counties", () => {
  const p = parseStateParcelCounties("Thanks to the following counties that specifically authorized it: Albany, Atlantis, and Wyoming. Geometry accuracy varies.");
  assert.deepEqual(p.counties, ["Albany", "Wyoming"]);
  assert.deepEqual(p.unmatched, ["Atlantis"]);
  assert.deepEqual(parseStateParcelCounties("No list here.").counties, []);
});

test("the recorded read says where, when and what, and the layers match the evidence", () => {
  const r = src.state_layer.read;
  assert.equal(r.url, `${src.state_layer.service_url}?f=json`);
  assert.equal(r.http_status, 200);
  assert.match(r.at, /^2026-11-14T/);
  assert.equal(src.state_layer.documented_at, "https://gis.ny.gov/parcels");
  assert.deepEqual(src.state_layer.layers, svc.layers.map((l) => ({ id: l.id, name: l.name })));
});

test("the State page's county table covers all 62 counties", () => {
  assert.deepEqual(Object.keys(src.state_page.county_resources).sort(), [...places().counties].sort());
});

test("every hand-reviewed registry parcel layer quotes its registry row exactly", () => {
  for (const [county, e] of Object.entries(src.registry_parcel_layers)) {
    const rows = countyRows(reg.sources, county);
    assert.ok(rows.some((s) => (s[e.field] ?? "").includes(e.quote)), `${county}: quote not found in ${e.field}`);
    assert.ok(["rest", "download"].includes(e.kind));
  }
});

test("parcel layer names: run-together county names count; other layers do not", () => {
  for (const n of ["Tax Parcels", "ParcelProperties2024", "Parcels_2025", "MapPLUTO", "Tax Lot Polygons", "Digital Tax Map"]) assert.ok(PARCEL_NAME.test(n), n);
  for (const n of ["Zoning Districts", "Building Footprints", "Polling Places"]) assert.ok(!PARCEL_NAME.test(n), n);
});

test("the table has 62 counties; the index, the registry and the State list each count", async () => {
  const { openDb, upsertPortal, writePortalDatasets, setPortalHarvest } = await import("../dist/db.js");
  const { portalRecord } = await import("../dist/harvest/run.js");
  const { mapSocrataAsset } = await import("../dist/harvest/socrata.js");
  const path = tempIndexPath();
  const db = openDb(path);
  const run = Number(db.prepare("INSERT INTO harvest_runs(started_at) VALUES ('2026-11-14T00:00:00Z')").run().lastInsertRowid);
  const yates = portalRecord(reg.sources.find((s) => s.source_id === "yates-county"));
  upsertPortal(db, yates);
  const ds = mapSocrataAsset({ resource: { id: "test-0001", name: "SYNTHETIC Tax_Parcels_2025" }, classification: {} }, "example.test");
  writePortalDatasets(db, yates, [ds], run, true);
  setPortalHarvest(db, yates.id, { adapter: "enterprise", status: "ok", note: null });
  db.close();

  const t = buildParcelTable(reg, { indexPath: path, sources: src, serviceDescription: svc.serviceDescription });
  assert.equal(t.rows.length, 62);
  const row = (c) => t.rows.find((r) => r.county === c);
  assert.equal(row("Yates").own_layer, "in-index");
  assert.equal(row("Yates").category, "own-only", "Yates is not in the State's list");
  assert.equal(row("Broome").own_layer, "registry-documented");
  assert.equal(row("Broome").category, "state-and-own");
  assert.equal(row("Allegany").category, "neither", "a Beacon parcel search is not a layer");
  assert.ok(row("Allegany").registry_text_mentions.length > 0, "the word appears, and is not counted");
  assert.equal(row("Erie").category, "state-only");
  assert.ok(row("Kings").county_rows.some((r) => r.source_id === "new-york-city"), "the boroughs use New York City's rows");
  const s = t.summary;
  assert.equal(s.shares_with_state, 38);
  assert.equal(Object.values(s.by_category).reduce((a, b) => a + b, 0), 62);
  assert.equal(s.neither, s.by_category.neither);
});

test("`parcels --json` runs offline", () => {
  const cache = mkdtempSync(join(tmpdir(), "nydr-parcels-"));
  const out = execFileSync(process.execPath, ["dist/cli.js", "parcels", "--json", "--index", join(cache, "none.sqlite")], {
    env: { ...process.env, NY_DATA_OFFLINE: "1", NY_DATA_CACHE_DIR: cache },
    encoding: "utf8",
  });
  const t = JSON.parse(out);
  assert.equal(t.rows.length, 62);
  assert.equal(t.index_path, null);
  assert.equal(t.summary.shares_with_state, 38);
});
