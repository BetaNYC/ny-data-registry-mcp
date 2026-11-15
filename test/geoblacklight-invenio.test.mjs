// GeoBlacklight (through OpenGeoMetadata) and InvenioRDM adapters (issue #16, milestone 6).
// Fixtures: a real OpenGeoMetadata record and the InvenioRDM docs' example record. Flow tests
// stub global fetch; nothing leaves the machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./helpers.mjs";
import { readTar, parseEnvelope, references, readRecord, mapOgmRecord, filterOgm, recordsFromFiles, harvestOgm } from "../dist/harvest/geoblacklight.js";
import { invenioTarget, newYorkVerdict, mapInvenioRecord, geometryBox, harvestInvenio } from "../dist/harvest/invenio.js";
import { planFor, cadenceDays } from "../dist/harvest/run.js";
import { resetHttpState } from "../dist/http.js";
import { loadBundled } from "../dist/registry.js";
import { readDataJson } from "../dist/paths.js";

const cfg = readDataJson("harvest-config.json");
const reg = loadBundled();
const src = (id) => reg.sources.find((s) => s.source_id === id);
const cugir = fixture("ogm-gbl1-cugir-000051.json").record;
const invDoc = fixture("invenio-record-doc.json");

/** A minimal ustar archive, as GitHub serves (every path under one top folder). */
function tar(files) {
  const blocks = [];
  for (const [name, text] of files) {
    const data = Buffer.from(text);
    const h = Buffer.alloc(512);
    h.write(`OpenGeoMetadata-edu.cornell-abc123/${name}`, 0);
    h.write("0000644\0", 100);
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("0", 156);
    h.write("ustar\0", 257);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

test("GeoBlacklight rows read their OpenGeoMetadata repository; Columbia stays excluded", () => {
  assert.deepEqual(planFor(src("cornell-university-library--cugir-library-cornell-edu"), cfg), {
    kind: "geoblacklight", repo: { repo: "OpenGeoMetadata/edu.cornell", ref: "main", provider: "Cornell" },
  });
  assert.equal(planFor(src("columbia-university-libraries--geodata-library-columbia-edu"), cfg).code, "policy");
  assert.equal(cadenceDays("x", "geoblacklight", cfg.cadence), 7);
  assert.equal(cfg.adapters.geoblacklight.enabled, true);
});

test("a GeoBlacklight 1.0 record maps with its envelope, links and subjects", () => {
  assert.deepEqual(parseEnvelope("ENVELOPE(76.76, 84.76, 19.91, 12.62)"), [76.76, 12.62, 84.76, 19.91], "the docs' example, W E N S");
  assert.equal(parseEnvelope("not an envelope"), null);
  const r = readRecord(cugir);
  assert.equal(r.schema, "gbl-1.0");
  assert.equal(r.id, "cugir-000051");
  assert.equal(r.public, true);
  assert.equal(r.provider, "Cornell");
  const d = mapOgmRecord(r);
  assert.equal(d.native_id, "cugir-000051");
  assert.equal(d.name, "Agricultural Districts, Tompkins County NY, 2000");
  assert.equal(d.permalink, "https://cugir.library.cornell.edu/catalog/cugir-000051");
  assert.deepEqual(d.extent, [-76.696211, 42.28149, -76.248765, 42.62748]);
  assert.equal(d.geometry_type, "Polygon");
  assert.equal(d.updated_at, "2021-11-12T00:00:00Z");
  assert.equal(d.publisher, "Tompkins County GIS Program");
  assert.ok(d.tags.includes("real property") && d.tags.includes("Tompkins County"));
  const f = Object.fromEntries(d.formats.map((x) => [x.format, x.url]));
  assert.equal(f.Shapefile, "https://cugir-data.s3.amazonaws.com/00/00/51/cugir-000051.zip");
  assert.equal(f["OGC WMS"], "https://cugir.library.cornell.edu/geoserver/cugir/wms");
  assert.equal(f["FGDC metadata"], "https://cugir-data.s3.amazonaws.com/00/00/51/fgdc.xml");
  assert.equal(d.api_endpoint, null, "no single endpoint is invented");
  assert.deepEqual(references("not json"), {});
});

test("an Aardvark record reads with the Aardvark field names", () => {
  const r = readRecord({ gbl_mdVersion_s: "Aardvark", id: "x-1", dct_title_s: "T", dct_accessRights_s: "Restricted", locn_geometry: "ENVELOPE(-74.3, -73.7, 40.9, 40.5)", schema_provider_s: "NYU" });
  assert.equal(r.schema, "aardvark");
  assert.equal(r.public, false);
  assert.deepEqual(r.bbox, [-74.3, 40.5, -73.7, 40.9]);
  assert.equal(readRecord({ title: "neither schema" }), null);
});

test("restricted, suppressed, withdrawn, other providers' and out-of-state records are dropped and counted", () => {
  const ny = readRecord(cugir);
  const mk = (o) => readRecord({ ...cugir, ...o });
  const recs = [
    ny,
    mk({ layer_slug_s: "a", dc_rights_s: "Restricted" }),
    mk({ layer_slug_s: "b", suppressed_b: true }),
    mk({ layer_slug_s: "c" }),
    mk({ layer_slug_s: "d", dct_provenance_s: "Columbia" }),
    mk({ layer_slug_s: "e", solr_geom: "ENVELOPE(76.76, 84.76, 19.91, 12.62)" }),
  ];
  const f = filterOgm(recs, { withdrawn: new Set(["c"]), provider: "Cornell" });
  assert.deepEqual(f.kept.map((r) => r.id), ["cugir-000051"]);
  assert.deepEqual(f.excluded, { not_public: 1, suppressed: 1, withdrawn: 1, other_provider: 1, out_of_state: 1 });
  const away = Array.from({ length: 5 }, (_, i) => mk({ layer_slug_s: `x${i}`, solr_geom: "ENVELOPE(76.76, 84.76, 19.91, 12.62)" }));
  assert.equal(filterOgm(away, { withdrawn: new Set() }).portal_in_ny.refuse, true, "a repository mostly outside New York is refused");
});

test("the archive is read as tar: records, withdrawn.json, and unreadable files counted", () => {
  const files = readTar(tar([
    ["00/00/51/geoblacklight.json", JSON.stringify(cugir)],
    ["00/00/51/fgdc.xml", "<xml/>"],
    ["withdrawn.json", JSON.stringify({ ogm_version: "1.0", withdrawn: [{ id: "cugir-000099", date: "2026-03-14" }] })],
    ["00/00/52/geoblacklight.json", "{ not json"],
  ]));
  assert.deepEqual(files.map((f) => f.name), ["00/00/51/geoblacklight.json", "00/00/51/fgdc.xml", "withdrawn.json", "00/00/52/geoblacklight.json"]);
  const r = recordsFromFiles(files);
  assert.equal(r.records.length, 1);
  assert.deepEqual([...r.withdrawn], ["cugir-000099"]);
  assert.equal(r.unreadable, 1);
});

async function stubbed(handler, fn) {
  const realFetch = globalThis.fetch;
  const saved = process.env.NY_DATA_OFFLINE;
  process.env.NY_DATA_OFFLINE = "0";
  process.env.NY_DATA_CACHE_DIR = mkdtempSync(join(tmpdir(), "nydr-m6-"));
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    return handler(String(url));
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

test("one request downloads the repository archive through the GitHub API", async () => {
  const gz = gzipSync(tar([["00/00/51/geoblacklight.json", JSON.stringify(cugir)]]));
  await stubbed(
    (u) => (u.endsWith("/robots.txt") ? new Response("", { status: 404 }) : new Response(gz, { status: 200, headers: { "content-type": "application/x-gzip" } })),
    async (calls) => {
      const h = await harvestOgm({ repo: "OpenGeoMetadata/edu.cornell", ref: "main", provider: "Cornell" });
      const api = calls.filter((c) => !c.url.endsWith("robots.txt"));
      assert.deepEqual(api.map((c) => c.url), ["https://api.github.com/repos/OpenGeoMetadata/edu.cornell/tarball/main"]);
      assert.equal(h.requests, 1);
      assert.equal(h.complete, true);
      assert.deepEqual(h.datasets.map((d) => d.native_id), ["cugir-000051"]);
    }
  );
});

// ─── InvenioRDM ─────────────────────────────────────────────────────────────

test("NYU UltraViolet is planned from the registry endpoint, and its adapter starts off", () => {
  assert.deepEqual(invenioTarget("https://ultraviolet.library.nyu.edu/api/communities/sdr/records"), { base: "https://ultraviolet.library.nyu.edu", community: "sdr" });
  assert.deepEqual(invenioTarget("https://example.org/api/records"), { base: "https://example.org", community: null });
  assert.equal(invenioTarget("https://example.org/records/abc"), null);
  const p = planFor(src("new-york-university-libraries--ultraviolet-library-nyu-edu"), cfg);
  assert.equal(p.code, "adapter-off");
  assert.match(p.reason, /supervised run/);
  const on = { ...cfg, adapters: { ...cfg.adapters, "invenio-rdm": { enabled: true } } };
  assert.deepEqual(planFor(src("new-york-university-libraries--ultraviolet-library-nyu-edu"), on), {
    kind: "invenio-rdm", target: { base: "https://ultraviolet.library.nyu.edu", community: "sdr" },
  });
});

test("New York filter: geometry first, then a named place; the docs' CERN point is outside", () => {
  assert.equal(newYorkVerdict(invDoc).verdict, "geometry-outside");
  const pt = (c) => ({ ...invDoc, metadata: { ...invDoc.metadata, locations: { features: [{ geometry: { type: "Point", coordinates: c } }] } } });
  assert.equal(newYorkVerdict(pt([-73.97, 40.78])).verdict, "geometry-in-ny");
  assert.deepEqual(geometryBox({ type: "Polygon", coordinates: [[[-74, 40], [-73, 40], [-73, 41], [-74, 40]]] }), [-74, 40, -73, 41]);
  const none = { ...invDoc, metadata: { ...invDoc.metadata, locations: undefined } };
  assert.equal(newYorkVerdict(none).verdict, "no-location");
  assert.equal(newYorkVerdict({ ...none, metadata: { ...none.metadata, title: "Subway entrances, New York City, 2019" } }).verdict, "named-ny");
  assert.equal(newYorkVerdict({ ...none, metadata: { ...none.metadata, subjects: [{ subject: "Brooklyn (New York, N.Y.)" }] } }).verdict, "named-ny");
});

test("an InvenioRDM record maps to its landing page and record API, never its files", () => {
  const d = mapInvenioRecord(invDoc, null);
  assert.equal(d.native_id, "cbc2k-q9x58");
  assert.equal(d.name, "An Updated Romans story");
  assert.equal(d.permalink, "https://ultraviolet.library.nyu.edu/records/cbc2k-q9x58");
  assert.equal(d.api_endpoint, "https://ultraviolet.library.nyu.edu/api/records/cbc2k-q9x58");
  assert.equal(d.type, "Photo");
  assert.ok(!d.formats.some((f) => /\/files/.test(f.url)));
});

test("community records are paged oldest first; restricted and out-of-state records are dropped", async () => {
  const nyPublic = { ...invDoc, id: "ny-1", access: { record: "public", files: "public" }, metadata: { ...invDoc.metadata, title: "Tax lots, New York City", locations: undefined } };
  const away = { ...invDoc, id: "away-1", access: { record: "public", files: "public" } };
  const pages = { 1: [invDoc, nyPublic], 2: [away] };
  await stubbed(
    (u) => {
      if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
      const page = Number(new URL(u).searchParams.get("page"));
      return new Response(JSON.stringify({ hits: { hits: pages[page] ?? [], total: 3 }, links: {} }), { status: 200, headers: { "content-type": "application/json" } });
    },
    async (calls) => {
      const h = await harvestInvenio({ base: "https://ultraviolet.library.nyu.edu", community: "sdr" }, { pageSize: 2 });
      const api = calls.filter((c) => !c.url.endsWith("robots.txt")).map((c) => c.url);
      assert.deepEqual(api, [
        "https://ultraviolet.library.nyu.edu/api/communities/sdr/records?sort=oldest&size=2&page=1",
        "https://ultraviolet.library.nyu.edu/api/communities/sdr/records?sort=oldest&size=2&page=2",
      ]);
      assert.equal(h.complete, true);
      assert.deepEqual(h.datasets.map((d) => d.native_id), ["ny-1"]);
      assert.deepEqual(h.excluded, { restricted: 1, "geometry-outside": 1, "no-location": 0 });
    }
  );
});
