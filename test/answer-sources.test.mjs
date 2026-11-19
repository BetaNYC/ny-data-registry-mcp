// Review of 0.4.0, round 2 (2026-11-19). Anything an index answer shows from a portal's catalog
// (a title, a count of that portal's records, a group named for it, a total that counts it) is
// covered by that portal's catalog source, which says "BetaNYC modified this data". A portal
// DATA-SOURCES.json has no entry for (the index is rebuilt nightly; DATA-SOURCES.json changes
// only with a release) still gets "modified", naming the portal, its publisher and its link, and
// pointing to the generic portal-catalogs entry in about_data. No network: a fixture index.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { tempIndexPath, buildFixtureIndex, UNKNOWN_PORTAL } from "./helpers.mjs";

const index = await buildFixtureIndex(tempIndexPath(), { unknownPortal: true });
process.env.NY_DATA_INDEX = index;
const { callTool } = await import("../dist/tools.js");
const sql = new DatabaseSync(index, { readOnly: true });
const ids = (q, ...p) => new Set(sql.prepare(q).all(...p).map((r) => r.portal_id));

const call = async (name, args) => {
  const r = await callTool(name, args);
  assert.notEqual(r.isError, true, `${name}: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};
/** Every source an answer names, each with what it says about being official. */
const sources = (b) => [
  ...[b.data_source, b.registry_source].filter(Boolean).map((s) => ({ ...s, says: s.cite })),
  ...(b.data_sources ?? []).flatMap((g) => g.sources.map((s) => ({ ...s, says: g.says }))),
];
const MODIFIED = /^BetaNYC modified this data: /;
/** The portals an answer covers with "BetaNYC modified this data". */
const covered = (b) => new Set(sources(b).filter((s) => MODIFIED.test(s.says) && s.portal_id).map((s) => s.portal_id));
const missing = (want, b) => [...want].filter((p) => !covered(b).has(p));
/** Portals named with any other answer: never allowed for a portal's catalog. */
const producedPortals = (b) => sources(b).filter((s) => s.portal_id && !MODIFIED.test(s.says)).map((s) => s.portal_id);

// Portals with a dataset on topic "environment": three, one of them unknown to DATA-SOURCES.json.
const ENV = ids("SELECT DISTINCT ds.portal_id FROM dataset_topics dt JOIN datasets ds ON ds.id = dt.dataset_id WHERE dt.topic_id = 'environment' AND ds.removed_at IS NULL");
const ALL = ids("SELECT DISTINCT portal_id FROM datasets WHERE removed_at IS NULL");

test("search: every portal with a match is covered, whatever the answer shows (rows, groups, totals)", async () => {
  assert.equal(ENV.size, 3);
  // Rows for one portal only; total_matches and the export count all three.
  for (const args of [
    { topic: "environment", limit: 1 },
    { topic: "environment", limit: 50 },
    { topic: "environment", group_by: "portal" },
    { topic: "environment", group_by: "county" },
    { topic: "environment", group_by: "entity" },
    { topic: "environment", group_by: "platform_family" },
    { topic: "environment", group_by: "portal", top_per_group: 1 },
    // One title per platform: a portal whose datasets are only in a group's count.
    { topic: "environment", group_by: "platform_family", top_per_group: 1 },
  ]) {
    const b = await call("search_datasets", args);
    assert.equal(b.total_matches, 4, JSON.stringify(args));
    assert.deepEqual(missing(ENV, b), [], JSON.stringify(args));
    assert.deepEqual(producedPortals(b), [], JSON.stringify(args));
    // The coverage list the answer carries is BetaNYC's, named apart; never the only source here.
    assert.ok(sources(b).some((s) => s.about_data_topic === "coverage" && /^BetaNYC produced this\./.test(s.says)), JSON.stringify(args));
    assert.notEqual(b.data_source.about_data_topic, "coverage", JSON.stringify(args));
  }
  const counted = await call("search_datasets", { topic: "environment", group_by: "platform_family", top_per_group: 1 });
  const shown = new Set(counted.groups.flatMap((g) => g.top.map((t) => t.dataset_id.split(":")[0])));
  assert.ok([...ENV].some((p) => !shown.has(p)), "a portal shown only in a count, not by a title");
  // With no match, the coverage list alone.
  const none = await call("search_datasets", { query: "zzqqxxnomatch" });
  assert.equal(none.data_source.about_data_topic, "coverage");
  assert.equal(none.data_sources, undefined);
});

test("whats_new, list_topics, registry_info and find_joinable cover every portal they count or list", async () => {
  const changed = ids("SELECT DISTINCT portal_id FROM changes");
  const wn = await call("whats_new", { since: "2000-01-01", limit: 1 });
  assert.ok(wn.index_change_detail.length === 1 && changed.size > 1, "one row shown, more portals counted");
  assert.deepEqual(missing(changed, wn), []);
  for (const b of [await call("list_topics", {}), await call("registry_info", {})]) {
    assert.deepEqual(missing(ALL, b), []);
    assert.deepEqual(producedPortals(b), []);
  }
  assert.deepEqual(missing(ids("SELECT DISTINCT portal_id FROM datasets WHERE id IN (SELECT dataset_id FROM dataset_topics WHERE topic_id = 'environment') AND portal_id = 'putnam-county'"), await call("list_topics", { portal: "putnam-county" })), []);
  const fj = await call("find_joinable", { dataset: "test-0001" });
  const listed = new Set([fj.dataset.portal_id, ...fj.keys.flatMap((k) => [...k.by_portal.map((p) => p.portal_id), ...k.top.map((t) => t.dataset_id.split(":")[0])])]);
  assert.ok(listed.has(UNKNOWN_PORTAL.id) && listed.size > 1);
  assert.deepEqual(missing(listed, fj), []);
});

test("a portal with no DATA-SOURCES.json entry: every dataset tool says BetaNYC modified it and names it", async () => {
  const ad = await callTool("about_data", { topic: "portal-catalogs" });
  assert.notEqual(ad.isError, true);
  assert.match(ad.content[0].text, /BetaNYC modified this data: cleaned it, left some records out, reshaped it, and joined it with other data\./);
  const calls = [
    ["get_dataset_columns", { dataset: `${UNKNOWN_PORTAL.id}:old-0001` }],
    ["get_dataset_columns", { dataset: `${UNKNOWN_PORTAL.id}:old-0001`, standard: "dcat-us" }],
    ["get_dataset_columns", { dataset: `${UNKNOWN_PORTAL.id}:old-0001`, standard: "croissant" }],
    ["find_joinable", { dataset: `${UNKNOWN_PORTAL.id}:old-0001` }],
    ["find_joinable", { dataset: "test-0001" }],
    ["search_datasets", { query: "wetland" }],
    ["search_datasets", { query: "wetland", group_by: "portal" }],
    ["search_datasets", { query: "wetland", portal: UNKNOWN_PORTAL.id }],
    ["search_datasets", { topic: "environment", limit: 1 }],
    ["whats_new", { since: "2000-01-01", portal: UNKNOWN_PORTAL.id }],
    ["whats_new", { since: "2000-01-01", limit: 1 }],
    ["list_topics", { portal: UNKNOWN_PORTAL.id }],
    ["list_topics", {}],
    ["registry_info", {}],
  ];
  for (const [name, args] of calls) {
    const where = `${name} ${JSON.stringify(args)}`;
    const b = await call(name, args);
    const mine = sources(b).filter((s) => s.portal_id === UNKNOWN_PORTAL.id);
    assert.ok(mine.length, `${where}: no source for the portal`);
    for (const s of mine) {
      assert.match(s.says, MODIFIED, where);
      assert.equal(s.about_data_topic, "portal-catalogs", where);
      assert.equal(s.source, UNKNOWN_PORTAL.name, where);
      assert.equal(s.publisher, UNKNOWN_PORTAL.publisher, where);
      assert.ok(s.source_url.startsWith(UNKNOWN_PORTAL.url), `${where}: ${s.source_url}`);
      assert.match(s.about_data_note, /about_data has no entry of its own for Old Agency Open Data yet\. about_data topic portal-catalogs says what BetaNYC does to every portal's catalog\./, where);
    }
    assert.deepEqual(producedPortals(b), [], where);
    // Every dataset row in the answer ("<portal>:<native id>") has a "modified" source for its
    // portal. (query_with.dataset_id is the portal's own id, with no portal part.)
    const rowPortals = new Set(JSON.stringify(b).match(/"dataset_id": ?"[^":]+:[^"]+"/g)?.map((m) => m.split('"')[3].split(":")[0]) ?? []);
    assert.deepEqual(missing(rowPortals, b), [], where);
  }
  // One dataset: the full block, with the dataset's own page as the official record.
  const one = (await call("get_dataset_columns", { dataset: `${UNKNOWN_PORTAL.id}:old-0001` })).data_source;
  assert.equal(one.portal_id, UNKNOWN_PORTAL.id);
  assert.match(one.cite, /^BetaNYC modified this data: .*Official record: Old Agency Open Data \(NYS Old Agency\), https:\/\/data\.old-agency\.ny\.gov\//);
});
