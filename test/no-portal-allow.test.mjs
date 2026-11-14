// "No portal" rows with a documented data endpoint (issue #16, milestone 3; epic #7, D4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { planFor } from "../dist/harvest/run.js";
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
