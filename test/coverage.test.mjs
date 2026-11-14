// The coverage command (issue #16, milestone 1): what is and isn't harvested, offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureIndex, tempIndexPath } from "./helpers.mjs";
import { buildCoverage, coverageMarkdown } from "../dist/coverage.js";
import { loadBundled } from "../dist/registry.js";
import { planFor, adapterEnabled } from "../dist/harvest/run.js";
import { readDataJson } from "../dist/paths.js";

const cfg = readDataJson("harvest-config.json");
const reg = loadBundled();
const row = (r, id) => r.rows.find((x) => x.source_id === id);

test("every registry row gets exactly one state, and the totals add up", async () => {
  const idx = await buildFixtureIndex(tempIndexPath());
  const r = buildCoverage(reg, { indexPath: idx });
  assert.equal(r.rows.length, reg.sources.length);
  assert.equal(Object.values(r.totals).reduce((a, b) => a + b, 0), reg.sources.length);
  assert.equal(Object.values(r.by_skip_code).reduce((a, b) => a + b, 0), r.totals["not-harvested"]);
  assert.equal(row(r, "nys-department-of-health").state, "harvested");
  assert.equal(row(r, "nys-department-of-health").index.datasets > 0, true);
  assert.equal(row(r, "cortland-county").state, "harvested");
  assert.equal(row(r, "monroe-county").state, "not-yet-read", "an adapter would read it; the fixture index has no read");
  assert.equal(r.by_adapter.socrata.harvested >= 2, true);
});

test("each skipped row says why, with a fixed code", () => {
  const r = buildCoverage(reg, { indexPath: null });
  assert.equal(r.index_path, null);
  assert.equal(r.totals.harvested, 0);
  assert.equal(row(r, "city-of-albany").skip_code, "not-live");
  assert.equal(row(r, "association-for-neighborhood-and-housing-development-anhd").skip_code, "policy");
  assert.equal(row(r, "rockland-county").skip_code, "policy");
  assert.equal(row(r, "new-york-state-senate").skip_code, "policy", "key required");
  const greene = row(r, "greene-county");
  assert.equal(greene.skip_code, "no-portal");
  assert.equal(greene.documented_endpoint, "https://gis.gcgovny.com/arcgis/rest/services", "the registry's endpoint, verbatim");
  for (const x of r.rows) {
    assert.equal(x.adapter === null, x.state === "not-harvested", x.source_id);
    if (x.state === "not-harvested") assert.ok(x.reason && x.skip_code, x.source_id);
  }
});

test("an adapter switched off in harvest-config.json reports adapter-off, and only for its portals", () => {
  const off = { ...cfg, adapters: { ...cfg.adapters, enterprise: { enabled: false, note: "test" } } };
  assert.equal(adapterEnabled("enterprise", off), false);
  assert.equal(adapterEnabled("socrata", off), true);
  assert.equal(adapterEnabled("not-listed", off), true, "an adapter not listed is on");
  const p = planFor(reg.sources.find((s) => s.source_id === "monroe-county"), off);
  assert.equal(p.kind, "skip");
  assert.equal(p.code, "adapter-off");
  assert.match(p.reason, /switched off.*test/);
  const r = buildCoverage(reg, { indexPath: null, cfg: off });
  assert.equal(row(r, "monroe-county").skip_code, "adapter-off");
  assert.equal(row(r, "nys-department-of-health").adapter, "socrata");
});

test("the markdown report lists the totals and the reasons", () => {
  const md = coverageMarkdown(buildCoverage(reg, { indexPath: null }));
  assert.match(md, /^# Harvest coverage/);
  assert.match(md, /\| not-harvested \| \d+ \|/);
  assert.match(md, /### Registry says no portal \(\d+\)/);
  assert.match(md, /greene-county/);
});

test("`coverage --json` runs offline from the registry and an index", async () => {
  const idx = await buildFixtureIndex(tempIndexPath());
  const cache = mkdtempSync(join(tmpdir(), "nydr-cov-"));
  const out = execFileSync(process.execPath, ["dist/cli.js", "coverage", "--json", "--index", idx], {
    env: { ...process.env, NY_DATA_OFFLINE: "1", NY_DATA_CACHE_DIR: cache },
    encoding: "utf8",
  });
  const r = JSON.parse(out);
  assert.equal(r.registry_origin, "bundled", "no cached copy in an empty cache dir; never fetched");
  assert.equal(r.registry_rows, reg.sources.length);
  assert.equal(r.index_path, idx);
});
