// about_data: "where does this data come from?" (betanyc-ai-workspace
// platform/system/about-data-standard.md). The answer is built from DATA-SOURCES.json by the
// shared module (src/betanyc-tools.ts, a copy: never edit it here). These tests keep the promises
// that matter for this server: every tool has a documented source, the registry is marked as
// BetaNYC's curation, and how current each source is comes from real state (the loaded
// registry's date, the harvested index's last harvest), with no request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tempIndexPath, buildFixtureIndex } from "./helpers.mjs";

const path = tempIndexPath();
process.env.NY_DATA_INDEX = path;
await buildFixtureIndex(path);
const LAST_HARVEST = "2026-11-05T09:12:33.000Z";
{
  const w = new DatabaseSync(path);
  w.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('last_harvest', ?)").run(LAST_HARVEST);
  w.close();
}

const { callTool, TOOLS, indexHarvestedAt } = await import("../dist/tools.js");
const { assertEveryToolExplained, FRESHNESS_NOT_FETCHED } = await import("../dist/betanyc-tools.js");
const { registry } = await import("../dist/registry.js");
const { closeDb } = await import("../dist/datasets.js");

globalThis.fetch = async (url) => {
  throw new Error(`about_data must not fetch, but fetched ${url}`);
};

const DS_TEXT = readFileSync(new URL("../DATA-SOURCES.json", import.meta.url), "utf8");
const TOOL_NAMES = TOOLS.map((t) => t.name);
const ask = async (args = {}) => {
  const r = await callTool("about_data", args);
  assert.notEqual(r.isError, true, r.content[0].text);
  return r;
};
const one = (body, topic) => body.sources.find((s) => s.topic === topic);

test("every tool says where its data comes from, so a new tool cannot ship unexplained", () => {
  assertEveryToolExplained(DS_TEXT, TOOL_NAMES);
  assert.throws(() => assertEveryToolExplained(DS_TEXT, [...TOOL_NAMES, "brand_new_tool"]), /brand_new_tool/);
});

test("about_data is advertised, read-only, and lists this server's topics", () => {
  const t = TOOLS.find((x) => x.name === "about_data");
  assert.ok(t);
  assert.equal(t.annotations.readOnlyHint, true);
  assert.match(t.description, /Topics on this server: portal-registry, socrata-catalogs, arcgis-catalogs\./);
});

test("about_data gives BetaNYC's contact address, lab@beta.nyc", async () => {
  const r = await ask();
  assert.equal(r.structuredContent.contact_email, "lab@beta.nyc");
  assert.match(r.content[0].text, /^Questions or error reports about this data, to BetaNYC: lab@beta\.nyc$/m);
});

test("the registry is BetaNYC's curation, not an official record, with errors reported to BetaNYC", async () => {
  const r = await ask({ topic: "portal-registry" });
  const s = one(r.structuredContent, "portal-registry");
  assert.equal(s.official, false);
  assert.equal(s.figures_official, false);
  assert.match(r.content[0].text, /^Not an official record: curated by BetaNYC\.$/m, "BetaNYC as publisher is not named twice (module 1.3.7)");
  assert.equal(s.report_errors.in_the_data_handled_by, "betanyc");
});

test("the registry's date is the one this server loaded", async () => {
  const s = one((await ask({ topic: "portal-registry" })).structuredContent, "portal-registry");
  assert.equal(s.as_of_status, "read");
  assert.equal(s.as_of, registry().generated);
});

test("both catalog sources report the harvested index's last harvest", async () => {
  for (const topic of ["socrata-catalogs", "arcgis-catalogs"]) {
    const s = one((await ask({ topic })).structuredContent, topic);
    assert.equal(s.official, true, topic);
    assert.equal(s.figures_official, false, topic);
    assert.equal(s.as_of_status, "read", topic);
    assert.equal(s.as_of, LAST_HARVEST, topic);
  }
});

test("with no index on this machine, the catalog sources say 'not fetched yet'", async () => {
  closeDb();
  process.env.NY_DATA_INDEX = join(tempIndexPath(), "..", "missing.sqlite");
  try {
    assert.equal(indexHarvestedAt(), FRESHNESS_NOT_FETCHED);
    const s = one((await ask({ topic: "socrata-catalogs" })).structuredContent, "socrata-catalogs");
    assert.equal(s.as_of_status, "not-fetched");
    // the registry still has its date
    assert.equal(one((await ask({ topic: "portal-registry" })).structuredContent, "portal-registry").as_of_status, "read");
  } finally {
    closeDb();
    process.env.NY_DATA_INDEX = path;
  }
});

test("asking by tool name returns the sources behind that tool", async () => {
  const { structuredContent: body } = await ask({ topic: "check_source" });
  assert.deepEqual(body.sources.map((s) => s.topic), ["portal-registry"]);
  const ds = await ask({ topic: "search_datasets" });
  assert.deepEqual(ds.structuredContent.sources.map((s) => s.topic), ["portal-registry", "socrata-catalogs", "arcgis-catalogs"]);
});

test("an unknown topic is an error that lists the topics", async () => {
  const r = await callTool("about_data", { topic: "ckan" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /portal-registry/);
});

test("the registry is published by BetaNYC; the catalogs by New York's governments", async () => {
  const { structuredContent: body } = await ask();
  assert.equal(one(body, "portal-registry").publisher, "BetaNYC");
  for (const topic of ["socrata-catalogs", "arcgis-catalogs"]) {
    assert.equal(one(body, topic).publisher, "New York State, New York City and other New York governments", topic);
  }
});

test("an error in a portal's catalog record goes to the portal, not to BetaNYC", async () => {
  for (const topic of ["socrata-catalogs", "arcgis-catalogs"]) {
    const s = one((await ask({ topic })).structuredContent, topic);
    assert.equal(s.report_errors.in_the_data_handled_by, "publisher", topic);
    assert.ok(s.caveats.some((c) => /contact on that dataset's own portal page/.test(c)), topic);
  }
  const soc = one((await ask({ topic: "socrata-catalogs" })).structuredContent, "socrata-catalogs");
  assert.match(soc.report_errors.in_the_data, /support\.socrata\.com\/.*Contact-a-Dataset-Owner/);
  assert.match(soc.how_gathered, /Data and Insights division of Tyler Technologies/);
});
