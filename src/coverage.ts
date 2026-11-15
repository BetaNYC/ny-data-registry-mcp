/**
 * Coverage: which registry rows the harvest reads, and why the rest are not read (issue #16,
 * milestone 1). Built offline from the registry, harvest-config.json and an index file. It
 * never calls a portal.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { readDataJson } from "./paths.js";
import type { LoadedRegistry, Source } from "./registry.js";
import { planFor, type SkipCode } from "./harvest/run.js";

export type CoverageState =
  /** Read, healthy, with datasets in the index. */
  | "harvested"
  /** Read and healthy, but no datasets kept (all filtered out, or an empty catalog). */
  | "read-empty"
  /** The last read failed, was blocked, or was refused by the out-of-state guard. */
  | "failing"
  /** An adapter would read it, but the index has no read yet (new row, new adapter, or no index). */
  | "not-yet-read"
  /** No adapter reads it; `skip_code` says why. */
  | "not-harvested";

export interface CoverageRow {
  source_id: string;
  entity: string;
  entity_type: string;
  region: string;
  registry_status: string;
  platform: string | null;
  platform_family: string | null;
  adapter: string | null;
  state: CoverageState;
  skip_code: SkipCode | null;
  reason: string | null;
  /** The registry's api_endpoint, when the row is not harvested but documents one. */
  documented_endpoint: string | null;
  index: { harvest_status: string | null; harvest_adapter: string | null; datasets: number; last_harvested: string | null } | null;
}

export interface CoverageReport {
  generated_at: string;
  registry_generated: string;
  registry_origin: string;
  registry_rows: number;
  index_path: string | null;
  index_last_harvest: string | null;
  totals: Record<CoverageState, number>;
  by_skip_code: Partial<Record<SkipCode, number>>;
  by_adapter: Record<string, { portals: number; harvested: number; datasets: number }>;
  rows: CoverageRow[];
}

const HEALTHY = new Set(["ok", "partial"]);
const FAILING = new Set(["failed", "blocked", "refused"]);

interface IndexPortal {
  id: string;
  harvest_status: string | null;
  harvest_adapter: string | null;
  last_harvested: string | null;
  n: number;
}

function readIndex(path: string): { portals: Map<string, IndexPortal>; last_harvest: string | null } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT p.id AS id, p.harvest_status AS harvest_status, p.harvest_adapter AS harvest_adapter, p.last_harvested AS last_harvested,
                (SELECT COUNT(*) FROM datasets d WHERE d.portal_id = p.id AND d.removed_at IS NULL) AS n
         FROM portals p`
      )
      .all() as unknown as IndexPortal[];
    const last = (db.prepare("SELECT value FROM meta WHERE key = 'last_harvest'").get() as { value: string } | undefined)?.value ?? null;
    return { portals: new Map(rows.map((r) => [r.id, { ...r, n: Number(r.n) }])), last_harvest: last };
  } finally {
    db.close();
  }
}

export function coverageRow(s: Source, cfg: Parameters<typeof planFor>[1], idx: IndexPortal | undefined): CoverageRow {
  const plan = planFor(s, cfg);
  const index = idx ? { harvest_status: idx.harvest_status, harvest_adapter: idx.harvest_adapter, datasets: idx.n, last_harvested: idx.last_harvested } : null;
  const base = {
    source_id: s.source_id,
    entity: s.entity,
    entity_type: s.entity_type,
    region: s.region,
    registry_status: s.status,
    platform: s.platform,
    platform_family: s.platform_family,
    index,
  };
  if (plan.kind === "skip") {
    return { ...base, adapter: null, state: "not-harvested", skip_code: plan.code, reason: plan.reason, documented_endpoint: s.api_endpoint?.trim() || null };
  }
  let state: CoverageState = "not-yet-read";
  if (idx && HEALTHY.has(idx.harvest_status ?? "")) state = idx.n > 0 ? "harvested" : "read-empty";
  else if (idx && FAILING.has(idx.harvest_status ?? "")) state = "failing";
  return { ...base, adapter: plan.kind, state, skip_code: null, reason: null, documented_endpoint: null };
}

export function buildCoverage(reg: LoadedRegistry, opts: { indexPath?: string | null; cfg?: Parameters<typeof planFor>[1]; now?: Date } = {}): CoverageReport {
  const cfg = opts.cfg ?? readDataJson<Parameters<typeof planFor>[1]>("harvest-config.json");
  const idx = opts.indexPath && existsSync(opts.indexPath) ? readIndex(opts.indexPath) : null;
  const rows = reg.sources.map((s) => coverageRow(s, cfg, idx?.portals.get(s.source_id)));
  const totals: Record<CoverageState, number> = { harvested: 0, "read-empty": 0, failing: 0, "not-yet-read": 0, "not-harvested": 0 };
  const by_skip_code: Partial<Record<SkipCode, number>> = {};
  const by_adapter: CoverageReport["by_adapter"] = {};
  for (const r of rows) {
    totals[r.state]++;
    if (r.skip_code) by_skip_code[r.skip_code] = (by_skip_code[r.skip_code] ?? 0) + 1;
    if (r.adapter) {
      const a = (by_adapter[r.adapter] ??= { portals: 0, harvested: 0, datasets: 0 });
      a.portals++;
      if (r.state === "harvested") a.harvested++;
      a.datasets += r.index?.datasets ?? 0;
    }
  }
  return {
    generated_at: (opts.now ?? new Date()).toISOString(),
    registry_generated: reg.generated,
    registry_origin: reg.origin,
    registry_rows: reg.sources.length,
    index_path: idx ? opts.indexPath! : null,
    index_last_harvest: idx?.last_harvest ?? null,
    totals,
    by_skip_code,
    by_adapter,
    rows,
  };
}

const SKIP_LABEL: Record<SkipCode, string> = {
  "not-live": "Registry says dead or unconfirmed",
  "no-portal": "Registry says no portal",
  policy: "Never called (key, account, blocks clients, or excluded)",
  "adapter-off": "Adapter switched off in harvest-config.json",
  "no-adapter": "Has an API, but no adapter in this build",
  "described-only": "Custom API: described, not harvested",
  "no-api": "No API (pages, viewers, downloads)",
  unmapped: "Platform not in platform-families.json",
  unconfirmed: "Platform family unconfirmed",
  "incomplete-row": "Row lacks the URL or domain an adapter needs",
};

const cell = (s: string | null | undefined) => (s ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();

export function coverageMarkdown(r: CoverageReport): string {
  const L: string[] = [];
  L.push(`# Harvest coverage`, "");
  L.push(`Registry ${r.registry_generated} (${r.registry_origin}), ${r.registry_rows} rows. ` + (r.index_path ? `Index harvested ${r.index_last_harvest ?? "?"}.` : "No index: nothing has been read yet."), "");
  L.push("| state | rows |", "|---|---|");
  for (const [k, v] of Object.entries(r.totals)) L.push(`| ${k} | ${v} |`);
  L.push("", "## By adapter", "", "| adapter | portals | harvested | datasets in index |", "|---|---|---|---|");
  for (const [k, v] of Object.entries(r.by_adapter).sort()) L.push(`| ${k} | ${v.portals} | ${v.harvested} | ${v.datasets} |`);
  const read = r.rows.filter((x) => x.adapter && x.state !== "harvested");
  if (read.length) {
    L.push("", "## Has an adapter, but no datasets in the index", "", "| portal | adapter | state | last status |", "|---|---|---|---|");
    for (const x of read) L.push(`| ${cell(x.entity)} (\`${x.source_id}\`) | ${x.adapter} | ${x.state} | ${cell(x.index?.harvest_status)} |`);
  }
  L.push("", "## Not harvested, by reason", "");
  for (const code of Object.keys(SKIP_LABEL) as SkipCode[]) {
    const rows = r.rows.filter((x) => x.skip_code === code);
    if (!rows.length) continue;
    L.push(`### ${SKIP_LABEL[code]} (${rows.length})`, "", "| portal | platform | documented endpoint |", "|---|---|---|");
    for (const x of rows) L.push(`| ${cell(x.entity)} (\`${x.source_id}\`) | ${cell(x.platform)} | ${cell(x.documented_endpoint)} |`);
    L.push("");
  }
  return L.join("\n");
}
