// "No portal" rows with a documented data endpoint (issue #16, milestone 3; epic #7, D4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedNoPortalPlan, planFor } from "../dist/harvest/run.js";
import { loadBundled } from "../dist/registry.js";
import { readDataJson } from "../dist/paths.js";

const cfg = readDataJson("harvest-config.json");
const reg = loadBundled();
const src = (id) => reg.sources.find((s) => s.source_id === id);

test("Utica, Wyoming County and Mount Vernon are read, by the adapter their endpoint needs", () => {
  assert.equal(src("city-of-utica").status, "no-portal");
  assert.deepEqual(planFor(src("city-of-utica"), cfg), { kind: "agol-org", orgId: "MBcb1JDktb5ipmv9" });
  assert.deepEqual(planFor(src("wyoming-county"), cfg), { kind: "agol-org", orgId: "Sq7KUOgahdDkqoAp" });
  assert.deepEqual(planFor(src("city-of-mount-vernon"), cfg), { kind: "enterprise", portalBase: "https://gis.cmvny.com/portal" });
});

test("each allowed row is New York: it names the New York org, never the look-alike", () => {
  const allow = cfg.allow_no_portal;
  assert.match(allow["City of Utica"].checked_new_york, /Utica, NY/);
  assert.match(allow["City of Utica"].checked_new_york, /Minnesota/);
  assert.match(allow["Wyoming County"].checked_new_york, /Warsaw, NY/);
  assert.match(allow["Wyoming County"].checked_new_york, /Pennsylvania/);
  for (const [entity, a] of Object.entries(allow)) {
    if (typeof a === "string") continue;
    const row = reg.sources.find((s) => s.entity === entity);
    assert.ok(row, entity);
    assert.ok(row.api_endpoint.includes(a.endpoint), `${entity}: endpoint is the registry's own`);
    assert.ok(!/uticamn|wycopa/.test(a.endpoint));
  }
});

// Added 2026-11-14 after one live read of each services directory root.
const COUNTY_SERVERS = {
  "greene-county": "https://gis.gcgovny.com/arcgis/rest/services",
  "washington-county": "https://gis.washingtoncountyny.gov/arcgis/rest/services",
  "cayuga-county": "https://ccgis2.cayugacounty.us/arcgis/rest/services",
  "essex-county": "https://essex-gis.co.essex.ny.us/arcgis/rest/services",
  "chautauqua-county": "https://maps.chautauquacounty.com/server/rest/services",
};

test("five county ArcGIS servers are read by the arcgis-server adapter, each with its live check recorded", () => {
  for (const [id, root] of Object.entries(COUNTY_SERVERS)) {
    const row = src(id);
    assert.equal(row.status, "no-portal", id);
    assert.deepEqual(planFor(row, cfg), { kind: "arcgis-server", root }, id);
    const a = cfg.allow_no_portal[row.entity];
    assert.equal(a.adapter, "arcgis-server");
    assert.equal(a.checked_live.url, `${root}?f=json`);
    assert.equal(a.checked_live.http_status, 200);
    assert.match(a.checked_live.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(a.checked_new_york, /NY|New York/, id);
  }
  // Each names the same-named county it is not.
  assert.match(cfg.allow_no_portal["Greene County"].checked_new_york, /Ohio/);
  assert.match(cfg.allow_no_portal["Washington County"].checked_new_york, /Wisconsin/);
  assert.match(cfg.allow_no_portal["Essex County"].checked_new_york, /Ontario/);
  assert.match(cfg.allow_no_portal["Chautauqua County"].checked_new_york, /Kansas/);
});

test("St. Lawrence County is left out: its server is shared with other counties", () => {
  assert.equal(cfg.allow_no_portal["St. Lawrence County"], undefined);
  assert.match(cfg.allow_no_portal["_left_out_2026-11-14"], /St\. Lawrence/);
  assert.notEqual(planFor(src("st-lawrence-county"), cfg).kind, "arcgis-server");
});

test("a moved county server stops its row too; its hand-kept links take over", () => {
  const essex = src("essex-county");
  const movedRow = { ...essex, api_endpoint: "https://gis.essexcountyva.gov/arcgis/rest/services" };
  const a = allowedNoPortalPlan(movedRow, cfg);
  assert.equal(a.kind, "skip");
  assert.match(a.reason, /no longer contains/);
  assert.equal(planFor(movedRow, cfg).kind, "hand-kept");
  assert.equal(planFor(essex, { ...cfg, adapters: { ...cfg.adapters, "arcgis-server": { enabled: false } } }).code, "adapter-off");
});

test("other 'no portal' rows stay skipped, even with an endpoint", () => {
  const k = planFor(src("city-of-kingston"), cfg);
  assert.equal(k.kind, "skip");
  assert.equal(k.code, "no-portal");
  assert.ok(src("city-of-kingston").api_endpoint, "Kingston documents an endpoint and is still not read");
});

test("a changed registry row, a key or a skip rule still stops an allowed row", () => {
  const utica = src("city-of-utica");
  const moved = planFor({ ...utica, api_endpoint: "https://services1.arcgis.com/OTHERORG123/arcgis/rest/services" }, cfg);
  assert.equal(moved.kind, "skip");
  assert.match(moved.reason, /no longer contains/);
  assert.equal(planFor({ ...utica, key_required: "Y" }, cfg).code, "policy");
  assert.equal(planFor(utica, { ...cfg, skip: { by_entity: { "City of Utica": "test skip" } } }).reason, "test skip");
  assert.equal(planFor(utica, { ...cfg, adapters: { ...cfg.adapters, "agol-org": { enabled: false } } }).code, "adapter-off");
});
