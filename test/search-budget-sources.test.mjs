// Round 2 (2026-11-19): a search names every portal with a match in data_sources, so its size
// budget covers those sources too. Rows and group titles are cut to leave room for them; when the
// sources alone would take most of the budget, the reply keeps 8,000 bytes of rows and groups and
// its size note says the larger limit it kept to. No network: a fixture index with many portals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempIndexPath, buildFixtureIndex } from "./helpers.mjs";

const index = await buildFixtureIndex(tempIndexPath());
{
  const { openDb, upsertPortal, writePortalDatasets, setPortalHarvest } = await import("../dist/db.js");
  const { mapSocrataAsset } = await import("../dist/harvest/socrata.js");
  const { portalRecord } = await import("../dist/harvest/run.js");
  const { registry } = await import("../dist/registry.js");
  const nyc = registry().sources.find((s) => s.source_id === "new-york-city");
  const db = openDb(index);
  const run = Number(db.prepare("INSERT INTO harvest_runs(started_at) VALUES ('2026-11-05T00:00:00Z')").run().lastInsertRowid);
  // Portals with no DATA-SOURCES.json entry, so each source is the longer fallback block.
  const add = (word, n) => {
    for (let i = 0; i < n; i++) {
      const host = `data.${word}-${i}.ny.gov`;
      const p = portalRecord({ ...nyc, source_id: `${word}-portal-${i}`, portal_name: `${word} test portal number ${i}`, entity: `${word} test agency ${i}`, url: `https://${host}/` });
      upsertPortal(db, p);
      const rows = Array.from({ length: 6 }, (_, k) =>
        mapSocrataAsset({ resource: { id: `${word.slice(0, 4)}-${i}-${k}`, name: `${word} dataset ${k} of portal ${i}: ${"a long title for size ".repeat(6)}`, type: "dataset" }, classification: {} }, host),
      );
      writePortalDatasets(db, p, rows, run, true);
      setPortalHarvest(db, p.id, { adapter: "socrata", status: "ok", note: null, socrata_domain: host });
    }
  };
  add("budgetsome", 18);
  add("budgetsixty", 60);
  // Two portals with the same name and publisher (round 3): each is its own source.
  for (const i of [0, 1]) {
    const host = `data.twin-${i}.ny.gov`;
    const p = portalRecord({ ...nyc, source_id: `budgettwin-portal-${i}`, portal_name: "Twin Open Data", entity: "Twin Agency", url: `https://${host}/` });
    upsertPortal(db, p);
    writePortalDatasets(db, p, [mapSocrataAsset({ resource: { id: `twin-${i}`, name: `budgettwin dataset ${i}`, type: "dataset" }, classification: {} }, host)], run, true);
    setPortalHarvest(db, p.id, { adapter: "socrata", status: "ok", note: null, socrata_domain: host });
  }
  db.close();
}
process.env.NY_DATA_INDEX = index;
const { callTool } = await import("../dist/tools.js");
const { RESPONSE_BUDGET_BYTES } = await import("../dist/datasets.js");

const answer = async (args) => {
  const r = await callTool("search_datasets", args);
  assert.notEqual(r.isError, true, r.content[0].text);
  const text = r.content[0].text;
  return { b: JSON.parse(text), bytes: Buffer.byteLength(text, "utf8") };
};
/** The portals of this fixture an answer names: a "topic: name (publisher), link" line each,
 * under a group that says "BetaNYC modified this data". */
const portalsNamed = (b, word) => {
  const lines = (b.data_sources ?? []).filter((g) => /^BetaNYC modified this data: /.test(g.says)).flatMap((g) => g.sources);
  const named = new Set();
  for (let i = 0; i < 80; i++) {
    const want = `portal-catalogs: ${word} test portal number ${i} (${word} test agency ${i}), https://data.${word}-${i}.ny.gov/`;
    if (lines.includes(want)) named.add(i);
  }
  return named;
};
const note = (b) => b.groups_size_note ?? b.size_note ?? "";
const linesBytes = (b) => Buffer.byteLength(JSON.stringify({ data_sources: b.data_sources }, null, 2));

test("a search's sources fit inside its 20,000-byte budget: rows and groups are cut to leave room", async () => {
  for (const args of [{ query: "budgetsome", group_by: "portal" }, { query: "budgetsome", limit: 50 }, { query: "budgetsome" }]) {
    const { b, bytes } = await answer(args);
    assert.equal(portalsNamed(b, "budgetsome").size, 18, JSON.stringify(args));
    assert.ok(bytes <= RESPONSE_BUDGET_BYTES, `${JSON.stringify(args)}: ${bytes} bytes`);
  }
});

// Round 3 (2026-11-19): the published index has about 60 portals. A grouped search shows every
// group's count (the counts are the answer, as in 0.3.0) and names all 60 portals, one short
// line each, within its 20,000-byte budget.
test("60 portals: every group's count, every portal named with label, publisher and link, within budget", async () => {
  for (const args of [{ query: "budgetsixty", group_by: "portal" }, { query: "budgetsixty" }, { query: "budgetsixty", limit: 50 }, { query: "budgetsixty", limit: 50, detail: "full" }]) {
    const where = JSON.stringify(args);
    const { b, bytes } = await answer(args);
    assert.equal(b.total_matches, 360, where);
    assert.equal(portalsNamed(b, "budgetsixty").size, 60, where);
    assert.ok(linesBytes(b) / 60 < 140, `${where}: ${Math.round(linesBytes(b) / 60)} bytes per portal`);
    assert.equal(b.group_count, 60, where);
    assert.ok(b.groups.every((g) => g.matches === 6), where);
    if (args.detail === "full") {
      // Full rows are large: when a group truly cannot fit, the answer says how many, which, and
      // the call that lists one.
      const out = 60 - b.groups.length;
      if (out) {
        assert.equal(b.groups_omitted_for_size, out, where);
        assert.match(b.groups_size_note, new RegExp(`^${out} smallest group\\(s\\), ${out * 6} matches \\(budgetsixty-portal-`), where);
        assert.match(b.groups_size_note, /search_datasets with the same arguments and portal: "budgetsixty-portal-\d+" lists one; export\.path has every match\./, where);
      }
    } else {
      assert.equal(b.groups.length, 60, `${where}: ${b.groups.length} groups shown; ${note(b)}`);
      assert.equal(b.groups_omitted_for_size, undefined, where);
    }
    assert.ok(bytes <= RESPONSE_BUDGET_BYTES, `${where}: ${bytes} bytes`);
    if (!args.group_by) assert.ok(b.results.length >= 1, `${where}: no rows`);
  }
});

test("two portals with the same name and publisher are two sources, keyed on their portal ids", async () => {
  const { b } = await answer({ query: "budgettwin" });
  const lines = b.data_sources.flatMap((g) => g.sources);
  for (const i of [0, 1]) assert.ok(lines.includes(`portal-catalogs: Twin Open Data (Twin Agency), https://data.twin-${i}.ny.gov/`), `twin ${i}: ${lines.join(" | ")}`);
});
