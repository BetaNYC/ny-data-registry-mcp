// runs_it: the government body that runs a data site, looked up by registry_id in the master
// list (BetaNYC/ny-gov-web-registry data/registry.json). The registry and the master list here
// are controlled copies, so these tests do not move when either one grows. Nothing leaves the
// machine: the refresh tests stub global fetch.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./helpers.mjs";

const { registry, setRegistry, buildSources, assignSourceIds } = await import("../dist/registry.js");
const { govBodies, setGovBodies, govBodiesFrom, loadBundledBodies, refreshGovBodies, runsIt, slimMasterList, GOV_REGISTRY_URL } = await import("../dist/govbodies.js");
const { findSources, listSourcesForPlace, howToQuery, registryInfo } = await import("../dist/sources.js");
const { checkSource } = await import("../dist/check.js");
const { callTool } = await import("../dist/tools.js");

const bundled = JSON.parse(readFileSync(new URL("../data/ny-data-portal-registry.json", import.meta.url), "utf8"));
const bundledBodies = JSON.parse(readFileSync(new URL("../data/gov-bodies.json", import.meta.url), "utf8"));

// The shape of a published master-list entity, trimmed to what matters here.
const entity = (id, name, extra = {}) => ({
  id,
  name,
  short_name: null,
  government_level: "county",
  classification: "county",
  status: "active",
  identifiers: [],
  areas: [],
  web_properties: [],
  ...extra,
});
const MASTER = {
  _generated_from: "test",
  entities: [
    entity("test-gov-nyc", "City of New York", {
      short_name: "NYC",
      government_level: "nyc",
      classification: "city",
      web_properties: [
        { domain: "old.example.gov", role: "primary", valid_from: null, valid_to: "2010" },
        { domain: "nyc.gov", role: "primary", valid_from: null, valid_to: null },
        { domain: "data.nyc.example", role: "microsite", valid_from: null, valid_to: null },
      ],
    }),
    entity("test-gov-erie", "Erie County", { web_properties: [{ domain: "erie.gov", role: "legacy", valid_to: null }] }),
    entity("test-gov-gone", "Old Village", { government_level: "village", classification: "village", status: "dissolved" }),
    { id: "no-name" },
    { name: "no id" },
  ],
};

const TEST_IDS = {
  "new-york-city": "test-gov-nyc",
  "erie-county": "test-gov-erie",
  "nys-department-of-health": "test-gov-not-in-list",
  "putnam-county": "test-gov-gone",
};

const originalRegistry = registry();
const originalBodies = govBodies();
const sids = assignSourceIds(bundled.rows);
const rows = bundled.rows.map((r, i) => ({ ...r, registry_id: TEST_IDS[sids[i]] ?? null }));
setRegistry({ generated: bundled.generated, origin: "bundled", fetched_at: null, refresh_error: null, sources: buildSources({ ...bundled, rows }) });
const controlled = govBodiesFrom({ source: "test", snapshot_date: "2026-11-14", bodies: slimMasterList(MASTER) });
setGovBodies(controlled);
after(() => {
  setRegistry(originalRegistry);
  setGovBodies(originalBodies);
});

const body = (r) => JSON.parse(r.content[0].text);

test("the master list is read by id: name, level, classification and the current primary domain", () => {
  assert.equal(slimMasterList(MASTER).length, 3, "entities without an id or a name are dropped");
  assert.deepEqual(runsIt("test-gov-nyc"), {
    found: true,
    name: "City of New York",
    short_name: "NYC",
    government_level: "nyc",
    classification: "city",
    website: "nyc.gov",
  });
  assert.equal(runsIt("test-gov-erie").website, null, "a legacy domain is not the website");
  assert.equal("short_name" in runsIt("test-gov-erie"), false);
  assert.equal(runsIt("test-gov-gone").status, "dissolved", "status shows only when it is not active");
  assert.equal(slimMasterList({ entities: [] }), null);
  assert.equal(slimMasterList({ rows: [] }), null);
});

test("no id means no answer, and an id the list lacks says so; nothing is guessed from names", () => {
  assert.equal(runsIt(null), null);
  assert.equal(runsIt(""), null);
  assert.deepEqual(runsIt("test-gov-not-in-list"), { found: false, note: "this registry_id is not in the master list yet" });
  // The master list has an "Erie County" body, but a row without an id never gets matched to it by name.
  const buffalo = listSourcesForPlace("Erie County").within.find((x) => x.source_id === "city-of-buffalo");
  assert.equal(buffalo.registry_id, null);
  assert.equal(buffalo.runs_it, null);
  assert.equal(runsIt("Erie County").found, false, "only the exact id matches");
});

test("find_sources, list_sources_for_place, how_to_query and check_source carry runs_it and say where it came from", async () => {
  const doh = findSources({ query: "health" });
  assert.deepEqual(doh.results.find((x) => x.source_id === "nys-department-of-health").runs_it, { found: false, note: "this registry_id is not in the master list yet" });
  assert.equal(doh.runs_it_source.list, "BetaNYC/ny-gov-web-registry data/registry.json");
  assert.equal(doh.runs_it_source.url, GOV_REGISTRY_URL);
  assert.equal(doh.runs_it_source.copy, "bundled");
  assert.equal(doh.runs_it_source.as_of, "2026-11-14");
  for (const x of findSources({ query: "county", status: "any", limit: 50 }).results) {
    assert.ok("runs_it" in x, x.source_id);
    if (!x.registry_id) assert.equal(x.runs_it, null, x.source_id);
  }

  const erie = listSourcesForPlace("Erie County");
  assert.equal(erie.own.find((x) => x.source_id === "erie-county").runs_it.name, "Erie County");
  assert.ok(erie.runs_it_source);

  const h = howToQuery({ source_id: "new-york-city" });
  assert.equal(h.source.runs_it.name, "City of New York");
  assert.equal(h.runs_it_source.bodies, 3);

  const c = await checkSource({ source_id: "new-york-city" });
  assert.equal(c.checked, false, "offline: nothing is fetched");
  assert.equal(c.source.runs_it.website, "nyc.gov");
  assert.ok(c.runs_it_source);
});

test("registry_info says which copy of the master list is loaded and which row ids it lacks", () => {
  const m = registryInfo(null).master_list;
  assert.equal(m.copy, "bundled");
  assert.equal(m.bodies, 3);
  assert.equal(m.row_ids_found, 3);
  assert.deepEqual(m.row_ids_not_in_list, ["test-gov-not-in-list"]);
});

test("through the MCP tools", async () => {
  const r = body(await callTool("find_sources", { query: "NYC Open Data" }));
  const nyc = r.results.find((x) => x.source_id === "new-york-city");
  assert.equal(nyc.runs_it.name, "City of New York");
  assert.equal(body(await callTool("how_to_query", { registry_id: "test-gov-erie" })).source.runs_it.name, "Erie County");
  assert.equal(body(await callTool("registry_info", {})).master_list.row_ids_not_in_list.length, 1);
});

test("the bundled fallback holds exactly the bodies the bundled registry's rows point to", () => {
  const ids = new Set(bundled.rows.map((r) => (typeof r.registry_id === "string" ? r.registry_id.trim() : "")).filter((v) => v && v !== "—"));
  const have = new Set(bundledBodies.bodies.map((b) => b.id));
  assert.deepEqual([...have].sort(), [...ids].sort(), "rebuild with: npm run build && node scripts/bundle_gov_bodies.mjs");
  for (const b of bundledBodies.bodies) assert.ok(b.name && "government_level" in b && "primary_domain" in b, b.id);
  assert.equal(loadBundledBodies().origin, "bundled");
  assert.equal(loadBundledBodies().byId.size, have.size);
});

// ─── refresh: published copy, cache, bundled fallback ─────────────────────────

async function withRefresh(handler, fn) {
  const realFetch = globalThis.fetch;
  const saved = { off: process.env.NY_DATA_OFFLINE, ref: process.env.NY_DATA_REGISTRY_REFRESH, dir: process.env.NY_DATA_CACHE_DIR };
  process.env.NY_DATA_OFFLINE = "0";
  process.env.NY_DATA_REGISTRY_REFRESH = "1";
  const dir = mkdtempSync(join(tmpdir(), "nydr-bodies-"));
  process.env.NY_DATA_CACHE_DIR = dir;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    return handler(calls.length, init);
  };
  try {
    await fn(calls, dir);
  } finally {
    globalThis.fetch = realFetch;
    process.env.NY_DATA_OFFLINE = saved.off;
    process.env.NY_DATA_REGISTRY_REFRESH = saved.ref;
    if (saved.dir === undefined) delete process.env.NY_DATA_CACHE_DIR;
    else process.env.NY_DATA_CACHE_DIR = saved.dir;
    setGovBodies(controlled);
  }
}
const ok = () => new Response(JSON.stringify(MASTER), { status: 200, headers: { etag: '"v1"', "content-type": "text/plain" } });

test("refresh: a fresh copy is used and cached slim; the next start sends the ETag and a 304 uses the cache", async () => {
  await withRefresh((n) => (n === 1 ? ok() : new Response(null, { status: 304 })), async (calls, dir) => {
    const first = await refreshGovBodies();
    assert.equal(first.origin, "fresh");
    assert.equal(first.refresh_error, null);
    assert.equal(calls[0].url, GOV_REGISTRY_URL);
    assert.match(calls[0].headers["User-Agent"], /^ny-data-registry-mcp\//);
    assert.equal(runsIt("test-gov-nyc").name, "City of New York");
    const cached = JSON.parse(readFileSync(join(dir, "gov-bodies.json"), "utf8"));
    assert.equal(cached.bodies.length, 3);
    assert.equal("web_properties" in cached.bodies[0], false, "only the slim fields are cached");

    const second = await refreshGovBodies();
    assert.equal(calls[1].headers["If-None-Match"], '"v1"');
    assert.equal(second.origin, "cache");
    assert.equal(second.refresh_error, null);
    assert.equal(runsIt("test-gov-erie").name, "Erie County");
  });
});

test("refresh: a failure falls back to the cache, then to the bundled copy, and says why", async () => {
  await withRefresh((n) => (n === 1 ? ok() : new Response("boom", { status: 500 })), async (calls, dir) => {
    await refreshGovBodies();
    const r = await refreshGovBodies();
    assert.equal(r.origin, "cache");
    assert.equal(r.refresh_error, "HTTP 500");
    assert.equal(runsIt("test-gov-nyc").found, true);
  });
  await withRefresh(() => new Response("boom", { status: 500 }), async (_calls, dir) => {
    const r = await refreshGovBodies();
    assert.equal(r.origin, "bundled");
    assert.equal(r.refresh_error, "HTTP 500");
    assert.equal(existsSync(join(dir, "gov-bodies.json")), false);
    assert.equal(runsIt("test-gov-nyc").found, false, "the bundled copy has only real ids");
  });
  await withRefresh(() => new Response(JSON.stringify({ entities: [] }), { status: 200 }), async () => {
    const r = await refreshGovBodies();
    assert.equal(r.origin, "bundled");
    assert.match(r.refresh_error, /no entities/);
  });
  await withRefresh(() => Promise.reject(new TypeError("fetch failed")), async (_calls, dir) => {
    writeFileSync(join(dir, "gov-bodies.json"), "{not json");
    const r = await refreshGovBodies();
    assert.equal(r.origin, "bundled", "a broken cache file is ignored");
    assert.equal(r.refresh_error, "fetch failed");
  });
});

test("offline: nothing is fetched and the bundled copy answers", async () => {
  await withRefresh(() => assert.fail("no request when offline"), async (calls) => {
    process.env.NY_DATA_OFFLINE = "1";
    const r = await refreshGovBodies();
    assert.equal(calls.length, 0);
    assert.equal(r.origin, "bundled");
    assert.equal(r.refresh_error, "refresh disabled");
    const anyId = bundledBodies.bodies[0];
    assert.equal(runsIt(anyId.id).name, anyId.name);
  });
  await withRefresh(() => assert.fail("no request when refresh is off"), async (calls) => {
    process.env.NY_DATA_REGISTRY_REFRESH = "0";
    await refreshGovBodies();
    assert.equal(calls.length, 0);
  });
});
