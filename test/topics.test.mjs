// Topic search (issue #18): the rule files load, labels map to topics (several, by hand, or
// none), the index gets topics, search_datasets filters by topic, and the coverage figure.
// Builds a small index of clearly-marked SYNTHETIC datasets with known labels. Offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tempIndexPath, buildFixtureIndex } from "./helpers.mjs";

const path = tempIndexPath();
process.env.NY_DATA_INDEX = path;
await buildFixtureIndex(path);

const T = await import("../dist/topics.js");
const { openDb, writePortalDatasets } = await import("../dist/db.js");
const { mapSocrataAsset } = await import("../dist/harvest/socrata.js");
const { portalRecord } = await import("../dist/harvest/run.js");
const { registry } = await import("../dist/registry.js");
const { searchDatasets, listTopics, closeDb, NO_TOPICS_NOTE } = await import("../dist/datasets.js");
const { writeCrosswalk, OPTIONAL_SIDE_FILES } = await import("../dist/publish/prepare.js");
const { rollbackSideFiles, rollbackCommands } = await import("../dist/publish/rollback.js");

const rules = T.loadTopicRules();
const topicsOf = (label, type, acr) => T.classifyLabel(label, type, acr, rules);

// A separate small index with known labels, for exact counts.
const synthPath = tempIndexPath();
{
  const db = openDb(synthPath);
  const nyc = portalRecord(registry().sources.find((s) => s.source_id === "new-york-city"));
  const { upsertPortal } = await import("../dist/db.js");
  upsertPortal(db, nyc);
  const mk = (id, name, classification, attribution) =>
    mapSocrataAsset({ resource: { id, name, type: "dataset", attribution }, classification }, "data.cityofnewyork.us");
  writePortalDatasets(
    db,
    nyc,
    [
      mk("syn-hous", "SYNTHETIC shelter census", { domain_category: "Housing & Development", domain_tags: ["homeless", "shelters"] }),
      mk("syn-scho", "SYNTHETIC school districts", { domain_tags: ["school district"] }),
      mk("syn-none", "SYNTHETIC widget list", { domain_tags: ["zzqx widget"] }),
      mk("syn-dot1", "SYNTHETIC street work", {}, "Department of Transportation (DOT)"),
      mk("syn-bare", "SYNTHETIC no labels at all", {}),
    ],
    1,
    true
  );
  T.buildTopics(db);
  db.close();
}

test("the rule files load: 24 topics, unique ids, every hand-assigned topic exists", () => {
  assert.equal(rules.topics.length, 24);
  assert.equal(new Set(rules.topics.map((t) => t.id)).size, 24);
  for (const t of rules.topics) assert.ok(t.name && t.match.length, t.id);
  for (const h of rules.hand) for (const id of h.topics) assert.ok(rules.byId.has(id), `${h.label} -> ${id}`);
  for (const w of ["infrastructure", "safety", "development"]) assert.ok(rules.hand.some((h) => h.label === w), `${w} is hand-assigned`);
});

test("a hand entry naming an unknown topic, or with no reason, is refused", () => {
  const file = JSON.parse(readFileSync(new URL("../data/topics.json", import.meta.url), "utf8"));
  assert.throws(() => T.loadTopicRules(file, { labels: [{ label: "x", topics: ["nope"], why: "y" }], acronym_tags_never_inherit: [] }), /unknown topic 'nope'/);
  assert.throws(() => T.loadTopicRules(file, { labels: [{ label: "x", topics: [], why: " " }], acronym_tags_never_inherit: [] }), /needs a why/);
});

test("labels are cleaned the same way on every portal", () => {
  assert.equal(T.normalizeLabel("/Categories/People/Health", "category", rules), "health");
  assert.equal(T.normalizeLabel("Bicycles", "tag", rules), "bike");
  assert.equal(T.normalizeLabel("COVID-19", "tag", rules), "covid 19");
  assert.deepEqual(T.departmentLabel("Health, Department of", rules), { normalized: "department of health", acronym: null });
  assert.deepEqual(T.departmentLabel("Department of Buildings (DOB)", rules), { normalized: "department of buildings", acronym: "DOB" });
});

test("a label can give several topics", () => {
  assert.deepEqual(topicsOf("School Districts", "tag").topics.sort(), ["boundaries", "education"]);
  assert.deepEqual(topicsOf("Housing & Development", "category").topics.sort(), ["housing", "landuse"]);
});

test("broad and ambiguous words follow the hand-assigned list, not the rules", () => {
  const c = (l, type = "tag") => topicsOf(l, type);
  assert.deepEqual(c("Infrastructure"), { ...c("Infrastructure"), topics: ["utilities"], by: "hand" });
  assert.deepEqual(c("safety").topics, ["safety"]);
  assert.deepEqual(c("Development").topics, ["landuse"]);
  assert.equal(c("Development").by, "hand");
  // "lot" is a tax lot or a parking lot: no topic, on purpose. "tax lot" is still Property.
  assert.deepEqual(c("lot").topics, []);
  assert.equal(c("lot").by, "hand");
  assert.ok(c("tax lot").topics.includes("property"));
  // ACS: the survey as a tag; the children's agency as a department.
  assert.deepEqual(c("ACS").topics, ["demographics"]);
  assert.deepEqual(c("Administration for Children's Services (ACS)", "department").topics, ["social"]);
  // Patient safety is not public safety.
  assert.deepEqual(c("Quality, Safety & Cost", "category").topics.sort(), ["finance", "health"]);
  // "safety" inside another label no longer means Public safety by itself.
  assert.deepEqual(c("traffic safety").topics, ["transportation"]);
});

test("an agency acronym used as a tag takes the agency's topics, from the index's own department names", () => {
  const acr = T.agencyAcronyms([{ label: "Department of Buildings (DOB)", count: 3 }], rules);
  assert.equal(acr.get("dob"), "department of buildings");
  assert.deepEqual(topicsOf("DOB", "tag", acr), { normalized: "dob", acronym: null, topics: ["buildings"], by: "acronym", non_topical: null });
  // Never for the listed words, even when an agency uses them.
  const acs = T.agencyAcronyms([{ label: "Geographic Systems (GIS)", count: 3 }], rules);
  assert.equal(topicsOf("GIS", "tag", acs).by, "none");
});

test("an unknown label gets no topic; place, year and format labels are named as such", () => {
  assert.deepEqual(topicsOf("zzqx widget", "tag"), { normalized: "zzqx widget", acronym: null, topics: [], by: "none", non_topical: null });
  assert.equal(topicsOf("2024", "tag").non_topical, "year");
  assert.equal(topicsOf("Brooklyn", "tag").non_topical, "place");
  assert.equal(topicsOf("Shapefile", "tag").non_topical, "format or housekeeping");
  assert.equal(topicsOf("Suffolk County GIS", "department").non_topical, "publisher (GIS or IT office, or generic)");
});

test("coverage: datasets with at least one topic, from the synthetic index", () => {
  const db = new DatabaseSync(synthPath, { readOnly: true });
  try {
    const t = T.computeTopics(db, rules);
    assert.equal(t.datasets, 5);
    assert.equal(t.datasets_with_topic, 3, "the widget list and the unlabeled one have none");
    assert.equal(t.coverage_percent, 60);
    assert.deepEqual([...t.assignments.get("new-york-city:syn-scho")].sort(), ["boundaries", "education"]);
    assert.deepEqual([...t.assignments.get("new-york-city:syn-dot1")], ["transportation"]);
    assert.equal(t.by_topic.find((x) => x.id === "housing").datasets, 1);
    // stored in the index as well
    assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'topic_coverage'").get().value), { datasets: 5, datasets_with_topic: 3, coverage_percent: 60 });
    assert.equal(T.coveragePercent(8910, 9569), 93.1);
  } finally {
    db.close();
  }
});

test("the crosswalk CSV has one row per label per portal, with its topics or why it has none", () => {
  const dir = mkdtempSync(join(tmpdir(), "nydr-xw-"));
  const out = join(dir, T.CROSSWALK_NAME);
  const n = writeCrosswalk(synthPath, out);
  const lines = readFileSync(out, "utf8").trim().split(/\r?\n/);
  assert.equal(lines[0], T.CROSSWALK_HEADER.join(","));
  assert.equal(lines.length, n + 1);
  assert.ok(lines.some((l) => l.startsWith("new-york-city,tag,zzqx widget,zzqx widget,,,none,,1")), "unknown label listed with no topic");
  assert.ok(lines.some((l) => l.includes("school district,education; boundaries,Education; Boundaries and administrative areas,rule")));
  assert.ok(OPTIONAL_SIDE_FILES.includes(T.CROSSWALK_NAME), "published beside the index");
});

test("search_datasets filters by topic, with or without a query, and rows carry their topics", () => {
  process.env.NY_DATA_INDEX = synthPath;
  closeDb();
  try {
    const edu = searchDatasets({ topic: "education" });
    assert.equal(edu.query, null);
    assert.deepEqual(edu.topic, { id: "education", name: "Education" });
    assert.deepEqual(edu.results.map((r) => r.dataset_id), ["new-york-city:syn-scho"]);
    assert.deepEqual(edu.results[0].topics, ["education", "boundaries"], "in the shared list's order");
    // by name, any case, and with a query
    const h = searchDatasets({ query: "shelter", topic: "housing and HOMELESSNESS" });
    assert.deepEqual(h.results.map((r) => r.dataset_id), ["new-york-city:syn-hous"]);
    assert.equal(searchDatasets({ query: "shelter", topic: "education" }).total_matches, 0);
    // without a topic, the same query still finds it, and the untopiced rows say so
    const all = searchDatasets({ query: "SYNTHETIC", limit: 10 });
    assert.equal(all.total_matches, 5);
    assert.deepEqual(all.results.find((r) => r.dataset_id === "new-york-city:syn-none").topics, []);
    // group_by and the CSV work without a query too
    const g = searchDatasets({ topic: "transportation", group_by: "county" });
    assert.equal(g.total_matches, 1);
    assert.ok(g.groups.length >= 1);
    assert.equal(g.export.rows, 1);
    assert.throws(() => searchDatasets({ topic: "space travel" }), /not one of the 24 topics.*housing/);
    assert.throws(() => searchDatasets({}), /give a query, a topic, or both/);
  } finally {
    process.env.NY_DATA_INDEX = path;
    closeDb();
  }
});

test("list_topics gives all 24 with counts and the coverage figure", () => {
  process.env.NY_DATA_INDEX = synthPath;
  closeDb();
  try {
    const l = listTopics();
    assert.equal(l.topics.length, 24);
    assert.equal(l.datasets, 5);
    assert.equal(l.datasets_with_topic, 3);
    assert.equal(l.coverage_percent, 60);
    assert.equal(l.topics[0].datasets >= l.topics[23].datasets, true, "most datasets first");
    assert.deepEqual(l.topics.filter((t) => t.datasets > 0).map((t) => t.id).sort(), ["boundaries", "education", "housing", "landuse", "transportation"]);
    assert.equal(l.topics.find((t) => t.id === "housing").datasets, 1);
    assert.match(l.crosswalk.url, /index-latest\/topic-crosswalk\.csv$/);
    assert.equal(listTopics({ portal: "putnam-county" }).datasets, 0);
  } finally {
    process.env.NY_DATA_INDEX = path;
    closeDb();
  }
});

test("an index built before topics: plain search works, a topic filter explains how to get them", () => {
  const old = tempIndexPath();
  const db = openDb(old);
  db.exec("ATTACH DATABASE '" + synthPath.replace(/'/g, "''") + "' AS s");
  db.exec("INSERT INTO portals SELECT * FROM s.portals; INSERT INTO datasets SELECT * FROM s.datasets; INSERT INTO datasets_fts(dataset_id, name, description, tags, columns, portal, place) SELECT dataset_id, name, description, tags, columns, portal, place FROM s.datasets_fts;");
  db.exec("DETACH DATABASE s");
  db.close();
  process.env.NY_DATA_INDEX = old;
  closeDb();
  try {
    const r = searchDatasets({ query: "SYNTHETIC" });
    assert.equal(r.total_matches, 5);
    assert.equal("topics" in r.results[0], false);
    assert.throws(() => searchDatasets({ topic: "education" }), (e) => e.message === NO_TOPICS_NOTE);
    const l = listTopics();
    assert.equal(l.note, NO_TOPICS_NOTE);
    assert.equal(l.topics.length, 24);
    assert.equal(l.topics[0].datasets, null);
  } finally {
    process.env.NY_DATA_INDEX = path;
    closeDb();
  }
});

test("the fixture index (real recorded portal answers) gets topics from its own labels", () => {
  closeDb();
  const l = listTopics();
  assert.ok(l.datasets > 0);
  assert.ok(l.datasets_with_topic > 0 && l.datasets_with_topic <= l.datasets);
  assert.equal(l.coverage_percent, T.coveragePercent(l.datasets_with_topic, l.datasets));
  // Cortland's zoning layer is tagged "zoning".
  const z = searchDatasets({ query: "zoning", topic: "landuse" });
  assert.ok(z.results.some((r) => r.dataset_id.endsWith("dea35a11cfbf4adeb083df6d63cf1f88")));
});

test("rollback: a snapshot made before the crosswalk existed is still a target, and the newer crosswalk leaves index-latest", () => {
  const required = ["harvest-stats.json", "eval.md", "gate.json"];
  const old = rollbackSideFiles({ required, optional: [T.CROSSWALK_NAME], targetFiles: [...required, "index.json"], latestFiles: [...required, T.CROSSWALK_NAME] });
  assert.deepEqual(old, { check: required, upload: required, removeFromLatest: [T.CROSSWALK_NAME] });
  const fresh = rollbackSideFiles({ required, optional: [T.CROSSWALK_NAME], targetFiles: [...required, T.CROSSWALK_NAME], latestFiles: [...required, T.CROSSWALK_NAME] });
  assert.deepEqual(fresh, { check: required, upload: [...required, T.CROSSWALK_NAME], removeFromLatest: [] });
  const rec = { from: null, to: "index-2026-11-12", reason: "r", at: "2026-11-14T00:00:00Z", by: null, from_last_harvest: null, from_sqlite_sha256: null };
  const cmds = rollbackCommands({ dir: "/r", sideFiles: old.upload, manifest: { last_harvest: "x", datasets: 1, portals_ok: 1, portals_failed: 0 }, rec, releases: [], removeFromLatest: old.removeFromLatest });
  assert.deepEqual(cmds.at(-1).args, ["release", "delete-asset", "index-latest", T.CROSSWALK_NAME, "--yes"], "removed last");
  assert.ok(!cmds.some((c) => c.args.includes(join("/r", T.CROSSWALK_NAME))));
});

// Round 3 (2026-11-19): `topics --index X` ignored --index and rebuilt the default index (it
// changed a real one during review). It now works on X, or refuses an option it does not know.
test("cli topics: --index is honored, the default index is not touched, unknown options are refused", async () => {
  const { spawnSync } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const target = await buildFixtureIndex(tempIndexPath());
  const clear = () => {
    const d = new DatabaseSync(target);
    d.exec("DELETE FROM dataset_topics");
    d.close();
  };
  const rows = () => {
    const d = new DatabaseSync(target, { readOnly: true });
    const n = d.prepare("SELECT COUNT(*) AS n FROM dataset_topics").get().n;
    d.close();
    return n;
  };
  const home = mkdtempSync(join(tmpdir(), "nydr-topicshome-"));
  const defaultIndex = join(home, "default", "ny-data-index.sqlite");
  const env = { ...process.env, HOME: home, USERPROFILE: home, NY_DATA_INDEX: defaultIndex, NY_DATA_OFFLINE: "1", NY_DATA_REGISTRY_REFRESH: "0", NY_DATA_INDEX_AUTO_DOWNLOAD: "0" };
  const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "topics", ...args], { env, encoding: "utf8", timeout: 60_000 });

  clear();
  const bad = cli("--index", target, "--bogus", "1");
  assert.equal(bad.status, 2, bad.stderr);
  assert.match(bad.stderr, /unknown option\(s\) for topics: --bogus 1/);
  assert.equal(rows(), 0, "a refused call changes nothing");

  const ok = cli("--index", target);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(rows() > 0, "the index named by --index is rebuilt");
  assert.equal(existsSync(defaultIndex), false, "the default index is never created or touched");

  const missing = cli("--index", join(home, "nope.sqlite"));
  assert.equal(missing.status, 1);
  // Node 22.16 prints its own "(node:…) ExperimentalWarning: SQLite …" line first; that is not ours.
  assert.match(missing.stderr, /^no index at .*nope\.sqlite; run download or harvest first/m);
});
