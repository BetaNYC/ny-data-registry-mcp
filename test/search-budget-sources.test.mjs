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
  add("budgetmany", 45);
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
const portalsNamed = (b) => new Set([b.data_source, ...(b.data_sources ?? []).flatMap((g) => g.sources)].map((s) => s.portal_id).filter(Boolean));
const note = (b) => b.groups_size_note ?? b.size_note ?? "";

test("a search's sources fit inside its 20,000-byte budget: rows and groups are cut to leave room", async () => {
  for (const args of [{ query: "budgetsome", group_by: "portal" }, { query: "budgetsome", limit: 50 }, { query: "budgetsome" }]) {
    const { b, bytes } = await answer(args);
    assert.equal(portalsNamed(b).size, 18, JSON.stringify(args));
    assert.ok(note(b), `${JSON.stringify(args)}: something was cut`);
    assert.ok(bytes <= RESPONSE_BUDGET_BYTES, `${JSON.stringify(args)}: ${bytes} bytes`);
    assert.match(note(b), new RegExp(`under ${RESPONSE_BUDGET_BYTES} bytes`), JSON.stringify(args));
  }
});

test("when the sources alone are most of the budget, the note gives the larger limit and the reply keeps to it", async () => {
  for (const args of [{ query: "budgetmany", group_by: "portal" }, { query: "budgetmany", limit: 50 }]) {
    const { b, bytes } = await answer(args);
    assert.equal(portalsNamed(b).size, 45, JSON.stringify(args));
    const limit = Number(note(b).match(/under (\d+) bytes/)?.[1]);
    assert.ok(limit > RESPONSE_BUDGET_BYTES, `${JSON.stringify(args)}: ${note(b)}`);
    assert.ok(bytes <= limit, `${JSON.stringify(args)}: ${bytes} bytes, note says under ${limit}`);
  }
});
