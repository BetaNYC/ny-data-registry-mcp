/**
 * Socrata Discovery API adapter.
 *
 * Built against the official OpenAPI spec, https://dev.socrata.com/apis/discovery.yaml
 * (rendered at https://dev.socrata.com/docs/other/discovery), read 2026-11-05:
 * - Endpoint: https://api.us.socrata.com/api/catalog/v1 (North American domains).
 * - `domains` + `search_context`, `only` (dataset, map, file, href ...), `limit`, and
 *   `scroll_id` for deep paging ("pass the asset id corresponding to the last result").
 *   offset + limit over 10,000 is a 400, so scroll_id is used throughout.
 * - Asset = { resource, classification, metadata, owner, creator, permalink, link }.
 *   resource carries columns_name / columns_field_name / columns_datatype /
 *   columns_description, data_updated_at, metadata_updated_at, page_views, download_count.
 * - The spec says programmatic use "should include an app token". An optional
 *   SOCRATA_APP_TOKEN is sent as X-App-Token when set; without it requests fall in the
 *   shared, lower-throttle pool (https://dev.socrata.com/docs/app-tokens.html).
 */
import { politeJson } from "../http.js";
import type { Distribution, HarvestedDataset } from "../db.js";

export const DISCOVERY = "https://api.us.socrata.com/api/catalog/v1";

const GEO_TYPES = /point|location|polygon|line|multi/i;

export interface SocrataAsset {
  resource: {
    name?: string;
    id: string;
    description?: string;
    attribution?: string | null;
    type?: string;
    updatedAt?: string;
    createdAt?: string;
    metadata_updated_at?: string;
    data_updated_at?: string | null;
    page_views?: { page_views_total?: number } | null;
    columns_name?: string[];
    columns_field_name?: string[];
    columns_datatype?: string[];
    columns_description?: string[];
    download_count?: number | null;
    provenance?: string;
    blob_mime_type?: string | null;
  };
  classification?: {
    categories?: string[];
    tags?: string[];
    domain_category?: string;
    domain_tags?: string[];
    domain_metadata?: { key: string; value: string }[];
  };
  metadata?: { domain?: string; license?: string };
  permalink?: string;
  link?: string;
}

export function mapSocrataAsset(a: SocrataAsset, domain: string): HarvestedDataset {
  const r = a.resource;
  const c = a.classification ?? {};
  const md = c.domain_metadata ?? [];
  const mdv = (re: RegExp) => md.find((m) => re.test(m.key))?.value ?? null;
  const fields = r.columns_field_name ?? [];
  const columns = fields.map((f, i) => ({
    name: r.columns_name?.[i] ?? null,
    field: f,
    type: r.columns_datatype?.[i] ?? null,
    description: r.columns_description?.[i] || null,
  }));
  const type = r.type ?? null;
  const formats: Distribution[] = [];
  // SODA endpoint pattern and formats: https://dev.socrata.com/docs/endpoints , /docs/formats/
  if (type === "dataset") {
    formats.push({ format: "API (SODA)", media_type: "application/json", url: `https://${domain}/resource/${r.id}.json`, provenance: "derived" });
    formats.push({ format: "CSV", media_type: "text/csv", url: `https://${domain}/resource/${r.id}.csv`, provenance: "derived" });
    if (columns.some((col) => col.type && GEO_TYPES.test(col.type))) {
      formats.push({ format: "GeoJSON", media_type: "application/vnd.geo+json", url: `https://${domain}/resource/${r.id}.geojson`, provenance: "derived" });
    }
  } else if (type === "file" && r.blob_mime_type) {
    formats.push({ format: r.blob_mime_type, media_type: r.blob_mime_type, url: a.permalink ?? null, provenance: "portal" });
  } else if (type === "href") {
    formats.push({ format: "External link", media_type: null, url: a.permalink ?? null, provenance: "portal" });
  }
  const geomCol = columns.find((col) => col.type && GEO_TYPES.test(col.type));
  return {
    native_id: r.id,
    name: r.name ?? null,
    description: r.description ?? null,
    department: mdv(/agency|department/i) ?? r.attribution ?? null,
    categories: [c.domain_category, ...(c.categories ?? [])].filter((x): x is string => !!x),
    tags: [...new Set([...(c.domain_tags ?? []), ...(c.tags ?? [])])],
    metadata_updated_at: r.metadata_updated_at ?? null,
    updated_at: r.data_updated_at ?? r.updatedAt ?? null,
    created_at: r.createdAt ?? null,
    type,
    permalink: a.permalink ?? null,
    downloads: typeof r.download_count === "number" ? r.download_count : null,
    views: typeof r.page_views?.page_views_total === "number" ? r.page_views.page_views_total : null,
    update_frequency: mdv(/frequency/i),
    api_endpoint: type === "dataset" ? `https://${domain}/resource/${r.id}.json` : null,
    formats,
    extent: null,
    license: a.metadata?.license ?? null,
    publisher: r.attribution ?? null,
    row_count: null,
    geometry_type: geomCol?.type ?? null,
    owner: null,
    org_id: null,
    columns: columns,
    columns_status: columns.length ? "from-search" : "none",
    provenance: {
      name: "portal", description: "portal", department: "portal", categories: "portal", tags: "portal",
      updated_at: "portal", metadata_updated_at: "portal", views: "portal", downloads: "portal", columns: "portal",
      update_frequency: "portal", license: "portal", publisher: "portal",
      formats: "derived", api_endpoint: "derived", geometry_type: "derived", place: "derived",
    },
  };
}

export interface SocrataHarvest {
  datasets: HarvestedDataset[];
  requests: number;
  complete: boolean;
  resultSetSize: number | null;
  error: string | null;
}

export async function harvestSocrata(domain: string, only: string[], maxPages = 100): Promise<SocrataHarvest> {
  const out: HarvestedDataset[] = [];
  let scroll = "";
  let requests = 0;
  let total: number | null = null;
  const headers = process.env.SOCRATA_APP_TOKEN ? { "X-App-Token": process.env.SOCRATA_APP_TOKEN } : undefined;
  try {
    for (let page = 0; page < maxPages; page++) {
      const q = new URLSearchParams({ domains: domain, search_context: domain, only: only.join(","), limit: "500", scroll_id: scroll });
      const { data } = await politeJson<{ results: SocrataAsset[]; resultSetSize: number }>(`${DISCOVERY}?${q}`, { headers });
      requests++;
      total = data.resultSetSize;
      for (const a of data.results) out.push(mapSocrataAsset(a, domain));
      if (data.results.length < 500) return { datasets: out, requests, complete: true, resultSetSize: total, error: null };
      scroll = data.results[data.results.length - 1].resource.id;
    }
    return { datasets: out, requests, complete: false, resultSetSize: total, error: `stopped at ${maxPages} pages` };
  } catch (e) {
    return { datasets: out, requests, complete: false, resultSetSize: total, error: e instanceof Error ? e.message : String(e) };
  }
}
