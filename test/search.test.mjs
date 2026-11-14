// search_datasets paging, true totals, group_by, compact/full rows and the response size budget.
// Builds the fixture index, then adds clearly-marked SYNTHETIC rows so a query matches more
// than the old 400-row cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempIndexPath, buildFixtureIndex } from "./helpers.mjs";

const path = tempIndexPath();
process.env.NY_DATA_INDEX = path;
await buildFixtureIndex(path);

const { openDb, writePortalDatasets } = await import("../dist/db.js");
const { mapSocrataAsset } = await import("../dist/harvest/socrata.js");
const { portalRecord } = await import("../dist/harvest/run.js");
const { registry } = await import("../dist/registry.js");
const { searchDatasets, toolJson, RESPONSE_BUDGET_BYTES, closeDb } = await import("../dist/datasets.js");
const { TOOLS, callTool } = await import("../dist/tools.js");
const { pruneExports, EXPORT_KEEP } = await import("../dist/exportcsv.js");
const { CallToolResultSchema } = await import("@modelcontextprotocol/sdk/types.js");
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const NYC_SYNTH = 431; // 430 plain + 1 tricky title
const TRICKY = 'SYNTHETIC parcel, "quoted" title\nsecond line';
const PUTNAM_SYNTH = 40;
{
  const w = openDb(path);
  const src = (id) => portalRecord(registry().sources.find((s) => s.source_id === id));
  const longText = "SYNTHETIC test description. ".repeat(20);
  const mk = (domain, id, name) =>
    mapSocrataAsset({ resource: { id, name, description: longText, type: "dataset", columns_field_name: ["bbl"], data_updated_at: "2026-10-01T12:34:56.000Z" }, classification: {} }, domain);
  const nyc = Array.from({ length: NYC_SYNTH - 1 }, (_, i) => mk("data.cityofnewyork.us", `syn-${String(i).padStart(4, "0")}`, `SYNTHETIC parcel layer ${i}`));
  // One title with a comma, a double quote and a newline, to test CSV quoting.
  nyc.push(mk("data.cityofnewyork.us", "syn-tric", TRICKY));
  const put = Array.from({ length: PUTNAM_SYNTH }, (_, i) => mk("example.invalid", `put-${String(i).padStart(4, "0")}`, `SYNTHETIC parcel layer putnam ${i}`));
  // complete=false: a partial write never removes the fixture rows already there
  writePortalDatasets(w, src("new-york-city"), nyc, 3, false);
  writePortalDatasets(w, src("putnam-county"), put, 3, false);
  w.close();
  closeDb();
}

function pageAll(args) {
  const ids = [];
  let offset = 0;
  let pages = 0;
  while (offset !== null) {
    const r = searchDatasets({ ...args, offset });
    ids.push(...r.results.map((x) => x.dataset_id));
    offset = r.next_offset;
    if (++pages > 100) throw new Error("paging did not terminate");
  }
  return ids;
}

test("total_matches is the true count, beyond the old 400-row cap", () => {
  const r = searchDatasets({ query: "parcel" });
  assert.ok(r.total_matches >= NYC_SYNTH + PUTNAM_SYNTH, `total_matches ${r.total_matches}`);
  assert.equal(r.ranked_pool.capped, false);
  assert.equal(r.ranked_pool.size, r.total_matches);
  assert.equal(r.total_candidates, undefined, "the old capped field is gone");
});

test("paging walks every match exactly once, in a stable order", () => {
  const total = searchDatasets({ query: "parcel" }).total_matches;
  const a = pageAll({ query: "parcel", limit: 37 });
  const b = pageAll({ query: "parcel", limit: 37 });
  assert.equal(a.length, total);
  assert.equal(new Set(a).size, total, "no duplicates across pages");
  assert.deepEqual(a, b, "same order on a second walk");
  // Page size does not change the order.
  assert.deepEqual(pageAll({ query: "parcel", limit: 50 }), a);
  const last = searchDatasets({ query: "parcel", offset: total - 1 });
  assert.equal(last.returned, 1);
  assert.equal(last.next_offset, null);
  const past = searchDatasets({ query: "parcel", offset: total + 5 });
  assert.equal(past.results.length, 0);
  assert.match(past.note, /past the last/);
});

test("group_by portal covers every match with exact counts and top titles", () => {
  const all = pageAll({ query: "parcel", limit: 50, detail: "full" });
  const g = searchDatasets({ query: "parcel", group_by: "portal" });
  const sum = g.groups.reduce((n, x) => n + x.matches, 0);
  assert.equal(sum, g.total_matches);
  assert.equal(sum, all.length);
  const byPortal = {};
  for (const id of all) {
    const p = id.split(":")[0];
    byPortal[p] = (byPortal[p] ?? 0) + 1;
  }
  assert.deepEqual(Object.fromEntries(g.groups.map((x) => [x.key, x.matches])), byPortal);
  const nyc = g.groups.find((x) => x.key === "new-york-city");
  assert.ok(nyc.matches >= NYC_SYNTH);
  assert.equal(nyc.portal, "NYC Open Data");
  assert.ok(g.groups.every((x) => x.top.length <= 3 && x.top.length >= 1));
  assert.ok(g.groups[0].matches >= g.groups.at(-1).matches, "largest group first");
  assert.equal(searchDatasets({ query: "parcel", group_by: "portal", top_per_group: 1 }).groups[0].top.length, 1);
});

test("group_by county counts a multi-county dataset in each county; entity and platform_family sum to the total", () => {
  const c = searchDatasets({ query: "parcel", group_by: "county" });
  const k = Object.fromEntries(c.groups.map((x) => [x.key, x.matches]));
  for (const county of ["Bronx", "Kings", "New York", "Queens", "Richmond"]) assert.ok(k[county] >= NYC_SYNTH, county);
  assert.ok(k.Putnam >= PUTNAM_SYNTH);
  assert.match(c.note, /counted in each/);
  for (const by of ["entity", "platform_family"]) {
    const g = searchDatasets({ query: "parcel", group_by: by });
    assert.equal(g.groups.reduce((n, x) => n + x.matches, 0), g.total_matches, by);
  }
});

test("group_by refuses list-only parameters instead of ignoring them", () => {
  for (const extra of [{ offset: 10 }, { limit: 5 }, { detail: "full" }]) {
    assert.throws(() => searchDatasets({ query: "parcel", group_by: "portal", ...extra }), /apply only without group_by/);
  }
  assert.throws(() => searchDatasets({ query: "parcel", top_per_group: 2 }), /only with group_by/);
});

test("rows are compact by default; detail full keeps the original shape", () => {
  const c = searchDatasets({ query: "medicaid" });
  assert.equal(c.detail, "compact");
  // registry_id appears only when the portal's registry row has one (test/registry-id.test.mjs).
  assert.deepEqual(Object.keys(c.results[0]).filter((k) => k !== "registry_id").sort(), ["dataset_id", "formats", "name", "portal", "portal_id", "type", "updated_at", "url"]);
  const p = searchDatasets({ query: "parcel layer putnam" }).results[0];
  assert.equal(p.updated_at, "2026-10-01", "date only");
  const f = searchDatasets({ query: "medicaid", detail: "full" }).results[0];
  for (const key of ["description", "api_endpoint", "query_with", "views", "score", "native_id"]) assert.ok(key in f, key);
  assert.equal(f.dataset_id, c.results[0].dataset_id, "same ranking in both shapes");
});

test("the size budget trims a page and says how to get the rest", () => {
  const r = searchDatasets({ query: "parcel", limit: 50, detail: "full", offset: 0 });
  assert.equal(r.auto_grouped, undefined, "paging by hand turns the auto-summary off");
  assert.equal(r.export, undefined, "and the automatic CSV");
  assert.ok(Buffer.byteLength(toolJson(r)) <= RESPONSE_BUDGET_BYTES, `bytes ${Buffer.byteLength(toolJson(r))}`);
  assert.ok(r.omitted_for_size > 0);
  assert.equal(r.returned + r.omitted_for_size, 50);
  assert.equal(r.next_offset, r.returned);
  assert.match(r.size_note, new RegExp(`offset=${r.returned}`));
  // The trimmed rows are exactly the next page's first rows.
  const ref = searchDatasets({ query: "parcel", limit: 50 });
  const next = searchDatasets({ query: "parcel", offset: r.next_offset, limit: 5 });
  assert.deepEqual(next.results.map((x) => x.dataset_id), ref.results.slice(r.returned, r.returned + 5).map((x) => x.dataset_id));
});

test("coverage says which registry portals the index does not search", () => {
  const r = searchDatasets({ query: "parcel" });
  assert.ok(r.coverage.registry_portals_not_fully_indexed > 0);
  assert.ok(r.coverage.by_reason["checked: no portal exists"] > 0);
  const erie = searchDatasets({ query: "parcel", place: "Erie County" });
  const row = erie.coverage.portals_for_this_place_not_fully_indexed.find((x) => x.portal_id === "erie-county");
  assert.match(row.reason, /no portal/);
  assert.equal(typeof erie.coverage.statewide_portals_not_fully_indexed, "number");
});

test("the MCP tool accepts every advertised search_datasets parameter and returns within budget", async () => {
  const props = TOOLS.find((t) => t.name === "search_datasets").inputSchema.properties;
  const sample = { query: "parcel", place: "Putnam", portal: "putnam-county", platform_family: "socrata", format: "csv", updated_since: "2000-01-01", limit: 5, offset: 0, detail: "compact", export: "never" };
  for (const key of Object.keys(props)) {
    if (key === "group_by" || key === "top_per_group") continue;
    const r = await callTool("search_datasets", { query: "parcel", [key]: sample[key] });
    assert.notEqual(r.isError, true, `${key}: ${r.content[0].text}`);
  }
  const g = await callTool("search_datasets", { query: "parcel", group_by: "portal", top_per_group: 2 });
  assert.notEqual(g.isError, true, g.content[0].text);
  assert.ok(Buffer.byteLength(g.content[0].text) <= RESPONSE_BUDGET_BYTES);
  const bad = await callTool("search_datasets", { query: "parcel", group_by: "town" });
  assert.equal(bad.isError, true);
});

/** Minimal RFC 4180 reader, for checking what the server wrote. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", i = 0, quoted = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r" && text[i + 1] === "\n") { row.push(field); rows.push(row); row = []; field = ""; i += 2; continue; }
    if (c === "\n" || c === "\r") throw new Error(`bare line break outside quotes at ${i}`);
    field += c; i++;
  }
  if (field !== "" || row.length) throw new Error("file does not end with CRLF");
  return rows;
}

test("auto-summary: more matches than fit gives every portal's count, the top rows, and a CSV of every match", () => {
  const r = searchDatasets({ query: "parcel" });
  assert.equal(r.auto_grouped, true);
  assert.match(r.auto_grouped_reason, /row limit \(10\)/);
  assert.equal(r.group_by, "portal");
  assert.equal(r.groups.reduce((n, g) => n + g.matches, 0), r.total_matches);
  assert.ok(r.results.length >= 1 && r.results.length <= 10);
  assert.ok(Buffer.byteLength(toolJson(r)) <= RESPONSE_BUDGET_BYTES);
  assert.equal(r.export.rows, r.total_matches);
  assert.ok(existsSync(r.export.path));
  assert.ok(r.export.path.startsWith(process.env.NY_DATA_EXPORT_DIR));
});

test("no auto-summary and no CSV when every match fits in the reply", () => {
  const r = searchDatasets({ query: "zoning" });
  assert.ok(r.total_matches <= 10);
  assert.equal(r.results.length, r.total_matches);
  assert.equal(r.auto_grouped, undefined);
  assert.equal(r.groups, undefined);
  assert.equal(r.export, undefined);
});

test("auto-summary also starts when matches are within limit but over the size budget", () => {
  const r = searchDatasets({ query: "parcel", portal: "putnam-county", limit: 50, detail: "full" });
  assert.ok(r.total_matches <= 50 && r.total_matches > 15, `total ${r.total_matches}`);
  assert.equal(r.auto_grouped, true);
  assert.match(r.auto_grouped_reason, /budget/);
  assert.ok(r.results.length < r.total_matches);
  assert.equal(r.export.rows, r.total_matches);
  assert.ok(Buffer.byteLength(toolJson(r)) <= RESPONSE_BUDGET_BYTES);
});

test("the CSV holds exactly total_matches rows, RFC 4180 quoted, best-ranked first", () => {
  const r = searchDatasets({ query: "parcel" });
  const text = readFileSync(r.export.path, "utf8");
  assert.equal(Buffer.byteLength(text), r.export.bytes);
  const rows = parseCsv(text);
  const [header, ...body] = rows;
  assert.deepEqual(header, r.export.columns);
  assert.equal(body.length, r.total_matches);
  const id = header.indexOf("dataset_id");
  const name = header.indexOf("name");
  assert.equal(new Set(body.map((x) => x[id])).size, r.total_matches);
  assert.deepEqual(new Set(body.map((x) => x[id])), new Set(pageAll({ query: "parcel", limit: 50 })));
  assert.equal(body.find((x) => x[id] === "new-york-city:syn-tric")[name], TRICKY, "comma, quote and newline survive");
  assert.match(text, /"SYNTHETIC parcel, ""quoted"" title\nsecond line"/);
  assert.deepEqual(body.slice(0, r.results.length).map((x) => x[id]), r.results.map((x) => x.dataset_id), "same order as the reply");
  assert.ok(body.every((x) => x.length === header.length));
  const sd = header.indexOf("socrata_domain");
  assert.equal(body.find((x) => x[id] === "new-york-city:syn-0001")[sd], "data.cityofnewyork.us");
});

test("export: never writes nothing; always writes even a small answer", () => {
  const before = readdirSync(process.env.NY_DATA_EXPORT_DIR).length;
  const n = searchDatasets({ query: "parcel", export: "never" });
  assert.equal(n.export, undefined);
  assert.equal(n.auto_grouped, true, "the summary still comes back");
  assert.equal(readdirSync(process.env.NY_DATA_EXPORT_DIR).length, before);
  const a = searchDatasets({ query: "zoning", export: "always" });
  assert.equal(a.export.rows, a.total_matches);
  const g = searchDatasets({ query: "parcel", group_by: "county" });
  assert.equal(g.export.rows, g.total_matches, "group_by lists no rows, so the CSV is written");
});

test("NY_DATA_EXPORT_DIR moves the exports", () => {
  const saved = process.env.NY_DATA_EXPORT_DIR;
  const dir = join(mkdtempSync(join(tmpdir(), "nydr-override-")), "nested");
  process.env.NY_DATA_EXPORT_DIR = dir;
  try {
    const r = searchDatasets({ query: "parcel" });
    assert.equal(dirname(r.export.path), dir);
    assert.ok(existsSync(r.export.path));
  } finally {
    process.env.NY_DATA_EXPORT_DIR = saved;
  }
});

test("pruning keeps the newest exports and never touches anything else", () => {
  const saved = process.env.NY_DATA_EXPORT_DIR;
  const root = mkdtempSync(join(tmpdir(), "nydr-prune-"));
  const dir = join(root, "exports");
  mkdirSync(join(dir, "sub"), { recursive: true });
  process.env.NY_DATA_EXPORT_DIR = dir;
  try {
    const name = (i) => `search-20261101T${String(100000000 + i).padStart(9, "0")}Z-000-q.csv`;
    for (let i = 0; i < EXPORT_KEEP + 10; i++) writeFileSync(join(dir, name(i)), "x\r\n");
    const others = ["notes.txt", "my-search.csv", "search-not-ours.csv"];
    for (const o of others) writeFileSync(join(dir, o), "keep");
    writeFileSync(join(dir, "sub", name(999)), "keep");
    writeFileSync(join(root, name(998)), "keep");
    const now = Date.now();
    // one recent-by-name file made old by mtime: removed for age
    const old = join(dir, name(EXPORT_KEEP + 9));
    utimesSync(old, new Date(now - 8 * 86400e3), new Date(now - 8 * 86400e3));
    const removed = pruneExports(now);
    const left = readdirSync(dir).filter((f) => /^search-2026/.test(f));
    assert.equal(left.length, EXPORT_KEEP - 1);
    assert.equal(removed, 11);
    assert.ok(!existsSync(old), "older than 7 days is removed");
    assert.ok(existsSync(join(dir, name(EXPORT_KEEP + 8))), "the newest stay");
    assert.ok(!existsSync(join(dir, name(0))), "the oldest go");
    for (const o of others) assert.ok(existsSync(join(dir, o)), o);
    assert.ok(existsSync(join(dir, "sub", name(999))), "no recursion");
    assert.ok(existsSync(join(root, name(998))), "nothing outside the exports folder");
  } finally {
    process.env.NY_DATA_EXPORT_DIR = saved;
  }
});

test("the MCP result carries a resource_link to the CSV and validates against the SDK schema", async () => {
  const r = await callTool("search_datasets", { query: "parcel" });
  assert.notEqual(r.isError, true, r.content[0].text);
  const parsed = CallToolResultSchema.parse(r);
  assert.equal(parsed.content[0].type, "text");
  const body = JSON.parse(parsed.content[0].text);
  const link = parsed.content[1];
  assert.equal(link.type, "resource_link");
  assert.equal(link.mimeType, "text/csv");
  assert.equal(link.uri, body.export.uri);
  assert.match(link.uri, /^file:\/\//);
  assert.equal(link.size, body.export.bytes);
  const small = await callTool("search_datasets", { query: "zoning" });
  assert.equal(small.content.length, 1, "no file, no link");
});

test("CSV: text that a spreadsheet would run as a formula gets a leading apostrophe; numbers do not", async () => {
  const { csvField } = await import("../dist/exportcsv.js");
  assert.equal(csvField("=HYPERLINK(\"http://x\")"), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvField("+1 parcels"), "'+1 parcels");
  assert.equal(csvField("-parcels"), "'-parcels");
  assert.equal(csvField("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvField("\tTab"), "'\tTab");
  assert.equal(csvField("\rCR"), `"'\rCR"`);
  assert.equal(csvField("Tax Parcels"), "Tax Parcels");
  assert.equal(csvField(-5), "-5");
  assert.equal(csvField(0), "0");
  assert.equal(csvField(null), "");
});

test("synonyms: two-word keys match only the adjacent pair", async () => {
  const { expandTerms, tokenize } = await import("../dist/sources.js");
  const terms = (q) => expandTerms(tokenize(q)).map((t) => t.term);
  assert.ok(terms("tax lot").includes("tax parcel"), "'tax lot' expands to 'tax parcel'");
  assert.ok(terms("tax lots").includes("parcels"), "'tax lots' expands to 'parcels'");
  assert.ok(!terms("parking lot").includes("parcel"), "'parking lot' must not expand to parcels");
  assert.ok(!terms("lot tax").includes("tax parcel"), "word order matters");
  const typed = expandTerms(tokenize("tax lot")).filter((t) => t.weight >= 0.9).map((t) => t.term);
  assert.deepEqual(typed.sort(), ["lot", "tax"], "synonyms are never weighted like typed words");
});
