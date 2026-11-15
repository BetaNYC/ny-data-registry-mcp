// registry_id: the id of a row's government body in BetaNYC/ny-gov-web-registry.
// Every tool that names a data site shows it when the row has one, and shows nothing made up
// when it does not. The registry here is a controlled copy: the bundled rows with every
// registry_id replaced by the test values below, so these tests do not move when the
// published registry fills in more ids.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tempIndexPath, buildFixtureIndex } from "./helpers.mjs";

const path = tempIndexPath();
process.env.NY_DATA_INDEX = path;
await buildFixtureIndex(path);

const { registry, setRegistry, buildSources, assignSourceIds, cleanRegistryId, registryIdFor } = await import("../dist/registry.js");
const { findSources, listSourcesForPlace, howToQuery, registryInfo, sourceSummary } = await import("../dist/sources.js");
const { checkSource } = await import("../dist/check.js");
const { searchDatasets, getDatasetColumns, findJoinable, whatsNew } = await import("../dist/datasets.js");
const { TOOLS, callTool } = await import("../dist/tools.js");

const bundled = JSON.parse(readFileSync(new URL("../data/ny-data-portal-registry.json", import.meta.url), "utf8"));

// source_id -> registry_id as written in the test registry. Rows not listed get null.
const TEST_IDS = {
  "new-york-city": "test-gov-nyc",
  "nys-department-of-health": "test-gov-doh",
  "erie-county": "test-gov-erie",
  "nyc-department-of-city-planning--nyc-gov": "test-gov-shared",
  "nyc-department-of-city-planning--services5-arcgis-com": "test-gov-shared",
  "putnam-county": "", // empty string: no id
  "cortland-county": "—", // the registry's placeholder: no id
};
const WITH_ID = Object.values(TEST_IDS).filter((v) => cleanRegistryId(v)).length;

const original = registry();
const sids = assignSourceIds(bundled.rows);
const rows = bundled.rows.map((r, i) => ({ ...r, registry_id: sids[i] in TEST_IDS ? TEST_IDS[sids[i]] : null }));
const controlled = { generated: bundled.generated, origin: "bundled", fetched_at: null, refresh_error: null, sources: buildSources({ ...bundled, rows }) };
setRegistry(controlled);
after(() => setRegistry(original));

const body = (r) => JSON.parse(r.content[0].text);
const nycDatasets = () => searchDatasets({ query: "synthetic", export: "never" });

test("registry_id is copied as is; empty strings and the '—' placeholder become null, never a made-up id", () => {
  assert.equal(cleanRegistryId("oti"), "oti");
  assert.equal(cleanRegistryId("  oti "), "oti");
  for (const v of ["", "   ", "—", null, undefined, 7]) assert.equal(cleanRegistryId(v), null, JSON.stringify(v));
  const byId = Object.fromEntries(registry().sources.map((s) => [s.source_id, s.registry_id]));
  assert.equal(byId["new-york-city"], "test-gov-nyc");
  assert.equal(byId["putnam-county"], null);
  assert.equal(byId["cortland-county"], null);
  assert.equal(byId["erie-county"], "test-gov-erie");
  assert.equal(registry().sources.filter((s) => s.registry_id).length, WITH_ID, "only the rows given an id carry one");
  // A row from a registry that predates the field gets null, not an error.
  const { registry_id, ...noField } = bundled.rows[0];
  void registry_id;
  assert.equal(buildSources({ ...bundled, rows: [noField] })[0].registry_id, null);
});

test("source summaries always carry registry_id: the value, or null", () => {
  const s = (id) => sourceSummary(registry().sources.find((x) => x.source_id === id));
  assert.equal(s("nys-department-of-health").registry_id, "test-gov-doh");
  assert.ok("registry_id" in s("cortland-county"));
  assert.equal(s("cortland-county").registry_id, null);
});

test("find_sources shows registry_id on each result", () => {
  const r = findSources({ query: "health" });
  const doh = r.results.find((x) => x.source_id === "nys-department-of-health");
  assert.equal(doh.registry_id, "test-gov-doh");
  const others = findSources({ query: "county", status: "any", limit: 50 }).results;
  const without = others.find((x) => x.source_id === "cortland-county");
  assert.ok(without, "cortland-county is in the results");
  assert.equal(without.registry_id, null);
  for (const x of others) assert.equal(x.registry_id, registryIdFor(x.source_id), x.source_id);
});

test("list_sources_for_place shows registry_id in own, within, regional and statewide lists", () => {
  const erie = listSourcesForPlace("Erie County");
  assert.equal(erie.own.find((x) => x.source_id === "erie-county").registry_id, "test-gov-erie");
  assert.equal(erie.within.find((x) => x.source_id === "city-of-buffalo").registry_id, null);
  for (const list of [erie.own, erie.within, erie.regional, erie.statewide]) {
    for (const x of list) assert.ok("registry_id" in x, x.source_id);
  }
  const nyc = listSourcesForPlace("NYC");
  assert.equal(nyc.own.find((x) => x.source_id === "new-york-city").registry_id, "test-gov-nyc");
});

test("how_to_query shows registry_id, finds a source by it, and lists every source that shares one", () => {
  assert.equal(howToQuery({ source_id: "new-york-city" }).source.registry_id, "test-gov-nyc");
  assert.equal(howToQuery({ source_id: "putnam-county" }).source.registry_id, null);
  assert.equal(howToQuery({ registry_id: "test-gov-doh" }).source.source_id, "nys-department-of-health");
  assert.equal(howToQuery({ registry_id: " test-gov-doh " }).source.source_id, "nys-department-of-health", "surrounding spaces are ignored");
  const shared = howToQuery({ registry_id: "test-gov-shared" });
  assert.equal(shared.ambiguous, true);
  assert.deepEqual(shared.candidates.map((c) => c.source_id).sort(), ["nyc-department-of-city-planning--nyc-gov", "nyc-department-of-city-planning--services5-arcgis-com"]);
  assert.ok(shared.candidates.every((c) => c.registry_id === "test-gov-shared"));
  const miss = howToQuery({ registry_id: "no-such-government" });
  assert.match(miss.error, new RegExp(`no row with registry_id 'no-such-government' \\(${WITH_ID} of ${registry().sources.length} rows carry one`));
});

test("check_source shows registry_id and accepts one (offline: nothing is fetched)", async () => {
  const r = await checkSource({ registry_id: "test-gov-doh" });
  assert.equal(r.source.source_id, "nys-department-of-health");
  assert.equal(r.source.registry_id, "test-gov-doh");
  assert.equal(r.checked, false);
  assert.equal((await checkSource({ source_id: "putnam-county" })).source.registry_id, null);
});

test("registry_info counts the rows that carry a registry_id", () => {
  assert.equal(registryInfo(null).with_registry_id, WITH_ID);
});

test("search_datasets compact rows carry registry_id only when the portal has one", () => {
  const nyc = nycDatasets();
  assert.ok(nyc.results.length >= 2);
  for (const x of nyc.results) assert.equal(x.registry_id, "test-gov-nyc", x.dataset_id);
  const z = searchDatasets({ query: "zoning", export: "never" }).results[0];
  assert.equal(z.portal_id, "cortland-county");
  assert.equal("registry_id" in z, false, "no key at all, not a null or a placeholder");
});

test("search_datasets full rows, groups, coverage and the CSV show registry_id", () => {
  const full = searchDatasets({ query: "zoning", detail: "full", export: "never" }).results[0];
  assert.ok("registry_id" in full);
  assert.equal(full.registry_id, null);
  assert.equal(searchDatasets({ query: "medicaid", detail: "full", export: "never" }).results[0].registry_id, "test-gov-doh");

  const g = searchDatasets({ query: "synthetic", group_by: "portal", export: "never" });
  assert.equal(g.groups.find((x) => x.key === "new-york-city").registry_id, "test-gov-nyc");
  const gz = searchDatasets({ query: "zoning", group_by: "portal", export: "never" });
  assert.equal("registry_id" in gz.groups.find((x) => x.key === "cortland-county"), false);

  const cov = searchDatasets({ query: "zoning", place: "Erie County", export: "never" }).coverage.portals_for_this_place_not_fully_indexed;
  assert.equal(cov.find((x) => x.portal_id === "erie-county").registry_id, "test-gov-erie");
  assert.equal("registry_id" in cov.find((x) => x.portal_id === "city-of-buffalo"), false);

  const e = searchDatasets({ query: "synthetic", export: "always" });
  const lines = readFileSync(e.export.path, "utf8").trim().split("\r\n");
  const header = lines[0].split(",");
  assert.deepEqual(header, e.export.columns);
  const col = header.indexOf("registry_id");
  assert.equal(col, header.indexOf("portal_id") + 1);
  for (const line of lines.slice(1)) assert.equal(line.split(",")[col], "test-gov-nyc");
  const ez = searchDatasets({ query: "zoning", export: "always" });
  const zl = readFileSync(ez.export.path, "utf8").trim().split("\r\n");
  assert.equal(zl[1].split(",")[col], "", "an empty cell, not a placeholder");
});

test("search_datasets and whats_new: portal=<registry_id> means every site of that government, and only those", () => {
  const all = searchDatasets({ query: "synthetic OR zoning OR medicaid", export: "never", limit: 50 });
  assert.ok(new Set(all.results.map((x) => x.portal_id)).size > 1, "the unfiltered search spans several portals");
  const r = searchDatasets({ query: "synthetic", portal: "test-gov-nyc", export: "never" });
  assert.ok(r.total_matches >= 2);
  assert.ok(r.results.every((x) => x.portal_id === "new-york-city"));
  assert.equal(searchDatasets({ query: "zoning", portal: "test-gov-nyc", export: "never" }).total_matches, 0);
  // A value that is not a registry_id keeps the old meaning: source_id or part of a portal name.
  assert.equal(searchDatasets({ query: "zoning", portal: "cortland-county", export: "never" }).total_matches, 1);
  const w = whatsNew("2000-01-01", "test-gov-nyc");
  assert.ok(w.index_change_detail.length > 0);
  assert.ok(w.data_updated_per_portal.every((x) => x.portal === "NYC Open Data"));
  assert.ok(w.index_change_detail.every((x) => x.portal === "NYC Open Data"));
});

test("get_dataset_columns and find_joinable show the portal's registry_id", () => {
  assert.equal(getDatasetColumns("dea35a11cfbf4adeb083df6d63cf1f88").registry_id, null);
  const j = findJoinable("test-0001");
  assert.equal(j.dataset.registry_id, "test-gov-nyc");
  const bbl = j.keys.find((k) => k.key === "BBL");
  assert.deepEqual(bbl.by_portal, [{ portal_id: "new-york-city", registry_id: "test-gov-nyc", n: 1 }]);
});

test("ids added to the registry show on dataset rows without a new harvest", () => {
  const before = nycDatasets().results[0].registry_id;
  try {
    const rows2 = rows.map((r, i) => (sids[i] === "new-york-city" ? { ...r, registry_id: "test-gov-nyc-renamed" } : r));
    setRegistry({ ...controlled, sources: buildSources({ ...bundled, rows: rows2 }) });
    assert.equal(nycDatasets().results[0].registry_id, "test-gov-nyc-renamed");
  } finally {
    setRegistry(controlled);
  }
  assert.equal(nycDatasets().results[0].registry_id, before);
});

test("through the MCP tools: registry_id in replies, and every description says what it joins to", async () => {
  assert.equal(body(await callTool("how_to_query", { registry_id: "test-gov-nyc" })).source.source_id, "new-york-city");
  assert.equal(body(await callTool("find_sources", { query: "health" })).results.find((x) => x.source_id === "nys-department-of-health").registry_id, "test-gov-doh");
  assert.equal(body(await callTool("search_datasets", { query: "synthetic", portal: "test-gov-nyc", export: "never" })).results[0].registry_id, "test-gov-nyc");
  for (const name of ["find_sources", "list_sources_for_place", "how_to_query", "check_source", "search_datasets"]) {
    assert.match(TOOLS.find((t) => t.name === name).description, /registry_id.*BetaNYC\/ny-gov-web-registry/, name);
  }
});
