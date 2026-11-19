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
import { closeDb, db } from "../dist/datasets.js";
import { openDb } from "../dist/db.js";
import { assertEveryToolExplained, BETANYC_INSTRUCTIONS, SHARED_MODULE_VERSION } from "../dist/betanyc-tools.js";

const DS_TEXT = readFileSync(new URL("../DATA-SOURCES.json", import.meta.url), "utf8");
const DS = JSON.parse(DS_TEXT);
const NAMES = TOOLS.map((t) => t.name);
const ask = (args = {}) => betanycTools().call("about_data", args);
const one = (topic) => ask({ topic }).structuredContent.sources.find((s) => s.topic === topic);

test("the shared module is 1.5.2, and the server passes on its instructions", () => {
  assert.equal(SHARED_MODULE_VERSION, "1.5.2");
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
    const url = (p.kind === "arcgis-server" ? p.root : p.kind === "geoblacklight" ? "https://cugir.library.cornell.edu/" : s.url.trim().split(/\s/)[0]).replace(/\/+$/, "");
    assert.ok(urls.has(url), `${s.source_id}: no DATA-SOURCES.json source links ${url}`);
  }
});

test("an error in a portal's catalog record goes to the portal's publisher, not only to BetaNYC", () => {
  for (const s of CATALOGS) {
    const got = one(s.id);
    assert.equal(got.report_errors.in_the_data_handled_by, "publisher", s.id);
    assert.doesNotMatch(got.report_errors.in_the_data, /github\.com\/BetaNYC|beta\.nyc/, s.id);
    assert.ok(got.caveats.some((c) => /contact on that dataset's own portal page/.test(c)), `${s.id}: says to use the dataset page's contact`);
  }
  const nyc = ask({ topic: "catalog-nyc-open-data" });
  assert.match(nyc.structuredContent.sources[0].report_errors.in_the_data, /support\.socrata\.com\/.*Contact-a-Dataset-Owner/);
  assert.match(nyc.content[0].text, /an error in the original records to New York City Office of Technology and Innovation: https:\/\/support\.socrata\.com/);
});

test("each catalog is checked at the portal itself, under the portal's own terms or a stated none", () => {
  for (const s of CATALOGS) {
    assert.equal(s.verify_at, s.source_url, `${s.id}: check a figure at the portal`);
    assert.ok(s.terms.license_name, s.id);
    assert.ok(s.terms.terms_url, `${s.id}: links the terms page, or where we looked`);
    assert.doesNotMatch(s.terms.terms_url, /github\.com\/BetaNYC/, `${s.id}: the portal's terms, not BetaNYC's`);
  }
  // A portal with its own terms page cites it; "None stated" is only for portals where we looked and found none.
  const pages = readDataJson("terms-pages.json").portals;
  assert.equal(DS.sources.find((s) => s.id === "catalog-open-ny").terms.terms_url, pages["nys-office-of-information-technology-services-open-ny-progra"].url);
  assert.equal(DS.sources.find((s) => s.id === "catalog-open-ny").terms.license_name, "Set by the OPEN-NY Terms of Use");
});

test("NYC Open Data's terms are set by law: no restrictions on use, and no warranty", () => {
  for (const topic of ["catalog-nyc-open-data", "catalog-nycmaphub"]) {
    const s = DS.sources.find((x) => x.id === topic);
    assert.equal(s.terms.license_name, "No restrictions on use: NYC Administrative Code \u00a7 23-502(d) (the Open Data Law, Local Law 11 of 2012)", topic);
    assert.equal(s.terms.terms_url, "https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCadmin/0-0-0-216807", topic);
    assert.ok(s.caveats.some((c) => /\u00a7 23-504/.test(c) && /no warranty/.test(c)), `${topic}: says there is no warranty`);
  }
  const text = ask({ topic: "catalog-nyc-open-data" }).content[0].text;
  const line = text.split("\n").find((l) => l.startsWith("Terms of use:"));
  assert.match(line, /^Terms of use: No restrictions on use: NYC Administrative Code \u00a7 23-502\(d\)/);
  assert.doesNotMatch(line, /None stated/);
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
    closeDb();
    const s = one("topics");
    assert.equal(s.as_of_status, "read");
    assert.equal(s.as_of, "2026-11-05T00:00:00Z");

    // Each portal gives its own last good read, not the index-wide date.
    const d = db();
    const read = (id) => d.prepare("SELECT last_harvested FROM portals WHERE id = ?").get(id).last_harvested;
    const health = one("catalog-health-data-ny");
    assert.equal(health.as_of_status, "read");
    assert.equal(health.as_of, read("nys-department-of-health"));
    assert.notEqual(health.as_of, "2026-11-05T00:00:00Z");
    assert.equal(one("catalog-cortland-county").as_of, read("cortland-county"));
    // A portal this index never read has no date.
    assert.equal(one("catalog-open-ny").as_of_status, "unavailable");

    // A failed read keeps the earlier datasets, so the date is when they were last seen, not the failed attempt.
    closeDb();
    const w = openDb(process.env.NY_DATA_INDEX);
    w.prepare("UPDATE datasets SET last_seen = '2026-10-01T00:00:00.000Z' WHERE portal_id = 'nys-department-of-health'").run();
    w.prepare("UPDATE portals SET harvest_status = 'failed', last_harvested = '2026-11-09T00:00:00.000Z' WHERE id = 'nys-department-of-health'").run();
    w.close();
    closeDb();
    assert.equal(one("catalog-health-data-ny").as_of, "2026-10-01T00:00:00.000Z");
  } finally {
    closeDb();
    if (saved === undefined) delete process.env.NY_DATA_INDEX;
    else process.env.NY_DATA_INDEX = saved;
  }
});
