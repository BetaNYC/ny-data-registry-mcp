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
import { registry } from "../dist/registry.js";
import { planFor } from "../dist/harvest/run.js";
import { readDataJson } from "../dist/paths.js";
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

const CATALOGS = DS.sources.filter((s) => s.id.startsWith("catalog-"));
const BETANYC_LISTS = ["portal-registry", "government-bodies", "places", "hand-kept", "topics", "coverage", "join-keys", "standard-descriptions"];

test("each harvested portal is its own source, published by the body that runs it, not the platform maker", () => {
  for (const s of CATALOGS) {
    const got = one(s.id);
    assert.equal(got.official, true, s.id);
    assert.equal(got.changed_by_betanyc.changed, true, s.id);
    assert.doesNotMatch(s.publisher.name, /Tyler|Esri|Socrata|ArcGIS/, `${s.id}: publisher is the portal's owner`);
  }
  assert.match(
    ask({ topic: "catalog-nyc-open-data" }).content[0].text,
    /BetaNYC modified this data: .*Official record: NYC Open Data \(New York City Office of Technology and Innovation\), https:\/\/data\.cityofnewyork\.us\//
  );
  for (const topic of BETANYC_LISTS) assert.equal(one(topic).official, false, topic);
  assert.match(ask({ topic: "portal-registry" }).content[0].text, /BetaNYC produced this\. It is not an official record\. Built from: NY Data Portal Registry, https:/);
});

test("every portal the harvest reads has a source, so a new portal cannot ship unexplained", () => {
  const cfg = readDataJson("harvest-config.json");
  const urls = new Set(CATALOGS.map((s) => s.source_url.replace(/\/+$/, "")));
  const planned = registry().sources
    .map((s) => ({ s, p: planFor(s, cfg) }))
    .filter(({ p }) => p.kind !== "skip" && p.kind !== "hand-kept");
  assert.equal(planned.length, CATALOGS.length, "one catalog source per harvested portal");
  for (const { s, p } of planned) {
    const url = (p.kind === "arcgis-server" ? p.root : p.kind === "geoblacklight" ? "https://github.com/OpenGeoMetadata/edu.cornell" : s.url.trim().split(/\s/)[0]).replace(/\/+$/, "");
    assert.ok(urls.has(url), `${s.source_id}: no DATA-SOURCES.json source links ${url}`);
  }
});

test("a tool name as topic gives the sources behind that tool", () => {
  const topics = ask({ topic: "find_joinable" }).structuredContent.sources.map((s) => s.topic);
  assert.deepEqual(topics, [...CATALOGS.map((s) => s.id), "join-keys"]);
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
    assert.equal(one("catalog-nyc-open-data").as_of_status, "not-fetched");
    process.env.NY_DATA_INDEX = await buildFixtureIndex(tempIndexPath(), { lastHarvest: "2026-11-05T00:00:00Z" });
    const s = one("topics");
    assert.equal(s.as_of_status, "read");
    assert.equal(s.as_of, "2026-11-05T00:00:00Z");
  } finally {
    if (saved === undefined) delete process.env.NY_DATA_INDEX;
    else process.env.NY_DATA_INDEX = saved;
  }
});
