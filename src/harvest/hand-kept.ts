/**
 * The hand-kept list (issue #16, milestone 5; epic #7, decision D6): for registry rows with no
 * data link (no portal, or web pages, viewers and downloads only), people record what the place
 * does offer, in `data/hand-kept.json`. The harvest turns each resource into an index entry, so
 * search can point to it. Nothing is fetched; the file is the source.
 */
import { readDataJson } from "../paths.js";
import { createHash } from "node:crypto";
import type { Source } from "../registry.js";
import type { HarvestedDataset } from "../db.js";

export const RESOURCE_KINDS = ["page", "viewer", "search", "download-page", "dashboard", "pdf", "request-form"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export interface HandKeptResource {
  title: string;
  url: string;
  kind: ResourceKind;
  description: string;
  /** Where this link comes from, and when it was recorded. */
  source: string;
  recorded: string;
  /** Whether a person has opened the link. */
  checked: boolean;
}

export interface HandKeptEntry {
  source_id: string;
  /** Must match the registry row's entity; a test checks it, so a changed row is noticed. */
  entity: string;
  resources: HandKeptResource[];
}

export interface HandKeptDoc {
  entries: HandKeptEntry[];
}

let doc: HandKeptDoc | null = null;
export function handKept(): HandKeptDoc {
  return (doc ??= readDataJson<HandKeptDoc>("hand-kept.json"));
}

/** The entry for a row, matched by source id and entity both, and only if it lists something. */
export function handKeptEntry(s: Source, d: HandKeptDoc = handKept()): HandKeptEntry | null {
  const e = d.entries.find((x) => x.source_id === s.source_id && x.entity === s.entity);
  return e && e.resources.length ? e : null;
}

export function mapHandKept(r: HandKeptResource): HarvestedDataset {
  return {
    // Stable per URL: the same link keeps its id when its title or description is edited.
    native_id: `hand-kept:${createHash("sha256").update(r.url.trim()).digest("hex").slice(0, 16)}`,
    name: r.title,
    description: `${r.description} (${r.checked ? "Checked by a person" : "Not yet checked"}; from ${r.source}, ${r.recorded}.)`,
    department: null,
    categories: [],
    tags: [r.kind],
    metadata_updated_at: null,
    updated_at: null,
    created_at: null,
    type: `hand-kept ${r.kind}`,
    permalink: r.url,
    downloads: null,
    views: null,
    update_frequency: null,
    api_endpoint: null,
    formats: [],
    extent: null,
    license: null,
    publisher: null,
    row_count: null,
    geometry_type: null,
    owner: null,
    org_id: null,
    columns: [],
    columns_status: "none",
    provenance: { name: "hand-kept", description: "hand-kept", permalink: "hand-kept", type: "hand-kept", tags: "hand-kept", place: "derived" },
  };
}
