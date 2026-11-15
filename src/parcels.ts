/**
 * Tax parcel coverage for all 62 counties (issue #16, milestone 2). Offline: built from
 * `data/parcel-sources.json` (the State's statewide parcel service, read once and recorded),
 * the registry, and an index file. It never calls a portal.
 *
 * For each county it answers three questions:
 * 1. Does the county share its parcels with the State's public layer?
 * 2. Does the county (or New York City, for the five boroughs) publish its own parcel layer
 *    that the index or the registry knows about?
 * 3. If neither, where does the State's documentation page point for that county?
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { readDataJson } from "./paths.js";
import { places, NYC_COUNTIES } from "./places.js";
import { stripHtml } from "./db.js";
import type { LoadedRegistry, Source } from "./registry.js";

export interface ParcelSources {
  state_layer: {
    name: string;
    service_url: string;
    documented_at: string;
    read: { url: string; at: string; http_status: number; etag: string | null; what: string; evidence_file: string };
    publication_date: string;
    layers: { id: number; name: string }[];
  };
  state_page: {
    url: string;
    read_at: string;
    county_resources: Record<string, { county_site: string | null; viewer: string | null; additional: string | null }>;
  };
  /** Hand-reviewed: counties whose own registry row documents a parcel layer, with an exact quote. */
  registry_parcel_layers: Record<string, { kind: "rest" | "download"; field: "notes" | "evidence"; quote: string }>;
}

/**
 * Dataset names that are tax parcel layers. Names only; descriptions mention parcels too often.
 * Substrings, not words: county layer names run words together ("ParcelProperties2024",
 * "Parcels_2025", "TaxMap").
 */
export const PARCEL_NAME = /parcel|tax[\s_]*lots?|tax[\s_]*maps?|pluto/i;

/**
 * The counties named in the State service's "Thanks to the following counties that
 * specifically authorized ... to share their GIS tax parcel data with the public: ..." sentence,
 * matched to the 62 county names. Anything that does not match is returned in `unmatched`,
 * never guessed.
 */
export function parseStateParcelCounties(serviceDescription: string, counties = places().counties): { counties: string[]; as_written: string | null; unmatched: string[] } {
  const text = stripHtml(serviceDescription).replace(/&amp;/g, "&").replace(/\s+/g, " ");
  const m = text.match(/Thanks to the following counties[^:]*:\s*(.+?)\.\s+(?:Geometry|[A-Z][a-z]+ [a-z]+ )/);
  if (!m) return { counties: [], as_written: null, unmatched: [] };
  const asWritten = m[1].trim();
  const found = new Set<string>();
  const unmatched: string[] = [];
  for (const raw of asWritten.split(/,|\.\s*and\s+|\band\s+/)) {
    const name = raw
      .replace(/^\s*NYC\s*-\s*/i, "")
      .replace(/\([^)]*\)/g, "")
      .replace(/\.$/, "")
      .trim()
      .replace(/^St\.?\s+/i, "St. ");
    if (!name) continue;
    const c = counties.find((x) => x.toLowerCase() === name.toLowerCase());
    if (c) found.add(c);
    else unmatched.push(raw.trim());
  }
  return { counties: counties.filter((c) => found.has(c)), as_written: asWritten, unmatched };
}

export type OwnLayer = "in-index" | "registry-documented" | "none-found";
export type ParcelCategory = "state-and-own" | "state-only" | "own-only" | "neither";

export interface ParcelRow {
  county: string;
  shares_with_state: boolean;
  own_layer: OwnLayer;
  category: ParcelCategory;
  /** The county's own registry rows (for the five boroughs: New York City's rows). */
  county_rows: { source_id: string; status: string; platform_family: string | null }[];
  /** Parcel-named datasets in the index from those rows' portals. */
  index_parcel_datasets: number;
  index_examples: { portal_id: string; name: string; permalink: string | null }[];
  /** The hand-reviewed registry entry, when the county's row documents a parcel layer. */
  registry_layer: { kind: "rest" | "download"; field: string; quote: string } | null;
  /** County rows whose registry text uses the word "parcel" at all (a viewer or search page counts). Not used to classify. */
  registry_text_mentions: string[];
  /** City portals in the county with parcel-named datasets in the index (not the county's own). */
  city_portals_with_parcels: { source_id: string; datasets: number }[];
  /** What the State's documentation page links for this county. */
  state_page: { county_site: string | null; viewer: string | null; additional: string | null } | null;
}

export interface ParcelTable {
  generated_at: string;
  registry_generated: string;
  index_path: string | null;
  index_last_harvest: string | null;
  state_layer: ParcelSources["state_layer"] & { counties_sharing: string[]; unmatched: string[] };
  summary: {
    counties: number;
    shares_with_state: number;
    own_layer_in_index: number;
    own_layer_registry_only: number;
    neither: number;
    by_category: Record<ParcelCategory, number>;
  };
  rows: ParcelRow[];
}

const COUNTY_TYPES = new Set(["county"]);
const NYC_TYPES = new Set(["city", "city-agency"]);

/** The rows that are the county's own government (the five boroughs: New York City's). */
export function countyRows(sources: Source[], county: string): Source[] {
  const nyc = NYC_COUNTIES.includes(county);
  return sources.filter((s) =>
    nyc ? s.place.scope === "nyc" && NYC_TYPES.has(s.entity_type) : s.place.scope === "county" && COUNTY_TYPES.has(s.entity_type) && s.place.counties.includes(county)
  );
}

function parcelDatasets(db: DatabaseSync | null): Map<string, { name: string; permalink: string | null }[]> {
  const out = new Map<string, { name: string; permalink: string | null }[]>();
  if (!db) return out;
  const rows = db.prepare("SELECT portal_id, name, permalink FROM datasets WHERE removed_at IS NULL AND name IS NOT NULL ORDER BY views DESC NULLS LAST, name").all() as {
    portal_id: string;
    name: string;
    permalink: string | null;
  }[];
  for (const r of rows) {
    if (!PARCEL_NAME.test(r.name)) continue;
    const l = out.get(r.portal_id) ?? [];
    l.push({ name: r.name, permalink: r.permalink });
    out.set(r.portal_id, l);
  }
  return out;
}

export function buildParcelTable(reg: LoadedRegistry, opts: { indexPath?: string | null; sources?: ParcelSources; serviceDescription: string; now?: Date }): ParcelTable {
  const src = opts.sources ?? readDataJson<ParcelSources>("parcel-sources.json");
  const parsed = parseStateParcelCounties(opts.serviceDescription);
  const sharing = new Set(parsed.counties);
  const db = opts.indexPath && existsSync(opts.indexPath) ? new DatabaseSync(opts.indexPath, { readOnly: true }) : null;
  try {
    const byPortal = parcelDatasets(db);
    const last = db ? ((db.prepare("SELECT value FROM meta WHERE key = 'last_harvest'").get() as { value: string } | undefined)?.value ?? null) : null;
    const rows: ParcelRow[] = places().counties.map((county) => {
      const own = countyRows(reg.sources, county);
      const ds = own.flatMap((s) => (byPortal.get(s.source_id) ?? []).map((d) => ({ portal_id: s.source_id, ...d })));
      const mentions = own.filter((s) => /parcel/i.test(`${s.portal_name ?? ""} ${s.notes ?? ""} ${s.evidence ?? ""} ${s.api_type ?? ""}`)).map((s) => s.source_id);
      const cities = reg.sources
        .filter((s) => s.place.scope === "city" && s.place.counties.includes(county) && byPortal.has(s.source_id))
        .map((s) => ({ source_id: s.source_id, datasets: byPortal.get(s.source_id)!.length }));
      const regLayer = src.registry_parcel_layers?.[county] ?? null;
      const ownLayer: OwnLayer = ds.length ? "in-index" : regLayer ? "registry-documented" : "none-found";
      const shares = sharing.has(county);
      const hasOwn = ownLayer !== "none-found";
      const category: ParcelCategory = shares && hasOwn ? "state-and-own" : shares ? "state-only" : hasOwn ? "own-only" : "neither";
      return {
        county,
        shares_with_state: shares,
        own_layer: ownLayer,
        category,
        county_rows: own.map((s) => ({ source_id: s.source_id, status: s.status, platform_family: s.platform_family })),
        index_parcel_datasets: ds.length,
        index_examples: ds.slice(0, 3),
        registry_layer: regLayer,
        registry_text_mentions: mentions,
        city_portals_with_parcels: cities,
        state_page: src.state_page.county_resources[county] ?? null,
      };
    });
    const by_category: Record<ParcelCategory, number> = { "state-and-own": 0, "state-only": 0, "own-only": 0, neither: 0 };
    for (const r of rows) by_category[r.category]++;
    return {
      generated_at: (opts.now ?? new Date()).toISOString(),
      registry_generated: reg.generated,
      index_path: db ? opts.indexPath! : null,
      index_last_harvest: last,
      state_layer: { ...src.state_layer, counties_sharing: parsed.counties, unmatched: parsed.unmatched },
      summary: {
        counties: rows.length,
        shares_with_state: rows.filter((r) => r.shares_with_state).length,
        own_layer_in_index: rows.filter((r) => r.own_layer === "in-index").length,
        own_layer_registry_only: rows.filter((r) => r.own_layer === "registry-documented").length,
        neither: by_category.neither,
        by_category,
      },
      rows,
    };
  } finally {
    db?.close();
  }
}

const cell = (s: string | null | undefined) => (s ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();
const link = (label: string, u: string | null) => (u ? `[${label}](${u.trim()})` : "");

export function parcelMarkdown(t: ParcelTable): string {
  const s = t.summary;
  const L: string[] = [
    "# Tax parcel coverage, 62 counties",
    "",
    `Built ${t.generated_at.slice(0, 10)} from registry ${t.registry_generated} and the index harvested ${t.index_last_harvest ?? "(no index)"}. ` +
      `The State list comes from one read of [${t.state_layer.name}](${t.state_layer.service_url}) on ${t.state_layer.read.at} (HTTP ${t.state_layer.read.http_status}; ${t.state_layer.publication_date}).`,
    "",
    "| | counties |",
    "|---|---|",
    `| Share their parcels with the State's public layer | ${s.shares_with_state} |`,
    `| Own parcel layer in the index | ${s.own_layer_in_index} |`,
    `| Own parcel layer documented in the registry, not in the index | ${s.own_layer_registry_only} |`,
    `| Neither: not shared with the State, and no own layer in the registry or index | ${s.neither} |`,
    "",
    "| category | counties |",
    "|---|---|",
    ...Object.entries(s.by_category).map(([k, v]) => `| ${k} | ${v} |`),
    "",
    "\"Own\" means the county's own portal (for the five boroughs, New York City's). In the index, a parcel layer is a dataset whose *name* says parcel, tax lot, tax map or PLUTO. In the registry, it is a layer or download the county's row documents, reviewed by hand (`registry_parcel_layers` in `data/parcel-sources.json`); a viewer, search page or request form does not count. City portals with parcel layers are listed but do not count.",
    "",
    "| county | shares with State | own layer | parcel datasets in index | registry rows | registry says | city portals with parcels | State page links |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const r of t.rows) {
    const sp = r.state_page;
    L.push(
      `| ${r.county} | ${r.shares_with_state ? "yes" : "no"} | ${r.own_layer} | ${r.index_parcel_datasets || ""} | ${cell(r.county_rows.map((x) => `\`${x.source_id}\` (${x.status})`).join(", "))} | ${r.registry_layer ? cell(`${r.registry_layer.kind}: "${r.registry_layer.quote}"`) : ""} | ${cell(r.city_portals_with_parcels.map((x) => `\`${x.source_id}\` (${x.datasets})`).join(", "))} | ${sp ? [link("county", sp.county_site), link("viewer", sp.viewer), link("more", sp.additional)].filter(Boolean).join(" ") : ""} |`
    );
  }
  if (t.state_layer.unmatched.length) L.push("", `Names in the State's list that matched no county: ${t.state_layer.unmatched.join(", ")}.`);
  L.push("");
  return L.join("\n");
}
