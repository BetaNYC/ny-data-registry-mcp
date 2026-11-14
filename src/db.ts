/**
 * The harvested index: one SQLite file with FTS5. Uses Node's built-in node:sqlite
 * (Node >= 22.16, the first official build whose bundled SQLite has FTS5), so there
 * is no native dependency to compile.
 *
 * Schema is a superset of Scout's TypeORM entities (Portal, Dataset, DatasetColumn,
 * Tag); see docs/scout-mapping.md. Missing values stay NULL; nothing is invented.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { indexPath } from "./paths.js";
import { keyLabel } from "./keycolumns.js";

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS portals (
  id TEXT PRIMARY KEY,               -- registry source_id (derived)
  name TEXT NOT NULL,                -- Scout Portal.name
  base_url TEXT,                     -- Scout Portal.baseURL
  logo TEXT,                         -- Scout Portal.logo (not collected: always NULL)
  admin_level TEXT,                  -- Scout Portal.adminLevel (from registry entity_type / scope)
  dataset_count INTEGER,             -- Scout Portal.datasetCount (harvested count)
  abbreviation TEXT,                 -- Scout Portal.abbreviation (not collected: NULL)
  entity TEXT, region TEXT, place_scope TEXT, place_counties TEXT, place_city TEXT,
  platform_family TEXT, platform_raw TEXT, api_type_raw TEXT, api_endpoint TEXT,
  registry_dataset_count INTEGER, registry_status TEXT, registry_last_verified TEXT,
  harvest_adapter TEXT, harvest_status TEXT, harvest_note TEXT, last_harvested TEXT,
  socrata_domain TEXT, arcgis_org_id TEXT
);
CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,               -- portal-namespaced: '<portal_id>:<native_id>'
  portal_id TEXT NOT NULL REFERENCES portals(id),
  native_id TEXT NOT NULL,           -- Socrata 4x4 exactly (= Scout Dataset.id), ArcGIS item id
  name TEXT, description TEXT, department TEXT, categories TEXT,
  metadata_updated_at TEXT, updated_at TEXT, created_at TEXT,
  type TEXT, permalink TEXT, downloads INTEGER, views INTEGER, update_frequency TEXT,
  is_test INTEGER NOT NULL DEFAULT 0,
  platform_family TEXT, api_endpoint TEXT, formats TEXT,
  place_counties TEXT, place_city TEXT, extent TEXT,
  license TEXT, publisher TEXT, row_count INTEGER, geometry_type TEXT,
  owner TEXT, org_id TEXT,
  columns_status TEXT,               -- from-search | fetched | not-fetched | none | error
  column_count INTEGER,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, removed_at TEXT,
  content_hash TEXT NOT NULL,
  provenance TEXT NOT NULL           -- JSON {field: 'portal' | 'derived'}
);
CREATE INDEX IF NOT EXISTS datasets_portal ON datasets(portal_id);
CREATE INDEX IF NOT EXISTS datasets_native ON datasets(native_id);
CREATE TABLE IF NOT EXISTS dataset_columns (
  id INTEGER PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  portal_id TEXT NOT NULL,
  name TEXT, field TEXT, type TEXT, description TEXT, layer TEXT,
  key_label TEXT,                    -- normalized join key (derived), see data/key-columns.json
  key_scope TEXT
);
CREATE INDEX IF NOT EXISTS columns_dataset ON dataset_columns(dataset_id);
CREATE INDEX IF NOT EXISTS columns_key ON dataset_columns(key_label);
CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY, portal_id TEXT NOT NULL, name TEXT NOT NULL, UNIQUE(portal_id, name));
CREATE TABLE IF NOT EXISTS dataset_tags (dataset_id TEXT NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (dataset_id, tag_id));
CREATE TABLE IF NOT EXISTS changes (id INTEGER PRIMARY KEY, dataset_id TEXT NOT NULL, portal_id TEXT NOT NULL, change TEXT NOT NULL, at TEXT NOT NULL, run_id INTEGER);
CREATE INDEX IF NOT EXISTS changes_at ON changes(at);
CREATE TABLE IF NOT EXISTS harvest_runs (id INTEGER PRIMARY KEY, started_at TEXT, finished_at TEXT, stats TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS datasets_fts USING fts5(
  dataset_id UNINDEXED, name, description, tags, columns, portal, place,
  tokenize = 'porter unicode61'
);
`;

export interface Distribution {
  format: string;
  media_type: string | null;
  url: string | null;
  provenance: "portal" | "derived";
}

export interface HarvestedColumn {
  name: string | null;
  field: string | null;
  type: string | null;
  description: string | null;
  layer?: string | null;
}

export interface HarvestedDataset {
  native_id: string;
  name: string | null;
  description: string | null;
  department: string | null;
  categories: string[];
  tags: string[];
  metadata_updated_at: string | null;
  updated_at: string | null;
  created_at: string | null;
  type: string | null;
  permalink: string | null;
  downloads: number | null;
  views: number | null;
  update_frequency: string | null;
  api_endpoint: string | null;
  formats: Distribution[];
  extent: [number, number, number, number] | null;
  license: string | null;
  publisher: string | null;
  row_count: number | null;
  geometry_type: string | null;
  owner: string | null;
  org_id: string | null;
  /** null = not fetched this run (keep what the index already has). */
  columns: HarvestedColumn[] | null;
  columns_status: "from-search" | "fetched" | "not-fetched" | "none" | "error";
  provenance: Record<string, "portal" | "derived">;
}

export interface PortalRecord {
  id: string;
  name: string;
  base_url: string | null;
  admin_level: string | null;
  entity: string;
  region: string;
  place_scope: string;
  place_counties: string[];
  place_city: string | null;
  platform_family: string | null;
  platform_raw: string | null;
  api_type_raw: string | null;
  api_endpoint: string | null;
  registry_dataset_count: number | null;
  registry_status: string;
  registry_last_verified: string;
}

/** Fail with a clear message when this Node's SQLite lacks FTS5 (official builds before 22.16, or a system SQLite built without it). */
function assertFts5(db: DatabaseSync): void {
  try {
    db.exec("CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(x); DROP TABLE temp.fts5_probe;");
  } catch {
    throw new Error(
      `This Node (${process.version}, SQLite ${process.versions.sqlite ?? "unknown"}) has no SQLite FTS5, which the dataset index needs. ` +
        "Use Node 22.16 or later from nodejs.org (or nvm, fnm, Volta). The registry tools still work."
    );
  }
}

export function openDb(path = indexPath(), opts: { readOnly?: boolean } = {}): DatabaseSync {
  if (!opts.readOnly) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, opts.readOnly ? { readOnly: true } : {});
  assertFts5(db);
  if (!opts.readOnly) {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  }
  return db;
}

export function indexExists(path = indexPath()): boolean {
  return existsSync(path);
}

export function upsertPortal(db: DatabaseSync, p: PortalRecord): void {
  db.prepare(
    `INSERT INTO portals (id, name, base_url, admin_level, entity, region, place_scope, place_counties, place_city,
       platform_family, platform_raw, api_type_raw, api_endpoint, registry_dataset_count, registry_status, registry_last_verified)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, base_url=excluded.base_url, admin_level=excluded.admin_level,
       entity=excluded.entity, region=excluded.region, place_scope=excluded.place_scope, place_counties=excluded.place_counties,
       place_city=excluded.place_city, platform_family=excluded.platform_family, platform_raw=excluded.platform_raw,
       api_type_raw=excluded.api_type_raw, api_endpoint=excluded.api_endpoint, registry_dataset_count=excluded.registry_dataset_count,
       registry_status=excluded.registry_status, registry_last_verified=excluded.registry_last_verified`
  ).run(
    p.id, p.name, p.base_url, p.admin_level, p.entity, p.region, p.place_scope, JSON.stringify(p.place_counties), p.place_city,
    p.platform_family, p.platform_raw, p.api_type_raw, p.api_endpoint, p.registry_dataset_count, p.registry_status, p.registry_last_verified
  );
}

export function setPortalHarvest(
  db: DatabaseSync,
  id: string,
  f: { adapter: string; status: string; note: string | null; socrata_domain?: string | null; arcgis_org_id?: string | null }
): void {
  const count = (db.prepare("SELECT COUNT(*) AS n FROM datasets WHERE portal_id = ? AND removed_at IS NULL").get(id) as { n: number }).n;
  db.prepare(
    `UPDATE portals SET harvest_adapter=?, harvest_status=?, harvest_note=?, last_harvested=?, dataset_count=?,
       socrata_domain=COALESCE(?, socrata_domain), arcgis_org_id=COALESCE(?, arcgis_org_id) WHERE id=?`
  ).run(f.adapter, f.status, f.note, new Date().toISOString(), count, f.socrata_domain ?? null, f.arcgis_org_id ?? null, id);
}

export function contentHash(d: HarvestedDataset, columns: HarvestedColumn[] | null): string {
  const h = createHash("sha256");
  h.update(JSON.stringify([d.name, d.description, d.updated_at, d.metadata_updated_at, d.type, d.tags, d.formats.map((f) => f.format).sort(), (columns ?? []).map((c) => [c.field, c.type])]));
  return h.digest("hex").slice(0, 24);
}

function tagId(db: DatabaseSync, portalId: string, name: string): number {
  db.prepare("INSERT OR IGNORE INTO tags(portal_id, name) VALUES (?, ?)").run(portalId, name);
  return (db.prepare("SELECT id FROM tags WHERE portal_id = ? AND name = ?").get(portalId, name) as { id: number }).id;
}

export interface UpsertResult {
  added: number;
  changed: number;
  unchanged: number;
  columns: number;
}

/**
 * Write one portal's datasets. Adds 'added' and 'changed' rows to `changes`.
 * Datasets the portal no longer lists are only marked removed when `complete` is true
 * (a partial or failed harvest never removes anything).
 */
export function writePortalDatasets(
  db: DatabaseSync,
  portal: PortalRecord,
  datasets: HarvestedDataset[],
  runId: number,
  complete: boolean
): UpsertResult & { removed: number } {
  const now = new Date().toISOString();
  const res = { added: 0, changed: 0, unchanged: 0, columns: 0, removed: 0 };
  const getExisting = db.prepare("SELECT content_hash, removed_at FROM datasets WHERE id = ?");
  const getCols = db.prepare("SELECT name, field, type, description, layer FROM dataset_columns WHERE dataset_id = ?");
  const delCols = db.prepare("DELETE FROM dataset_columns WHERE dataset_id = ?");
  const insCol = db.prepare(
    "INSERT INTO dataset_columns(dataset_id, portal_id, name, field, type, description, layer, key_label, key_scope) VALUES (?,?,?,?,?,?,?,?,?)"
  );
  const delTags = db.prepare("DELETE FROM dataset_tags WHERE dataset_id = ?");
  const insTag = db.prepare("INSERT OR IGNORE INTO dataset_tags(dataset_id, tag_id) VALUES (?, ?)");
  const delFts = db.prepare("DELETE FROM datasets_fts WHERE dataset_id = ?");
  const insFts = db.prepare("INSERT INTO datasets_fts(dataset_id, name, description, tags, columns, portal, place) VALUES (?,?,?,?,?,?,?)");
  const change = db.prepare("INSERT INTO changes(dataset_id, portal_id, change, at, run_id) VALUES (?,?,?,?,?)");
  const upsert = db.prepare(`
    INSERT INTO datasets (id, portal_id, native_id, name, description, department, categories, metadata_updated_at, updated_at,
      created_at, type, permalink, downloads, views, update_frequency, is_test, platform_family, api_endpoint, formats,
      place_counties, place_city, extent, license, publisher, row_count, geometry_type, owner, org_id, columns_status,
      column_count, first_seen, last_seen, removed_at, content_hash, provenance)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, department=excluded.department,
      categories=excluded.categories, metadata_updated_at=excluded.metadata_updated_at, updated_at=excluded.updated_at,
      created_at=excluded.created_at, type=excluded.type, permalink=excluded.permalink, downloads=excluded.downloads,
      views=excluded.views, update_frequency=excluded.update_frequency, platform_family=excluded.platform_family,
      api_endpoint=excluded.api_endpoint, formats=excluded.formats, place_counties=excluded.place_counties,
      place_city=excluded.place_city, extent=excluded.extent, license=excluded.license, publisher=excluded.publisher,
      row_count=excluded.row_count, geometry_type=COALESCE(excluded.geometry_type, datasets.geometry_type),
      owner=excluded.owner, org_id=excluded.org_id, columns_status=excluded.columns_status, column_count=excluded.column_count,
      last_seen=excluded.last_seen, removed_at=NULL, content_hash=excluded.content_hash, provenance=excluded.provenance`);

  db.exec("BEGIN");
  try {
    for (const d of datasets) {
      const id = `${portal.id}:${d.native_id}`;
      const existing = getExisting.get(id) as { content_hash: string; removed_at: string | null } | undefined;
      let columns = d.columns;
      let columnsStatus = d.columns_status;
      if (columns === null && existing) {
        const old = getCols.all(id) as unknown as HarvestedColumn[];
        if (old.length) {
          columns = old;
          columnsStatus = "fetched";
        }
      }
      const hash = contentHash(d, columns);
      upsert.run(
        id, portal.id, d.native_id, d.name, d.description, d.department, JSON.stringify(d.categories), d.metadata_updated_at,
        d.updated_at, d.created_at, d.type, d.permalink, d.downloads, d.views, d.update_frequency, portal.platform_family,
        d.api_endpoint, JSON.stringify(d.formats), JSON.stringify(portal.place_counties), portal.place_city,
        d.extent ? JSON.stringify(d.extent) : null, d.license, d.publisher, d.row_count, d.geometry_type, d.owner, d.org_id,
        columnsStatus, columns ? columns.length : null, existing ? now : now, now, hash, JSON.stringify(d.provenance)
      );
      if (!existing) {
        db.prepare("UPDATE datasets SET first_seen = ? WHERE id = ?").run(now, id);
        change.run(id, portal.id, "added", now, runId);
        res.added++;
      } else if (existing.content_hash !== hash || existing.removed_at) {
        change.run(id, portal.id, existing.removed_at ? "added" : "changed", now, runId);
        res.changed++;
      } else res.unchanged++;
      delCols.run(id);
      for (const c of columns ?? []) {
        const k = keyLabel(c.field, c.name);
        insCol.run(id, portal.id, c.name, c.field, c.type, c.description, c.layer ?? null, k?.label ?? null, k?.scope ?? null);
        res.columns++;
      }
      delTags.run(id);
      for (const t of d.tags) if (t) insTag.run(id, tagId(db, portal.id, t));
      delFts.run(id);
      insFts.run(
        id, d.name ?? "", stripHtml(d.description ?? "").slice(0, 4000), d.tags.join(" "),
        (columns ?? []).map((c) => `${c.name ?? ""} ${c.field ?? ""}`).join(" "),
        `${portal.name} ${portal.entity}`, `${portal.place_city ?? ""} ${portal.place_counties.join(" ")} ${portal.region}`
      );
    }
    if (complete) {
      const gone = db
        .prepare("SELECT id FROM datasets WHERE portal_id = ? AND removed_at IS NULL AND last_seen < ?")
        .all(portal.id, now) as { id: string }[];
      for (const g of gone) {
        db.prepare("UPDATE datasets SET removed_at = ? WHERE id = ?").run(now, g.id);
        db.prepare("DELETE FROM datasets_fts WHERE dataset_id = ?").run(g.id);
        change.run(g.id, portal.id, "removed", now, runId);
        res.removed++;
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return res;
}

/** Remove everything for a portal (used when the out-of-state guard refuses it). */
export function purgePortal(db: DatabaseSync, portalId: string): number {
  const ids = db.prepare("SELECT id FROM datasets WHERE portal_id = ?").all(portalId) as { id: string }[];
  db.exec("BEGIN");
  for (const { id } of ids) {
    db.prepare("DELETE FROM datasets_fts WHERE dataset_id = ?").run(id);
    db.prepare("DELETE FROM dataset_columns WHERE dataset_id = ?").run(id);
    db.prepare("DELETE FROM dataset_tags WHERE dataset_id = ?").run(id);
  }
  db.prepare("DELETE FROM datasets WHERE portal_id = ?").run(portalId);
  db.exec("COMMIT");
  return ids.length;
}

export function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

/** Portals in the index (with or without datasets) whose id is not in `registryIds`, with their live dataset counts. */
export function portalsNotIn(db: DatabaseSync, registryIds: Set<string>): { portal_id: string; datasets: number }[] {
  const rows = db
    .prepare("SELECT p.id AS id, (SELECT COUNT(*) FROM datasets d WHERE d.portal_id = p.id AND d.removed_at IS NULL) AS n FROM portals p ORDER BY p.id")
    .all() as { id: string; n: number }[];
  return rows.filter((r) => !registryIds.has(r.id)).map((r) => ({ portal_id: r.id, datasets: Number(r.n) }));
}

/** Remove a portal entirely: its datasets (as purgePortal), its change history and its row. */
export function dropPortal(db: DatabaseSync, portalId: string): number {
  const n = purgePortal(db, portalId);
  db.prepare("DELETE FROM changes WHERE portal_id = ?").run(portalId);
  db.prepare("DELETE FROM tags WHERE portal_id = ?").run(portalId);
  db.prepare("DELETE FROM portals WHERE id = ?").run(portalId);
  return n;
}
