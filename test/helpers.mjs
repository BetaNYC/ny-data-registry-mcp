// Shared test setup. Tests never touch the network: NY_DATA_OFFLINE=1 makes every
// politeFetch throw, and the registry refresh is disabled.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.NY_DATA_OFFLINE = "1";
process.env.NY_DATA_REGISTRY_REFRESH = "0";
// search_datasets CSV exports go to a throwaway folder, never the real cache.
process.env.NY_DATA_EXPORT_DIR ??= mkdtempSync(join(tmpdir(), "nydr-exports-"));

export const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
export const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

export function tempIndexPath() {
  const dir = mkdtempSync(join(tmpdir(), "nydr-test-"));
  return join(dir, "idx.sqlite");
}

/** Build a small index from the recorded fixtures, through the real mappers and writer. */
export async function buildFixtureIndex(path, { lastHarvest = "2026-11-05T00:00:00Z" } = {}) {
  const { openDb, writePortalDatasets } = await import("../dist/db.js");
  const { mapSocrataAsset } = await import("../dist/harvest/socrata.js");
  const { mapArcgisItem, mergeDcat, filterItems } = await import("../dist/harvest/arcgis.js");
  const { registry } = await import("../dist/registry.js");
  const { portalRecord } = await import("../dist/harvest/run.js");
  const src = (id) => registry().sources.find((s) => s.source_id === id);
  const db = openDb(path);
  const run = Number(db.prepare("INSERT INTO harvest_runs(started_at) VALUES ('2026-11-05T00:00:00Z')").run().lastInsertRowid);

  const health = portalRecord(src("nys-department-of-health"));
  const { upsertPortal, setPortalHarvest } = await import("../dist/db.js");
  upsertPortal(db, health);
  const soc = fixture("socrata-catalog-health.json").results.map((a) => mapSocrataAsset(a, "health.data.ny.gov"));
  writePortalDatasets(db, health, soc, run, true);
  setPortalHarvest(db, health.id, { adapter: "socrata", status: "ok", note: null, socrata_domain: "health.data.ny.gov" });

  const cortland = portalRecord(src("cortland-county"));
  upsertPortal(db, cortland);
  const dcat = fixture("hub-dcat-cortland.json").dataset;
  const layer = fixture("arcgis-layer-cortland-zoning.json");
  const item = {
    id: "dea35a11cfbf4adeb083df6d63cf1f88",
    title: "2025 Cortland Zoning Feature Layer",
    type: "Feature Service",
    owner: "cortlandplanning",
    url: "https://services2.arcgis.com/fRWb1mz1huf3Aqyy/arcgis/rest/services/Cortland_Zoning_Feature_Layer/FeatureServer",
    tags: ["zoning"],
    numViews: 10,
    extent: [[-76.2767, 42.4077], [-75.8665, 42.7788]],
    access: "public",
  };
  const ds = mapArcgisItem(item, { permalink: null });
  mergeDcat(ds, dcat.filter((d) => d.identifier.includes(item.id)));
  ds.columns = layer.fields.map((f) => ({ name: f.alias, field: f.name, type: f.type, description: null, layer: null }));
  ds.columns_status = "fetched";
  ds.geometry_type = layer.geometryType;
  writePortalDatasets(db, cortland, [ds], run, true);
  setPortalHarvest(db, cortland.id, { adapter: "hub", status: "ok", note: null });

  const putnam = portalRecord(src("putnam-county"));
  upsertPortal(db, putnam);
  const ogc = fixture("hub-ogc-items-putnam.json").features.map((f) => ({ ...f.properties, id: f.properties.id ?? f.id }));
  const f = filterItems(ogc, { ownOrg: null, esriOrgIds: ["P3ePLMYs2RVChkJx"], esriOwner: /^esri/i });
  writePortalDatasets(db, putnam, f.kept.map((it) => mapArcgisItem(it, { permalink: null })), run, true);
  setPortalHarvest(db, putnam.id, { adapter: "hub", status: "ok", note: null });

  // A synthetic NYC-style dataset so find_joinable has a BBL partner. Clearly marked synthetic.
  const nyc = portalRecord(src("new-york-city"));
  upsertPortal(db, nyc);
  const mk = (id, name, cols) => ({
    ...mapSocrataAsset({ resource: { id, name, type: "dataset", columns_field_name: cols, columns_name: cols, columns_datatype: cols.map(() => "Text") }, classification: {} }, "data.cityofnewyork.us"),
  });
  writePortalDatasets(db, nyc, [mk("test-0001", "SYNTHETIC 311 test rows", ["unique_key", "bbl", "borough", "incident_zip", "community_board"]), mk("test-0002", "SYNTHETIC pluto test rows", ["bbl", "borocode", "cd", "zipcode", "name"])], run, true);
  setPortalHarvest(db, nyc.id, { adapter: "socrata", status: "ok", note: null, socrata_domain: "data.cityofnewyork.us" });

  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('last_harvest', ?)").run(lastHarvest);
  db.close();
  return path;
}
