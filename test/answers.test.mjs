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

test("registry answers cite the registry's date; dataset rows their portal's catalog; a dataset its own page", async () => {
  const reg = (await call("find_sources", { query: "health" })).data_source;
  assert.equal(reg.source, "NY Data Portal Registry");
  assert.equal(reg.as_of_kind, "snapshot");
  // whats_new lists rows from several portals: one source per portal catalog, as of that portal's
  // last good read in the index (the same date about_data gives for that catalog).
  const wn = await call("whats_new", { since: "2000-01-01" });
  assert.ok(wn.data_sources.length > 1, "rows from several portals name each portal's catalog");
  assert.deepEqual(wn.data_source, wn.data_sources[0]);
  const portals = new Set(wn.index_change_detail.map((r) => r.dataset_id.split(":")[0]));
  assert.equal(wn.data_sources.length, portals.size);
  for (const s of wn.data_sources) assert.match(s.about_data_topic, /^catalog-/);
  const ds = await call("get_dataset_columns", { dataset: WIDE });
  assert.equal(ds.data_source.source_url, ds.url, "the dataset's own page is the official record");
  assert.equal(ds.data_source.source, "Cortland County GIS Portal");
  assert.equal(ds.data_source.about_data_topic, "catalog-cortland-county");
  assert.equal(ds.data_source.as_of, ds.last_seen);
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

// Review of 0.4.0 (2026-11-19): a dataset row is a portal's own catalog record that BetaNYC's
// harvest changed (left records out, reshaped, joined to the registry, and for most portals
// cleaned), so every answer made of dataset rows says "BetaNYC modified this data" and names that
// portal's catalog, as about_data does. "Produced" is only for BetaNYC's own lists.
test("dataset rows say BetaNYC modified this data and name their portal's catalog, never 'NY Data Registry index'", async () => {
  for (const [name, args] of [["search_datasets", { query: "zoning" }], ["find_joinable", { dataset: "test-0001" }], ["whats_new", { since: "2000-01-01" }], ["get_dataset_columns", { dataset: WIDE }], ["get_dataset_columns", { dataset: WIDE, standard: "dcat-us" }]]) {
    const b = await call(name, args);
    const s = b.data_source;
    assert.match(s.about_data_topic, /^catalog-/, name);
    assert.equal(s.changed_by_betanyc.kind, "modified-by-betanyc", name);
    assert.match(s.cite, /^BetaNYC modified this data: .*This copy should not be considered the official record\. .*Official record: /, name);
    assert.notEqual(s.source, "NY Data Registry index", name);
  }
  // BetaNYC's own work in an answer is named apart, as produced: the join-key list, the topic
  // rules, the standard mapping, and the coverage list when no row matched.
  assert.ok((await call("find_joinable", { dataset: "test-0001" })).data_sources.some((s) => s.about_data_topic === "join-keys" && s.changed_by_betanyc.kind === "produced-by-betanyc"));
  assert.equal((await call("list_topics", {})).data_source.about_data_topic, "topics");
  assert.ok((await call("get_dataset_columns", { dataset: WIDE, standard: "dcat-us" })).data_sources.some((s) => s.about_data_topic === "standard-descriptions"));
  const none = await call("search_datasets", { query: "zzqqxxnomatch" });
  assert.equal(none.results.length, 0);
  assert.equal(none.data_source.about_data_topic, "coverage");
  // Socrata portals are not cleaned; ArcGIS portals strip HTML, so their label says "cleaned it".
  assert.match((await call("get_dataset_columns", { dataset: "test-0001" })).data_source.cite, /^BetaNYC modified this data: left some records out, reshaped it, and joined it with other data\./);
  assert.match((await call("get_dataset_columns", { dataset: WIDE })).data_source.cite, /^BetaNYC modified this data: cleaned it, left some records out, reshaped it, and joined it with other data\./);
});

// Every source a tool answer names (data_source, each of data_sources, registry_source) is a
// source about_data gives for that tool, with the same name and publisher and the same answer on
// whether it is official, in the same words: the cite starts with about_data's own first
// sentences for that source ("BetaNYC modified this data: <what BetaNYC did>. This copy should
// not be considered the official record." or "BetaNYC produced this. It is not an official
// record.") and names the source the same way after "Official record:" or "Built from:".
// The live check found search_datasets saying "BetaNYC produced this" under a name about_data
// did not give for that tool; problemsWith() reports exactly that (checked below).
const { officialKind, officialWording, builtFrom } = await import("../dist/betanyc-tools.js");
async function aboutDataSource(topic) {
  const r = await callTool("about_data", { topic });
  if (r.isError) return null;
  return r.structuredContent.sources.length === 1 && r.structuredContent.sources[0].topic === topic ? r.structuredContent.sources[0] : null;
}
async function toolTopics(tool) {
  const r = await callTool("about_data", { topic: tool });
  if (r.isError) return new Set();
  return new Set([...r.structuredContent.sources, ...(r.structuredContent.portal_catalogs ?? [])].map((s) => s.topic));
}
async function problemsWith(tool, s) {
  const where = `${tool}: ${s.source}`;
  if (!s.about_data_topic) return [`${where}: no about_data_topic`];
  const ad = await aboutDataSource(s.about_data_topic);
  if (!ad) return [`${where}: about_data has no source ${s.about_data_topic}`];
  const out = [];
  if (!(await toolTopics(tool)).has(ad.topic)) out.push(`${where}: about_data for ${tool} does not list ${ad.topic}`);
  if (ad.source !== s.source) out.push(`${where}: about_data names it ${ad.source}`);
  if (ad.publisher !== s.publisher) out.push(`${where}: about_data's publisher is ${ad.publisher}`);
  const kind = officialKind(ad.official, ad.changed_by_betanyc.changed, ad.changed_by_betanyc.steps);
  if ((s.changed_by_betanyc?.kind ?? "published-as-is") !== kind) out.push(`${where}: answer says ${s.changed_by_betanyc?.kind ?? "published-as-is"}, about_data says ${kind}`);
  const wording = officialWording({ official: ad.official, changed: ad.changed_by_betanyc.changed, steps: ad.changed_by_betanyc.steps, publisher: ad.publisher, sourceName: ad.source, sourceUrl: ad.source_url });
  const [label, tag] = wording.split(/ (Official record|Built from|Source): /);
  if (!s.cite.startsWith(label)) out.push(`${where}: cite does not start with about_data's words: ${label}`);
  if (!s.cite.includes(`${tag}: ${builtFrom(ad.source, ad.publisher)}, `)) out.push(`${where}: cite does not name the source as about_data does (${tag}: ${builtFrom(ad.source, ad.publisher)})`);
  return out;
}
const named = (b) => [...(b.data_sources ?? [b.data_source]), b.registry_source].filter(Boolean);

test("every source a tool answer names is in about_data for that tool, with the same name, publisher and label", async () => {
  const domain = TOOLS.map((t) => t.name).filter((n) => !["whats_changed", "about_betanyc", "about_data"].includes(n));
  const seen = new Set();
  const problems = [];
  const walk = async (name, b) => {
    for (const s of named(b)) {
      seen.add(name);
      problems.push(...(await problemsWith(name, s)));
    }
  };
  for (const [name, args] of [...CALLS, ["search_datasets", { query: "zzqqxxnomatch" }], ["whats_new", { since: "2000-01-01", portal: "nassau-county" }]]) await walk(name, await call(name, args));
  // check_source that reached the portal (the request is faked).
  const realFetch = globalThis.fetch;
  const saved = process.env.NY_DATA_OFFLINE;
  process.env.NY_DATA_OFFLINE = "0";
  globalThis.fetch = async () => new Response("<html></html>", { status: 200 });
  resetHttpState();
  try {
    await walk("check_source", await call("check_source", { source_id: "nys-department-of-health" }));
  } finally {
    globalThis.fetch = realFetch;
    process.env.NY_DATA_OFFLINE = saved;
    resetHttpState();
  }
  assert.deepEqual(problems, []);
  assert.deepEqual(domain.filter((n) => !seen.has(n)), [], "every registry and index tool is checked");
});

test("the agreement check fails on the answer the live check found, and on a wrong name or label", async () => {
  const b = await call("search_datasets", { query: "zoning" });
  const good = b.data_source;
  assert.deepEqual(await problemsWith("search_datasets", good), []);
  // What 0.4.0 said before this fix: "BetaNYC produced this", source "NY Data Registry index".
  const old = { ...good, source: "NY Data Registry index", publisher: "BetaNYC", about_data_topic: undefined, changed_by_betanyc: { kind: "produced-by-betanyc", detail: "built this index" }, cite: "BetaNYC produced this. It is not an official record. What BetaNYC did: built this index. Built from: NY Data Registry index, https://github.com/BetaNYC/ny-data-registry-mcp/releases" };
  assert.notDeepEqual(await problemsWith("search_datasets", old), []);
  assert.notDeepEqual(await problemsWith("search_datasets", { ...good, source: "Cortland County catalog" }), [], "a name about_data does not give");
  assert.notDeepEqual(await problemsWith("search_datasets", { ...good, changed_by_betanyc: { kind: "produced-by-betanyc", detail: "x" } }), [], "the other label");
  assert.notDeepEqual(await problemsWith("search_datasets", { ...good, cite: good.cite.replace("cleaned it, ", "") }), [], "different words for what BetaNYC did");
  assert.notDeepEqual(await problemsWith("find_sources", good), [], "a source about_data does not give for that tool");
});

test("registry answers say BetaNYC produced the registry; check_source keeps the live check apart from it", async () => {
  for (const [name, args] of [["find_sources", { query: "health" }], ["list_sources_for_place", { place: "Erie County" }], ["how_to_query", { entity: "Nassau County" }], ["registry_info", {}], ["check_source", { source_id: "nys-department-of-health" }]]) {
    const s = (await call(name, args)).data_source;
    assert.equal(s.source, "NY Data Portal Registry", name);
    assert.equal(s.changed_by_betanyc.kind, "produced-by-betanyc", name);
    assert.match(s.cite, /^BetaNYC produced this\. It is not an official record\. What BetaNYC did: BetaNYC opens each portal and records what it finds/, name);
  }
  // A check that reached the portal: data_source is BetaNYC's record of the portal's reply,
  // fetched now (portal-check, produced); registry_source is the registry row it was compared with.
  const realFetch = globalThis.fetch;
  const saved = process.env.NY_DATA_OFFLINE;
  process.env.NY_DATA_OFFLINE = "0";
  globalThis.fetch = async () => new Response("<html></html>", { status: 200 });
  resetHttpState();
  try {
    const b = await call("check_source", { source_id: "nys-department-of-health" });
    assert.equal(b.checked, true);
    assert.equal(b.data_source.as_of_kind, "retrieved");
    assert.equal(b.data_source.about_data_topic, "portal-check");
    assert.equal(b.data_source.changed_by_betanyc.kind, "produced-by-betanyc");
    assert.match(b.data_source.cite, /^BetaNYC produced this\. It is not an official record\. .*Fetched from the source for this answer.*Built from: NY Data Registry portal check, https:/);
    assert.equal(b.registry_source.source, "NY Data Portal Registry");
    assert.equal(b.registry_source.changed_by_betanyc.kind, "produced-by-betanyc");
    assert.notEqual(b.registry_source.cite, b.data_source.cite);
  } finally {
    globalThis.fetch = realFetch;
    process.env.NY_DATA_OFFLINE = saved;
    resetHttpState();
  }
});
