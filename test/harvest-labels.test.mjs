// Review round 2, F8: a field the harvest cleaned or chose is labeled "derived" in its
// provenance, not "portal". Labels only: the harvested values are unchanged. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./helpers.mjs";
import { mapServerService } from "../dist/harvest/arcgis-server.js";
import { mapOgmRecord, readRecord } from "../dist/harvest/geoblacklight.js";
import { mapInvenioRecord } from "../dist/harvest/invenio.js";
import { mapArcgisItem } from "../dist/harvest/arcgis.js";
import { cleanedLabel } from "../dist/db.js";

const ref = { name: "Parcels/Tax_Parcels", type: "MapServer", url: "https://gis.example.gov/arcgis/rest/services/Parcels/Tax_Parcels/MapServer" };

test("cleanedLabel: derived only when cleaning changed the value", () => {
  assert.equal(cleanedLabel("plain text", "plain text"), "portal");
  assert.equal(cleanedLabel("<p>text</p>", "text"), "derived");
  assert.equal(cleanedLabel("a  b", "a b"), "derived");
  assert.equal(cleanedLabel(null, null), "portal");
});

test("ArcGIS Server: an HTML description and the copyrightText publisher are derived", () => {
  const d = mapServerService(ref, { serviceDescription: "<p>Tax  parcels</p>", copyrightText: "NYS <b>ITS</b>" });
  assert.equal(d.description, "Tax parcels", "the value itself is unchanged by this fix");
  assert.equal(d.provenance.description, "derived");
  assert.equal(d.publisher, "NYS ITS");
  assert.equal(d.provenance.publisher, "derived");
  const plain = mapServerService(ref, { serviceDescription: "Tax parcels" });
  assert.equal(plain.provenance.description, "portal");
  assert.equal(plain.publisher, null);
});

test("GeoBlacklight: an HTML description is derived; a plain one is the portal's", () => {
  const rec = (desc) =>
    readRecord({ geoblacklight_version: "1.0", layer_slug_s: "x-1", dc_title_s: "Roads", dc_description_s: desc, dc_rights_s: "Public", solr_geom: "ENVELOPE(-76, -75, 43, 42)" });
  assert.equal(mapOgmRecord(rec("<b>Roads</b> of Tompkins")).provenance.description, "derived");
  assert.equal(mapOgmRecord(rec("Roads of Tompkins")).provenance.description, "portal");
});

test("InvenioRDM: an HTML description is derived", () => {
  const r = (description) => ({ id: "abc", metadata: { title: "Survey", description }, links: {} });
  assert.equal(mapInvenioRecord(r("<p>Survey data</p>"), null).provenance.description, "derived");
  assert.equal(mapInvenioRecord(r("Survey data"), null).provenance.description, "portal");
});

test("ArcGIS items: a snippet standing in for a missing description is derived; a cleaned license too", () => {
  const base = { id: "a1", title: "Zoning", type: "Feature Service", url: "https://services.example/x/FeatureServer" };
  const snip = mapArcgisItem({ ...base, snippet: "Zoning districts" }, { permalink: null });
  assert.equal(snip.description, "Zoning districts");
  assert.equal(snip.provenance.description, "derived");
  assert.equal(mapArcgisItem({ ...base, description: "Full text", snippet: "Short" }, { permalink: null }).provenance.description, "portal");
  assert.equal(mapArcgisItem({ ...base, licenseInfo: "<p>CC BY</p>" }, { permalink: null }).provenance.license, "derived");
  assert.equal(mapArcgisItem({ ...base, licenseInfo: "CC BY" }, { permalink: null }).provenance.license, "portal");
});

test("DATA-SOURCES.json no longer says every value is kept as the portal gives it, for cleaned catalogs", async () => {
  const { readFileSync } = await import("node:fs");
  const ds = JSON.parse(readFileSync(new URL("../DATA-SOURCES.json", import.meta.url), "utf8"));
  const catalogs = ds.sources.filter((s) => s.id.startsWith("catalog-"));
  const asIs = catalogs.filter((s) => /Titles, descriptions and other values are kept as the portal gives them/.test(s.changes.detail));
  // Only the Socrata catalogs (no cleaning) keep that sentence.
  assert.ok(asIs.every((s) => /Socrata/.test(s.what)), asIs.map((s) => s.id).join(", "));
  for (const id of ["catalog-dec-gis-services", "catalog-cornell-cugir"]) {
    assert.match(catalogs.find((s) => s.id === id).changes.detail, /HTML tags removed/, id);
  }
  assert.match(catalogs.find((s) => s.id === "catalog-albany-county").changes.detail, /snippet/);
});
