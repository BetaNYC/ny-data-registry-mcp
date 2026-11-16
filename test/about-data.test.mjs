// about_data: "where does this data come from, and is it official?" (betanyc-ai-workspace #1672).
// The answer comes from DATA-SOURCES.json through BetaNYC's shared module (src/betanyc-tools.ts,
// a copy of the workspace's canonical file: never edit it here). How current each source is
// comes from real state, never from a date typed into DATA-SOURCES.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tempIndexPath, buildFixtureIndex } from "./helpers.mjs";
import { betanycTools, SERVER_INSTRUCTIONS, TOOLS } from "../dist/tools.js";
import { assertEveryToolExplained, BETANYC_INSTRUCTIONS, SHARED_MODULE_VERSION } from "../dist/betanyc-tools.js";

const DS_TEXT = readFileSync(new URL("../DATA-SOURCES.json", import.meta.url), "utf8");
const DS = JSON.parse(DS_TEXT);
const NAMES = TOOLS.map((t) => t.name);
const ask = (args = {}) => betanycTools().call("about_data", args);
const one = (topic) => ask({ topic }).structuredContent.sources.find((s) => s.topic === topic);

test("the shared module is 1.4.0, and the server passes on its instructions", () => {
  assert.equal(SHARED_MODULE_VERSION, "1.4.0");
  assert.ok(SERVER_INSTRUCTIONS.endsWith(BETANYC_INSTRUCTIONS));
});

test("every tool says where its data comes from, so a new tool cannot ship unexplained", () => {
  assertEveryToolExplained(DS_TEXT, NAMES);
  assert.throws(() => assertEveryToolExplained(DS_TEXT, [...NAMES, "brand_new_tool"]), /brand_new_tool/);
});

test("every source gives one of the three answers, naming the source and a link", () => {
  const r = ask();
  assert.notEqual(r.isError, true, r.content[0].text);
  const body = r.structuredContent;
  assert.deepEqual(body.topics, DS.sources.map((s) => s.id));
  assert.deepEqual(body.left_out ?? [], []);
  assert.equal(body.contact_email, "lab@beta.nyc");
  const text = r.content[0].text;
  for (const s of DS.sources) {
    assert.ok(text.includes(s.source_name), `${s.id}: names ${s.source_name}`);
    assert.ok(text.includes(s.source_url), `${s.id}: links ${s.source_url}`);
  }
  // Nothing here is published as is: BetaNYC filters and reshapes every catalog it harvests.
  for (const s of body.sources) assert.equal(s.figures_official, false, s.topic);
});

test("harvested catalogs are modified official records; BetaNYC's own lists are produced by BetaNYC", () => {
  for (const topic of ["catalog-socrata", "catalog-arcgis", "catalog-geoblacklight"]) {
    const s = one(topic);
    assert.equal(s.official, true, topic);
    assert.equal(s.changed_by_betanyc.changed, true, topic);
  }
  assert.match(ask({ topic: "catalog-socrata" }).content[0].text, /BetaNYC modified this data: .*Official record: Socrata Discovery API \(Tyler Technologies\), https:\/\/dev\.socrata\.com\/docs\/other\/discovery/);
  for (const topic of ["portal-registry", "government-bodies", "places", "hand-kept", "topics", "coverage", "join-keys", "standard-descriptions"]) {
    assert.equal(one(topic).official, false, topic);
  }
  assert.match(ask({ topic: "portal-registry" }).content[0].text, /BetaNYC produced this\. It is not an official record\. Built from: NY Data Portal Registry, https:/);
});

test("a tool name as topic gives the sources behind that tool", () => {
  const topics = ask({ topic: "find_joinable" }).structuredContent.sources.map((s) => s.topic);
  assert.deepEqual(topics, ["catalog-socrata", "catalog-arcgis", "catalog-geoblacklight", "join-keys"]);
});

test("freshness comes from real state: the portal list's date, and no date for undated files", () => {
  const generated = JSON.parse(readFileSync(new URL("../data/ny-data-portal-registry.json", import.meta.url), "utf8")).generated;
  const reg = one("portal-registry");
  assert.equal(reg.as_of_status, "read");
  assert.equal(reg.as_of, generated);
  const gov = one("government-bodies");
  assert.equal(gov.as_of_status, "read");
  assert.match(gov.as_of, /^\d{4}-\d{2}-\d{2}/);
  for (const topic of ["places", "join-keys"]) assert.equal(one(topic).as_of_status, "unavailable", topic);
});

test("index sources say 'not fetched yet' before the first download, then the index's last harvest", async () => {
  const saved = process.env.NY_DATA_INDEX;
  try {
    process.env.NY_DATA_INDEX = join(tempIndexPath(), "..", "missing.sqlite");
    assert.equal(one("catalog-socrata").as_of_status, "not-fetched");
    process.env.NY_DATA_INDEX = await buildFixtureIndex(tempIndexPath(), { lastHarvest: "2026-11-05T00:00:00Z" });
    const s = one("topics");
    assert.equal(s.as_of_status, "read");
    assert.equal(s.as_of, "2026-11-05T00:00:00Z");
  } finally {
    if (saved === undefined) delete process.env.NY_DATA_INDEX;
    else process.env.NY_DATA_INDEX = saved;
  }
});
