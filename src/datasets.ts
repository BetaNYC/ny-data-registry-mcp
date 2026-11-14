/**
 * Phase 2: answers from the harvested index.
 */
import type { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { slugFor, writeExport } from "./exportcsv.js";
import { openDb, indexExists, stripHtml } from "./db.js";
import { indexPath } from "./paths.js";
import { installPendingIndex } from "./fetchindex.js";
import { staleNote } from "./indexage.js";
import { expandTerms, placeMatches, tokenize } from "./sources.js";
import { resolvePlace, places, type ResolvedPlace } from "./places.js";
import { registry, type Source } from "./registry.js";

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
let cachedId: string | null = null;
let checkedAt = 0;
/**
 * How often an open handle checks that the file at its path is still the one it opened. An
 * update renames a new file over the index; on macOS and Linux a handle keeps reading the old
 * file until it reopens. Calls run one at a time and prepare their statements per call, so no
 * query is mid-flight when the handle is swapped.
 */
let identityCheckMs = 60_000;
/** For tests. */
export function setIdentityCheckMs(ms: number): void {
  identityCheckMs = ms;
}

function fileId(p: string): string | null {
  try {
    const st = statSync(p);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

export function db(): DatabaseSync {
  const p = indexPath();
  if (cached && cachedPath === p) {
    if (Date.now() - checkedAt < identityCheckMs) return cached;
    checkedAt = Date.now();
    if (fileId(p) === cachedId) return cached;
    closeDb(); // replaced (or removed): open the file that is there now
  } else if (cached) closeDb();
  // A verified update that could not be swapped in while the file was open (Windows).
  try {
    installPendingIndex(p);
  } catch {
    /* keep the current index; the next update check reports the problem */
  }
  if (!indexExists(p)) throw new NoIndexError();
  cached = openDb(p, { readOnly: true });
  cachedPath = p;
  cachedId = fileId(p);
  checkedAt = Date.now();
  return cached;
}
export function closeDb(): void {
  cached?.close();
  cached = null;
  cachedPath = null;
  cachedId = null;
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

/** Re-rank bonus when a title holds the query's words together, in order. */
export const PHRASE_BONUS = 6;

function ftsQuery(q: string): string | null {
  return ftsQueries(q)?.all ?? null;
}

/**
 * `all`: every typed word, its stem and its synonyms (used for counts, groups and the CSV).
 * `typed`: only the typed words and their stems (weight >= 0.9). Ranking uses `typed` first, so
 * a dataset full of synonym words never outranks one that has the words actually asked for.
 */
function ftsQueries(q: string): { all: string; typed: string; hasSynonyms: boolean } | null {
  const terms = expandTerms(tokenize(q));
  if (!terms.length) return null;
  const quote = (t: string) => `"${t.replace(/"/g, "")}"`;
  const typed = terms.filter((t) => t.weight >= 0.9).map((t) => quote(t.term));
  const all = terms.map((t) => quote(t.term));
  return { all: all.join(" OR "), typed: typed.join(" OR "), hasSynonyms: all.length > typed.length };
}

/** Synonym-only matches count this much of their text score when ranked. */
export const SYNONYM_WEIGHT = 0.5;

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

export const GROUP_BY = ["portal", "entity", "county", "platform_family"] as const;
export type GroupBy = (typeof GROUP_BY)[number];
export const DETAIL = ["compact", "full"] as const;
export type Detail = (typeof DETAIL)[number];

/** How many matches (best text relevance first) are re-ranked. Paging past this is not possible; total_matches is never capped. */
export const RANK_POOL_MAX = 5000;
/** Target ceiling for one search_datasets answer, in bytes of the JSON text the tool returns. */
export const RESPONSE_BUDGET_BYTES = 20_000;
export const MAX_LIMIT = 50;
export const MAX_TOP_PER_GROUP = 10;

export interface SearchArgs {
  query: string;
  place?: string;
  portal?: string;
  platform_family?: string;
  format?: string;
  updated_since?: string;
  limit?: number;
  offset?: number;
  detail?: Detail;
  group_by?: GroupBy;
  top_per_group?: number;
  export?: ExportMode;
}

export const EXPORT_MODE = ["auto", "always", "never"] as const;
export type ExportMode = (typeof EXPORT_MODE)[number];

/** The exact text the MCP tools return (tools.ts uses this too), so the size budget measures what the client receives. */
export function toolJson(v: unknown): string {
  return JSON.stringify(v, null, 2);
}
const byteSize = (v: unknown) => Buffer.byteLength(toolJson(v), "utf8");

function compact(r: DatasetRow) {
  const formats = JSON.parse(r.formats || "[]") as { format: string }[];
  return {
    dataset_id: r.id,
    name: r.name,
    portal: r.portal_name,
    portal_id: r.portal_id,
    type: r.type,
    updated_at: r.updated_at ? r.updated_at.slice(0, 10) : null,
    url: r.permalink,
    formats: [...new Set(formats.map((f) => f.format))].slice(0, 6),
  };
}

interface PoolRow {
  id: string;
  name: string | null;
  type: string | null;
  views: number | null;
  portal_id: string;
  portal_name: string;
  portal_entity: string;
  platform_family: string | null;
  place_counties: string | null;
  rank: number;
}

const NO_COUNTY = "(no county: statewide or regional)";

function groupKeys(r: PoolRow, by: GroupBy): string[] {
  if (by === "portal") return [r.portal_id];
  if (by === "entity") return [r.portal_entity];
  if (by === "platform_family") return [r.platform_family ?? "unknown"];
  const c = JSON.parse(r.place_counties || "[]") as string[];
  return c.length ? c : [NO_COUNTY];
}

/**
 * Which registry portals are absent from the index, so an empty or short answer is not
 * read as "no such data exists". With a place, lists the ones that cover it (statewide
 * ones are only counted); without one, counts by reason.
 */
export function coverageNote(place: ResolvedPlace | null) {
  const d = db();
  const status = new Map(
    (d.prepare("SELECT id, harvest_status FROM portals").all() as { id: string; harvest_status: string | null }[]).map((r) => [r.id, r.harvest_status])
  );
  const reason = (s: Source): string | null => {
    const h = status.get(s.source_id);
    if (h === "ok") return null;
    if (h === "partial") return "partially harvested (some datasets may be missing)";
    if (s.status === "no-portal") return "checked: no portal exists";
    if (s.status === "dead") return "portal is dead";
    if (h === "failed" || h === "blocked" || h === "refused") return `harvest ${h}`;
    if (!status.has(s.source_id)) return "not in this index (added to the registry after the last harvest)";
    return "not harvested (platform not covered by the harvester)";
  };
  const gaps = registry()
    .sources.map((s) => ({ s, why: reason(s) }))
    .filter((x) => x.why !== null);
  const countBy = (xs: typeof gaps) => {
    const out: Record<string, number> = {};
    for (const x of xs) out[x.why!] = (out[x.why!] ?? 0) + 1;
    return out;
  };
  const indexed = status.size ? [...status.values()].filter((h) => h === "ok" || h === "partial").length : 0;
  if (!place) {
    return {
      portals_indexed: indexed,
      registry_portals_not_fully_indexed: gaps.length,
      by_reason: countBy(gaps),
      note: "These registry portals are not (fully) searched here, so a missing result is not proof the data does not exist. Give a place to list the ones that cover it, or use list_sources_for_place / how_to_query to reach them directly.",
    };
  }
  const local = gaps.filter((x) => {
    const m = placeMatches(x.s, place);
    return m !== null && x.s.place.scope !== "statewide";
  });
  const statewide = gaps.filter((x) => x.s.place.scope === "statewide" && placeMatches(x.s, place) !== null);
  return {
    place: place.name,
    portals_for_this_place_not_fully_indexed: local.map((x) => ({ portal_id: x.s.source_id, entity: x.s.entity, reason: x.why })),
    statewide_portals_not_fully_indexed: statewide.length,
    note: "Portals listed here are not (fully) searched, so a missing result is not proof the data does not exist. Use how_to_query on a portal_id to reach it directly.",
  };
}

export function searchDatasets(a: SearchArgs) {
  const d = db();
  const limit = Math.min(a.limit ?? 10, MAX_LIMIT);
  const offset = Math.max(a.offset ?? 0, 0);
  const detail: Detail = a.detail ?? "compact";
  if (a.group_by && (a.offset !== undefined || a.limit !== undefined || a.detail !== undefined)) {
    throw new Error("group_by returns every group with counts and top titles; offset, limit and detail apply only without group_by. Use top_per_group to change how many titles each group shows.");
  }
  if (!a.group_by && a.top_per_group !== undefined) throw new Error("top_per_group applies only with group_by");
  const fq = ftsQuery(a.query);
  if (!fq) return { query: a.query, total_matches: 0, results: [], note: "the query has no searchable words" };
  const where: string[] = ["d.removed_at IS NULL"];
  const params: (string | number)[] = [];
  let resolved: ResolvedPlace | null = null;
  if (a.place) {
    const p = resolvePlace(a.place);
    resolved = p;
    if (!p) return { query: a.query, place_error: `'${a.place}' is not a New York place this server knows`, total_matches: 0, results: [] };
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
  const from = `FROM datasets_fts JOIN datasets d ON d.id = datasets_fts.dataset_id JOIN portals p ON p.id = d.portal_id
    WHERE datasets_fts MATCH ? AND ${where.join(" AND ")}`;
  const total = (d.prepare(`SELECT COUNT(*) AS n ${from}`).get(fq, ...params) as { n: number }).n;

  // bm25 column weights: dataset_id, name, description, tags, columns, portal, place.
  // The pool is the best RANK_POOL_MAX by text relevance; d.id breaks ties so pages are stable.
  const poolSql = `SELECT d.id, d.name, d.type, d.views, d.portal_id, p.name AS portal_name, p.entity AS portal_entity, d.platform_family, d.place_counties,
        bm25(datasets_fts, 0, 10.0, 1.5, 3.0, 1.0, 0.5, 0.5) AS rank ${from} ORDER BY rank, d.id LIMIT ?`;
  const qs = ftsQueries(a.query)!;
  let pool: PoolRow[];
  if (!qs.hasSynonyms) {
    pool = d.prepare(poolSql).all(fq, ...params, RANK_POOL_MAX) as unknown as PoolRow[];
  } else {
    // Typed words first, scored on their own; then synonym-only matches at SYNONYM_WEIGHT.
    const typed = d.prepare(poolSql).all(qs.typed, ...params, RANK_POOL_MAX) as unknown as PoolRow[];
    const room = RANK_POOL_MAX - typed.length;
    const syn = room > 0 ? (d.prepare(poolSql).all(`(${qs.all}) NOT (${qs.typed})`, ...params, room) as unknown as PoolRow[]) : [];
    pool = [...typed, ...syn.map((r) => ({ ...r, rank: r.rank * SYNONYM_WEIGHT }))];
  }
  const qTokens = tokenize(a.query);
  // The exact words typed, in order, beat a synonym: "tax lot" ranks "Tax Lot" titles above
  // "Tax Parcel" ones, even though both match.
  const phrase = qTokens.length > 1 ? qTokens.join(" ") : null;
  const scored = pool.map((r) => {
    const title = (r.name ?? "").toLowerCase();
    let s = -r.rank;
    const hits = qTokens.filter((t) => title.includes(t.length > 4 ? t.replace(/s$/, "") : t)).length;
    s += hits * 4;
    if (qTokens.length && hits === qTokens.length) s += 4;
    if (phrase && ` ${title.replace(/[^a-z0-9]+/g, " ")} `.includes(` ${phrase}`)) s += PHRASE_BONUS;
    if (r.type === "dataset" || r.type === "Feature Service") s += 1;
    if (r.views) s += Math.min(Math.log10(r.views + 1), 6) * 0.6;
    if (resolved) s += placePenalty(r.name ?? "", resolved);
    return { r, s };
  });
  scored.sort((x, y) => y.s - x.s || (x.r.id < y.r.id ? -1 : x.r.id > y.r.id ? 1 : 0));
  const capped = total > pool.length;
  const head = {
    query: a.query,
    place: resolved?.name ?? null,
    total_matches: total,
    ranked_pool: capped
      ? { size: pool.length, capped: true, note: `Only the ${pool.length} best text matches of ${total} were re-ranked and can be paged; narrow the query or add filters to reach the rest.` }
      : { size: pool.length, capped: false },
  };
  const lastHarvest = (d.prepare("SELECT value FROM meta WHERE key = 'last_harvest'").get() as { value: string } | undefined)?.value ?? null;
  // Only dataset searches carry the age warning (issue #15), and only when the index is old.
  const note = staleNote(lastHarvest);
  const staleField = note ? { index_note: note } : {};
  const coverage = coverageNote(resolved);

  const exportMode: ExportMode = a.export ?? "auto";
  const pagingByHand = a.offset !== undefined;
  const ctx: SearchCtx = { d, from, fq, params, scored, a, total };

  if (a.group_by) {
    const topN = a.top_per_group ?? 3;
    const groups = computeGroups(ctx, a.group_by, topN);
    const resp: Record<string, unknown> = {
      ...head,
      group_by: a.group_by,
      group_key: a.group_by === "portal" ? "portal_id" : a.group_by,
      group_count: groups.length,
      top_per_group: topN,
      groups,
      note: groupNote(a.group_by),
      coverage,
      index_last_harvest: lastHarvest,
      ...staleField,
    };
    // No rows are listed in group mode, so the CSV is the full list.
    if (exportMode === "always" || (exportMode === "auto" && total > 0)) attachExport(ctx, resp);
    fitGroups(resp, groups, null);
    return resp;
  }

  const pageIds = scored.slice(offset, offset + limit);
  const full = new Map<string, DatasetRow>();
  if (pageIds.length) {
    const rows = d.prepare(`${SELECT_DS} WHERE d.id IN (${pageIds.map(() => "?").join(",")})`).all(...pageIds.map((x) => x.r.id)) as unknown as DatasetRow[];
    for (const r of rows) full.set(r.id, r);
  }
  const results: Record<string, unknown>[] = pageIds.map((x) => {
    const r = full.get(x.r.id)!;
    return detail === "full" ? { ...summary(r), score: Math.round(x.s * 10) / 10 } : compact(r);
  });
  const resp: Record<string, unknown> = { ...head };
  Object.assign(resp, {
    detail,
    offset,
    returned: results.length,
    next_offset: offset + results.length < scored.length ? offset + results.length : null,
    results,
    coverage,
    index_last_harvest: lastHarvest,
    ...staleField,
  });
  if (offset >= scored.length && scored.length > 0) resp.note = `offset ${offset} is past the last ranked match (${scored.length}).`;
  // One call should carry the whole answer. When the matches do not all fit in the reply
  // (more than limit, or over the size budget), summarize every match by portal and put the
  // full list in a CSV, unless the caller is paging by hand with offset.
  const overLimit = total > results.length;
  const overBudget = byteSize(resp) > RESPONSE_BUDGET_BYTES;
  let groups: GroupRow[] | null = null;
  if (!pagingByHand && (overLimit || overBudget)) {
    groups = computeGroups(ctx, "portal", 3);
    const summary = {
      auto_grouped: true,
      auto_grouped_reason: overLimit
        ? `${total} datasets match, more than the reply's row limit (${limit}). Every match is counted by portal in groups; the best-ranked rows follow in results, and export has the full list.`
        : `${total} datasets match, more than fit in this reply's ${RESPONSE_BUDGET_BYTES}-byte budget. Every match is counted by portal in groups; the best-ranked rows follow in results, and export has the full list.`,
      group_by: "portal",
      group_key: "portal_id",
      group_count: groups.length,
      top_per_group: 3,
      groups,
    };
    // put the summary ahead of the rows, so a reader meets it first
    const rest = { ...resp };
    for (const k of Object.keys(resp)) delete resp[k];
    Object.assign(resp, head, summary, rest);
  }
  if (exportMode === "always" || (exportMode === "auto" && groups !== null)) attachExport(ctx, resp);
  if (groups) fitSummary(resp, results, groups);
  else while (results.length > 1 && byteSize(resp) > RESPONSE_BUDGET_BYTES) results.pop();
  const omitted = pageIds.length - results.length;
  resp.returned = results.length;
  if (omitted > 0) {
    resp.next_offset = offset + results.length;
    resp.omitted_for_size = omitted;
    resp.size_note = `${omitted} more row(s) were left out to keep the answer under ${RESPONSE_BUDGET_BYTES} bytes.${resp.export ? " The export CSV has every match." : ` offset=${offset + results.length} gets them${detail === "full" ? ', or use detail: "compact"' : ""}.`}`;
  }
  return resp;
}

interface SearchCtx {
  d: DatabaseSync;
  from: string;
  fq: string;
  params: (string | number)[];
  scored: { r: PoolRow; s: number }[];
  a: SearchArgs;
  total: number;
}

interface GroupRow {
  key: string;
  matches: number;
  top: { dataset_id: string; name: string | null }[];
  [label: string]: unknown;
}

function computeGroups(ctx: SearchCtx, by: GroupBy, topN: number): GroupRow[] {
  const { d, from, fq, params, scored } = ctx;
  // Exact counts over every match, not just the ranked pool.
  const sql =
    by === "portal"
      ? `SELECT d.portal_id AS k, COUNT(*) AS n ${from} GROUP BY d.portal_id`
      : by === "entity"
      ? `SELECT p.entity AS k, COUNT(*) AS n ${from} GROUP BY p.entity`
      : by === "platform_family"
      ? `SELECT COALESCE(d.platform_family, 'unknown') AS k, COUNT(*) AS n ${from} GROUP BY 1`
      : `SELECT COALESCE(j.value, '${NO_COUNTY}') AS k, COUNT(*) AS n
         FROM datasets_fts JOIN datasets d ON d.id = datasets_fts.dataset_id JOIN portals p ON p.id = d.portal_id
         LEFT JOIN json_each(COALESCE(d.place_counties, '[]')) j
         ${from.slice(from.indexOf("WHERE"))} GROUP BY 1`;
  const counts = d.prepare(sql).all(fq, ...params) as { k: string; n: number }[];
  const top = new Map<string, { dataset_id: string; name: string | null }[]>();
  const label = new Map<string, Record<string, string>>();
  for (const { r } of scored) {
    for (const k of groupKeys(r, by)) {
      if (by === "portal" && !label.has(k)) label.set(k, { portal: r.portal_name, entity: r.portal_entity });
      const t = top.get(k) ?? [];
      if (t.length < topN) t.push({ dataset_id: r.id, name: r.name });
      top.set(k, t);
    }
  }
  return counts
    .map((c) => ({ key: c.k, ...(label.get(c.k) ?? {}), matches: c.n, top: top.get(c.k) ?? [] }))
    .sort((x, y) => y.matches - x.matches || x.key.localeCompare(y.key));
}

function groupNote(by: GroupBy): string {
  return (
    (by === "county"
      ? "A dataset tagged with several counties (NYC portals carry all five) is counted in each, so the group counts can add up to more than total_matches. "
      : "") +
    `Counts cover every match. Each group's titles are its best-ranked matches (top_per_group of them). The export CSV lists every match; or search again with ${by === "portal" ? "portal=<portal_id>" : by === "platform_family" ? "platform_family=<value>" : by === "county" ? "place=<county> County" : "portal=<entity>"} to narrow to one group.`
  );
}

/** Group mode: shorten the title lists first, then drop the smallest groups (counted, never silently). */
function fitGroups(resp: Record<string, unknown>, groups: GroupRow[], results: unknown[] | null): void {
  let n = Number(resp.top_per_group);
  while (n > 0 && byteSize(resp) > RESPONSE_BUDGET_BYTES) {
    n--;
    for (const g of groups) g.top = g.top.slice(0, n);
    resp.top_per_group = n;
    resp.groups_size_note = `Titles per group cut to ${n} to keep the answer under ${RESPONSE_BUDGET_BYTES} bytes.`;
  }
  let dropped = 0;
  while (groups.length > 1 && byteSize(resp) > RESPONSE_BUDGET_BYTES) {
    groups.pop();
    dropped++;
    resp.groups_omitted_for_size = dropped;
    resp.groups_size_note = `${dropped} smallest group(s) and the per-group titles were left out to keep the answer under ${RESPONSE_BUDGET_BYTES} bytes.${resp.export ? " The export CSV has every match." : " Add a filter (place, portal, platform_family) to see them."}`;
  }
  void results;
}

/**
 * Auto-summary: choose the most group titles (3, 2, 1, 0) that still leave room for at
 * least MIN_ROWS rows, then as many rows as fit. Below that, fewer rows, then fewer groups.
 */
const MIN_ROWS = 5;
function fitSummary(resp: Record<string, unknown>, results: unknown[], groups: GroupRow[]): void {
  const allRows = [...results];
  const allTops = groups.map((g) => g.top);
  const set = (t: number, n: number) => {
    groups.forEach((g, i) => (g.top = allTops[i].slice(0, t)));
    resp.top_per_group = t;
    results.length = 0;
    results.push(...allRows.slice(0, n));
    resp.returned = n;
    return byteSize(resp) <= RESPONSE_BUDGET_BYTES;
  };
  const floor = Math.min(MIN_ROWS, allRows.length);
  for (let t = Number(resp.top_per_group); t >= 0; t--) {
    if (!set(t, floor)) continue;
    let n = floor;
    while (n < allRows.length && set(t, n + 1)) n++;
    set(t, n);
    if (t < 3) resp.groups_size_note = `Titles per group cut to ${t} to keep the answer under ${RESPONSE_BUDGET_BYTES} bytes.`;
    return;
  }
  let n = floor;
  while (n > 0 && !set(0, n)) n--;
  if (set(0, n)) {
    resp.groups_size_note = `Titles per group cut to 0 to keep the answer under ${RESPONSE_BUDGET_BYTES} bytes.`;
    return;
  }
  fitGroups(resp, groups, null);
}

const CSV_HEADER = [
  "rank", "dataset_id", "name", "portal", "portal_id", "type", "updated_at", "url", "formats",
  "api_endpoint", "socrata_domain", "socrata_dataset_id", "platform_family", "place_counties", "geometry_type", "column_count",
];

/** Write every match (not just the pool) to a CSV, best-ranked first, and describe it in resp.export. */
function attachExport(ctx: SearchCtx, resp: Record<string, unknown>): void {
  const { d, from, fq, params, scored, a } = ctx;
  const rows = d
    .prepare(
      `SELECT d.id, d.native_id, d.name, p.name AS portal_name, d.portal_id, d.type, d.updated_at, d.permalink, d.formats, d.api_endpoint,
        p.socrata_domain, d.platform_family, d.place_counties, d.geometry_type, d.column_count ${from}
        ORDER BY bm25(datasets_fts, 0, 10.0, 1.5, 3.0, 1.0, 0.5, 0.5), d.id`
    )
    .all(fq, ...params) as unknown as (DatasetRow & { native_id: string })[];
  const order = new Map(scored.map((x, i) => [x.r.id, i]));
  const ranked = rows
    .map((r, i) => ({ r, o: order.get(r.id) ?? scored.length + i }))
    .sort((x, y) => x.o - y.o)
    .map((x) => x.r);
  const list = (json: string | null, f: (v: any) => string) => [...new Set((JSON.parse(json || "[]") as any[]).map(f))].join("; ");
  const out = ranked.map((r, i) => [
    i + 1,
    r.id,
    r.name,
    r.portal_name,
    r.portal_id,
    r.type,
    r.updated_at ? r.updated_at.slice(0, 10) : null,
    r.permalink,
    list(r.formats, (x) => x.format),
    r.api_endpoint,
    r.platform_family === "socrata" ? r.socrata_domain : null,
    r.platform_family === "socrata" && r.socrata_domain ? r.native_id : null,
    r.platform_family,
    list(r.place_counties, String),
    r.geometry_type,
    r.column_count,
  ]);
  const w = writeExport(slugFor([a.query, a.place, a.portal, a.platform_family, a.format, a.updated_since, a.group_by]), CSV_HEADER, out);
  resp.export = {
    path: w.path,
    uri: pathToFileURL(w.path).href,
    rows: w.rows,
    bytes: w.bytes,
    format: "CSV (RFC 4180), UTF-8, one row per matching dataset, best-ranked first",
    columns: CSV_HEADER,
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
