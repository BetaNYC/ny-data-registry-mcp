// ArcGIS Server REST directory adapter (issue #16, milestone 4). Fixtures are the documented
// example responses from Esri's ArcGIS REST API reference, plus the State parcel service read
// on 2026-11-14. The flow tests stub global fetch; nothing leaves the machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./helpers.mjs";
import {
  serverRootOf, fullServiceName, mapServerService, envelopeToLonLat, listServerServices, harvestArcgisServer, DEFAULT_SERVER_CONFIG,
} from "../dist/harvest/arcgis-server.js";
import { planFor, cadenceDays } from "../dist/harvest/run.js";
import { resetHttpState } from "../dist/http.js";
import { loadBundled } from "../dist/registry.js";
import { readDataJson } from "../dist/paths.js";

const cfg = readDataJson("harvest-config.json");
const reg = loadBundled();
const src = (id) => reg.sources.find((s) => s.source_id === id);
const catalog = fixture("arcgis-server-catalog-doc.json");
const mapDoc = fixture("arcgis-server-mapservice-doc.json");
const parcelSvc = fixture("nys-tax-parcels-public-featureserver.json");
const layer = fixture("arcgis-layer-cortland-zoning.json");

test("the services directory root comes from the registry row, never invented", () => {
  assert.equal(serverRootOf("https://orthos.its.ny.gov/arcgis/rest/services", "https://orthos.its.ny.gov/arcgis/rest/services/wms"), "https://orthos.its.ny.gov/arcgis/rest/services");
  assert.equal(serverRootOf("https://gisservices.dec.ny.gov/arcgis/rest/services?f=json"), "https://gisservices.dec.ny.gov/arcgis/rest/services");
  assert.equal(serverRootOf("https://ccgis2.cayugacounty.us/arcgis/rest/services (also https://ccgis.cayugacounty.us/arcgis/rest/services)"), "https://ccgis2.cayugacounty.us/arcgis/rest/services");
  assert.equal(serverRootOf("https://example.gov/gis/viewer.html", null), null);
});

test("standalone ArcGIS Server rows get the adapter; ArcGIS Online orgs and 'no portal' rows do not", () => {
  assert.deepEqual(planFor(src("broome-county"), cfg), { kind: "arcgis-server", root: "https://gis.broomecountyny.gov/arcgis/rest/services" });
  assert.deepEqual(planFor(src("ulster-county"), cfg), { kind: "arcgis-server", root: "https://gis.ulstercountyny.gov/server/rest/services" });
  assert.equal(planFor(src("nys-department-of-environmental-conservation--gisservices-dec-ny-gov"), cfg).kind, "arcgis-server");
  assert.equal(planFor(src("nys-department-of-environmental-conservation--services6-arcgis-com"), cfg).kind, "agol-org");
  assert.equal(planFor(src("greene-county"), cfg).code, "no-portal", "a no-portal county server is read only if put on allow_no_portal");
  assert.equal(cadenceDays("broome-county", "arcgis-server", cfg.cadence), 7, "weekly per host (D5)");
  assert.equal(cfg.adapters["arcgis-server"].enabled, true);
});

test("folder names: added once, never twice", () => {
  assert.equal(fullServiceName(null, "SampleWorldCities"), "SampleWorldCities");
  assert.equal(fullServiceName("Parcels", "NYS_Tax_Parcels_Public"), "Parcels/NYS_Tax_Parcels_Public");
  assert.equal(fullServiceName("Parcels", "Parcels/NYS_Tax_Parcels_Public"), "Parcels/NYS_Tax_Parcels_Public");
});

test("the documented map service example maps to one dataset, with its own title and keywords", () => {
  const ref = { name: "SampleWorldCities", type: "MapServer", url: "https://organization.example.com/arcgis/rest/services/SampleWorldCities/MapServer" };
  const d = mapServerService(ref, mapDoc);
  assert.equal(d.native_id, "SampleWorldCities/MapServer");
  assert.equal(d.name, "StreetMap USA.mxd", "documentInfo.Title");
  assert.equal(d.provenance.name, "portal");
  assert.equal(d.description, "Test Map Service Description");
  assert.deepEqual(d.tags, ["StreetMap USA"]);
  assert.equal(d.type, "Map Service");
  assert.equal(d.publisher, "ESRI");
  assert.deepEqual(d.extent, [-130, 24, -65, 50]);
  assert.equal(d.columns_status, "not-fetched");
  assert.equal(d.api_endpoint, ref.url);
  assert.equal(d.row_count, null, "never invented");
  const noTitle = mapServerService({ name: "Parcels/NYS_Tax_Parcels_Public", type: "FeatureServer", url: "u" }, parcelSvc);
  assert.equal(noTitle.name, "NYS_Tax_Parcels_Public", "no documentInfo.Title: the service name, untouched");
  assert.equal(noTitle.provenance.name, "derived");
  assert.deepEqual(noTitle.categories, ["Parcels"]);
  assert.match(noTitle.description, /38 counties have provided/);
});

test("extents: geographic kept, Web Mercator converted, any other projection unknown", () => {
  assert.deepEqual(envelopeToLonLat({ xmin: -79, ymin: 40, xmax: -72, ymax: 45, spatialReference: { wkid: 4326 } }), [-79, 40, -72, 45]);
  const wm = envelopeToLonLat(parcelSvc.fullExtent ?? { xmin: -8473579.69, ymin: 4813104.43, xmax: -8404461.95, ymax: 5748753.81, spatialReference: { wkid: 102100, latestWkid: 3857 } });
  assert.ok(wm[0] > -77 && wm[2] < -75 && wm[1] > 39 && wm[3] < 46, JSON.stringify(wm));
  assert.equal(envelopeToLonLat({ xmin: 600000, ymin: 1000000, xmax: 700000, ymax: 1100000, spatialReference: { wkid: 2260 } }), null);
  assert.equal(envelopeToLonLat(undefined), null);
});

// ─── flow, with a stubbed server ────────────────────────────────────────────

const ROOT = "https://gis.example.gov/arcgis/rest/services";
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

async function withServer(fn) {
  const realFetch = globalThis.fetch;
  const saved = process.env.NY_DATA_OFFLINE;
  process.env.NY_DATA_OFFLINE = "0";
  process.env.NY_DATA_CACHE_DIR = mkdtempSync(join(tmpdir(), "nydr-ags-"));
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push({ url: u, at: Date.now() });
    if (u.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /arcgis/rest/services/Private\n");
    if (u === `${ROOT}?f=json`) return json({ ...catalog, folders: ["Utilities", "Parcels", "Private"] });
    if (u === `${ROOT}/Parcels?f=json`) return json({ currentVersion: 11.1, folders: [], services: [{ name: "Parcels/NYS_Tax_Parcels_Public", type: "FeatureServer" }, { name: "Parcels/Locator", type: "GeocodeServer" }] });
    if (u === `${ROOT}/SampleWorldCities/MapServer?f=json`) return json(mapDoc);
    if (u === `${ROOT}/Parcels/NYS_Tax_Parcels_Public/FeatureServer?f=json`) return json(parcelSvc);
    if (/\/(MapServer|FeatureServer)\/\d+\?f=json$/.test(u)) return json(layer);
    return json({ error: { code: 404, message: "not found" } });
  };
  resetHttpState();
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
    process.env.NY_DATA_OFFLINE = saved;
    resetHttpState();
  }
}

const quick = { ...DEFAULT_SERVER_CONFIG, min_interval_ms: 1000, max_layers_per_service: 1 };

test("a server is walked politely: robots.txt first, utility and disallowed folders skipped, only data services kept", async () => {
  await withServer(async (calls) => {
    const h = await harvestArcgisServer(ROOT, quick);
    assert.equal(calls[0].url, "https://gis.example.gov/robots.txt");
    assert.ok(!calls.some((c) => /Utilities/.test(c.url)), "the Utilities folder is never read");
    assert.ok(!calls.some((c) => /Locator/.test(c.url)), "a GeocodeServer is not data");
    assert.deepEqual(h.folders_skipped, ["Utilities"]);
    assert.equal(h.complete, false, "the Private folder is disallowed by robots.txt, so the listing is incomplete");
    assert.deepEqual(h.datasets.map((d) => d.native_id).sort(), ["Parcels/NYS_Tax_Parcels_Public/FeatureServer", "SampleWorldCities/MapServer"]);
    const p = h.datasets.find((d) => d.native_id.startsWith("Parcels"));
    assert.equal(p.columns_status, "fetched");
    assert.equal(p.columns[0].field, layer.fields[0].name);
    const gaps = calls.slice(1).map((c, i) => c.at - calls[i].at);
    for (const g of gaps.slice(1)) assert.ok(g >= 990, `gap ${g} ms`);
  });
});

test("the per-host request cap stops the read and marks it incomplete", async () => {
  await withServer(async (calls) => {
    const budget = { left: 2 };
    const l = await listServerServices(ROOT, quick, budget);
    assert.equal(l.complete, false);
    assert.match(l.error, /request cap/);
    assert.equal(l.requests, 2);
    assert.equal(calls.filter((c) => !c.url.endsWith("robots.txt")).length, 2);
  });
});

test("the nightly harvest reads an ArcGIS Server portal end to end and records it", async () => {
  const { tempIndexPath } = await import("./helpers.mjs");
  const { runHarvest } = await import("../dist/harvest/run.js");
  const { openDb } = await import("../dist/db.js");
  process.env.NY_DATA_INDEX = tempIndexPath();
  const realFetch = globalThis.fetch;
  const saved = process.env.NY_DATA_OFFLINE;
  process.env.NY_DATA_OFFLINE = "0";
  const B = "https://gis.broomecountyny.gov/arcgis/rest/services";
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
    if (u === `${B}?f=json`) return json({ currentVersion: 10.61, folders: ["Utilities"], services: [{ name: "br_parcels", type: "MapServer" }] });
    if (u === `${B}/br_parcels/MapServer?f=json`) return json(parcelSvc);
    if (/\/br_parcels\/MapServer\/\d+\?f=json$/.test(u)) return json(layer);
    return json({ error: { code: 404 } });
  };
  resetHttpState();
  try {
    const s = await runHarvest({ only: ["broome-county"], log: () => {} });
    const p = s.portals[0];
    assert.equal(p.adapter, "arcgis-server");
    assert.equal(p.outcome, "ok");
    assert.equal(p.datasets, 1);
    assert.equal(p.columns_fetched_for, 1);
    const db = openDb();
    const row = db.prepare("SELECT harvest_adapter, harvest_status FROM portals WHERE id = 'broome-county'").get();
    assert.deepEqual({ ...row }, { harvest_adapter: "arcgis-server", harvest_status: "ok" });
    const d = db.prepare("SELECT native_id, api_endpoint FROM datasets WHERE portal_id = 'broome-county'").get();
    assert.equal(d.native_id, "br_parcels/MapServer");
    assert.equal(d.api_endpoint, `${B}/br_parcels/MapServer`);
    db.close();
  } finally {
    globalThis.fetch = realFetch;
    process.env.NY_DATA_OFFLINE = saved;
    resetHttpState();
  }
});

test("the time cap stops a host as surely as the request cap", async () => {
  const { canRequest } = await import("../dist/harvest/arcgis-server.js");
  assert.equal(canRequest({ left: 5 }), true);
  assert.equal(canRequest({ left: 0 }), false);
  assert.equal(canRequest({ left: 5, deadline: 1000 }, 999), true);
  assert.equal(canRequest({ left: 5, deadline: 1000 }, 1000), false);
  assert.equal(cfg.arcgis_server.max_seconds_per_host, 1800);
});
