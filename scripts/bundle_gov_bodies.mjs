#!/usr/bin/env node
// Rebuild data/gov-bodies.json, the bundled fallback of the master list of government bodies
// (BetaNYC/ny-gov-web-registry data/registry.json). It keeps only the bodies that the bundled
// registry's rows point to by registry_id, and only the fields a reply uses.
//
//   npm run build
//   node scripts/bundle_gov_bodies.mjs [--from <local registry.json>] [--commit <sha>]
//
// Without --from it reads the published file once. It never writes to the master list.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { slimMasterList, GOV_REGISTRY_URL } = await import("../dist/govbodies.js");
const { USER_AGENT } = await import("../dist/paths.js");

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const from = arg("from");
const raw = from
  ? JSON.parse(readFileSync(from, "utf8"))
  : await (await fetch(GOV_REGISTRY_URL, { headers: { "User-Agent": USER_AGENT } })).json();
const all = slimMasterList(raw);
if (!all) throw new Error("the master list has no entities");

const registry = JSON.parse(readFileSync(fileURLToPath(new URL("../data/ny-data-portal-registry.json", import.meta.url)), "utf8"));
const wanted = new Set(
  registry.rows.map((r) => (typeof r.registry_id === "string" ? r.registry_id.trim() : "")).filter((v) => v && v !== "—")
);
const bodies = all.filter((b) => wanted.has(b.id)).sort((a, b) => a.id.localeCompare(b.id));
const missing = [...wanted].filter((id) => !bodies.some((b) => b.id === id)).sort();

const doc = {
  source: GOV_REGISTRY_URL,
  snapshot_date: new Date().toISOString().slice(0, 10),
  ...(arg("commit") ? { source_commit: arg("commit") } : {}),
  note: "Bundled fallback: only the bodies the bundled registry's rows point to. Rebuild with scripts/bundle_gov_bodies.mjs.",
  bodies,
};
writeFileSync(fileURLToPath(new URL("../data/gov-bodies.json", import.meta.url)), JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${bodies.length} of ${all.length} bodies (${wanted.size} ids in the bundled registry)`);
if (missing.length) console.log(`not in the master list: ${missing.join(", ")}`);
