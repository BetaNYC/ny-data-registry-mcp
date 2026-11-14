/**
 * A small, comparable summary of one index file: totals and per-portal dataset counts.
 * The publish gate compares tonight's index with the published one through these.
 */
import { DatabaseSync } from "node:sqlite";

export interface PortalSummary {
  datasets: number;
  harvest_status: string | null;
}

export interface IndexSummary {
  schema_version: number | null;
  last_harvest: string | null;
  registry_generated: string | null;
  datasets: number;
  portals_ok: number;
  portals_failed: number;
  portals: Record<string, PortalSummary>;
}

/** Harvest outcomes that keep a portal's data in the index. */
export const HEALTHY_STATUSES = new Set(["ok", "partial"]);
/** Harvest outcomes counted as failed in the manifest. */
export const FAILED_STATUSES = new Set(["failed", "blocked"]);

export function indexSummary(path: string): IndexSummary {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const meta = (k: string) => (db.prepare("SELECT value FROM meta WHERE key = ?").get(k) as { value: string } | undefined)?.value ?? null;
    const sv = meta("schema_version");
    const portals: Record<string, PortalSummary> = {};
    const rows = db
      .prepare(
        `SELECT p.id AS id, p.harvest_status AS status,
                (SELECT COUNT(*) FROM datasets d WHERE d.portal_id = p.id AND d.removed_at IS NULL) AS n
         FROM portals p`
      )
      .all() as { id: string; status: string | null; n: number }[];
    for (const r of rows) {
      // Portals the harvest never read (registry rows with no adapter) carry no status and no data.
      if (r.status === null && r.n === 0) continue;
      portals[r.id] = { datasets: Number(r.n), harvest_status: r.status };
    }
    const datasets = (db.prepare("SELECT COUNT(*) AS n FROM datasets WHERE removed_at IS NULL").get() as { n: number }).n;
    const statuses = Object.values(portals).map((p) => p.harvest_status ?? "");
    return {
      schema_version: sv === null ? null : Number(sv),
      last_harvest: meta("last_harvest"),
      registry_generated: meta("registry_generated"),
      datasets: Number(datasets),
      portals_ok: statuses.filter((s) => s === "ok").length,
      portals_failed: statuses.filter((s) => FAILED_STATUSES.has(s)).length,
      portals,
    };
  } finally {
    db.close();
  }
}
