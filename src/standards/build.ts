/**
 * Croissant 1.1 and DCAT-US 3.0 descriptions of the datasets in the index (issue #17).
 * Field mapping, required fields and what is left blank: docs/standard-metadata-plan.md.
 *
 * Specs: Croissant 1.1 (mlcommons/croissant docs/croissant-spec-1.1.md, published 2026-01-29)
 * and the DCAT-US 3.0 JSON Schema (GSA/dcat-us jsonschema/definitions). Metadata only: nothing
 * here reads a dataset's contents. Nothing is invented: a value the portal did not give is left
 * out, and the two required fields we never have (DCAT-US contactPoint, and description when
 * the portal gave none) are listed in `missing`.
 */
import type { DatabaseSync } from "node:sqlite";
import { stripHtml, type Distribution } from "../db.js";
import { hasTopics } from "../topics.js";
import { classifyLicense, termsPages, TERMS_LABEL, type LicenseInfo, type TermsPages } from "./license.js";

export const STANDARDS = ["croissant", "dcat-us"] as const;
export type Standard = (typeof STANDARDS)[number];

export const CROISSANT_CONFORMS_TO = "http://mlcommons.org/croissant/1.1";
export const DCAT_US_TITLE = "DCAT-US v3.0";
export const REPO_URL = "https://github.com/BetaNYC/ny-data-registry-mcp";
export const TOPICS_DOC_URL = `${REPO_URL}/blob/main/docs/topics.md`;

/**
 * Croissant 1.1 Appendix 1 JSON-LD context, except schema.org is `https://`. The appendix
 * prints `http://schema.org/`, but mlcroissant 1.1.1 then rejects the document ("doesn't
 * extend https://schema.org/Dataset"), and the spec's own 1.1 examples
 * (mlcommons/croissant datasets/1.1/) use `https://schema.org/`.
 */
export const CROISSANT_CONTEXT = {
  "@language": "en",
  "@vocab": "https://schema.org/",
  sc: "https://schema.org/",
  cr: "http://mlcommons.org/croissant/",
  rai: "http://mlcommons.org/croissant/RAI/",
  dct: "http://purl.org/dc/terms/",
  annotation: "cr:annotation",
  arrayShape: "cr:arrayShape",
  citeAs: "cr:citeAs",
  column: "cr:column",
  conformsTo: "dct:conformsTo",
  containedIn: "cr:containedIn",
  data: { "@id": "cr:data", "@type": "@json" },
  dataType: { "@id": "cr:dataType", "@type": "@vocab" },
  equivalentProperty: "cr:equivalentProperty",
  examples: { "@id": "cr:examples", "@type": "@json" },
  excludes: "cr:excludes",
  extract: "cr:extract",
  field: "cr:field",
  fileProperty: "cr:fileProperty",
  fileObject: "cr:fileObject",
  fileSet: "cr:fileSet",
  format: "cr:format",
  includes: "cr:includes",
  isArray: "cr:isArray",
  isLiveDataset: "cr:isLiveDataset",
  jsonPath: "cr:jsonPath",
  key: "cr:key",
  md5: "cr:md5",
  parentField: "cr:parentField",
  recordSet: "cr:recordSet",
  references: "cr:references",
  regex: "cr:regex",
  readLines: "cr:readLines",
  sdVersion: "cr:sdVersion",
  separator: "cr:separator",
  source: "cr:source",
  subField: "cr:subField",
  transform: "cr:transform",
  unArchive: "cr:unArchive",
  value: "cr:value",
};

/** One dataset with everything both standards draw on. */
export interface StdRecord {
  id: string;
  portal_id: string;
  native_id: string;
  name: string | null;
  description: string | null;
  permalink: string | null;
  created_at: string | null;
  updated_at: string | null;
  update_frequency: string | null;
  publisher: string | null;
  license: string | null;
  categories: string[];
  tags: string[];
  topics: { id: string; name: string }[];
  formats: Distribution[];
  extent: number[] | null;
  portal_name: string;
  portal_entity: string;
}

const parse = <T>(s: string | null, d: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : d;
  } catch {
    return d;
  }
};

/** Live datasets (or the ones named) with their tags and topics. */
export function loadRecords(db: DatabaseSync, ids?: string[]): StdRecord[] {
  const where = ids ? `d.id IN (${ids.map(() => "?").join(",")})` : "d.removed_at IS NULL";
  if (ids && !ids.length) return [];
  const rows = db
    .prepare(
      `SELECT d.id, d.portal_id, d.native_id, d.name, d.description, d.permalink, d.created_at, d.updated_at, d.update_frequency,
        d.publisher, d.license, d.categories, d.formats, d.extent, p.name AS portal_name, p.entity AS portal_entity
       FROM datasets d JOIN portals p ON p.id = d.portal_id WHERE ${where} ORDER BY d.portal_id, d.id`
    )
    .all(...(ids ?? [])) as Record<string, string | null>[];
  const recs = new Map<string, StdRecord>();
  for (const r of rows) {
    recs.set(r.id!, {
      id: r.id!,
      portal_id: r.portal_id!,
      native_id: r.native_id!,
      name: r.name,
      description: r.description,
      permalink: r.permalink,
      created_at: r.created_at,
      updated_at: r.updated_at,
      update_frequency: r.update_frequency,
      publisher: r.publisher,
      license: r.license,
      categories: parse<string[]>(r.categories, []).filter(Boolean),
      tags: [],
      topics: [],
      formats: parse<Distribution[]>(r.formats, []),
      extent: parse<number[] | null>(r.extent, null),
      portal_name: r.portal_name!,
      portal_entity: r.portal_entity!,
    });
  }
  if (!recs.size) return [];
  const sub = ids ? `IN (${ids.map(() => "?").join(",")})` : "IN (SELECT id FROM datasets WHERE removed_at IS NULL)";
  const args = ids ?? [];
  for (const t of db.prepare(`SELECT dt.dataset_id AS id, t.name FROM dataset_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.dataset_id ${sub} ORDER BY t.name`).all(...args) as { id: string; name: string }[]) {
    recs.get(t.id)?.tags.push(t.name);
  }
  if (hasTopics(db)) {
    for (const t of db.prepare(`SELECT dt.dataset_id AS id, tp.id AS tid, tp.name FROM dataset_topics dt JOIN topics tp ON tp.id = dt.topic_id WHERE dt.dataset_id ${sub} ORDER BY tp.position`).all(...args) as { id: string; tid: string; name: string }[]) {
      recs.get(t.id)?.topics.push({ id: t.tid, name: t.name });
    }
  }
  return [...recs.values()];
}

/** The index's harvest time, from its meta table. */
export function indexHarvestTime(db: DatabaseSync): string | null {
  return (db.prepare("SELECT value FROM meta WHERE key = 'last_harvest'").get() as { value: string } | undefined)?.value ?? null;
}

const plainDescription = (r: StdRecord): string | null => {
  const s = r.description ? stripHtml(r.description) : "";
  return s ? s : null;
};

/** ISO 19115 maintenance frequency codes (DCAT-US accrualPeriodicity), for exact portal words only. */
export const FREQUENCY_CODES: Record<string, string> = {
  daily: "daily",
  weekly: "weekly",
  monthly: "monthly",
  quarterly: "quarterly",
  annually: "annually",
  annual: "annually",
  yearly: "annually",
  "as needed": "asNeeded",
  "every 6 months": "biannually",
  "semi-annually": "biannually",
  continuously: "continual",
  continual: "continual",
  irregular: "irregular",
  "static - not updated": "notPlanned",
};

export function frequencyCode(v: string | null): string | null {
  return v ? FREQUENCY_CODES[v.trim().toLowerCase()] ?? null : null;
}

/** An extent the portal gave, when it is four numbers inside longitude and latitude ranges. */
export function lonLatBox(e: number[] | null): [number, number, number, number] | null {
  if (!e || e.length !== 4 || e.some((n) => typeof n !== "number" || !Number.isFinite(n))) return null;
  const [minx, miny, maxx, maxy] = e;
  if (minx < -180 || maxx > 180 || miny < -90 || maxy > 90 || minx > maxx || miny > maxy) return null;
  return [minx, miny, maxx, maxy];
}

/** APIs, map services and web pages are reached, not downloaded. */
export function isServiceFormat(format: string): boolean {
  return /\bAPI\b|\bOGC\b|Service|External link/i.test(format);
}

const DERIVED_NOTE = "Link built by BetaNYC from the portal's documented URL pattern; the portal does not list it.";

/** A short @id piece: lowercase letters, digits and dashes. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

/** What a standard document left out, and why. */
export interface Missing {
  field: string;
  required: boolean;
  why: string;
}

const NO_DESCRIPTION: Missing = { field: "description", required: true, why: "The portal gives no description for this dataset. We do not write one." };
const NO_CONTACT: Missing = {
  field: "contactPoint",
  required: true,
  why: "DCAT-US requires a contact with an email address. Portals do not give one in their catalogs, and we do not make one up.",
};

export interface Built {
  document: Record<string, unknown>;
  license: LicenseInfo;
  missing: Missing[];
}

function publisherName(r: StdRecord): string {
  return r.publisher?.trim() || r.portal_entity;
}

/** One dataset as a Croissant 1.1 document. */
export function toCroissant(r: StdRecord, o: { harvestedAt: string | null; terms?: TermsPages } = { harvestedAt: null }): Built {
  const lic = classifyLicense(r.license, r.portal_id, o.terms ?? termsPages());
  const missing: Missing[] = [];
  const doc: Record<string, unknown> = {
    "@context": CROISSANT_CONTEXT,
    "@type": "sc:Dataset",
    conformsTo: CROISSANT_CONFORMS_TO,
    name: r.name ?? r.native_id,
    identifier: r.id,
  };
  const description = plainDescription(r);
  if (description) doc.description = description;
  else missing.push(NO_DESCRIPTION);
  if (r.permalink) doc.url = r.permalink;
  else missing.push({ field: "url", required: true, why: "The portal gives no page for this dataset." });
  if (r.created_at) doc.datePublished = r.created_at;
  else missing.push({ field: "datePublished", required: true, why: "The portal gives no creation date for this dataset." });
  if (r.updated_at) doc.dateModified = r.updated_at;
  if (r.publisher?.trim()) doc.creator = { "@type": "sc:Organization", name: r.publisher.trim() };
  else missing.push({ field: "creator", required: true, why: "The portal names no creator or source for this dataset." });
  doc.publisher = { "@type": "sc:Organization", name: publisherName(r) };

  if (lic.license) doc.license = lic.license.url ?? lic.license.name;
  else missing.push({ field: "license", required: true, why: licenseWhy(lic) });
  const usage: Record<string, unknown>[] = [];
  if (lic.terms_page) usage.push({ "@type": "sc:CreativeWork", name: capitalize(TERMS_LABEL), url: lic.terms_page.url });
  if (lic.statement) usage.push({ "@type": "sc:CreativeWork", name: "Use terms stated by the portal (not a license)", text: lic.statement });
  if (usage.length) doc.usageInfo = usage.length === 1 ? usage[0] : usage;

  // Plain text: mlcroissant 1.1.1 rejects DefinedTerm keywords ("should have an attribute
  // @type: https://schema.org/Text"), though the spec allows them.
  const keywords = [...new Set([...r.tags, ...r.categories, ...r.topics.map((t) => t.name)])];
  if (keywords.length) doc.keywords = keywords;

  const box = lonLatBox(r.extent);
  if (box) doc.spatialCoverage = { "@type": "sc:Place", geo: { "@type": "sc:GeoShape", box: `${box[1]} ${box[0]} ${box[3]} ${box[2]}` } };

  // No checksums: we never download the data, and the portals change it. Croissant asks live
  // datasets to say so, and mlcroissant then accepts FileObjects without md5 or sha256.
  doc.isLiveDataset = true;
  const used = new Set<string>();
  const files: Record<string, unknown>[] = [];
  for (const f of r.formats) {
    if (!f.url || !f.media_type || isServiceFormat(f.format)) continue;
    const fo: Record<string, unknown> = {
      "@type": "cr:FileObject",
      "@id": uniqueId(`file-${slug(f.format)}`, used),
      name: f.format,
      contentUrl: f.url,
      encodingFormat: f.media_type,
    };
    if (f.provenance === "derived") fo.description = DERIVED_NOTE;
    files.push(fo);
  }
  doc.distribution = files;
  // No recordSet. mlcroissant 1.1.1 requires every Field to name a `source` (a file and column to
  // read) or a `value`. We never read the data, so we cannot say which file column holds which
  // field. Columns stay in get_dataset_columns.

  doc.sdPublisher = { "@type": "sc:Organization", name: "BetaNYC", url: REPO_URL };
  if (o.harvestedAt) doc.sdDatePublished = o.harvestedAt;
  return { document: doc, license: lic, missing };
}

/** One dataset as a DCAT-US 3.0 Dataset. */
export function toDcatUs(r: StdRecord, o: { terms?: TermsPages } = {}): Built {
  const lic = classifyLicense(r.license, r.portal_id, o.terms ?? termsPages());
  const missing: Missing[] = [NO_CONTACT];
  const doc: Record<string, unknown> = { "@type": "Dataset", title: r.name ?? r.native_id, identifier: r.id };
  const description = plainDescription(r);
  if (description) doc.description = description;
  else missing.push(NO_DESCRIPTION);
  if (r.permalink) doc.landingPage = { "@type": "Document", title: `${r.name ?? r.native_id} on ${r.portal_name}`, accessURL: r.permalink };
  if (r.created_at) doc.issued = r.created_at;
  if (r.updated_at) doc.modified = r.updated_at;
  doc.publisher = { "@type": "Organization", name: publisherName(r) };
  if (r.tags.length) doc.keyword = r.tags;
  const themes: unknown[] = [...r.categories];
  for (const t of r.topics) themes.push({ "@type": "Concept", prefLabel: t.name, notation: [t.id], inScheme: { "@type": "ConceptScheme", title: "BetaNYC shared topics for New York open data", "@id": TOPICS_DOC_URL } });
  if (themes.length) doc.theme = themes;
  const freq = frequencyCode(r.update_frequency);
  if (freq) doc.accrualPeriodicity = freq;
  const box = lonLatBox(r.extent);
  if (box) {
    const [x1, y1, x2, y2] = box;
    doc.spatial = { "@type": "Location", bbox: { type: "Polygon", coordinates: [[[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]] } };
  }

  if (lic.license) doc.license = lic.license.url ?? lic.license.name;
  else missing.push({ field: "license", required: false, why: licenseWhy(lic) });
  const rights: string[] = [];
  if (lic.terms_page) rights.push(`${capitalize(TERMS_LABEL)}: ${lic.terms_page.url}`);
  if (lic.statement) rights.push(lic.statement);
  if (rights.length) doc.rights = rights;

  const dist: Record<string, unknown>[] = [];
  for (const f of r.formats) {
    if (!f.url) continue;
    const d: Record<string, unknown> = { "@type": "Distribution", title: f.format };
    if (f.media_type) d.mediaType = f.media_type;
    if (isServiceFormat(f.format)) d.accessURL = f.url;
    else d.downloadURL = f.url;
    if (f.provenance === "derived") d.description = DERIVED_NOTE;
    dist.push(d);
  }
  if (dist.length) doc.distribution = dist;
  return { document: doc, license: lic, missing };
}

function licenseWhy(l: LicenseInfo): string {
  if (l.terms_page) return `No license from the portal. A terms page is linked instead and labeled "${TERMS_LABEL}".`;
  if (l.statement) return "No license from the portal. Its own use terms are kept word for word, not as a license.";
  return "No license from the portal, and no checked terms page for it. We do not invent one.";
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The DCAT-US Catalog wrapper for the statewide file. */
export function dcatCatalog(o: { harvestedAt: string | null; datasets: number }): Record<string, unknown> {
  const c: Record<string, unknown> = {
    "@type": "Catalog",
    conformsTo: { "@type": "Standard", title: DCAT_US_TITLE },
    title: "New York open data portals: BetaNYC's harvested catalog",
    description:
      `Metadata for ${o.datasets.toLocaleString("en-US")} datasets on New York's open data portals, harvested by BetaNYC's ny-data-registry-mcp. ` +
      "Metadata only: no dataset contents. Each dataset's publisher, license and links are the portal's; contact points are not published by the portals and are left out.",
    publisher: { "@type": "Agent", name: "BetaNYC" },
    homepage: { "@type": "Document", title: "ny-data-registry-mcp on GitHub", accessURL: REPO_URL },
    rights: [
      "Each dataset's license is its portal's. Where a portal gives none, a terms page may be linked and is labeled 'terms page, not a license'. No license is inferred.",
    ],
    language: "en",
  };
  if (o.harvestedAt) c.modified = o.harvestedAt;
  return c;
}
