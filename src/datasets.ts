/**
 * Phase 2: answers from the harvested index.
 */
import type { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { openDb, indexExists, stripHtml } from "./db.js";
import { indexPath } from "./paths.js";
import { expandTerms, tokenize } from "./sources.js";
import { resolvePlace, places, type ResolvedPlace } from "./places.js";
import { registry } from "./registry.js";

export class NoIndexError extends Error {
  constructor(detail?: string) {
    super(
      `The dataset index is not installed yet (looked for ${indexPath()}). ` +
        (detail ? `${detail} ` : "") +
        "The server downloads it by itself on first run (about 19 MB, from " +
        "https://github.com/BetaNYC/ny-data-registry-mcp/releases/download/index-latest/ny-data-index.sqlite.gz). " +
        "To get it by hand, run `npx -y -p @betanyc/ny-data-registry-mcp ny-data-registry download`, or see the README section 'Get the index'. " +
        "Or build it yourself with `ny-data-registry harvest` (15-60 minutes, read-only and throttled), or set NY_DATA_INDEX to an existing ny-data-index.sqlite. " +
        "The registry tools (find_sources, list_sources_for_place, how_to_query, check_source, registry_info) work without it."
    );
  }
}

let cached: DatabaseSync | null = null;
let cachedPath: string | null = null;
export function db(): DatabaseSync {
  const p = indexPath();
  if (cached && cachedPath === p) return cached;
  if (!indexExists(p)) throw new NoIndexError();
  cached = openDb(p, { readOnly: true });
  cachedPath = p;
  return cached;
}
export function closeDb(): void {
  cached?.close();
  cached = null;
  cachedPath = null;
}

export function indexInfo(): Record<string, unknown> | null {
  try {
    const d = db();
    const meta = Object.fromEntries((d.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    const n = d.prepare("SELECT (SELECT COUNT(*) FROM datasets WHERE removed_at IS NULL) AS datasets, (SELECT COUNT(*) FROM dataset_columns) AS columns, (SELECT COUNT(*) FROM portals WHERE harvest_status IN ('ok','partial')) AS portals").get() as Record<string, number>;
    const byPortal = d.prepare("SELECT id, harvest_status, dataset_count, last_harvested FROM portals WHERE harvest_status IS NOT NULL ORDER BY id").all();
    return { path: indexPath(), bytes: statSync(indexPath()).size, last_harvest: meta.last_harvest ?? null, registry_generated_at_harvest: meta.registry_generated ?? null, ...n, portals_detail: byPortal };
  } catch (e) {
    return { path: indexPath(), built: false, note: e instanceof Error ? e.message : String(e) };
  }
}

interface DatasetRow {
  id: string;
  portal_id: string;
  native_id: string;
  name: string | null;
  description: string | null;
  type: string | null;
  permalink: string | null;
  updated_at: string | null;
  views: number | null;
  formats: string;
  api_endpoint: string | null;
  platform_family: string | null;
  column_count: number | null;
  columns_status: string | null;
  place_counties: string;
  place_city: string | null;
  geometry_type: string | null;
  portal_name: string;
  portal_entity: string;
  portal_place_scope: string;
  socrata_domain: string | null;
}

const SELECT_DS = `SELECT d.id, d.portal_id, d.native_id, d.name, d.description, d.type, d.permalink, d.updated_at, d.views,
  d.formats, d.api_endpoint, d.platform_family, d.column_count, d.columns_status, d.place_counties, d.place_city, d.geometry_type,
  p.name AS portal_name, p.entity AS portal_entity, p.place_scope AS portal_place_scope, p.socrata_domain
  FROM datasets d JOIN portals p ON p.id = d.portal_id`;

function summary(r: DatasetRow) {
  const formats = JSON.parse(r.formats || "[]") as { format: string; url: string | null; provenance: string }[];
  return {
    dataset_id: r.id,
    native_id: r.native_id,
    name: r.name,
    portal: r.portal_name,
    portal_id: r.portal_id,
    entity: r.portal_entity,
    platform_family: r.platform_family,
    type: r.type,
    url: r.permalink,
    api_endpoint: r.api_endpoint,
    formats: [...new Set(formats.map((f) => f.format))],
    updated_at: r.updated_at,
    views: r.views,
    column_count: r.column_count,
    columns_status: r.columns_status,
    geometry_type: r.geometry_type,
    description: r.description ? stripHtml(r.description).slice(0, 240) : null,
    query_with: r.platform_family === "socrata" && r.socrata_domain ? { mcp: "socrata", domain: r.socrata_domain, dataset_id: r.native_id } : null,
  };
}

function ftsQuery(q: string): string | null {
  const terms = expandTerms(tokenize(q));
  if (!terms.length) return null;
  return terms.map((t) => `"${t.term.replace(/"/g, "")}"`).join(" OR ");
}

const FORMAT_ALIASES: Record<string, string[]> = {
  csv: ["csv"],
  json: ["api (soda)", "json", "geojson"],
  geojson: ["geojson"],
  shapefile: ["zip", "shapefile"],
  kml: ["kml"],
  api: ["api (soda)", "arcgis geoservices rest api"],
  arcgis: ["arcgis geoservices rest api"],
  xlsx: ["xlsx", "excel", "microsoft excel"],
  geopackage: ["gpkg", "geopackage"],
  pdf: ["application/pdf", "pdf"],
};

export interface SearchArgs {
  query: string;
  place?: string;
  portal?: string;
  platform_family?: string;
  format?: string;
  updated_since?: string;
  limit?: number;
}

export function searchDatasets(a: SearchArgs) {
  const d = db();
  const limit = Math.min(a.limit ?? 10, 50);
  const fq = ftsQuery(a.query);
  if (!fq) return { query: a.query, results: [], note: "the query has no searchable words" };
  const where: string[] = ["d.removed_at IS NULL"];
  const params: (string | number)[] = [fq];
  let placeNote: string | null = null;
  let resolved: ResolvedPlace | null = null;
  if (a.place) {
    const p = resolvePlace(a.place);
    resolved = p;
    if (!p) return { query: a.query, place_error: `'${a.place}' is not a New York place this server knows`, results: [] };
    placeNote = p.name;
    if (p.kind === "state") where.push("p.place_scope = 'statewide'");
    else if (p.kind === "region") {
      where.push("(p.region = ? OR p.place_scope = 'statewide')");
      params.push(p.region!);
    } else {
      // portals for this place, plus statewide portals (which cover everywhere)
      where.push(`(p.place_scope = 'statewide' OR EXISTS (SELECT 1 FROM json_each(d.place_counties) j WHERE j.value IN (${p.counties.map(() => "?").join(",")})))`);
      params.push(...p.counties);
    }
  }
  if (a.portal) {
    where.push("(d.portal_id = ? OR p.name LIKE ? OR p.entity LIKE ?)");
    params.push(a.portal, `%${a.portal}%`, `%${a.portal}%`);
  }
  if (a.platform_family) {
    where.push("d.platform_family = ?");
    params.push(a.platform_family);
  }
  if (a.updated_since) {
    where.push("d.updated_at >= ?");
    params.push(a.updated_since);
  }
  if (a.format) {
    const al = FORMAT_ALIASES[a.format.toLowerCase()] ?? [a.format.toLowerCase()];
    where.push(`EXISTS (SELECT 1 FROM json_each(d.formats) f WHERE lower(json_extract(f.value, '$.format')) IN (${al.map(() => "?").join(",")}))`);
    params.push(...al);
  }
  // bm25 column weights: dataset_id, name, description, tags, columns, portal, place
  const cols = SELECT_DS.replace(/^SELECT /, "").replace(/\s+FROM datasets d JOIN portals p ON p.id = d.portal_id$/, "");
  const sql = `SELECT ${cols}, bm25(datasets_fts, 0, 10.0, 1.5, 3.0, 1.0, 0.5, 0.5) AS rank
    FROM datasets_fts JOIN datasets d ON d.id = datasets_fts.dataset_id JOIN portals p ON p.id = d.portal_id
    WHERE datasets_fts MATCH ? AND ${where.join(" AND ")} ORDER BY rank LIMIT 400`;
  const rows = d.prepare(sql).all(...params) as unknown as (DatasetRow & { rank: number })[];
  const qTokens = tokenize(a.query);
  const scored = rows.map((r) => {
    const title = (r.name ?? "").toLowerCase();
    let s = -r.rank;
    const hits = qTokens.filter((t) => title.includes(t.length > 4 ? t.replace(/s$/, "") : t)).length;
    s += hits * 4;
    if (qTokens.length && hits === qTokens.length) s += 4;
    if (r.type === "dataset" || r.type === "Feature Service") s += 1;
    if (r.views) s += Math.min(Math.log10(r.views + 1), 6) * 0.6;
    if (resolved) s += placePenalty(r.name ?? "", resolved);
    return { r, s };
  });
  scored.sort((x, y) => y.s - x.s);
  return {
    query: a.query,
    place: placeNote,
    total_candidates: rows.length,
    results: scored.slice(0, limit).map((x) => ({ ...summary(x.r), score: Math.round(x.s * 10) / 10 })),
    index_last_harvest: (d.prepare("SELECT value FROM meta WHERE key = 'last_harvest'").get() as { value: string } | undefined)?.value ?? null,
  };
}

function findDataset(ref: string): DatasetRow | null {
  const d = db();
  const r = d.prepare(`${SELECT_DS} WHERE d.id = ? OR d.permalink = ? OR d.api_endpoint = ?`).get(ref, ref, ref) as DatasetRow | undefined;
  if (r) return r;
  const byNative = d.prepare(`${SELECT_DS} WHERE d.native_id = ? AND d.removed_at IS NULL`).all(ref) as unknown as DatasetRow[];
  if (byNative.length >= 1) return byNative[0];
  const m = ref.match(/([a-z0-9]{4}-[a-z0-9]{4})|([0-9a-f]{32})/i);
  if (m) {
    const r2 = d.prepare(`${SELECT_DS} WHERE d.native_id = ? AND d.removed_at IS NULL`).get(m[0]) as DatasetRow | undefined;
    if (r2) return r2;
  }
  return null;
}

export function getDatasetColumns(ref: string) {
  const r = findDataset(ref);
  if (!r) return { error: `no dataset '${ref}' in the index. Use search_datasets to find its dataset_id.` };
  const cols = db().prepare("SELECT name, field, type, description, layer, key_label FROM dataset_columns WHERE dataset_id = ? ORDER BY id").all(r.id);
  const full = db().prepare("SELECT license, publisher, extent, row_count, update_frequency, first_seen, last_seen, provenance, formats FROM datasets WHERE id = ?").get(r.id) as Record<string, string | null>;
  return {
    ...summary(r),
    columns: cols,
    columns_note:
      r.columns_status === "not-fetched"
        ? "Columns not fetched yet (per-portal request cap). Read them live from the service: GET <api_endpoint>?f=json, then each layer ?f=json."
        : r.columns_status === "none"
        ? "This item type has no column schema (a file, link or map)."
        : null,
    distributions: JSON.parse(full.formats ?? "[]"),
    license: full.license,
    publisher: full.publisher,
    extent: full.extent ? JSON.parse(full.extent) : null,
    row_count: full.row_count,
    update_frequency: full.update_frequency,
    first_seen: full.first_seen,
    last_seen: full.last_seen,
    provenance: JSON.parse(full.provenance ?? "{}"),
  };
}

export function findJoinable(ref: string, column?: string, limitPerKey = 10) {
  const r = findDataset(ref);
  if (!r) return { error: `no dataset '${ref}' in the index` };
  const d = db();
  let keys = d.prepare("SELECT key_label, group_concat(DISTINCT field) AS field FROM dataset_columns WHERE dataset_id = ? AND key_label IS NOT NULL GROUP BY key_label").all(r.id) as { key_label: string; field: string }[];
  if (column) {
    keys = keys.filter((k) => k.field.toLowerCase().split(",").includes(column.toLowerCase()) || k.key_label.toLowerCase() === column.toLowerCase());
    if (!keys.length) return { dataset: summary(r), error: `column '${column}' is not a recognized join key (BBL, BIN, borough, community district, council district, census tract, SWIS, FIPS, ZIP)` };
  }
  // NYC-only keys (BBL, BIN, borough, community district, council district) are meaningless
  // outside the city: Buffalo's council_district is a different council. Keep NYC and
  // statewide portals only for those.
  const scopeOf = (label: string) =>
    (d.prepare("SELECT key_scope FROM dataset_columns WHERE key_label = ? AND key_scope IS NOT NULL LIMIT 1").get(label) as { key_scope: string } | undefined)?.key_scope;
  const nycOnly = "AND NOT (p.place_scope IN ('county','city','regional') AND COALESCE(p.place_city, '') != 'New York City')";
  const groups = keys.map((k) => {
    const sc = scopeOf(k.key_label) === "nyc" ? nycOnly : "";
    const base = `FROM dataset_columns c JOIN datasets ds ON ds.id = c.dataset_id JOIN portals p ON p.id = ds.portal_id WHERE c.key_label = ? AND c.dataset_id != ? AND ds.removed_at IS NULL ${sc}`;
    const total = (d.prepare(`SELECT COUNT(DISTINCT c.dataset_id) AS n ${base}`).get(k.key_label, r.id) as { n: number }).n;
    const byPortal = d.prepare(`SELECT ds.portal_id, COUNT(DISTINCT c.dataset_id) AS n ${base} GROUP BY ds.portal_id ORDER BY n DESC`).all(k.key_label, r.id);
    const top = d
      .prepare(`${SELECT_DS} WHERE d.removed_at IS NULL AND d.id != ? AND d.id IN (SELECT c.dataset_id ${base.replace("c.dataset_id != ?", "1 = 1")}) ORDER BY (d.portal_id = ?) DESC, COALESCE(d.views, 0) DESC LIMIT ?`)
      .all(r.id, k.key_label, r.portal_id, limitPerKey) as unknown as DatasetRow[];
    return {
      key: k.key_label,
      your_column: k.field,
      datasets_sharing_key: total,
      by_portal: byPortal,
      top: top.map((t) => {
        const f = d.prepare("SELECT field FROM dataset_columns WHERE dataset_id = ? AND key_label = ? LIMIT 1").get(t.id, k.key_label) as { field: string };
        return { dataset_id: t.id, name: t.name, portal: t.portal_name, their_column: f?.field, views: t.views, url: t.permalink };
      }),
    };
  });
  return {
    dataset: summary(r),
    keys: groups,
    method: "Curated key-column map (data/key-columns.json): a column counts only if its normalized field name is a listed variant of a key. Not raw name equality, and no value-overlap test; check values before joining. NYC-only keys are limited to NYC and statewide portals.",
  };
}

export function whatsNew(since: string, portal?: string, limit = 50) {
  const d = db();
  if (!/^\d{4}-\d{2}-\d{2}/.test(since)) return { error: "since must be a date, YYYY-MM-DD" };
  const params: string[] = [since];
  let pw = "";
  if (portal) {
    pw = " AND (c.portal_id = ? OR p.name LIKE ?)";
    params.push(portal, `%${portal}%`);
  }
  const counts = d.prepare(`SELECT c.change, COUNT(*) AS n FROM changes c JOIN portals p ON p.id = c.portal_id WHERE c.at >= ?${pw} GROUP BY c.change`).all(...params);
  const rows = d
    .prepare(`SELECT c.change, c.at, c.dataset_id, ds.name, p.name AS portal, ds.permalink, ds.updated_at FROM changes c JOIN datasets ds ON ds.id = c.dataset_id JOIN portals p ON p.id = c.portal_id WHERE c.at >= ?${pw} ORDER BY c.at DESC, c.change LIMIT ?`)
    .all(...params, String(limit));
  const firstRun = (d.prepare("SELECT MIN(started_at) AS s FROM harvest_runs").get() as { s: string | null }).s;
  const updated = d
    .prepare(`SELECT ds.id AS dataset_id, ds.name, p.name AS portal, ds.updated_at, ds.permalink FROM datasets ds JOIN portals p ON p.id = ds.portal_id WHERE ds.removed_at IS NULL AND ds.updated_at >= ?${portal ? " AND (ds.portal_id = ? OR p.name LIKE ?)" : ""} ORDER BY ds.updated_at DESC LIMIT ?`)
    .all(...params, String(limit));
  return {
    since,
    index_changes: counts,
    index_change_detail: rows,
    data_updated_per_portal: updated,
    note:
      firstRun && since < firstRun.slice(0, 10)
        ? `The index's first harvest was ${firstRun.slice(0, 10)}. 'added' before that date means 'first indexed', not 'newly published'. data_updated_per_portal uses each portal's own updated date.`
        : "index_changes compares harvests. data_updated_per_portal uses each portal's own updated date.",
  };
}

export function registryPortalIds(): string[] {
  return registry().sources.map((s) => s.source_id);
}

/**
 * A statewide portal also hosts layers for single counties ("Oswego County Active Tax
 * Parcels" on the State GIS Clearinghouse). When a place is asked for, a title that names
 * a different county or city is pushed down; one that names the asked-for place is lifted.
 */
export function placePenalty(title: string, p: ResolvedPlace): number {
  const t = title.toLowerCase();
  const want = new Set([...p.counties.map((c) => c.toLowerCase()), ...(p.city ? [p.city.toLowerCase()] : [])]);
  if ([...want].some((w) => new RegExp(`\\b${w.replace(/[.]/g, "\\.")}\\b`).test(t))) return 3;
  const P = places();
  const others = [
    ...P.counties.map((c) => `${c.toLowerCase()} county`),
    ...Object.keys(P.cities).map((c) => `city of ${c.toLowerCase()}`),
  ].filter((n) => ![...want].some((w) => n.startsWith(w + " ") || n.endsWith(" " + w)));
  return others.some((n) => t.includes(n)) ? -15 : 0;
}
