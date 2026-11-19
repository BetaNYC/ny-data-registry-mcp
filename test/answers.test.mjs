// Every data answer names its source, a link and how current it is (#36, #37), and every list
// is bounded and says how to get the rest (#38).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { tempIndexPath, buildFixtureIndex } from "./helpers.mjs";
import { resetHttpState } from "../dist/http.js";

const index = await buildFixtureIndex(tempIndexPath());
// A wide dataset: 300 extra columns on the Cortland zoning layer, more than the default page.
const WIDE = "dea35a11cfbf4adeb083df6d63cf1f88";
{
  const d = new DatabaseSync(index);
  const { id, portal_id } = d.prepare("SELECT id, portal_id FROM datasets WHERE native_id = ? OR id LIKE ?").get(WIDE, `%${WIDE}%`);
  const ins = d.prepare("INSERT INTO dataset_columns (dataset_id, portal_id, name, field, type) VALUES (?, ?, ?, ?, 'esriFieldTypeString')");
  for (let i = 0; i < 300; i++) ins.run(id, portal_id, `Extra ${i}`, `extra_${i}`);
  d.close();
}
process.env.NY_DATA_INDEX = index;
const { callTool, TOOLS } = await import("../dist/tools.js");

const CALLS = [
  ["find_sources", { query: "health" }],
  ["list_sources_for_place", { place: "Erie County" }],
  ["how_to_query", { entity: "Nassau County" }],
  ["check_source", { source_id: "nys-department-of-health" }],
  ["registry_info", {}],
  ["search_datasets", { query: "zoning" }],
  ["list_topics", {}],
  ["get_dataset_columns", { dataset: WIDE }],
  ["get_dataset_columns", { dataset: WIDE, standard: "dcat-us" }],
  ["find_joinable", { dataset: "test-0001" }],
  ["whats_new", { since: "2000-01-01" }],
];
const call = async (name, args) => {
  const r = await callTool(name, args);
  assert.notEqual(r.isError, true, `${name}: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};

test("every domain tool's answer carries data_source: source, publisher, link and as-of", async () => {
  const domain = new Set(TOOLS.map((t) => t.name).filter((n) => !["whats_changed", "about_betanyc", "about_data"].includes(n)));
  for (const [name, args] of CALLS) {
    domain.delete(name);
    const s = (await call(name, args)).data_source;
    assert.ok(s, `${name} has no data_source`);
    assert.ok(s.source && s.publisher, name);
    assert.match(s.source_url, /^https:\/\//, name);
    assert.notEqual(s.as_of_kind, "unknown", `${name}: no usable as-of`);
    assert.ok(s.as_of, name);
    // Data passed on as published: "Source: … Link: …". Data BetaNYC built or changed says so
    // first, as about_data does (shared module 1.5.2, changedByBetanyc).
    assert.match(s.cite, /^(Source: .* As of .* Link: |BetaNYC modified this data: .* As of .* Official record: .*|BetaNYC produced this\. It is not an official record\. .* As of .* Built from: .*)https:\/\//, name);
  }
  assert.deepEqual([...domain], [], "every domain tool is checked");
});

test("registry answers cite the registry's date; index answers the index's last harvest; a dataset its own page", async () => {
  const reg = (await call("find_sources", { query: "health" })).data_source;
  assert.equal(reg.source, "NY Data Portal Registry");
  assert.equal(reg.as_of_kind, "snapshot");
  const idx = (await call("whats_new", { since: "2000-01-01" })).data_source;
  assert.equal(idx.source, "NY Data Registry index");
  assert.equal(idx.as_of, "2026-11-05T00:00:00Z");
  const ds = await call("get_dataset_columns", { dataset: WIDE });
  assert.equal(ds.data_source.source_url, ds.url);
  assert.equal(ds.data_source.publisher, ds.entity);
});

test("check_source that reached the portal cites the portal, fetched for this answer", async () => {
  const realFetch = globalThis.fetch;
  const saved = process.env.NY_DATA_OFFLINE;
  process.env.NY_DATA_OFFLINE = "0";
  globalThis.fetch = async () => new Response("<html></html>", { status: 200 });
  resetHttpState();
  try {
    const b = await call("check_source", { source_id: "nys-department-of-health" });
    assert.equal(b.checked, true);
    // Shared module 1.5.1: a live answer's as_of is its fetch time unless the data gives its own
    // date; a status check has none, so it is "retrieved", as of the fetch.
    assert.equal(b.data_source.as_of_kind, "retrieved");
    assert.equal(b.data_source.as_of, b.data_source.retrieved_at);
    assert.ok(Math.abs(Date.parse(b.data_source.as_of) - Date.parse(b.checked_at)) < 5000);
    assert.match(b.data_source.cite, /Fetched from the source for this answer at .* \(New York time\)/);
    assert.equal(b.data_source.source_url, b.url);
  } finally {
    globalThis.fetch = realFetch;
    process.env.NY_DATA_OFFLINE = saved;
    resetHttpState();
  }
});

test("list_sources_for_place: 25 per list by default, counts and a showing note; limit lists more", async () => {
  const big = await call("list_sources_for_place", { place: "Long Island" });
  assert.ok(big.counts.own > 25, `Long Island has ${big.counts.own} own rows`);
  assert.equal(big.own.length, 25);
  assert.ok(big.statewide.length <= 25);
  assert.match(big.showing, new RegExp(`own 25 of ${big.counts.own}`));
  assert.match(big.showing, /limit \(up to 100\)/);
  const all = await call("list_sources_for_place", { place: "Long Island", limit: 100 });
  assert.equal(all.own.length, all.counts.own);
  const small = await call("list_sources_for_place", { place: "Erie County", include_statewide: false });
  assert.equal(small.showing, "Every list is complete.");
  assert.equal((await callTool("list_sources_for_place", { place: "Long Island", limit: 101 })).isError, true);
});

test("get_dataset_columns: 100 columns by default, then offset pages through the rest", async () => {
  const first = await call("get_dataset_columns", { dataset: WIDE });
  const total = first.columns_shown.total;
  assert.ok(total > 300);
  assert.equal(first.columns.length, 100);
  assert.equal(first.columns_shown.next_offset, 100);
  assert.match(first.columns_shown.note, new RegExp(`1 to 100 of ${total}.*offset 100`));
  const last = await call("get_dataset_columns", { dataset: WIDE, offset: 300, limit: 500 });
  assert.equal(last.columns.length, total - 300);
  assert.equal(last.columns_shown.next_offset, null);
  assert.equal((await callTool("get_dataset_columns", { dataset: WIDE, limit: 501 })).isError, true);
});

test("find_sources, find_joinable and whats_new say when a list was cut and how to get more", async () => {
  const fs = await call("find_sources", { query: "county", status: "any", limit: 1 });
  assert.ok(fs.total_matches > 1);
  assert.match(fs.showing, new RegExp(`Showing 1 of ${fs.total_matches}\\. Narrow`));
  const fj = await call("find_joinable", { dataset: "test-0001", limit_per_key: 1 });
  for (const k of fj.keys) assert.match(k.showing, k.datasets_sharing_key > k.top.length ? /Showing \d+ of \d+\. Raise limit_per_key/ : /Showing all/);
  const wn = await call("whats_new", { since: "2000-01-01", limit: 1 });
  assert.equal(wn.data_updated_per_portal.length, 1);
  assert.ok(wn.data_updated_total > 1);
  assert.match(wn.showing, /index_change_detail 1 of \d+, data_updated_per_portal 1 of \d+\. Raise limit/);
});

// F8 (review round 2): answers agree with about_data. The index is BetaNYC's own product; one
// dataset's record is BetaNYC's modified copy, with the portal page as the official record.
test("index answers say BetaNYC built the index; a dataset's record says BetaNYC modified it", async () => {
  for (const [name, args] of [["search_datasets", { query: "zoning" }], ["list_topics", {}], ["find_joinable", { dataset: "test-0001" }], ["whats_new", { since: "2000-01-01" }], ["get_dataset_columns", { dataset: WIDE, standard: "dcat-us" }]]) {
    const s = (await call(name, args)).data_source;
    assert.equal(s.source, "NY Data Registry index", name);
    assert.equal(s.publisher, "BetaNYC", name);
    assert.equal(s.changed_by_betanyc?.kind, "produced-by-betanyc", name);
    assert.match(s.cite, /^BetaNYC produced this\. It is not an official record\. What BetaNYC did: built this index/, name);
  }
  const ds = await call("get_dataset_columns", { dataset: WIDE });
  const s = ds.data_source;
  assert.equal(s.changed_by_betanyc.kind, "modified-by-betanyc");
  assert.match(s.changed_by_betanyc.detail, /NY Data Registry index's copy of the portal's catalog record/);
  assert.match(s.cite, /^BetaNYC modified this data: .*This copy should not be considered the official record\. .*Official record: .*catalog/);
  assert.equal(s.source_url, ds.url, "the portal's own page is the official record");
  assert.equal(s.publisher, ds.entity);
  assert.deepEqual(s.held_in, { source: "NY Data Registry index", publisher: "BetaNYC", source_url: "https://github.com/BetaNYC/ny-data-registry-mcp/releases" });
  // about_data says the same for the portal catalogs this record comes from.
  const { betanycTools } = await import("../dist/tools.js");
  const ad = betanycTools().call("about_data", { topic: "get_dataset_columns" }).content[0].text;
  assert.match(ad, /BetaNYC modified this data: .*This copy should not be considered the official record/);
});

// Post-merge (epic #33): every tool's answer says what about_data says for that tool. Where
// about_data gives a source BetaNYC modified or produced, the answer says BetaNYC modified or
// produced it, with a kind about_data also gives.
test("each tool's answer agrees with about_data on whether BetaNYC modified or produced its data", async () => {
  const { betanycTools } = await import("../dist/tools.js");
  const { officialKind } = await import("../dist/betanyc-tools.js");
  const argsFor = Object.fromEntries(CALLS.map(([n, a]) => [n, a]));
  let walked = 0;
  for (const t of TOOLS) {
    const ad = betanycTools().call("about_data", { topic: t.name });
    if (ad.isError) {
      assert.ok(["whats_changed", "about_betanyc", "about_data"].includes(t.name), `${t.name}: ${ad.content[0].text}`);
      continue; // the three shared tools describe this server, not data
    }
    const told = new Set(ad.structuredContent.sources.map((s) => officialKind(s.official, s.changed_by_betanyc?.changed ?? false, s.changed_by_betanyc?.steps ?? [])));
    const b = await call(t.name, argsFor[t.name]);
    const said = [b.data_source, b.registry_source].filter(Boolean).map((s) => s.changed_by_betanyc?.kind).filter(Boolean);
    if ([...told].some((k) => k !== "published-as-is")) assert.ok(said.length, `${t.name}: about_data says ${[...told]}, the answer says nothing`);
    for (const k of said) assert.ok(told.has(k), `${t.name} says ${k}; about_data says ${[...told]}`);
    for (const s of [b.data_source, b.registry_source].filter(Boolean)) {
      if (s.changed_by_betanyc?.kind === "produced-by-betanyc") assert.match(s.cite, /^BetaNYC produced this\. It is not an official record\./, t.name);
      if (s.changed_by_betanyc?.kind === "modified-by-betanyc") assert.match(s.cite, /^BetaNYC modified this data: /, t.name);
    }
    walked++;
  }
  assert.equal(walked, 10, "the ten registry and index tools");
});

test("registry answers say BetaNYC produced the registry; check_source keeps the live check apart from it", async () => {
  for (const [name, args] of [["find_sources", { query: "health" }], ["list_sources_for_place", { place: "Erie County" }], ["how_to_query", { entity: "Nassau County" }], ["registry_info", {}], ["check_source", { source_id: "nys-department-of-health" }]]) {
    const s = (await call(name, args)).data_source;
    assert.equal(s.source, "NY Data Portal Registry", name);
    assert.equal(s.changed_by_betanyc.kind, "produced-by-betanyc", name);
    assert.match(s.cite, /^BetaNYC produced this\. It is not an official record\. What BetaNYC did: compiled and maintains this registry of New York data portals/, name);
  }
  // A check that reached the portal: data_source is the portal, fetched now (published as is);
  // registry_source is the BetaNYC registry row it was compared with.
  const realFetch = globalThis.fetch;
  const saved = process.env.NY_DATA_OFFLINE;
  process.env.NY_DATA_OFFLINE = "0";
  globalThis.fetch = async () => new Response("<html></html>", { status: 200 });
  resetHttpState();
  try {
    const b = await call("check_source", { source_id: "nys-department-of-health" });
    assert.equal(b.checked, true);
    assert.equal(b.data_source.as_of_kind, "retrieved");
    assert.equal(b.data_source.changed_by_betanyc, undefined, "the live check is the portal's own reply");
    assert.match(b.data_source.cite, /^Source: .*Fetched from the source for this answer/);
    assert.equal(b.registry_source.source, "NY Data Portal Registry");
    assert.equal(b.registry_source.changed_by_betanyc.kind, "produced-by-betanyc");
    assert.notEqual(b.registry_source.cite, b.data_source.cite);
  } finally {
    globalThis.fetch = realFetch;
    process.env.NY_DATA_OFFLINE = saved;
    resetHttpState();
  }
});
