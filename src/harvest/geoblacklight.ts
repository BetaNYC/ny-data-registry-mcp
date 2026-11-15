/**
 * GeoBlacklight adapter, through OpenGeoMetadata (issue #16, milestone 6). A GeoBlacklight site
 * is not called. Its institution shares the same records on GitHub under OpenGeoMetadata, so the
 * whole repository is read as one archive, once a week.
 *
 * Built against official docs, read 2026-11-14:
 * - GeoBlacklight 1.0 schema: https://opengeometadata.org/gbl-1.0/ (dc_identifier_s, dc_rights_s
 *   "Public" | "Restricted", dc_title_s, dc_description_s, layer_slug_s, solr_geom
 *   "ENVELOPE(W, E, N, S)", dct_references_s, dc_format_s, dc_subject_sm, dct_spatial_sm,
 *   layer_geom_type_s, layer_modified_dt, suppressed_b, dc_publisher_s / dc_publisher_sm).
 * - OGM Aardvark schema: https://opengeometadata.org/ogm-aardvark/ (id, dct_title_s,
 *   dct_description_sm, dct_accessRights_s, locn_geometry and dcat_bbox, dct_references_s,
 *   dct_format_s, dct_subject_sm, dcat_keyword_sm, dct_spatial_sm, gbl_mdModified_dt,
 *   gbl_suppressed_b, dct_publisher_sm, dct_license_sm, gbl_mdVersion_s "Aardvark").
 * - Reference URIs (keys of dct_references_s): https://opengeometadata.org/reference-uris/
 * - withdrawn.json (records a repository stopped publishing): https://opengeometadata.org/repository-files/
 * - The archive: GitHub REST API "Download a repository archive (tar)",
 *   GET /repos/{owner}/{repo}/tarball/{ref}, which redirects to the archive:
 *   https://docs.github.com/en/rest/repos/contents#download-a-repository-archive-tar
 */
import { gunzipSync } from "node:zlib";
import { politeFetch } from "../http.js";
import { bboxCenterInNY, bboxIntersectsNY, isLonLatBox } from "../places.js";
import { stripHtml, type Distribution, type HarvestedDataset } from "../db.js";

export interface OgmRepo {
  /** "OpenGeoMetadata/edu.cornell" */
  repo: string;
  ref: string;
  /** Records published by this institution (dct_provenance_s / schema_provider_s), if the repository mixes in others. */
  provider?: string;
}

// ─── tar ────────────────────────────────────────────────────────────────────

/** Regular files in a (POSIX ustar / pax) tar archive. Names have their first path part (GitHub's `owner-repo-sha/`) removed. */
export function readTar(buf: Buffer): { name: string; data: Buffer }[] {
  const out: { name: string; data: Buffer }[] = [];
  let off = 0;
  let paxPath: string | null = null;
  const str = (a: number, b: number) => buf.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const name = str(off, off + 100);
    const size = parseInt(str(off + 124, off + 136).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(off + 345, off + 500);
    const dataStart = off + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const m = data.toString("utf8").match(/\d+ path=([^\n]*)\n/);
      paxPath = m ? m[1] : null;
      continue;
    }
    if (type === "g") continue;
    const full = paxPath ?? (prefix ? `${prefix}/${name}` : name);
    paxPath = null;
    if (type !== "0" && type !== "\0") continue;
    out.push({ name: full.split("/").slice(1).join("/"), data });
  }
  return out;
}

// ─── records ────────────────────────────────────────────────────────────────

/** "ENVELOPE(W, E, N, S)" as [W, S, E, N], or null. */
export function parseEnvelope(s: unknown): [number, number, number, number] | null {
  if (typeof s !== "string") return null;
  const m = s.match(/ENVELOPE\(\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*\)/i);
  if (!m) return null;
  const [w, e, n, so] = m.slice(1).map(Number);
  const box: [number, number, number, number] = [w, so, e, n];
  return isLonLatBox(box) ? box : null;
}

const REF_FORMAT: Record<string, string> = {
  "http://schema.org/downloadUrl": "download",
  "http://www.opengis.net/def/serviceType/ogc/wfs": "OGC WFS",
  "http://www.opengis.net/def/serviceType/ogc/wms": "OGC WMS",
  "http://www.opengis.net/def/serviceType/ogc/wcs": "OGC WCS",
  "http://www.opengis.net/cat/csw/csdgm": "FGDC metadata",
  "http://www.isotc211.org/schemas/2005/gmd/": "ISO 19139 metadata",
  "http://www.w3.org/1999/xhtml": "HTML metadata",
  "http://lccn.loc.gov/sh85035852": "data dictionary",
};

/** dct_references_s is a JSON string of reference URI → URL (or a list of URLs). */
export function references(s: unknown): Record<string, string[]> {
  if (typeof s !== "string" || !s.trim()) return {};
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(o)) {
      const urls = (Array.isArray(v) ? v : [v])
        .map((x) => (typeof x === "string" ? x : x && typeof x === "object" && typeof (x as { url?: unknown }).url === "string" ? (x as { url: string }).url : null))
        .filter((x): x is string => !!x);
      if (urls.length) out[k] = urls;
    }
    return out;
  } catch {
    return {};
  }
}

type Rec = Record<string, unknown>;
const first = (v: unknown): string | null => (Array.isArray(v) ? (typeof v[0] === "string" ? v[0] : null) : typeof v === "string" ? v : null);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : typeof v === "string" && v.trim() ? [v] : []);

export interface OgmRecord {
  schema: "gbl-1.0" | "aardvark";
  id: string;
  public: boolean;
  suppressed: boolean;
  provider: string | null;
  bbox: [number, number, number, number] | null;
  rec: Rec;
}

/** Read one metadata file as a record, or null when it is neither schema. */
export function readRecord(rec: Rec): OgmRecord | null {
  if (rec.geoblacklight_version === "1.0" && typeof rec.layer_slug_s === "string") {
    return {
      schema: "gbl-1.0", id: rec.layer_slug_s, public: rec.dc_rights_s === "Public", suppressed: rec.suppressed_b === true,
      provider: first(rec.dct_provenance_s), bbox: parseEnvelope(rec.solr_geom), rec,
    };
  }
  if (rec.gbl_mdVersion_s === "Aardvark" && typeof rec.id === "string") {
    return {
      schema: "aardvark", id: rec.id, public: rec.dct_accessRights_s === "Public", suppressed: rec.gbl_suppressed_b === true,
      provider: first(rec.schema_provider_s), bbox: parseEnvelope(rec.locn_geometry) ?? parseEnvelope(rec.dcat_bbox), rec,
    };
  }
  return null;
}

export function mapOgmRecord(r: OgmRecord): HarvestedDataset {
  const x = r.rec;
  const g = r.schema === "gbl-1.0";
  const refs = references(x.dct_references_s);
  const fmt = first(g ? x.dc_format_s : x.dct_format_s);
  const formats: Distribution[] = [];
  for (const [uri, urls] of Object.entries(refs)) {
    const label = REF_FORMAT[uri];
    if (!label) continue;
    for (const url of urls) formats.push({ format: label === "download" ? fmt ?? "download" : label, media_type: null, url, provenance: "portal" });
  }
  const ident = first(g ? x.dc_identifier_s : x.dct_identifier_sm);
  const landing = refs["http://schema.org/url"]?.[0] ?? (ident && /^https?:\/\//.test(ident) ? ident : null);
  const modified = first(g ? x.layer_modified_dt : x.gbl_mdModified_dt);
  const description = g ? first(x.dc_description_s) : list(x.dct_description_sm).join("\n\n") || null;
  return {
    native_id: r.id,
    name: first(g ? x.dc_title_s : x.dct_title_s),
    description: description ? stripHtml(description) : null,
    department: null,
    categories: list(g ? x.dct_isPartOf_sm : x.dct_isPartOf_sm),
    tags: [...new Set([...list(g ? x.dc_subject_sm : x.dct_subject_sm), ...list(x.dcat_keyword_sm), ...list(x.dct_spatial_sm)])],
    metadata_updated_at: modified,
    updated_at: modified,
    created_at: null,
    type: first(g ? x.dc_type_s : x.gbl_resourceClass_sm),
    permalink: landing,
    downloads: null,
    views: null,
    update_frequency: null,
    api_endpoint: null,
    formats,
    extent: r.bbox,
    license: list(x.dct_license_sm)[0] ?? null,
    publisher: first(g ? x.dc_publisher_s ?? x.dc_publisher_sm : x.dct_publisher_sm),
    row_count: null,
    geometry_type: first(x.layer_geom_type_s),
    owner: null,
    org_id: null,
    columns: [],
    columns_status: "none",
    provenance: {
      name: "portal", description: "portal", tags: "portal", categories: "portal", updated_at: "portal", type: "portal",
      permalink: "portal", formats: "portal", extent: "portal", publisher: "portal", license: "portal", place: "derived",
    },
  };
}

export interface OgmFilter {
  kept: OgmRecord[];
  excluded: { not_public: number; suppressed: number; withdrawn: number; other_provider: number; out_of_state: number };
  portal_in_ny: { checked: number; center_in_ny: number; refuse: boolean };
}

/** Public, not suppressed, not withdrawn, this provider's, and not wholly outside New York. */
export function filterOgm(records: OgmRecord[], opts: { withdrawn: Set<string>; provider?: string }): OgmFilter {
  const f: OgmFilter = { kept: [], excluded: { not_public: 0, suppressed: 0, withdrawn: 0, other_provider: 0, out_of_state: 0 }, portal_in_ny: { checked: 0, center_in_ny: 0, refuse: false } };
  for (const r of records) {
    if (!r.public) { f.excluded.not_public++; continue; }
    if (r.suppressed) { f.excluded.suppressed++; continue; }
    if (opts.withdrawn.has(r.id)) { f.excluded.withdrawn++; continue; }
    if (opts.provider && r.provider && r.provider !== opts.provider) { f.excluded.other_provider++; continue; }
    if (r.bbox) {
      f.portal_in_ny.checked++;
      if (bboxCenterInNY(r.bbox)) f.portal_in_ny.center_in_ny++;
      if (bboxIntersectsNY(r.bbox) === false) { f.excluded.out_of_state++; continue; }
    }
    f.kept.push(r);
  }
  const p = f.portal_in_ny;
  p.refuse = p.checked >= 3 && p.center_in_ny / p.checked < 0.5;
  return f;
}

export interface OgmHarvest {
  datasets: HarvestedDataset[];
  filter: OgmFilter;
  files: number;
  records: number;
  requests: number;
  complete: boolean;
  error: string | null;
}

/** Records and withdrawals from an archive's files. Unreadable files are counted, never guessed at. */
export function recordsFromFiles(files: { name: string; data: Buffer }[]): { records: OgmRecord[]; withdrawn: Set<string>; unreadable: number } {
  const records: OgmRecord[] = [];
  const withdrawn = new Set<string>();
  let unreadable = 0;
  for (const f of files) {
    if (!f.name.endsWith(".json")) continue;
    let o: unknown;
    try {
      o = JSON.parse(f.data.toString("utf8"));
    } catch {
      unreadable++;
      continue;
    }
    if (f.name === "withdrawn.json") {
      for (const w of ((o as { withdrawn?: { id?: string }[] }).withdrawn ?? [])) if (typeof w?.id === "string") withdrawn.add(w.id);
      continue;
    }
    const recs = Array.isArray(o) ? o : [o];
    for (const x of recs) {
      const r = x && typeof x === "object" ? readRecord(x as Rec) : null;
      if (r) records.push(r);
    }
  }
  return { records, withdrawn, unreadable };
}

export async function harvestOgm(repo: OgmRepo, maxBytes = 200 * 1024 * 1024): Promise<OgmHarvest> {
  const url = `https://api.github.com/repos/${repo.repo}/tarball/${encodeURIComponent(repo.ref)}`;
  // In GitHub Actions the workflow token is sent, so the shared runner IPs do not hit the
  // unauthenticated rate limit. It goes to api.github.com only.
  const headers: Record<string, string> = { "X-GitHub-Api-Version": "2022-11-28" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await politeFetch(url, { binary: true, timeoutMs: 300000, headers });
  if (!r.ok || !r.bytes) throw new Error(`HTTP ${r.status} from ${url}: ${r.body.slice(0, 200)}`);
  if (r.bytes.length > maxBytes) throw new Error(`archive is ${r.bytes.length} bytes, over the ${maxBytes} cap`);
  const files = readTar(gunzipSync(r.bytes));
  const { records, withdrawn, unreadable } = recordsFromFiles(files);
  const filter = filterOgm(records, { withdrawn, provider: repo.provider });
  return {
    datasets: filter.kept.map(mapOgmRecord),
    filter,
    files: files.length,
    records: records.length,
    requests: 1,
    complete: unreadable === 0,
    error: unreadable ? `${unreadable} metadata file(s) were not valid JSON; treated as incomplete (nothing marked removed)` : null,
  };
}
