/**
 * ArcGIS adapters: Hub sites, Enterprise portals, and ArcGIS Online orgs.
 *
 * Built against official docs, read 2026-11-05:
 * - Hub feeds: https://doc.arcgis.com/en/hub/content/federate-data.htm
 *   DCAT-US 1.1 at <siteURL>/api/feed/dcat-us/1.1.json; OGC API - Records described by
 *   each site at <siteURL>/api/search/definition (OpenAPI 3.0). Items endpoint
 *   /api/search/v1/collections/dataset/items with `limit` (max 100) and `startindex` (1-based).
 * - DCAT-US 1.1 field meanings: https://resources.data.gov/resources/dcat-us/
 * - Portal search: https://developers.arcgis.com/rest/users-groups-and-items/search/
 *   (`q`, `num` max 100, `start` 1-based, `nextStart`; total exact to 10,000) and
 *   https://developers.arcgis.com/rest/users-groups-and-items/search-reference/ (`orgid:`, `type:`).
 * - Portal self (org id): <portal>/sharing/rest/portals/self?f=json
 * - Feature service / layer JSON (`?f=json`): layers, tables; fields{name,type,alias},
 *   geometryType, description, copyrightText:
 *   https://developers.arcgis.com/rest/services-reference/enterprise/feature-service/
 *   https://developers.arcgis.com/rest/services-reference/enterprise/feature-layer/
 *
 * The harvester stores metadata only (titles, descriptions, field names, links). It
 * never downloads data, and it excludes Esri-owned content (see docs/terms.md).
 */
import { politeJson, BlockedError } from "../http.js";
import { bboxCenterInNY, bboxIntersectsNY, isLonLatBox } from "../places.js";
import type { Distribution, HarvestedColumn, HarvestedDataset } from "../db.js";

export interface ArcgisItem {
  id: string;
  title?: string;
  name?: string;
  type?: string;
  owner?: string;
  orgId?: string;
  created?: number;
  modified?: number;
  description?: string | null;
  snippet?: string | null;
  tags?: string[];
  categories?: string[];
  url?: string | null;
  numViews?: number;
  licenseInfo?: string | null;
  accessInformation?: string | null;
  source?: string | null;
  extent?: number[][] | { type: string; coordinates: number[][][] } | null;
  access?: string;
}

const SERVICE_TYPES = new Set(["Feature Service", "Map Service"]);

export function bboxOf(extent: ArcgisItem["extent"]): [number, number, number, number] | null {
  if (!extent) return null;
  if (Array.isArray(extent) && extent.length === 2 && Array.isArray(extent[0])) {
    const [[a, b], [c, d]] = extent as number[][];
    return [a, b, c, d].every(Number.isFinite) ? [a, b, c, d] : null;
  }
  const geo = extent as { coordinates?: number[][][] };
  const ring = geo.coordinates?.[0];
  if (!ring?.length) return null;
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function parseDcatSpatial(s: unknown): [number, number, number, number] | null {
  if (typeof s !== "string") return null;
  const n = s.split(",").map(Number);
  return n.length === 4 && n.every(Number.isFinite) ? (n as [number, number, number, number]) : null;
}

const iso = (ms?: number) => (typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : null);
const templated = (s?: string | null) => (s && !/\{\{.*\}\}/.test(s) ? s : null);

export function mapArcgisItem(it: ArcgisItem, opts: { permalink: string | null }): HarvestedDataset {
  const svc = it.url && /\/(FeatureServer|MapServer)(\/\d+)?\/?$/.test(it.url) ? it.url.replace(/\/$/, "") : null;
  const formats: Distribution[] = [];
  if (svc) formats.push({ format: "ArcGIS GeoServices REST API", media_type: "application/json", url: svc, provenance: "portal" });
  else if (it.type && it.url) formats.push({ format: it.type, media_type: null, url: it.url, provenance: "portal" });
  return {
    native_id: it.id,
    name: it.title ?? it.name ?? null,
    description: (it.description || it.snippet) ?? null,
    department: it.accessInformation ?? it.source ?? null,
    categories: it.categories ?? [],
    tags: (it.tags ?? []).filter((t) => t && t.trim()),
    metadata_updated_at: iso(it.modified),
    updated_at: iso(it.modified),
    created_at: iso(it.created),
    type: it.type ?? null,
    permalink: opts.permalink,
    downloads: null,
    views: typeof it.numViews === "number" ? it.numViews : null,
    update_frequency: null,
    api_endpoint: svc,
    formats,
    extent: ((e) => (isLonLatBox(e) ? e : null))(bboxOf(it.extent)),
    license: it.licenseInfo ? it.licenseInfo.replace(/<[^>]+>/g, " ").trim() || null : null,
    publisher: it.source ?? it.accessInformation ?? null,
    row_count: null,
    geometry_type: null,
    owner: it.owner ?? null,
    org_id: it.orgId ?? null,
    columns: null,
    columns_status: svc && it.type && SERVICE_TYPES.has(it.type) ? "not-fetched" : "none",
    provenance: {
      name: "portal", description: "portal", department: "portal", tags: "portal", categories: "portal", updated_at: "portal",
      created_at: "portal", views: "portal", extent: "portal", license: "portal", publisher: "portal", api_endpoint: "portal",
      formats: "portal", permalink: "derived", place: "derived",
    },
  };
}

// ─── second hop: fields per layer ────────────────────────────────────────────

export interface ColumnFetch {
  columns: HarvestedColumn[];
  geometry_type: string | null;
  requests: number;
  error: string | null;
}

/** GET <service>?f=json, then each layer/table ?f=json (up to maxLayers). */
export async function fetchServiceColumns(serviceUrl: string, budget: { left: number }, maxLayers = 10): Promise<ColumnFetch> {
  const out: ColumnFetch = { columns: [], geometry_type: null, requests: 0, error: null };
  const layerUrls: { url: string; name: string | null }[] = [];
  try {
    if (/\/\d+$/.test(serviceUrl)) {
      layerUrls.push({ url: serviceUrl, name: null });
    } else {
      if (budget.left <= 0) return { ...out, error: "budget" };
      budget.left--;
      out.requests++;
      const { data } = await politeJson<{ layers?: { id: number; name: string }[]; tables?: { id: number; name: string }[]; error?: unknown }>(`${serviceUrl}?f=json`);
      if ((data as any).error) throw new Error(`service error: ${JSON.stringify((data as any).error).slice(0, 160)}`);
      for (const l of [...(data.layers ?? []), ...(data.tables ?? [])].slice(0, maxLayers)) {
        layerUrls.push({ url: `${serviceUrl}/${l.id}`, name: l.name ?? null });
      }
    }
    const multi = layerUrls.length > 1;
    const geoms = new Set<string>();
    for (const l of layerUrls) {
      if (budget.left <= 0) {
        out.error = out.columns.length ? "partial: layer budget reached" : "budget";
        break;
      }
      budget.left--;
      out.requests++;
      const { data } = await politeJson<{ name?: string; fields?: { name: string; type?: string; alias?: string }[]; geometryType?: string; error?: unknown }>(`${l.url}?f=json`);
      if ((data as any).error) continue;
      if (data.geometryType) geoms.add(data.geometryType);
      for (const f of data.fields ?? []) {
        out.columns.push({
          name: f.alias ?? null,
          field: f.name,
          type: f.type ?? null,
          description: null,
          layer: multi ? l.name ?? data.name ?? null : null,
        });
      }
    }
    out.geometry_type = geoms.size ? [...geoms].join(",") : null;
    return out;
  } catch (e) {
    // A blocked or failing *layer* (often a third-party service an item points to) is
    // recorded and skipped. Only a blocked *listing* call stops a whole portal.
    return { ...out, error: e instanceof BlockedError ? `blocked: ${e.reason}` : e instanceof Error ? e.message : String(e) };
  }
}

// ─── listing items ───────────────────────────────────────────────────────────

export interface Listing {
  items: ArcgisItem[];
  requests: number;
  complete: boolean;
  total: number | null;
  error: string | null;
}

/**
 * OGC API - Records listing. Newer Hub sites have a `dataset` collection; some older
 * sites only have `all` (Otsego's registry row uses /collections/all/items), in which
 * case non-data item types are dropped by the caller's type filter.
 */
export async function listHubItems(site: string, maxPages = 40, collection = "dataset"): Promise<Listing> {
  const base = site.replace(/\/+$/, "");
  const byId = new Map<string, ArcgisItem>();
  let requests = 0;
  let total: number | null = null;
  // Unsorted paging is not stable (seen 2026-11-05: Syracuse pages repeated and skipped
  // items between runs). Sort by `id`, a queryable listed at /collections/<c>/queryables;
  // if a site rejects it, page unsorted and rely on the completeness check below.
  let sort = "&sortBy=%2Bid";
  try {
    for (let page = 0; page < maxPages; page++) {
      const url = `${base}/api/search/v1/collections/${collection}/items?limit=100&startindex=${page * 100 + 1}${sort}`;
      let data: { features: { id: string; properties: ArcgisItem }[]; numberMatched?: number; links?: { rel: string }[] };
      try {
        ({ data } = await politeJson(url, { cache: true }));
      } catch (e) {
        if (page === 0 && sort && /HTTP 400/.test(String(e))) {
          sort = "";
          page--;
          requests++;
          continue;
        }
        throw e;
      }
      requests++;
      total = data.numberMatched ?? total;
      for (const f of data.features ?? []) byId.set(f.properties.id ?? f.id, { ...f.properties, id: f.properties.id ?? f.id });
      const hasNext = (data.links ?? []).some((l) => l.rel === "next");
      if (!hasNext || (data.features ?? []).length === 0) {
        const items = [...byId.values()];
        const short = total !== null && items.length < total;
        return { items, requests, complete: !short, total, error: short ? `listing returned ${items.length} unique of ${total}; treated as incomplete (nothing marked removed)` : null };
      }
    }
    return { items: [...byId.values()], requests, complete: false, total, error: `stopped at ${maxPages} pages` };
  } catch (e) {
    if (e instanceof BlockedError) throw e;
    return { items: [...byId.values()], requests, complete: false, total, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface DcatEntry {
  identifier?: string;
  landingPage?: string;
  title?: string;
  spatial?: string;
  license?: string;
  publisher?: { name?: string };
  distribution?: { format?: string; mediaType?: string; accessURL?: string; downloadURL?: string; title?: string }[];
}

/** DCAT-US 1.1 feed, keyed by ArcGIS item id (taken from the identifier's `id=` parameter). */
export async function dcatByItem(site: string): Promise<{ byItem: Map<string, DcatEntry[]>; requests: number; error: string | null }> {
  const byItem = new Map<string, DcatEntry[]>();
  try {
    const { data } = await politeJson<{ dataset?: DcatEntry[] }>(`${site.replace(/\/+$/, "")}/api/feed/dcat-us/1.1.json`, { cache: true, timeoutMs: 120000 });
    for (const d of data.dataset ?? []) {
      const m = (d.identifier ?? "").match(/[?&]id=([0-9a-f]{32})/i) ?? (d.landingPage ?? "").match(/\/([0-9a-f]{32})(?:_\d+)?\/?$/i);
      if (!m) continue;
      const k = m[1].toLowerCase();
      byItem.set(k, [...(byItem.get(k) ?? []), d]);
    }
    return { byItem, requests: 1, error: null };
  } catch (e) {
    if (e instanceof BlockedError) throw e;
    return { byItem, requests: 1, error: e instanceof Error ? e.message : String(e) };
  }
}

export function mergeDcat(ds: HarvestedDataset, entries: DcatEntry[] | undefined): void {
  if (!entries?.length) return;
  const seen = new Set(ds.formats.map((f) => `${f.format}|${f.url}`));
  for (const e of entries) {
    for (const d of e.distribution ?? []) {
      if (!d.format || d.format === "Web Page") continue;
      const url = d.downloadURL ?? d.accessURL ?? null;
      const k = `${d.format}|${url}`;
      if (seen.has(k)) continue;
      seen.add(k);
      ds.formats.push({ format: d.format, media_type: d.mediaType ?? null, url, provenance: "portal" });
    }
  }
  const first = entries[0];
  if (first.landingPage) {
    ds.permalink = first.landingPage;
    ds.provenance.permalink = "portal";
  }
  if (!ds.license && templated(first.license)) ds.license = templated(first.license);
  if (!ds.publisher && templated(first.publisher?.name)) ds.publisher = templated(first.publisher?.name);
  if (!ds.extent) {
    const e = parseDcatSpatial(first.spatial);
    ds.extent = isLonLatBox(e) ? e : null;
  }
}

export async function portalSelf(portalBase: string): Promise<{ id: string | null; name: string | null }> {
  const { data } = await politeJson<{ id?: string; name?: string }>(`${portalBase}/sharing/rest/portals/self?f=json`);
  return { id: data.id ?? null, name: data.name ?? null };
}

export async function searchPortal(sharingBase: string, q: string, maxPages = 30): Promise<Listing> {
  const items: ArcgisItem[] = [];
  let requests = 0;
  let total: number | null = null;
  let start = 1;
  try {
    for (let page = 0; page < maxPages; page++) {
      // Sorted by created (stable for existing items), so pages do not shift between requests.
      const params = new URLSearchParams({ q, num: "100", start: String(start), f: "json", sortField: "created", sortOrder: "asc" });
      const { data } = await politeJson<{ total: number; nextStart: number; results: ArcgisItem[]; error?: unknown }>(`${sharingBase}/search?${params}`);
      requests++;
      if ((data as any).error) throw new Error(`search error: ${JSON.stringify((data as any).error).slice(0, 200)}`);
      total = data.total;
      for (const it of data.results ?? []) if (!items.some((x) => x.id === it.id)) items.push(it);
      if (!data.nextStart || data.nextStart < 0 || (data.results ?? []).length === 0) {
        const short = items.length < total;
        return { items, requests, complete: !short, total, error: short ? `search returned ${items.length} unique of ${total}; treated as incomplete (nothing marked removed)` : null };
      }
      start = data.nextStart;
    }
    return { items, requests, complete: false, total, error: `stopped at ${maxPages} pages` };
  } catch (e) {
    if (e instanceof BlockedError) throw e;
    return { items, requests, complete: false, total, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── filtering ───────────────────────────────────────────────────────────────

export interface FilterResult {
  kept: ArcgisItem[];
  excluded: { esri: number; other_org: number; out_of_state: number; not_public: number };
  own_org: string | null;
  other_orgs: Record<string, number>;
  /** Out-of-state guard for the whole portal. */
  portal_in_ny: { checked: number; center_in_ny: number; refuse: boolean };
}

export function mostCommonOrg(items: ArcgisItem[]): string | null {
  const counts = new Map<string, number>();
  for (const it of items) if (it.orgId) counts.set(it.orgId, (counts.get(it.orgId) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [k, v] of counts) if (v > n) [best, n] = [k, v];
  return best;
}

/** Item types that are data (used when a listing is not already limited to data). */
export const DATA_TYPES = new Set(["Feature Service", "Map Service", "CSV", "Shapefile", "File Geodatabase", "GeoJson", "Microsoft Excel", "KML", "Table", "Image Service", "GeoPackage", "CSV Collection"]);

/** Build items from a DCAT-US feed when a Hub site has no OGC Records collection (older Hub Basic sites). */
export function itemsFromDcat(entries: DcatEntry[]): ArcgisItem[] {
  const byId = new Map<string, ArcgisItem>();
  for (const d of entries) {
    const m = (d.identifier ?? "").match(/[?&]id=([0-9a-f]{32})/i) ?? (d.landingPage ?? "").match(/\/([0-9a-f]{32})(?:_\d+)?\/?$/i);
    if (!m) continue;
    const id = m[1].toLowerCase();
    if (byId.has(id)) continue;
    const geo = (d.distribution ?? []).find((x) => x.format === "ArcGIS GeoServices REST API");
    const svc = geo?.accessURL ? geo.accessURL.replace(/\/\d+\/?$/, "") : null;
    const org = svc?.match(/services\d*\.arcgis\.com\/([A-Za-z0-9]+)\//)?.[1];
    const b = parseDcatSpatial(d.spatial);
    const anyD = d as DcatEntry & { description?: string; keyword?: string[]; modified?: string; issued?: string };
    byId.set(id, {
      id,
      title: d.title,
      type: svc ? (/MapServer/.test(svc) ? "Map Service" : "Feature Service") : undefined,
      url: svc,
      orgId: org,
      description: anyD.description ?? null,
      tags: (anyD.keyword ?? []).filter((k) => k && k.trim()),
      modified: anyD.modified ? Date.parse(anyD.modified) : undefined,
      created: anyD.issued ? Date.parse(anyD.issued) : undefined,
      extent: b ? [[b[0], b[1]], [b[2], b[3]]] : null,
      access: "public",
    });
  }
  return [...byId.values()];
}

export function filterItems(
  items: ArcgisItem[],
  opts: { ownOrg: string | null; esriOrgIds: string[]; esriOwner: RegExp; serviceHostOrg?: string | null; serviceHost?: string | null; dataTypesOnly?: boolean }
): FilterResult {
  const res: FilterResult = {
    kept: [],
    excluded: { esri: 0, other_org: 0, out_of_state: 0, not_public: 0 },
    own_org: opts.ownOrg,
    other_orgs: {},
    portal_in_ny: { checked: 0, center_in_ny: 0, refuse: false },
  };
  for (const it of items) {
    if (it.access && it.access !== "public") {
      res.excluded.not_public++;
      continue;
    }
    if ((it.orgId && opts.esriOrgIds.includes(it.orgId)) || (it.owner && opts.esriOwner.test(it.owner))) {
      res.excluded.esri++;
      continue;
    }
    if (opts.ownOrg && it.orgId && it.orgId !== opts.ownOrg) {
      res.excluded.other_org++;
      res.other_orgs[it.orgId] = (res.other_orgs[it.orgId] ?? 0) + 1;
      continue;
    }
    if (opts.serviceHostOrg && it.url && !it.url.includes(`/${opts.serviceHostOrg}/`)) {
      res.excluded.other_org++;
      continue;
    }
    if (opts.serviceHost && it.url) {
      let h = "";
      try {
        h = new URL(it.url).host;
      } catch {
        h = "";
      }
      if (h !== opts.serviceHost) {
        res.excluded.other_org++;
        res.other_orgs[h || "(no host)"] = (res.other_orgs[h || "(no host)"] ?? 0) + 1;
        continue;
      }
    }
    if (opts.dataTypesOnly && it.type && !DATA_TYPES.has(it.type)) continue;
    const b = bboxOf(it.extent);
    if (isLonLatBox(b)) {
      res.portal_in_ny.checked++;
      if (bboxCenterInNY(b)) res.portal_in_ny.center_in_ny++;
      if (bboxIntersectsNY(b) === false) {
        res.excluded.out_of_state++;
        continue;
      }
    }
    res.kept.push(it);
  }
  const p = res.portal_in_ny;
  p.refuse = p.checked >= 3 && p.center_in_ny / p.checked < 0.5;
  return res;
}
