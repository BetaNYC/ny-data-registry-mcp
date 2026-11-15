#!/usr/bin/env node
/**
 * ny-data-registry harvest [--only id,id] [--max-layers N] [--concurrency N] [--stats-out file] [--ignore-cadence]
 * ny-data-registry eval [--out file] [--result-out file.json]
 * ny-data-registry stats
 * ny-data-registry download [--force]
 * ny-data-registry update [--check]
 * ny-data-registry topics [--crosswalk-out file.csv]
 * ny-data-registry coverage [--json] [--out file] [--index path] [--refresh]
 * ny-data-registry parcels [--json] [--out file] [--index path] [--refresh]
 * ny-data-registry standards [--out-dir dir]
 *
 * `update` exit codes: UPDATE_EXIT_CODES in refresh.ts (2 is a usage error).
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runHarvest } from "./harvest/run.js";
import { loadLocal, refreshRegistry, setRegistry } from "./registry.js";
import { buildCoverage, coverageMarkdown } from "./coverage.js";
import { buildParcelTable, parcelMarkdown, type ParcelSources } from "./parcels.js";
import { refreshGovBodies } from "./govbodies.js";
import { indexInfo } from "./datasets.js";
import { runEval } from "./eval.js";
import { downloadIndex, indexUrl } from "./fetchindex.js";
import { checkForUpdate, UPDATE_EXIT_CODES } from "./refresh.js";
import { openDb, indexExists } from "./db.js";
import { cacheDir, DATA_DIR, indexPath, readDataJson } from "./paths.js";
import { writeStatewide } from "./standards/statewide.js";
import { buildTopics, computeTopics, crosswalkCsv } from "./topics.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}


const cmd = process.argv[2];
const OFFLINE_CMDS = new Set(["download", "update", "topics", "coverage", "parcels", "standards"]);
if (!OFFLINE_CMDS.has(cmd)) await refreshRegistry();
if (cmd === "eval") await refreshGovBodies();
if (cmd === "update") {
  const extra = process.argv.slice(3).filter((a) => a !== "--check");
  if (extra.length) {
    console.error(`unknown option(s) for update: ${extra.join(" ")}\nusage: ny-data-registry update [--check]`);
    process.exitCode = 2;
  } else {
    const r = await checkForUpdate({ manual: true, checkOnly: process.argv.includes("--check") });
    (r.outcome === "failed" ? console.error : console.log)(r.message);
    process.exitCode = UPDATE_EXIT_CODES[r.outcome];
  }
} else if (cmd === "download") {
  const force = process.argv.includes("--force");
  console.error(`downloading ${indexUrl()} ...`);
  const r = await downloadIndex({ force });
  console.log(r.skipped ? `index already installed at ${r.path} (${r.bytes} bytes); use --force to replace it` : `installed ${r.path} (${r.bytes} bytes), checksums verified`);
} else if (cmd === "harvest") {
  const summary = await runHarvest({
    only: arg("only")?.split(","),
    maxLayers: arg("max-layers") ? Number(arg("max-layers")) : undefined,
    concurrency: arg("concurrency") ? Number(arg("concurrency")) : undefined,
    ignoreCadence: process.argv.includes("--ignore-cadence"),
  });
  const out = arg("stats-out");
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(summary, null, 2));
  }
  const { portals, ...head } = summary;
  console.log(JSON.stringify(head, null, 2));
  console.log(`portals: ${portals.length} entries (see --stats-out for detail)`);
} else if (cmd === "eval") {
  const res = await runEval();
  const out = arg("out");
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, res.markdown);
  }
  const resultOut = arg("result-out");
  if (resultOut) {
    mkdirSync(dirname(resultOut), { recursive: true });
    const { markdown, ...result } = res;
    writeFileSync(resultOut, JSON.stringify(result, null, 2));
  }
  console.log(res.markdown);
  process.exitCode = res.passed ? 0 : 1;
} else if (cmd === "topics") {
  // Rebuild the topics on an existing index (the harvest does this itself) and report coverage.
  if (!indexExists()) {
    console.error(`no index at ${indexPath()}; run download or harvest first`);
    process.exitCode = 1;
  } else {
    const db = openDb();
    const t = buildTopics(db);
    const out = arg("crosswalk-out");
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, crosswalkCsv(computeTopics(db).crosswalk));
    }
    db.close();
    console.log(JSON.stringify(t, null, 2));
  }
} else if (cmd === "coverage") {
  // Offline: the newest registry on this machine (or a fresh one with --refresh), the
  // harvest config, and an index file. No portal is called.
  const reg = process.argv.includes("--refresh") ? await refreshRegistry() : loadLocal();
  setRegistry(reg);
  const report = buildCoverage(reg, { indexPath: arg("index") ?? indexPath() });
  const text = process.argv.includes("--json") ? JSON.stringify(report, null, 2) : coverageMarkdown(report);
  const out = arg("out");
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text + "\n");
  }
  console.log(text);
} else if (cmd === "parcels") {
  // Offline: data/parcel-sources.json, the recorded State service response, the registry and an index.
  const reg = process.argv.includes("--refresh") ? await refreshRegistry() : loadLocal();
  setRegistry(reg);
  const src = readDataJson<ParcelSources>("parcel-sources.json");
  const evidence = JSON.parse(readFileSync(join(DATA_DIR, "..", src.state_layer.read.evidence_file), "utf8")) as { serviceDescription: string };
  const table = buildParcelTable(reg, { indexPath: arg("index") ?? indexPath(), sources: src, serviceDescription: evidence.serviceDescription });
  const text = process.argv.includes("--json") ? JSON.stringify(table, null, 2) : parcelMarkdown(table);
  const out = arg("out");
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text + "\n");
  }
  console.log(text);
} else if (cmd === "standards") {
  // The statewide Croissant and DCAT-US files, from the installed index (the nightly publish makes the same files).
  if (!indexExists()) {
    console.error(`no index at ${indexPath()}; run download or harvest first`);
    process.exitCode = 1;
  } else {
    const dir = arg("out-dir") ?? join(cacheDir(), "standards");
    const stats = writeStatewide(indexPath(), dir);
    console.log(JSON.stringify({ out_dir: dir, ...stats }, null, 2));
  }
} else if (cmd === "stats") {
  console.log(JSON.stringify(indexInfo(), null, 2));
} else {
  console.error("usage: ny-data-registry <update|download|harvest|eval|stats|topics|coverage|parcels|standards> [options]");
  process.exitCode = 2;
}
