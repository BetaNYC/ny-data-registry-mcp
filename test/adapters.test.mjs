import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { mapSocrataAsset } from "../dist/harvest/socrata.js";
import { mapArcgisItem, filterItems, mergeDcat, parseDcatSpatial, bboxOf, mostCommonOrg } from "../dist/harvest/arcgis.js";
import { planFor, agolOrgOf, enterprisePortalBase } from "../dist/harvest/run.js";
import { parseRobots, robotsAllows } from "../dist/http.js";
import { keyLabel } from "../dist/keycolumns.js";
import { registry } from "../dist/registry.js";
import { readDataJson } from "../dist/paths.js";

const cfg = readDataJson("harvest-config.json");
const src = (id) => registry().sources.find((s) => s.source_id === id);

test("Socrata asset maps with the exact 4x4, zipped columns and provenance", () => {
  const a = fixture("socrata-catalog-health.json").results[0];
  const d = mapSocrataAsset(a, "health.data.ny.gov");
  assert.equal(d.native_id, a.resource.id);
  assert.match(d.native_id, /^[a-z0-9]{4}-[a-z0-9]{4}$/);
  assert.equal(d.columns.length, a.resource.columns_field_name.length);
  assert.equal(d.columns[0].field, a.resource.columns_field_name[0]);
  assert.equal(d.columns[0].type, a.resource.columns_datatype[0]);
  assert.equal(d.columns_status, "from-search");
  assert.equal(d.views, a.resource.page_views.page_views_total);
  assert.equal(d.row_count, null, "Discovery does not give row counts; never invented");
  assert.equal(d.provenance.formats, "derived");
  assert.equal(d.provenance.columns, "portal");
  assert.equal(d.update_frequency, "Weekly");
  assert.equal(d.api_endpoint, `https://health.data.ny.gov/resource/${a.resource.id}.json`);
});

test("ArcGIS OGC item maps, and DCAT adds formats and the landing page", () => {
  const item = fixture("hub-ogc-items-putnam.json").features[0].properties;
  const d = mapArcgisItem(item, { permalink: null });
  assert.equal(d.native_id, item.id);
  assert.equal(d.api_endpoint, item.url);
  assert.equal(d.columns_status, "not-fetched");
  assert.deepEqual(d.extent.map((x) => Math.round(x * 100) / 100), [-73.98, 41.32, -73.53, 41.53]);
  assert.equal(d.downloads, null);

  const dcat = fixture("hub-dcat-cortland.json").dataset.filter((x) => x.identifier.includes("dea35a11"));
  const c = mapArcgisItem({ id: "dea35a11cfbf4adeb083df6d63cf1f88", type: "Feature Service", url: "https://services2.arcgis.com/x/arcgis/rest/services/Z/FeatureServer" }, { permalink: null });
  mergeDcat(c, dcat);
  const fmts = c.formats.map((f) => f.format);
  for (const f of ["CSV", "GeoJSON", "KML", "ZIP"]) assert.ok(fmts.includes(f), f);
  assert.ok(c.permalink.includes("hub.arcgis.com/datasets/dea35a11"));
  assert.equal(c.publisher, null, "the unrendered '{{source}}' template is dropped, not stored");
});

test("Monroe gotcha: Esri's Living Atlas items are excluded from a county portal", () => {
  const s = fixture("enterprise-search-monroe-unfiltered.json");
  const f = filterItems(s.results, { ownOrg: "0123456789ABCDEF", esriOrgIds: cfg.defaults.esri_org_ids, esriOwner: new RegExp(cfg.defaults.esri_owner_pattern, "i") });
  assert.equal(f.kept.length, 0, f.kept.map((x) => x.title).join(", "));
  assert.equal(f.excluded.esri, s.results.length);
});

test("items from another org, out-of-state items, and non-public items are excluded", () => {
  const ny = [[-76.3, 42.4], [-75.9, 42.8]];
  const ohio = [[-83.2, 40.1], [-82.7, 40.5]];
  const items = [
    { id: "a", orgId: "OWN", extent: ny, access: "public" },
    { id: "b", orgId: "OTHER", extent: ny, access: "public" },
    { id: "c", orgId: "OWN", extent: ohio, access: "public" },
    { id: "d", orgId: "OWN", extent: ny, access: "org" },
    { id: "e", orgId: "P3ePLMYs2RVChkJx", extent: ny },
  ];
  const f = filterItems(items, { ownOrg: "OWN", esriOrgIds: ["P3ePLMYs2RVChkJx"], esriOwner: /^esri/i });
  assert.deepEqual(f.kept.map((x) => x.id), ["a"]);
  assert.deepEqual(f.excluded, { esri: 1, other_org: 1, out_of_state: 1, not_public: 1 });
});

test("out-of-state guard refuses a portal whose items are mostly outside New York (the old Delaware, Ohio Hub)", () => {
  const ohio = [[-83.2, 40.1], [-82.7, 40.5]];
  const items = Array.from({ length: 10 }, (_, i) => ({ id: String(i), orgId: "X", extent: ohio }));
  const f = filterItems(items, { ownOrg: "X", esriOrgIds: [], esriOwner: /^esri/i });
  assert.equal(f.portal_in_ny.refuse, true);
  assert.equal(mostCommonOrg([{ orgId: "A" }, { orgId: "B" }, { orgId: "B" }]), "B");
});

test("DCAT spatial and ArcGIS extents parse; bad values become null", () => {
  assert.deepEqual(parseDcatSpatial("-77.0191,42.1397,-75.0443,43.0385"), [-77.0191, 42.1397, -75.0443, 43.0385]);
  assert.equal(parseDcatSpatial("{{extent}}"), null);
  assert.deepEqual(bboxOf([[1, 2], [3, 4]]), [1, 2, 3, 4]);
  assert.equal(bboxOf(null), null);
});

test("harvest plan: adapters, skips and reasons", () => {
  assert.deepEqual(planFor(src("nassau-county"), cfg), { kind: "socrata", domain: "opennassau.nassaucountyny.gov" });
  assert.equal(planFor(src("monroe-county"), cfg).kind, "enterprise");
  assert.equal(enterprisePortalBase(src("monroe-county")), "https://maps.monroecounty.gov/portal");
  assert.equal(planFor(src("rockland-county"), cfg).kind, "skip");
  assert.equal(planFor(src("columbia-university-libraries"), cfg).kind, "skip");
  assert.equal(planFor(src("association-for-neighborhood-and-housing-development-anhd"), cfg).kind, "skip");
  assert.equal(planFor(src("erie-county"), cfg).kind, "skip");
  assert.equal(planFor(src("new-york-state-senate"), cfg).kind, "skip");
  assert.deepEqual(planFor(src("nys-department-of-environmental-conservation"), cfg), { kind: "agol-org", orgId: "DZHaqZm9cxOD4CWM" });
  assert.equal(agolOrgOf(src("tioga-county")), "PvkAiSMFS7cpxnJP");
  for (const s of registry().sources) {
    const p = planFor(s, cfg);
    if (s.key_required === "Y") assert.equal(p.kind, "skip", `${s.source_id} needs a key and must never be called`);
    if (s.status !== "live") assert.equal(p.kind, "skip");
  }
});

test("robots.txt: Disallow and Crawl-delay are honored for '*'", () => {
  const r = parseRobots("User-agent: *\nCrawl-delay: 60\nDisallow: /sites/\nDisallow: /admin/\n\nUser-agent: otherbot\nDisallow: /\n");
  assert.equal(r.crawlDelay, 60);
  assert.ok(robotsAllows(r.disallow, "/api/search/v1/collections/dataset/items?limit=100"));
  assert.ok(!robotsAllows(r.disallow, "/sites/foo"));
  const mine = parseRobots("User-agent: *\nDisallow:\n\nUser-agent: ny-data-registry-mcp\nDisallow: /api/\n");
  assert.ok(!robotsAllows(mine.disallow, "/api/feed"));
});

test("key columns: curated variants match, generic names do not", () => {
  for (const [f, k] of [["bbl", "BBL"], ["BORO", "borough"], ["incident_zip", "ZIP"], ["Community Board", "community district"], ["council_district", "council district"], ["SWIS", "SWIS"], ["county_fips", "FIPS"], ["ct2020", "census tract"], ["bin", "BIN"]]) {
    assert.equal(keyLabel(f)?.label, k, f);
  }
  for (const f of ["name", "cd", "ct", "id", "geoid", "tract", "OBJECTID", "Shape__Area"]) assert.equal(keyLabel(f), null, f);
});

test("placeholder and projected extents mean 'unknown', never 'outside New York'", async () => {
  const { isLonLatBox, bboxIntersectsNY } = await import("../dist/places.js");
  assert.equal(isLonLatBox([0, 0, 0, 0]), false);
  assert.equal(isLonLatBox([873633.39, 1087758.39, 955413.93, 1125227.5]), false); // Syracuse fire hydrants, State Plane
  assert.equal(bboxIntersectsNY([0, 0, 0, 0]), null);
  const items = [
    { id: "zero", orgId: "X", extent: [[0, 0], [0, 0]] },
    { id: "stateplane", orgId: "X", extent: [[873633.39, 1087758.39], [955413.93, 1125227.5]] },
  ];
  const f = filterItems(items, { ownOrg: "X", esriOrgIds: [], esriOwner: /^esri/i });
  assert.equal(f.kept.length, 2);
  assert.equal(f.excluded.out_of_state, 0);
  assert.equal(mapArcgisItem(items[1], { permalink: null }).extent, null);
});

test("a place-specific search pushes down titles that name a different county", async () => {
  const { placePenalty } = await import("../dist/datasets.js");
  const { resolvePlace } = await import("../dist/places.js");
  const erie = resolvePlace("Erie County");
  assert.ok(placePenalty("Oswego County Active Tax Parcels", erie) < 0);
  assert.ok(placePenalty("Erie County Parcels", erie) > 0);
  assert.equal(placePenalty("NYS Tax Parcels Public", erie), 0);
});

test("Socrata computed-region columns never get a join key, whatever their display name", () => {
  assert.equal(keyLabel(":@computed_region_f5dn_yrer", "Community Districts"), null);
  assert.equal(keyLabel("community_board", "Community Board")?.label, "community district");
});
