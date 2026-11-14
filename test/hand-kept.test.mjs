// The hand-kept list (issue #16, milestone 5; epic #7, D6). No network: the file is the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempIndexPath } from "./helpers.mjs";
import { handKept, handKeptEntry, mapHandKept, linkUsable, LINK_RESULTS, RESOURCE_KINDS } from "../dist/harvest/hand-kept.js";
import { planFor, runHarvest } from "../dist/harvest/run.js";
import { loadBundled } from "../dist/registry.js";
import { readDataJson } from "../dist/paths.js";

const cfg = readDataJson("harvest-config.json");
const reg = loadBundled();
const src = (id) => reg.sources.find((s) => s.source_id === id);

test("every entry matches a registry row by id and entity, and every resource is complete", () => {
  const d = handKept();
  assert.ok(d.entries.length > 0);
  const ids = new Set();
  for (const e of d.entries) {
    assert.ok(!ids.has(e.source_id), `duplicate entry ${e.source_id}`);
    ids.add(e.source_id);
    const row = src(e.source_id);
    assert.ok(row, `${e.source_id} is not in the registry`);
    assert.equal(row.entity, e.entity, `${e.source_id}: entity changed in the registry; check the entry again`);
    const urls = new Set();
    for (const r of e.resources) {
      assert.match(r.url, /^https?:\/\/\S+$/, r.url);
      assert.ok(!urls.has(r.url), `${e.source_id}: duplicate ${r.url}`);
      urls.add(r.url);
      assert.ok(RESOURCE_KINDS.includes(r.kind), r.kind);
      assert.ok(r.title && r.description && r.source, e.source_id);
      assert.match(r.recorded, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(typeof r.checked, "boolean");
    }
  }
});

test("a row with no data link uses its entry; a row an adapter reads never does", () => {
  const p = planFor(src("allegany-county"), cfg);
  assert.equal(p.kind, "hand-kept");
  assert.ok(p.entry.resources.length > 0);
  for (const s of reg.sources) {
    const plan = planFor(s, cfg);
    if (plan.kind === "hand-kept") {
      assert.notEqual(s.status, "dead");
      assert.equal(s.key_required === "Y", false, `${s.source_id} needs a key`);
    }
  }
  assert.equal(planFor(src("broome-county"), cfg).kind, "arcgis-server");
  const off = { ...cfg, adapters: { ...cfg.adapters, "hand-kept": { enabled: false } } };
  assert.equal(planFor(src("allegany-county"), off).code, "adapter-off");
});

test("an entry whose entity no longer matches, or that lists nothing, is not used", () => {
  const row = src("allegany-county");
  const res = [{ title: "t", url: "https://example.gov/x", kind: "page", description: "d", source: "s", recorded: "2026-11-14", checked: false }];
  assert.equal(handKeptEntry(row, { entries: [{ source_id: row.source_id, entity: "Somewhere Else", resources: res }] }), null);
  assert.equal(handKeptEntry(row, { entries: [{ source_id: row.source_id, entity: row.entity, resources: [] }] }), null);
  assert.ok(handKeptEntry(row, { entries: [{ source_id: row.source_id, entity: row.entity, resources: res }] }));
});

test("a resource becomes a plain link in the index: no endpoint, no columns, marked hand-kept and unchecked", () => {
  const r = { title: "Allegany County parcel viewer", url: "https://example.gov/viewer", kind: "viewer", description: "A viewer.", source: "the State's page", recorded: "2026-11-14", checked: false };
  const d = mapHandKept(r);
  assert.match(d.native_id, /^hand-kept:[0-9a-f]{16}$/);
  assert.equal(mapHandKept({ ...r, title: "renamed" }).native_id, d.native_id, "the id follows the URL");
  assert.equal(d.api_endpoint, null);
  assert.deepEqual(d.formats, []);
  assert.equal(d.type, "hand-kept viewer");
  assert.equal(d.permalink, r.url);
  assert.match(d.description, /Not yet checked; from the State's page, 2026-11-14/);
  assert.equal(d.provenance.name, "hand-kept");
});

test("the harvest writes hand-kept entries with no network call", async () => {
  process.env.NY_DATA_INDEX = tempIndexPath();
  const s = await runHarvest({ only: ["allegany-county"], log: () => {} });
  const p = s.portals[0];
  assert.equal(p.adapter, "hand-kept");
  assert.equal(p.outcome, "ok", "NY_DATA_OFFLINE=1: any request would have failed it");
  assert.equal(p.requests, 0);
  assert.equal(p.datasets, planFor(src("allegany-county"), cfg).entry.resources.length);
});

test("link checks: every link has one, a broken link is kept in the file but left out of the index, others are flagged", () => {
  for (const e of handKept().entries) {
    for (const r of e.resources) {
      assert.ok(r.link_check, `${r.url} has no link check`);
      assert.ok(LINK_RESULTS.includes(r.link_check.result), r.link_check.result);
      assert.match(r.link_check.checked, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(r.checked, false, "an automated check is not a person opening the link");
    }
  }
  const row = src("allegany-county");
  const base = { title: "t", kind: "page", description: "d", source: "s", recorded: "2026-11-14", checked: false };
  const ok = { ...base, url: "https://example.gov/ok", link_check: { checked: "2026-11-14", final_url: "https://example.gov/ok", http_status: 200, result: "ok" } };
  const broken = { ...base, url: "https://example.gov/gone", link_check: { checked: "2026-11-14", final_url: "https://example.gov/gone", http_status: 404, result: "broken" } };
  const blocked = { ...base, url: "https://example.gov/login", link_check: { checked: "2026-11-14", final_url: null, http_status: 401, result: "blocked", note: "login required (401)" } };
  const e = handKeptEntry(row, { entries: [{ source_id: row.source_id, entity: row.entity, resources: [ok, broken, blocked] }] });
  assert.deepEqual(e.resources.map((r) => r.url), [ok.url, blocked.url]);
  assert.equal(handKeptEntry(row, { entries: [{ source_id: row.source_id, entity: row.entity, resources: [broken] }] }), null, "all broken: nothing to list");
  assert.ok(!linkUsable(broken) && linkUsable(ok) && linkUsable(blocked) && linkUsable(base));
  assert.match(mapHandKept(blocked).description, /Link check 2026-11-14: blocked, login required \(401\)\.$/);
  assert.doesNotMatch(mapHandKept(ok).description, /Link check/);
  // The real file: Seneca County's 404 page is kept but not indexed.
  const seneca = handKept().entries.find((x) => x.source_id === "seneca-county");
  const gone = seneca.resources.find((r) => r.link_check.result === "broken");
  assert.ok(gone);
  assert.ok(!handKeptEntry(src("seneca-county")).resources.some((r) => r.url === gone.url));
});
