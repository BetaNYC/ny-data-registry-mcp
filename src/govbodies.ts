/**
 * Who runs a data site: the government body a registry row's registry_id points to, read from
 * BetaNYC/ny-gov-web-registry (data/registry.json), "the master list".
 *
 * Same pattern as the registry: a bundled copy, plus a conditional refresh of the published
 * copy cached under ${HOME}/.cache/betanyc/ny-data-registry/. The bundled copy holds only the
 * bodies the bundled registry's rows point to. The master list is READ ONLY here.
 *
 * Matching is by exact id only. No id means no answer, and nothing is guessed from names.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheDir, readDataJson, USER_AGENT } from "./paths.js";
import { fetchWithRetry } from "./http.js";

export const GOV_REGISTRY_URL = "https://raw.githubusercontent.com/BetaNYC/ny-gov-web-registry/main/data/registry.json";
export const GOV_REGISTRY_REPO = "BetaNYC/ny-gov-web-registry";
export const GOV_REGISTRY_FILE = "data/registry.json";

/** The few fields this server keeps from each master-list entity. */
export interface GovBody {
  id: string;
  name: string;
  short_name: string | null;
  government_level: string | null;
  classification: string | null;
  /** The domain of the body's current primary web property, as the master list writes it (e.g. "mta.info"). */
  primary_domain: string | null;
  status: string | null;
}

export interface GovBodiesDoc {
  /** Where the list was read from. */
  source: string;
  /** Bundled copy only: the day it was taken, and the commit it was taken from. */
  snapshot_date?: string;
  source_commit?: string;
  bodies: GovBody[];
}

export interface LoadedGovBodies {
  origin: "bundled" | "cache" | "fresh";
  fetched_at: string | null;
  snapshot_date: string | null;
  refresh_error: string | null;
  byId: Map<string, GovBody>;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The current primary web property: role "primary" and no end date. Null when there is none. */
function primaryDomain(props: unknown): string | null {
  if (!Array.isArray(props)) return null;
  const p = props.find((x) => x && x.role === "primary" && (x.valid_to === null || x.valid_to === undefined));
  return p ? str(p.domain) : null;
}

/** Keep only what a reply uses. Entities without a string id are dropped. */
export function slimEntities(entities: unknown[]): GovBody[] {
  const out: GovBody[] = [];
  for (const e of entities as any[]) {
    const id = str(e?.id);
    const name = str(e?.name);
    if (!id || !name) continue;
    out.push({
      id,
      name,
      short_name: str(e.short_name),
      government_level: str(e.government_level),
      classification: str(e.classification),
      primary_domain: primaryDomain(e.web_properties),
      status: str(e.status),
    });
  }
  return out;
}

/** The published file: { entities: [...] } with at least one entity that has an id and a name. */
export function slimMasterList(raw: unknown): GovBody[] | null {
  const ents = (raw as any)?.entities;
  if (!Array.isArray(ents)) return null;
  const bodies = slimEntities(ents);
  return bodies.length ? bodies : null;
}

function validSlim(x: any): x is GovBodiesDoc {
  return x && typeof x === "object" && Array.isArray(x.bodies) && x.bodies.length > 0 && x.bodies.every((b: any) => typeof b?.id === "string");
}

function toLoaded(doc: GovBodiesDoc, origin: LoadedGovBodies["origin"], fetched_at: string | null, refresh_error: string | null): LoadedGovBodies {
  return {
    origin,
    fetched_at,
    snapshot_date: doc.snapshot_date ?? null,
    refresh_error,
    byId: new Map(doc.bodies.map((b) => [b.id, b])),
  };
}

let loaded: LoadedGovBodies | null = null;

export function loadBundledBodies(): LoadedGovBodies {
  return toLoaded(readDataJson<GovBodiesDoc>("gov-bodies.json"), "bundled", null, null);
}

function cacheFiles() {
  const dir = cacheDir();
  return { dir, body: join(dir, "gov-bodies.json"), meta: join(dir, "gov-bodies.meta.json") };
}

/**
 * Conditional GET of the published master list. Falls back to the cached copy, then the
 * bundled copy. Off with NY_DATA_REGISTRY_REFRESH=0 or NY_DATA_OFFLINE=1. Never throws.
 * Only the slim fields are cached, so the cache stays small as the list grows.
 */
export async function refreshGovBodies(timeoutMs = 5000): Promise<LoadedGovBodies> {
  const bundled = loadBundledBodies();
  if (process.env.NY_DATA_REGISTRY_REFRESH === "0" || process.env.NY_DATA_OFFLINE === "1") {
    loaded = { ...bundled, refresh_error: "refresh disabled" };
    return loaded;
  }
  const f = cacheFiles();
  let meta: { etag?: string; fetched_at?: string } = {};
  let cached: GovBodiesDoc | null = null;
  try {
    if (existsSync(f.body)) {
      const c = JSON.parse(readFileSync(f.body, "utf8"));
      if (validSlim(c)) cached = c;
      meta = JSON.parse(readFileSync(f.meta, "utf8"));
    }
  } catch {
    // A broken meta file only costs the ETag; a broken body is ignored.
    meta = {};
  }
  try {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT };
    if (cached && meta.etag) headers["If-None-Match"] = meta.etag;
    const res = await fetchWithRetry(GOV_REGISTRY_URL, { headers, signal: AbortSignal.timeout(timeoutMs) }, Date.now() + timeoutMs);
    if (res.status === 304 && cached) {
      meta.fetched_at = new Date().toISOString();
      writeFileSync(f.meta, JSON.stringify(meta));
      loaded = toLoaded(cached, "cache", meta.fetched_at, null);
      return loaded;
    }
    if (res.status === 200) {
      const bodies = slimMasterList(await res.json());
      if (!bodies) throw new Error("published master list has no entities");
      const doc: GovBodiesDoc = { source: GOV_REGISTRY_URL, bodies };
      mkdirSync(f.dir, { recursive: true });
      writeFileSync(f.body, JSON.stringify(doc));
      const now = new Date().toISOString();
      writeFileSync(f.meta, JSON.stringify({ etag: res.headers.get("etag") ?? undefined, fetched_at: now }));
      loaded = toLoaded(doc, "fresh", now, null);
      return loaded;
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    loaded = cached ? toLoaded(cached, "cache", meta.fetched_at ?? null, err) : { ...bundled, refresh_error: err };
    return loaded;
  }
}

export function govBodies(): LoadedGovBodies {
  if (!loaded) loaded = loadBundledBodies();
  return loaded;
}

/** Test hook. */
export function setGovBodies(r: LoadedGovBodies | null): void {
  loaded = r;
}

/** Build a LoadedGovBodies from a slim doc (test hook and the bundle script). */
export function govBodiesFrom(doc: GovBodiesDoc, origin: LoadedGovBodies["origin"] = "bundled"): LoadedGovBodies {
  return toLoaded(doc, origin, null, null);
}

export type RunsIt =
  | { found: true; name: string; short_name?: string; government_level: string | null; classification: string | null; website: string | null; status?: string }
  | { found: false; note: string };

/**
 * The body that runs a data site, by its registry_id. Null when the row has no id.
 * `found: false` when the id is not in the master list this server loaded.
 */
export function runsIt(registryId: string | null | undefined): RunsIt | null {
  if (!registryId) return null;
  const b = govBodies().byId.get(registryId);
  if (!b) return { found: false, note: "this registry_id is not in the master list yet" };
  return {
    found: true,
    name: b.name,
    ...(b.short_name ? { short_name: b.short_name } : {}),
    government_level: b.government_level,
    classification: b.classification,
    website: b.primary_domain,
    ...(b.status && b.status !== "active" ? { status: b.status } : {}),
  };
}

/** One line per reply saying where every runs_it block came from. */
export function runsItSource() {
  const g = govBodies();
  return {
    list: `${GOV_REGISTRY_REPO} ${GOV_REGISTRY_FILE}`,
    url: GOV_REGISTRY_URL,
    copy: g.origin,
    as_of: g.fetched_at ?? g.snapshot_date,
    bodies: g.byId.size,
    rule: "runs_it is looked up by registry_id only. No id means runs_it is null; nothing is guessed from names. website is the body's primary domain as the list gives it.",
  };
}
