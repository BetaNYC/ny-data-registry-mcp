// Review round 2 on PR #51 (epic #33): check_source by URL never checks another government's
// portal (F1), only http(s) URLs have a host (F2), what a caller typed and what an outside
// server sent come back short and on one line (F3), and bad registry values are treated as
// absent for matching and fetching without being rewritten (F7). Every request is faked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempIndexPath, buildFixtureIndex } from "./helpers.mjs";
import { resetHttpState } from "../dist/http.js";
import { registry, setRegistry, buildSources, usableUrl, refreshRegistry } from "../dist/registry.js";
import { lookupSource, safeHost, sourceSummary, hasApi, howToQuery } from "../dist/sources.js";
import { echo } from "../dist/echo.js";

process.env.NY_DATA_INDEX = await buildFixtureIndex(tempIndexPath());
const { callTool } = await import("../dist/tools.js");

async function withStub(handler, fn) {
  const realFetch = globalThis.fetch;
  const saved = process.env.NY_DATA_OFFLINE;
  process.env.NY_DATA_OFFLINE = "0";
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls);
  };
  resetHttpState();
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
    process.env.NY_DATA_OFFLINE = saved;
    resetHttpState();
  }
}
const ok = () => new Response("<html></html>", { status: 200 });
const row = (id) => registry().sources.find((s) => s.source_id === id);

// ─── F1 ─────────────────────────────────────────────────────────────────────

test("F1: every row's own portal URL and API address names that row, or a list that has it; never another row", () => {
  const tally = { own: 0, list: 0 };
  for (const s of registry().sources) {
    for (const u of [s.portal_url, s.api_url]) {
      if (!u) continue;
      const r = lookupSource({ url: u });
      assert.ok(!r.error, `${s.source_id} ${u}: ${r.error}`);
      if (r.source) {
        assert.equal(r.source.source_id, s.source_id, `${u} is ${s.source_id}'s own address but names ${r.source.source_id}`);
        tally.own++;
      } else {
        assert.ok(r.candidates.includes(s), `${u}: the list leaves out ${s.source_id}`);
        tally.list++;
      }
    }
  }
  // 339 usable addresses in the bundled registry: 337 name their own row, 2 give a list.
  assert.equal(tally.own + tally.list, 339);
  assert.ok(tally.own >= 330, JSON.stringify(tally));
});

test("F1: the reviewer's cases check their own row (exact API address or page)", () => {
  for (const [id, field] of [["city-of-rye", "api_url"], ["city-of-utica", "api_url"], ["city-of-amsterdam", "api_url"], ["nyc311", "portal_url"]]) {
    const s = row(id);
    assert.ok(s?.[field], `${id} has a ${field}`);
    assert.equal(lookupSource({ url: s[field] }).source?.source_id, id, `${id} ${s[field]}`);
  }
  // A layer below a row's own services folder is that row's.
  assert.equal(lookupSource({ url: `${row("city-of-rye").api_url}/Parcels/FeatureServer/0` }).source?.source_id, "city-of-rye");
});

test("F1: a shared or generic host with no matching page or path gives a list and sends no request", async () => {
  await withStub(ok, async (calls) => {
    for (const url of [
      "https://github.com/anything",
      "https://www.arcgis.com/home",
      "https://services3.arcgis.com/NotARegistryOrg/arcgis/rest/services",
      "https://beacon.schneidercorp.com/Application.aspx?PageType=Search",
    ]) {
      const r = await callTool("check_source", { url });
      const t = r.content[0].text;
      if (r.isError) assert.match(t, /no registry row/, url);
      else {
        const b = JSON.parse(t);
        assert.equal(b.ambiguous, true, `${url}: ${t.slice(0, 200)}`);
        assert.ok(b.total >= 1 && b.candidates.length >= 1, url);
        assert.match(b.message, /nothing was fetched/);
        assert.equal(b.checked, undefined, url);
      }
    }
    assert.equal(calls.length, 0, calls.map((c) => c.url).join(", "));
  });
});

test("F1: a clear match on a shared host checks only that row, and says how many share it", async () => {
  await withStub(ok, async (calls) => {
    const b = JSON.parse((await callTool("check_source", { url: row("city-of-rye").api_url })).content[0].text);
    assert.equal(b.source.source_id, "city-of-rye");
    assert.ok(b.url_matches.total > 1);
    assert.equal(b.url_matches.checked, "city-of-rye");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, row("city-of-rye").portal_url, "the registry row's portal, not the pasted address");
  });
});

// ─── F2 ─────────────────────────────────────────────────────────────────────

test("F2: only http and https URLs have a host", async () => {
  assert.equal(safeHost("foo://data.ny.gov"), null);
  assert.equal(safeHost("ftp://data.ny.gov/x"), null);
  assert.equal(safeHost("javascript://data.ny.gov"), null);
  assert.equal(safeHost("https://www.data.ny.gov/x"), "data.ny.gov");
  assert.equal(safeHost("http://data.ny.gov"), "data.ny.gov");
  await withStub(ok, async (calls) => {
    const r = await callTool("check_source", { url: "foo://data.ny.gov" });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /no registry row matches 'foo:\/\/data\.ny\.gov': it is not an http\(s\) URL/);
    assert.equal(calls.length, 0);
  });
});

// ─── F3 ─────────────────────────────────────────────────────────────────────

test("F3a: echo flattens to one line and caps at 80 characters", () => {
  assert.equal(echo("a\nb\t c‮d"), "a b c d");
  const long = echo("x".repeat(300));
  assert.equal([...long].length, 80);
  assert.ok(long.endsWith("…"));
  assert.equal(echo("short"), "short");
});

test("F3a: every message that repeats the caller's input repeats at most 80 characters, on one line", async () => {
  const LONG = `${"x".repeat(200)}\nsecond line\n    at evil (file.js:1:2)`;
  const cases = [
    ["how_to_query", { source_id: LONG }],
    ["how_to_query", { registry_id: LONG }],
    ["how_to_query", { entity: LONG }],
    ["check_source", { url: LONG }],
    ["check_source", { url: `https://${"h".repeat(200)}.example/` }],
    ["find_sources", { query: "parcels", place: LONG }],
    ["search_datasets", { query: "parcels", place: LONG }],
    ["search_datasets", { topic: LONG }],
    ["get_dataset_columns", { dataset: LONG }],
    ["find_joinable", { dataset: LONG }],
    ["find_joinable", { dataset: "test-0001", column: LONG }],
    ["find_sources", { query: "x", [LONG]: 1 }],
    [LONG, {}],
  ];
  for (const [name, args] of cases) {
    const r = await callTool(name, args);
    const t = r.content[0].text;
    assert.equal(r.isError, true, `${name.slice(0, 20)}: ${t.slice(0, 120)}`);
    assert.doesNotMatch(t, /\n/, `${name.slice(0, 20)}: more than one line`);
    assert.ok(!t.includes("x".repeat(80)), `${name.slice(0, 20)} ${JSON.stringify(args).slice(0, 40)}: input repeated whole`);
    assert.ok(!t.includes("h".repeat(80)), `${name.slice(0, 20)}: host repeated whole`);
    assert.match(t, /…/, `${name.slice(0, 20)}: no sign that the input was cut`);
  }
});

test("F3b: check_source's request_error and verdict are one plain line, no cause chain or stack", async () => {
  const cause = { code: "ECONNRESET", message: `socket hang up ${"y".repeat(600)}\n    at TLSSocket.onClose (node:_tls_wrap.js:1:2)\nmore` };
  await withStub(
    () => {
      throw Object.assign(new TypeError("fetch failed"), { cause });
    },
    async () => {
      const b = JSON.parse((await callTool("check_source", { source_id: "nys-department-of-health" })).content[0].text);
      assert.doesNotMatch(b.request_error, /\n|TLSSocket|_tls_wrap/);
      assert.ok([...b.request_error].length <= 300, `${[...b.request_error].length} characters`);
      assert.ok(b.request_error.endsWith("…"));
      assert.doesNotMatch(b.verdict, /\n|TLSSocket/);
      assert.ok(b.verdict.length < 400);
    }
  );
});

test("F3c: a redirect's Location is cut at 500 characters, and the answer says so", async () => {
  const far = `https://elsewhere.example/${"z".repeat(2000)}`;
  await withStub(
    () => new Response("", { status: 302, headers: { location: far } }),
    async (calls) => {
      const b = JSON.parse((await callTool("check_source", { source_id: "nys-department-of-health" })).content[0].text);
      assert.equal([...b.redirect_to].length, 500);
      assert.ok(b.redirect_to.endsWith("…"));
      assert.match(b.redirect_note, new RegExp(`was ${far.length} characters; redirect_to shows the first 500`));
      assert.ok(!b.verdict.includes("z".repeat(100)));
      assert.equal(calls.length, 1);
    }
  );
  await withStub(
    () => new Response("", { status: 301, headers: { location: "https://health.data.ny.gov/new" } }),
    async () => {
      const b = JSON.parse((await callTool("check_source", { source_id: "nys-department-of-health" })).content[0].text);
      assert.equal(b.redirect_to, "https://health.data.ny.gov/new");
      assert.equal(b.redirect_note, undefined);
    }
  );
});

test("F3d: a failed cache write in the registry refresh does not show this machine's path", async () => {
  const blocker = join(mkdtempSync(join(tmpdir(), "nydr-blocked-")), "a-file");
  writeFileSync(blocker, "not a folder");
  const saved = { cache: process.env.NY_DATA_CACHE_DIR, refresh: process.env.NY_DATA_REGISTRY_REFRESH };
  process.env.NY_DATA_CACHE_DIR = join(blocker, "cache"); // mkdir under a file fails with ENOTDIR, naming the path
  process.env.NY_DATA_REGISTRY_REFRESH = "1";
  const doc = readFileSync(new URL("../data/ny-data-portal-registry.json", import.meta.url), "utf8");
  try {
    await withStub(
      () => new Response(doc, { status: 200, headers: { "content-type": "application/json" } }),
      async (calls) => {
        const r = await refreshRegistry(5000);
        assert.equal(calls.length, 1);
        assert.ok(r.refresh_error, "the write failed");
        assert.ok(!r.refresh_error.includes(blocker), r.refresh_error);
        assert.match(r.refresh_error, /\[cache folder\]/);
        const info = (await callTool("registry_info", {})).content[0].text;
        assert.ok(!info.includes(blocker), "registry_info shows the cache path");
      }
    );
  } finally {
    process.env.NY_DATA_CACHE_DIR = saved.cache;
    process.env.NY_DATA_REGISTRY_REFRESH = saved.refresh;
    if (saved.cache === undefined) delete process.env.NY_DATA_CACHE_DIR;
    setRegistry(null);
  }
});

test("F3d: the same for the master list of government bodies", async () => {
  const { refreshGovBodies, setGovBodies } = await import("../dist/govbodies.js");
  const blocker = join(mkdtempSync(join(tmpdir(), "nydr-blocked-")), "a-file");
  writeFileSync(blocker, "not a folder");
  const saved = { cache: process.env.NY_DATA_CACHE_DIR, refresh: process.env.NY_DATA_REGISTRY_REFRESH };
  process.env.NY_DATA_CACHE_DIR = join(blocker, "cache");
  process.env.NY_DATA_REGISTRY_REFRESH = "1";
  try {
    await withStub(
      () => new Response(JSON.stringify({ entities: [{ id: "test-gov", name: "Test Government" }] }), { status: 200 }),
      async (calls) => {
        const g = await refreshGovBodies(5000);
        assert.equal(calls.length, 1);
        assert.ok(g.refresh_error, "the write failed");
        assert.ok(!g.refresh_error.includes(blocker), g.refresh_error);
        assert.match(g.refresh_error, /\[cache folder\]/);
      }
    );
  } finally {
    process.env.NY_DATA_CACHE_DIR = saved.cache;
    process.env.NY_DATA_REGISTRY_REFRESH = saved.refresh;
    if (saved.cache === undefined) delete process.env.NY_DATA_CACHE_DIR;
    setGovBodies(null);
  }
});

test("F3d: the index path appears in the no-index error on purpose, and in no other error", async () => {
  const idx = process.env.NY_DATA_INDEX;
  const errors = [
    ["how_to_query", { source_id: "nope" }],
    ["get_dataset_columns", { dataset: "nope" }],
    ["whats_new", { since: "soon" }],
    ["check_source", { url: "https://nowhere.example/" }],
  ];
  for (const [name, args] of errors) assert.ok(!(await callTool(name, args)).content[0].text.includes(idx), name);
  const saved = process.env.NY_DATA_INDEX;
  const missing = join(mkdtempSync(join(tmpdir(), "nydr-none-")), "absent.sqlite");
  const savedAuto = process.env.NY_DATA_INDEX_AUTO_DOWNLOAD;
  process.env.NY_DATA_INDEX_AUTO_DOWNLOAD = "0";
  process.env.NY_DATA_INDEX = missing;
  try {
    const { NoIndexError } = await import("../dist/datasets.js");
    assert.match(new NoIndexError().message, new RegExp(`looked for ${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    process.env.NY_DATA_INDEX = saved;
    if (savedAuto === undefined) delete process.env.NY_DATA_INDEX_AUTO_DOWNLOAD;
    else process.env.NY_DATA_INDEX_AUTO_DOWNLOAD = savedAuto;
  }
});

// ─── F7 ─────────────────────────────────────────────────────────────────────

test("F7: a value that is not a usable http(s) URL is absent for matching and fetching, and shown as is", async () => {
  assert.equal(usableUrl("—"), null);
  assert.equal(usableUrl("  "), null);
  assert.equal(usableUrl(null), null);
  assert.equal(usableUrl("https://511ny.org/help/24 (title: \"Requesting Access\")"), "https://511ny.org/help/24");
  assert.equal(usableUrl("https://user:pw@example.org/"), null);
  assert.equal(usableUrl("ftp://example.org/"), null);

  const dash = registry().sources.filter((s) => s.api_endpoint === "—");
  assert.equal(dash.length, 19, "19 rows hold a dash for a blank API endpoint");
  for (const s of dash) {
    assert.equal(s.api_url, null, s.source_id);
    assert.equal(s.api_endpoint, "—", "the registry value itself is unchanged");
    assert.equal(hasApi(s), false, s.source_id);
    assert.equal(howToQuery({ source_id: s.source_id }).endpoint, null, s.source_id);
  }
  const noUrl = registry().sources.filter((s) => !s.url).map((s) => s.source_id).sort();
  assert.deepEqual(noUrl, ["city-of-albany", "city-of-new-rochelle", "city-of-troy", "city-of-white-plains"]);
  const dot = row("nys-department-of-transportation--511ny-org");
  assert.equal(dot.portal_url, "https://511ny.org/help/24");
  assert.equal(sourceSummary(dot).url, 'https://511ny.org/help/24 (title: "Requesting Access")', "find_sources shows the row as the registry has it");

  await withStub(ok, async (calls) => {
    for (const id of noUrl) {
      const b = JSON.parse((await callTool("check_source", { source_id: id })).content[0].text);
      assert.equal(b.checked, false, id);
      assert.match(b.reason, /no usable portal URL/, id);
    }
    assert.equal(calls.length, 0);
  });
});

test("F7: check_source fetches only the URL part of a portal value with a note after it", async () => {
  const doc = JSON.parse(readFileSync(new URL("../data/ny-data-portal-registry.json", import.meta.url), "utf8"));
  const i = doc.rows.findIndex((r) => r.entity === "NYS Department of Health");
  doc.rows[i] = { ...doc.rows[i], url: 'https://health.data.ny.gov/ (title: "Health Data NY")', api_endpoint: "—" };
  setRegistry({ generated: doc.generated, origin: "bundled", fetched_at: null, refresh_error: null, sources: buildSources(doc) });
  try {
    await withStub(ok, async (calls) => {
      const b = JSON.parse((await callTool("check_source", { source_id: "nys-department-of-health" })).content[0].text);
      assert.equal(b.checked, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://health.data.ny.gov/");
      assert.equal(b.source.url, 'https://health.data.ny.gov/ (title: "Health Data NY")');
      // A "—" API endpoint matches nothing (it used to equal the null host of every such row).
      assert.equal(lookupSource({ url: "https://health.data.ny.gov/" }).source?.source_id, "nys-department-of-health");
    });
  } finally {
    setRegistry(null);
  }
});
