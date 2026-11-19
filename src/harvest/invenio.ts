/**
 * InvenioRDM adapter (issue #16, milestone 6), for NYU Libraries' UltraViolet and its Spatial
 * Data Repository community. Metadata only: record pages, never files.
 *
 * Built against official docs, read 2026-11-14:
 * - Community records: GET /api/communities/{id}/records
 *   https://inveniordm.docs.cern.ch/reference/rest_api_communities/
 *   Response: { hits: { hits: [record], total }, links: { self, ... } }; the documented example
 *   link uses `page`, `size` and `sort`.
 * - Search parameters (`q`, `sort` with built-ins "newest" | "oldest" | ..., `size` default 10,
 *   `page`): https://inveniordm.docs.cern.ch/reference/rest_api_drafts_records/
 * - Record shape (id, created, updated, access.record "public" | "restricted", links.self_html,
 *   metadata.title, description, subjects[].subject, publication_date, publisher, rights[],
 *   resource_type.title, locations.features[].geometry / place / description):
 *   https://inveniordm.docs.cern.ch/reference/metadata/ and the "Get a record" example.
 *
 * New York filter: a record is kept when one of its location geometries touches New York, or,
 * when it has no geometry, when its title, places or subjects name New York. Everything else is
 * dropped and counted. Locations are optional in InvenioRDM ("not part of the deposit page
 * yet"), so this adapter starts switched off until a supervised run shows the filter works.
 */
import { politeJson, BlockedError } from "../http.js";
import { bboxIntersectsNY, isLonLatBox } from "../places.js";
import { cleanedLabel, stripHtml, type HarvestedDataset } from "../db.js";

export interface InvenioTarget {
  /** "https://ultraviolet.library.nyu.edu" */
  base: string;
  /** Community slug or UUID, or null for the whole repository. */
  community: string | null;
}

/** Base URL and community from the registry's endpoint (".../api/communities/<id>/records" or ".../api/records"). */
export function invenioTarget(endpoint: string | null | undefined): InvenioTarget | null {
  const m = (endpoint ?? "").match(/(https?:\/\/[^/\s]+)\/api\/(?:communities\/([^/\s?]+)\/records|records)\b/);
  return m ? { base: m[1], community: m[2] ? decodeURIComponent(m[2]) : null } : null;
}

type Geometry = { type?: string; coordinates?: unknown };
export interface InvenioRecord {
  id: string;
  created?: string;
  updated?: string;
  access?: { record?: string; files?: string };
  links?: { self_html?: string; self?: string };
  metadata?: {
    title?: string;
    description?: string;
    publication_date?: string;
    publisher?: string;
    resource_type?: { id?: string; title?: Record<string, string> };
    subjects?: { id?: string; subject?: string }[];
    rights?: { id?: string; title?: Record<string, string>; link?: string }[];
    locations?: { features?: { geometry?: Geometry; place?: string; description?: string }[] };
  };
}

/** Lon/lat bounding box of any GeoJSON geometry, or null. */
export function geometryBox(g: Geometry | undefined): [number, number, number, number] | null {
  if (!g) return null;
  const pts: number[][] = [];
  const walk = (c: unknown) => {
    if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") pts.push(c as number[]);
    else if (Array.isArray(c)) c.forEach(walk);
  };
  walk(g.coordinates);
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const box: [number, number, number, number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return isLonLatBox(box) ? box : null;
}

const NY_TEXT = /\bNew York\b|\bNYC\b|\bManhattan\b|\bBrooklyn\b|\bBronx\b|\bQueens\b|\bStaten Island\b/i;

export type NyVerdict = "geometry-in-ny" | "named-ny" | "geometry-outside" | "no-location";

export function newYorkVerdict(r: InvenioRecord): { verdict: NyVerdict; box: [number, number, number, number] | null } {
  const feats = r.metadata?.locations?.features ?? [];
  const boxes = feats.map((f) => geometryBox(f.geometry)).filter((b): b is [number, number, number, number] => !!b);
  const inNy = boxes.find((b) => bboxIntersectsNY(b) === true);
  if (inNy) return { verdict: "geometry-in-ny", box: inNy };
  if (boxes.length) return { verdict: "geometry-outside", box: null };
  const text = [r.metadata?.title, ...feats.map((f) => f.place), ...(r.metadata?.subjects ?? []).map((s) => s.subject)].filter(Boolean).join(" | ");
  return NY_TEXT.test(text) ? { verdict: "named-ny", box: null } : { verdict: "no-location", box: null };
}

export function mapInvenioRecord(r: InvenioRecord, box: [number, number, number, number] | null): HarvestedDataset {
  const m = r.metadata ?? {};
  const right = m.rights?.[0];
  const description = m.description ? stripHtml(m.description) : null;
  return {
    native_id: r.id,
    name: m.title ?? null,
    description,
    department: null,
    categories: m.resource_type?.title?.en ? [m.resource_type.title.en] : [],
    tags: (m.subjects ?? []).map((s) => s.subject).filter((s): s is string => !!s),
    metadata_updated_at: r.updated ?? null,
    updated_at: r.updated ?? null,
    created_at: r.created ?? null,
    type: m.resource_type?.title?.en ?? m.resource_type?.id ?? null,
    permalink: r.links?.self_html ?? null,
    downloads: null,
    views: null,
    update_frequency: null,
    api_endpoint: r.links?.self ?? null,
    formats: r.links?.self ? [{ format: "InvenioRDM REST API (record)", media_type: "application/json", url: r.links.self, provenance: "portal" }] : [],
    extent: box,
    license: right?.title?.en ?? right?.id ?? null,
    publisher: m.publisher ?? null,
    row_count: null,
    geometry_type: null,
    owner: null,
    org_id: null,
    columns: [],
    columns_status: "none",
    provenance: {
      name: "portal", description: cleanedLabel(m.description, description), tags: "portal", categories: "portal", updated_at: "portal", created_at: "portal",
      type: "portal", permalink: "portal", api_endpoint: "portal", formats: "derived", extent: "portal", license: "portal", publisher: "portal", place: "derived",
    },
  };
}

export interface InvenioHarvest {
  datasets: HarvestedDataset[];
  requests: number;
  complete: boolean;
  total: number | null;
  excluded: Record<"restricted" | "geometry-outside" | "no-location", number>;
  error: string | null;
}

export async function harvestInvenio(t: InvenioTarget, opts: { pageSize?: number; maxPages?: number } = {}): Promise<InvenioHarvest> {
  const size = opts.pageSize ?? 25;
  const maxPages = opts.maxPages ?? 200;
  const path = t.community ? `/api/communities/${encodeURIComponent(t.community)}/records` : "/api/records";
  const out: InvenioHarvest = { datasets: [], requests: 0, complete: false, total: null, excluded: { restricted: 0, "geometry-outside": 0, "no-location": 0 }, error: null };
  const seen = new Set<string>();
  try {
    for (let page = 1; page <= maxPages; page++) {
      // Oldest first: the order of existing records does not shift while new ones are added.
      const { data } = await politeJson<{ hits?: { hits?: InvenioRecord[]; total?: number | { value?: number } } }>(`${t.base}${path}?sort=oldest&size=${size}&page=${page}`);
      out.requests++;
      const tot = data.hits?.total;
      out.total = typeof tot === "number" ? tot : typeof tot?.value === "number" ? tot.value : out.total;
      const hits = data.hits?.hits ?? [];
      for (const r of hits) {
        if (!r?.id || seen.has(r.id)) continue;
        seen.add(r.id);
        if (r.access?.record && r.access.record !== "public") {
          out.excluded.restricted++;
          continue;
        }
        const v = newYorkVerdict(r);
        if (v.verdict === "geometry-outside" || v.verdict === "no-location") {
          out.excluded[v.verdict]++;
          continue;
        }
        out.datasets.push(mapInvenioRecord(r, v.box));
      }
      if (!hits.length || (out.total !== null && page * size >= out.total)) {
        out.complete = out.total === null || seen.size >= out.total;
        if (!out.complete) out.error = `listing returned ${seen.size} unique of ${out.total}; treated as incomplete (nothing marked removed)`;
        return out;
      }
    }
    out.error = `stopped at ${maxPages} pages`;
    return out;
  } catch (e) {
    if (e instanceof BlockedError) throw e;
    out.error = e instanceof Error ? e.message : String(e);
    return out;
  }
}
