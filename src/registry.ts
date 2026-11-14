/**
 * The portal registry: bundled copy, plus an optional conditional refresh from
 * GitHub Pages cached under ${HOME}/.cache/betanyc/ny-data-registry/.
 * The registry is READ ONLY here. This package never edits it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheDir, readDataJson, REGISTRY_PAGE, REGISTRY_URL, USER_AGENT } from "./paths.js";
import { familyFor, FAMILIES, type FamilyResult } from "./families.js";
import { placeForRow, type RowPlace } from "./places.js";

export interface RegistryRow {
  tier: number;
  entity: string;
  entity_type: string;
  region: string;
  portal_name: string | null;
  url: string | null;
  platform: string | null;
  api_type: string | null;
  api_endpoint: string | null;
  key_required: string;
  dataset_count: number | null;
  status: string;
  last_verified: string;
  evidence: string | null;
  notes: string | null;
  registry_id: string | null;
  page: string | null;
  example_request: string | null;
}

export interface RegistryDoc {
  generated: string;
  source: string;
  fields: number;
  rows: RegistryRow[];
}

/** A registry row plus the fields this package derives. Derived fields are named in `derived`. */
export interface Source extends RegistryRow {
  source_id: string;
  platform_family: string | null;
  platform_family_status: FamilyResult["status"];
  platform_family_note: string | null;
  place: RowPlace;
  page_url: string;
  derived: string[];
}

export interface LoadedRegistry {
  generated: string;
  origin: "bundled" | "pages-cache" | "pages-fresh";
  fetched_at: string | null;
  refresh_error: string | null;
  sources: Source[];
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Stable id per row, derived (the registry has no row id, and registry_id names the
 * government body, which several rows can share). entity slug, plus the portal's host when
 * an entity has several rows.
 */
export function assignSourceIds(rows: RegistryRow[]): string[] {
  const byEntity = new Map<string, number>();
  for (const r of rows) byEntity.set(slug(r.entity), (byEntity.get(slug(r.entity)) ?? 0) + 1);
  const used = new Set<string>();
  return rows.map((r) => {
    const base = slug(r.entity);
    let id = base;
    if ((byEntity.get(base) ?? 0) > 1) {
      let host = "";
      try {
        host = r.url ? new URL(r.url).host.replace(/^www\./, "") : "";
      } catch {
        host = "";
      }
      id = `${base}--${slug(host || r.portal_name || r.platform || "row")}`;
    }
    let n = 2;
    const stem = id;
    while (used.has(id)) id = `${stem}-${n++}`;
    used.add(id);
    return id;
  });
}

export function buildSources(doc: RegistryDoc): Source[] {
  const ids = assignSourceIds(doc.rows);
  return doc.rows.map((row, i) => {
    // Prefer the registry's own platform_family once upstream adds it (docs/upstream/0001-add-platform-family.patch).
    const upstream = (row as RegistryRow & { platform_family?: string | null }).platform_family;
    const local = familyFor(row.platform, row.api_type);
    const fam =
      upstream !== undefined && (upstream === null || (FAMILIES as readonly string[]).includes(upstream))
        ? { ...local, family: upstream as FamilyResult["family"], status: (upstream === null ? "unconfirmed" : "mapped") as FamilyResult["status"], note: local.note ?? "platform_family from the registry" }
        : local;
    const page_url = row.page
      ? REGISTRY_PAGE.replace(/ny-data-portal-registry\.html$/, row.page.replace(/\.md$/, ".html"))
      : REGISTRY_PAGE;
    return {
      ...row,
      registry_id: cleanRegistryId(row.registry_id),
      source_id: ids[i],
      platform_family: fam.family,
      platform_family_status: fam.status,
      platform_family_note: fam.note,
      place: placeForRow(row),
      page_url,
      derived: ["source_id", "platform_family", "place", "page_url"],
    };
  });
}

/**
 * registry_id is the id of the government body in BetaNYC/ny-gov-web-registry
 * (data/registry.json). Copied from the row as is; an empty string or the registry's "—"
 * placeholder becomes null. Never derived or guessed.
 */
export function cleanRegistryId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t !== "—" ? t : null;
}

const ridBySource = new WeakMap<Source[], Map<string, string | null>>();
const sourcesByRid = new WeakMap<Source[], Map<string, string[]>>();

function ridMaps(): { bySource: Map<string, string | null>; byRid: Map<string, string[]> } {
  const sources = registry().sources;
  let bySource = ridBySource.get(sources);
  let byRid = sourcesByRid.get(sources);
  if (!bySource || !byRid) {
    bySource = new Map(sources.map((s) => [s.source_id, s.registry_id]));
    byRid = new Map();
    for (const s of sources) if (s.registry_id) byRid.set(s.registry_id, [...(byRid.get(s.registry_id) ?? []), s.source_id]);
    ridBySource.set(sources, bySource);
    sourcesByRid.set(sources, byRid);
  }
  return { bySource, byRid };
}

/**
 * The registry_id of a source (an index portal_id is a source_id), read from the registry
 * loaded now, not the index, so ids added upstream show without a new harvest. Null when
 * the row has none or the source is no longer in the registry.
 */
export function registryIdFor(sourceId: string): string | null {
  return ridMaps().bySource.get(sourceId) ?? null;
}

/** The source_ids of every row whose registry_id is exactly this value (several rows can share one). */
export function sourceIdsForRegistryId(registryId: string): string[] {
  return ridMaps().byRid.get(registryId.trim()) ?? [];
}

function validDoc(x: any): x is RegistryDoc {
  return x && typeof x === "object" && Array.isArray(x.rows) && x.rows.length > 0 && typeof x.generated === "string";
}

let loaded: LoadedRegistry | null = null;

export function loadBundled(): LoadedRegistry {
  const doc = readDataJson<RegistryDoc>("ny-data-portal-registry.json");
  return { generated: doc.generated, origin: "bundled", fetched_at: null, refresh_error: null, sources: buildSources(doc) };
}

function cacheFiles() {
  const dir = cacheDir();
  return { dir, body: join(dir, "registry.json"), meta: join(dir, "registry.meta.json") };
}

/**
 * Conditional GET of the published registry. Falls back to the cached copy, then the
 * bundled copy. Opt out with NY_DATA_REGISTRY_REFRESH=0. Never throws.
 */
export async function refreshRegistry(timeoutMs = 5000): Promise<LoadedRegistry> {
  const bundled = loadBundled();
  if (process.env.NY_DATA_REGISTRY_REFRESH === "0" || process.env.NY_DATA_OFFLINE === "1") {
    loaded = { ...bundled, refresh_error: "refresh disabled" };
    return loaded;
  }
  const f = cacheFiles();
  let meta: { etag?: string; fetched_at?: string } = {};
  let cached: RegistryDoc | null = null;
  try {
    if (existsSync(f.body)) {
      const c = JSON.parse(readFileSync(f.body, "utf8"));
      if (validDoc(c)) cached = c;
      meta = JSON.parse(readFileSync(f.meta, "utf8"));
    }
  } catch {
    cached = null;
  }
  try {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT };
    if (cached && meta.etag) headers["If-None-Match"] = meta.etag;
    const res = await fetch(REGISTRY_URL, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 304 && cached) {
      meta.fetched_at = new Date().toISOString();
      writeFileSync(f.meta, JSON.stringify(meta));
      loaded = pick(bundled, cached, "pages-cache", meta.fetched_at);
      return loaded;
    }
    if (res.status === 200) {
      const doc = await res.json();
      if (!validDoc(doc)) throw new Error("published registry JSON has no rows");
      mkdirSync(f.dir, { recursive: true });
      writeFileSync(f.body, JSON.stringify(doc));
      const now = new Date().toISOString();
      writeFileSync(f.meta, JSON.stringify({ etag: res.headers.get("etag") ?? undefined, fetched_at: now }));
      loaded = pick(bundled, doc, "pages-fresh", now);
      return loaded;
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    loaded = cached ? { ...pick(bundled, cached, "pages-cache", meta.fetched_at ?? null), refresh_error: err } : { ...bundled, refresh_error: err };
    return loaded;
  }
}

/** Use the published copy unless it is older than the bundled one. */
function pick(bundled: LoadedRegistry, doc: RegistryDoc, origin: LoadedRegistry["origin"], fetched_at: string | null): LoadedRegistry {
  if (doc.generated < bundled.generated) return { ...bundled, refresh_error: `published copy (${doc.generated}) is older than bundled; using bundled` };
  return { generated: doc.generated, origin, fetched_at, refresh_error: null, sources: buildSources(doc) };
}

export function registry(): LoadedRegistry {
  if (!loaded) loaded = loadBundled();
  return loaded;
}

/** Test hook. */
export function setRegistry(r: LoadedRegistry | null): void {
  loaded = r;
}
