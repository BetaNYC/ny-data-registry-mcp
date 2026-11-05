#!/usr/bin/env node
/**
 * ny-data-registry harvest [--only id,id] [--max-layers N] [--concurrency N] [--stats-out file]
 * ny-data-registry eval [--out file]
 * ny-data-registry stats
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runHarvest } from "./harvest/run.js";
import { refreshRegistry } from "./registry.js";
import { indexInfo } from "./datasets.js";
import { runEval } from "./eval.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const cmd = process.argv[2];
await refreshRegistry();
if (cmd === "harvest") {
  const summary = await runHarvest({
    only: arg("only")?.split(","),
    maxLayers: arg("max-layers") ? Number(arg("max-layers")) : undefined,
    concurrency: arg("concurrency") ? Number(arg("concurrency")) : undefined,
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
  console.log(res.markdown);
  process.exitCode = res.passed ? 0 : 1;
} else if (cmd === "stats") {
  console.log(JSON.stringify(indexInfo(), null, 2));
} else {
  console.error("usage: ny-data-registry <harvest|eval|stats> [options]");
  process.exitCode = 2;
}
