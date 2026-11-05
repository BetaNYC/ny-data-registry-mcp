import { test } from "node:test";
import assert from "node:assert/strict";
import "./helpers.mjs";
import { readFileSync } from "node:fs";
import { familyFor, allMappings, FAMILIES } from "../dist/families.js";
import { registry, setRegistry, loadBundled } from "../dist/registry.js";
import { resolvePlace } from "../dist/places.js";
import { findSources, listSourcesForPlace, howToQuery, registryInfo } from "../dist/sources.js";
import { checkSource } from "../dist/check.js";

const bundled = JSON.parse(readFileSync(new URL("../data/ny-data-portal-registry.json", import.meta.url), "utf8"));

test("every platform string in the bundled registry is in the family table (none unmapped)", () => {
  for (const r of bundled.rows) {
    const f = familyFor(r.platform, r.api_type);
    assert.notEqual(f.status, "unmapped", `unmapped platform string: ${JSON.stringify(r.platform)}`);
    if (f.family !== null) assert.ok(FAMILIES.includes(f.family));
  }
});

test("an unknown platform string is flagged unmapped, never guessed", () => {
  const f = familyFor("ArcGIS Hub (brand new variant)", "OGC");
  assert.equal(f.status, "unmapped");
  assert.equal(f.family, null);
  assert.equal(f.platform_raw, "ArcGIS Hub (brand new variant)");
});

test("UNCONFIRMED strings stay family null with status unconfirmed", () => {
  assert.equal(familyFor("Unknown", "UNCONFIRMED").status, "unconfirmed");
  assert.equal(familyFor("Unknown", "UNCONFIRMED").family, null);
});

test("family table has no unused rows and only allowed families", () => {
  const strings = new Set(bundled.rows.map((r) => r.platform));
  for (const m of allMappings()) assert.ok(strings.has(m.platform), `stale row: ${m.platform}`);
});

test("source ids are unique and stable", () => {
  const ids = registry().sources.map((s) => s.source_id);
  assert.equal(ids.length, 140);
  assert.equal(new Set(ids).size, 140);
  assert.ok(ids.includes("erie-county"));
  assert.ok(ids.includes("nyc-department-of-city-planning--services5-arcgis-com"));
  assert.deepEqual(loadBundled().sources.map((s) => s.source_id), ids);
});

test("places resolve counties, cities, boroughs, NYC and regions", () => {
  assert.equal(resolvePlace("Erie County").kind, "county");
  assert.deepEqual(resolvePlace("Buffalo").counties, ["Erie"]);
  assert.equal(resolvePlace("City of Buffalo").kind, "city");
  assert.deepEqual(resolvePlace("Brooklyn").counties, ["Kings"]);
  assert.equal(resolvePlace("NYC").kind, "nyc");
  assert.equal(resolvePlace("Capital Region").kind, "region");
  assert.equal(resolvePlace("Albany").kind, "county"); // ambiguous name: county wins, its cities are listed inside it
  assert.equal(resolvePlace("City of Albany").kind, "city");
  assert.equal(resolvePlace("Springfield"), null);
});

test("list_sources_for_place: Erie County was checked and has no portal", () => {
  const r = listSourcesForPlace("Erie County");
  assert.equal(r.answer, "no-portal-exists");
  assert.ok(r.within.some((s) => s.source_id === "city-of-buffalo"), "Buffalo's portal is listed inside Erie County");
  assert.ok(r.statewide.some((s) => s.source_id === "nys-office-of-information-technology-services-gis-program-of--data-gis-ny-gov"));
});

test("list_sources_for_place distinguishes not-in-registry from no-portal", () => {
  const full = registry();
  try {
    setRegistry({ ...full, sources: full.sources.filter((s) => s.source_id !== "erie-county") });
    const r = listSourcesForPlace("Erie County");
    assert.equal(r.answer, "not-in-registry");
    assert.match(r.message, /NOT that no portal exists/);
  } finally {
    setRegistry(full);
  }
  assert.equal(listSourcesForPlace("Springfield").answer, "unknown-place");
  assert.equal(listSourcesForPlace("Buffalo").answer, "portal-exists");
  assert.equal(listSourcesForPlace("City of Albany").answer, "portal-dead");
});

test("find_sources defaults to live rows and never returns a dead one", () => {
  for (const q of ["albany", "nypl", "long island", "socrata"]) {
    for (const r of findSources({ query: q }).results) assert.equal(r.status, "live", `${q} → ${r.source_id}`);
  }
  assert.ok(findSources({ query: "albany", status: "any" }).results.some((r) => r.status === "dead"));
  assert.equal(findSources({ query: "health" }).results[0].source_id, "nys-department-of-health");
});

test("how_to_query hands Socrata rows to the socrata MCP with the API domain, not the portal domain", () => {
  const n = howToQuery({ entity: "Nassau County" });
  assert.equal(n.use.mcp, "socrata");
  assert.equal(n.use.domain, "opennassau.nassaucountyny.gov");
  assert.equal(howToQuery({ source_id: "nys-department-of-health" }).use.domain, "health.data.ny.gov");
});

test("how_to_query points to the matching @betanyc MCP and its env var", () => {
  const r = howToQuery({ entity: "NYC311" });
  assert.equal(r.use.mcp, "nyc-311-mcp");
  assert.equal(r.key_env_var, "NYC_311_API_KEY");
  assert.ok(r.warnings.some((w) => w.startsWith("UNCONFIRMED")));
  assert.equal(howToQuery({ entity: "New York State Senate" }).use.mcp, "nys-openlegislation-mcp");
});

test("how_to_query flags UNCONFIRMED, undocumented, gated and dead rows and never invents an endpoint", () => {
  const pa = howToQuery({ entity: "Port Authority of New York and New Jersey" });
  assert.ok(pa.warnings.some((w) => w.startsWith("UNCONFIRMED")));
  assert.ok(pa.warnings.some((w) => w.startsWith("UNDOCUMENTED")));
  const anhd = howToQuery({ entity: "Association for Neighborhood and Housing Development (ANHD)" });
  assert.equal(anhd.endpoint, null);
  assert.ok(anhd.warnings.some((w) => w.startsWith("GATED")));
  const albany = howToQuery({ entity: "City of Albany" });
  assert.ok(albany.warnings.some((w) => w.startsWith("DEAD")));
  assert.equal(albany.use, null);
  const erie = howToQuery({ entity: "Erie County" });
  assert.equal(erie.endpoint, null);
  for (const s of registry().sources) {
    const r = howToQuery({ source_id: s.source_id });
    if (r.endpoint) assert.equal(r.endpoint, s.api_endpoint, `${s.source_id}: endpoint must be verbatim`);
  }
});

test("check_source refuses keyed, gated and bot-blocking sources, and is offline in tests", async () => {
  assert.match((await checkSource({ source_id: "new-york-state-senate" })).reason, /key required/);
  assert.match((await checkSource({ source_id: "rockland-county" })).reason, /Blocks automated/);
  assert.match((await checkSource({ source_id: "association-for-neighborhood-and-housing-development-anhd" })).reason, /Account-gated/);
  const r = await checkSource({ source_id: "nys-department-of-health" });
  assert.equal(r.checked, false);
  assert.match(r.reason, /offline/);
});

test("registry_info reports counts and nothing unmapped", () => {
  const i = registryInfo(null);
  assert.equal(i.rows, 140);
  assert.deepEqual(i.by_status, { live: 89, "no-portal": 36, UNCONFIRMED: 11, dead: 4 });
  assert.deepEqual(i.unmapped_platform_strings, []);
  assert.equal(i.origin, "bundled");
});

test("an upstream platform_family in the registry is preferred to the local table", async () => {
  const { buildSources } = await import("../dist/registry.js");
  const row = { ...bundled.rows.find((r) => r.entity === "Erie County"), platform_family: "arcgis-server" };
  const [s] = buildSources({ generated: "2026-11-06", source: "test", fields: 19, rows: [row] });
  assert.equal(s.platform_family, "arcgis-server");
  const [t] = buildSources({ generated: "2026-11-06", source: "test", fields: 19, rows: [{ ...row, platform_family: "not-a-family" }] });
  assert.equal(t.platform_family, "none", "an invalid upstream value is ignored, the local table answers");
});
