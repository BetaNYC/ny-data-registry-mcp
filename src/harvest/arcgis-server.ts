/**
 * ArcGIS Server REST directory adapter (issue #16, milestone 4). For agencies and counties that
 * publish services with no catalog in front of them: the State's GIS servers, DOT, DEC, and
 * county servers such as Broome and Ulster. Read weekly per host (epic #7, decision D5).
 *
 * Built against official docs, read 2026-11-14:
 * - Services Directory root: https://developers.arcgis.com/rest/services-reference/enterprise/catalog/
 *   `<root>?f=json` gives `currentVersion`, `folders` (names) and `services` ({name, type}).
 *   A folder is read the same way at `<root>/<folder>`.
 * - Map service: https://developers.arcgis.com/rest/services-reference/enterprise/map-service/
 *   (`serviceDescription`, `mapName`, `description`, `copyrightText`, `layers`, `tables`,
 *   `fullExtent`, `documentInfo` {Title, Keywords, ...}, `capabilities`).
 * - Feature service: https://developers.arcgis.com/rest/services-reference/enterprise/feature-service/
 *   (same descriptive fields, `layers` and `tables` as {id, name}).
 * - Image service: https://developers.arcgis.com/rest/services-reference/enterprise/image-service/
 *   (`name`, `serviceDescription`, `description`, `extent`, `copyrightText`; no layers).
 * - Layer fields: `<service>/<id>?f=json`, `fields` {name, type, alias}, `geometryType`.
 *
 * Metadata only: one request per folder, one per service, and a few per service for layer
 * fields, all inside a per-host request cap. robots.txt and Crawl-delay are honored by
 * politeFetch; this adapter also keeps its own, wider gap between requests to a host.
 */
import { politeJson, BlockedError, setHostFloorMs } from "../http.js";
import { isLonLatBox } from "../places.js";
import { cleanedLabel, stripHtml, type HarvestedColumn, type HarvestedDataset } from "../db.js";

export interface ServerConfig {
  /** Total requests to one host per read (listing, services and layers together). */
  max_requests_per_host: number;
  /** Gap between two requests to the same host (at least the package floor of 1 s). */
  min_interval_ms: number;
  /** Folders never read (ArcGIS Server's own utility folders). */
  skip_folders: string[];
  /** Service types kept. */
  service_types: string[];
  /** Layer field requests per service. */
  max_layers_per_service: number;
  /** Stop reading a host after this long (a long robots.txt Crawl-delay could otherwise outlast the workflow). */
  max_seconds_per_host: number;
}

/** Requests left, and the time after which no new request starts. */
export interface ServerBudget {
  left: number;
  deadline?: number;
}

/** Whether another request may start: requests left and time left. */
export function canRequest(b: ServerBudget, now = Date.now()): boolean {
  return b.left > 0 && (b.deadline === undefined || now < b.deadline);
}

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  max_requests_per_host: 400,
  min_interval_ms: 2000,
  skip_folders: ["Utilities", "System"],
  service_types: ["MapServer", "FeatureServer", "ImageServer"],
  max_layers_per_service: 5,
  max_seconds_per_host: 1800,
};

/** A path robots.txt disallows is skipped (and the read marked incomplete); any other block stops the host. */
function robotsSkip(e: unknown): boolean {
  return e instanceof BlockedError && /robots\.txt/.test(e.reason);
}

/** `https://host/<context>/rest/services` from a registry row's URL or endpoint, or null. */
export function serverRootOf(...urls: (string | null | undefined)[]): string | null {
  for (const u of urls) {
    const m = (u ?? "").match(/(https?:\/\/[^\s?#;]+?\/rest\/services)(?=[/?#\s;]|$)/i);
    if (m) return m[1];
  }
  return null;
}

export interface CatalogDoc {
  currentVersion?: number;
  folders?: string[];
  services?: { name: string; type: string }[];
  error?: unknown;
}

export interface ServiceRef {
  /** Full name as the directory gives it, with its folder ("Parcels/NYS_Tax_Parcels_Public"). */
  name: string;
  type: string;
  url: string;
}

/**
 * The full service name. The docs show root service names only; inside a folder, servers give
 * the name with its folder already in front. Both are handled: the folder is added only when
 * missing.
 */
export function fullServiceName(folder: string | null, name: string): string {
  if (!folder) return name;
  return name === folder || name.startsWith(`${folder}/`) ? name : `${folder}/${name}`;
}

export interface ServerListing {
  services: ServiceRef[];
  folders_read: number;
  folders_skipped: string[];
  requests: number;
  complete: boolean;
  version: number | null;
  error: string | null;
}

/** Walk the directory: the root, then each folder (and nested folder), within the request budget. */
export async function listServerServices(root: string, cfg: ServerConfig, budget: ServerBudget): Promise<ServerListing> {
  const out: ServerListing = { services: [], folders_read: 0, folders_skipped: [], requests: 0, complete: true, version: null, error: null };
  const keep = new Set(cfg.service_types);
  const skip = new Set(cfg.skip_folders.map((f) => f.toLowerCase()));
  const queue: (string | null)[] = [null];
  const seen = new Set<string>();
  while (queue.length) {
    const folder = queue.shift()!;
    if (!canRequest(budget)) {
      out.complete = false;
      out.error = `${budget.left <= 0 ? "request cap" : "time cap"} reached while listing (${queue.length + 1} folder(s) not read)`;
      break;
    }
    budget.left--;
    out.requests++;
    const url = folder ? `${root}/${folder.split("/").map(encodeURIComponent).join("/")}?f=json` : `${root}?f=json`;
    let doc: CatalogDoc;
    try {
      ({ data: doc } = await politeJson<CatalogDoc>(url));
    } catch (e) {
      if (!folder || (e instanceof BlockedError && !robotsSkip(e))) throw e;
      out.complete = false;
      out.error = `folder ${folder}: ${e instanceof Error ? e.message : String(e)}`;
      continue;
    }
    if (doc.error) {
      if (!folder) throw new Error(`directory error: ${JSON.stringify(doc.error).slice(0, 200)}`);
      out.complete = false;
      out.error = `folder ${folder}: ${JSON.stringify(doc.error).slice(0, 160)}`;
      continue;
    }
    if (!folder) out.version = typeof doc.currentVersion === "number" ? doc.currentVersion : null;
    else out.folders_read++;
    for (const s of doc.services ?? []) {
      if (!s?.name || !keep.has(s.type)) continue;
      const name = fullServiceName(folder, s.name);
      const k = `${name}/${s.type}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.services.push({ name, type: s.type, url: `${root}/${name.split("/").map(encodeURIComponent).join("/")}/${s.type}` });
    }
    for (const f of doc.folders ?? []) {
      const full = fullServiceName(folder, f);
      const last = full.split("/").pop()!.toLowerCase();
      if (skip.has(last) || skip.has(full.toLowerCase())) {
        out.folders_skipped.push(full);
        continue;
      }
      queue.push(full);
    }
  }
  return out;
}

export interface ServiceDoc {
  currentVersion?: number;
  serviceDescription?: string;
  description?: string;
  mapName?: string;
  name?: string;
  copyrightText?: string;
  capabilities?: string;
  layers?: { id: number; name: string; subLayerIds?: number[] | null; type?: string; geometryType?: string }[];
  tables?: { id: number; name: string }[];
  fullExtent?: Envelope;
  extent?: Envelope;
  documentInfo?: Record<string, string>;
  error?: unknown;
}

interface Envelope {
  xmin?: number;
  ymin?: number;
  xmax?: number;
  ymax?: number;
  spatialReference?: { wkid?: number; latestWkid?: number };
}

const WEB_MERCATOR = new Set([102100, 102113, 3857, 900913]);
const GEOGRAPHIC = new Set([4326, 4269]);
const R = 6378137;

/** An envelope as a lon/lat box: geographic as is, Web Mercator converted; any other projection is unknown (null). */
export function envelopeToLonLat(e: Envelope | undefined): [number, number, number, number] | null {
  if (!e || ![e.xmin, e.ymin, e.xmax, e.ymax].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  const wkid = e.spatialReference?.latestWkid ?? e.spatialReference?.wkid;
  let box: [number, number, number, number] | null = null;
  if (wkid && GEOGRAPHIC.has(wkid)) box = [e.xmin!, e.ymin!, e.xmax!, e.ymax!];
  else if (wkid && WEB_MERCATOR.has(wkid)) {
    const lon = (x: number) => (x / R) * (180 / Math.PI);
    const lat = (y: number) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);
    box = [lon(e.xmin!), lat(e.ymin!), lon(e.xmax!), lat(e.ymax!)];
  }
  return isLonLatBox(box) ? box : null;
}

const ITEM_TYPE: Record<string, string> = { MapServer: "Map Service", FeatureServer: "Feature Service", ImageServer: "Image Service" };

/** Map one service's JSON to a dataset. The title is the service's own (documentInfo.Title), else its name. */
export function mapServerService(ref: ServiceRef, doc: ServiceDoc): HarvestedDataset {
  const title = doc.documentInfo?.Title?.trim() || ref.name.split("/").pop()!;
  const rawDesc = doc.serviceDescription || doc.description || "";
  const desc = stripHtml(rawDesc) || null;
  const publisher = stripHtml(doc.copyrightText ?? "") || null;
  const keywords = (doc.documentInfo?.Keywords ?? "")
    .split(/[,;]/)
    .map((k) => k.trim())
    .filter(Boolean);
  const folder = ref.name.includes("/") ? ref.name.slice(0, ref.name.lastIndexOf("/")) : null;
  return {
    native_id: `${ref.name}/${ref.type}`,
    name: title,
    description: desc,
    department: null,
    categories: folder ? [folder] : [],
    tags: keywords,
    metadata_updated_at: null,
    updated_at: null,
    created_at: null,
    type: ITEM_TYPE[ref.type] ?? ref.type,
    permalink: ref.url,
    downloads: null,
    views: null,
    update_frequency: null,
    api_endpoint: ref.url,
    formats: [{ format: "ArcGIS GeoServices REST API", media_type: "application/json", url: ref.url, provenance: "portal" }],
    extent: envelopeToLonLat(doc.fullExtent ?? doc.extent),
    license: null,
    publisher,
    row_count: null,
    geometry_type: null,
    owner: null,
    org_id: null,
    columns: null,
    columns_status: (doc.layers?.length || doc.tables?.length) ? "not-fetched" : "none",
    provenance: {
      name: doc.documentInfo?.Title?.trim() ? "portal" : "derived",
      // Cleaned by stripHtml (tags removed, spaces squeezed): derived when that changed the value.
      // The publisher is the service's copyrightText, a credit line, not a named publisher field.
      description: cleanedLabel(rawDesc, desc), tags: "portal", categories: "derived", extent: "portal", publisher: publisher === null ? "portal" : "derived",
      api_endpoint: "portal", formats: "portal", permalink: "derived", place: "derived", type: "derived",
    },
  };
}

/** Field requests for a service's data layers (not group layers), inside both budgets. */
export async function fetchLayerColumns(ref: ServiceRef, doc: ServiceDoc, maxLayers: number, budget: ServerBudget): Promise<{ columns: HarvestedColumn[]; geometry_type: string | null; requests: number; complete: boolean }> {
  const layers = [...(doc.layers ?? []).filter((l) => !l.subLayerIds?.length), ...(doc.tables ?? [])];
  const multi = layers.length > 1;
  const out: HarvestedColumn[] = [];
  const geoms = new Set<string>();
  let requests = 0;
  let complete = true;
  for (const l of layers.slice(0, maxLayers)) {
    if (!canRequest(budget)) {
      complete = false;
      break;
    }
    budget.left--;
    requests++;
    try {
      const { data } = await politeJson<{ fields?: { name: string; type?: string; alias?: string }[]; geometryType?: string; error?: unknown }>(`${ref.url}/${l.id}?f=json`);
      if (data.error) continue;
      if (data.geometryType) geoms.add(data.geometryType);
      for (const f of data.fields ?? []) out.push({ name: f.alias ?? null, field: f.name, type: f.type ?? null, description: null, layer: multi ? l.name : null });
    } catch (e) {
      if (e instanceof BlockedError && !robotsSkip(e)) throw e;
      complete = false;
    }
  }
  if (layers.length > maxLayers) complete = false;
  return { columns: out, geometry_type: geoms.size ? [...geoms].join(",") : null, requests, complete };
}

export interface ServerHarvest {
  datasets: HarvestedDataset[];
  requests: number;
  complete: boolean;
  listed: number;
  version: number | null;
  folders_skipped: string[];
  error: string | null;
}

/** Read one ArcGIS Server: list, then each service, then layer fields, all inside the host's cap. */
export async function harvestArcgisServer(root: string, cfg: ServerConfig = DEFAULT_SERVER_CONFIG): Promise<ServerHarvest> {
  setHostFloorMs(new URL(root).host, cfg.min_interval_ms);
  const budget: ServerBudget = { left: cfg.max_requests_per_host, deadline: Date.now() + cfg.max_seconds_per_host * 1000 };
  const l = await listServerServices(root, cfg, budget);
  let requests = l.requests;
  let complete = l.complete;
  let error = l.error;
  const datasets: HarvestedDataset[] = [];
  for (const ref of l.services) {
    if (!canRequest(budget)) {
      complete = false;
      error = error ?? `${budget.left <= 0 ? `request cap (${cfg.max_requests_per_host})` : `time cap (${cfg.max_seconds_per_host} s)`} reached: ${l.services.length - datasets.length} service(s) not read`;
      break;
    }
    budget.left--;
    requests++;
    let doc: ServiceDoc;
    try {
      ({ data: doc } = await politeJson<ServiceDoc>(`${ref.url}?f=json`));
    } catch (e) {
      if (e instanceof BlockedError && !robotsSkip(e)) throw e;
      complete = false;
      error = error ?? `service ${ref.name}: ${e instanceof Error ? e.message : String(e)}`;
      continue;
    }
    if (doc.error) {
      // A secured or broken service: listed, but not public. Not stored.
      continue;
    }
    const ds = mapServerService(ref, doc);
    if (ds.columns_status === "not-fetched" && canRequest(budget)) {
      const c = await fetchLayerColumns(ref, doc, cfg.max_layers_per_service, budget);
      requests += c.requests;
      if (c.columns.length) {
        ds.columns = c.columns;
        ds.columns_status = "fetched";
        ds.geometry_type = c.geometry_type;
        ds.provenance.columns = "portal";
        ds.provenance.geometry_type = "portal";
      }
    }
    datasets.push(ds);
  }
  return { datasets, requests, complete, listed: l.services.length, version: l.version, folders_skipped: l.folders_skipped, error };
}
