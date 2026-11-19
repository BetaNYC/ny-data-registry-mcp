import { z } from "zod";
import { echo } from "./echo.js";
import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { FAMILIES } from "./families.js";
import { CANDIDATES_MAX, findSources, howToQuery, listSourcesForPlace, PLACE_LIST_DEFAULT, PLACE_LIST_MAX, registryInfo } from "./sources.js";
import { checkSource } from "./check.js";
import { COLUMNS_DEFAULT, COLUMNS_MAX, COUNTED, countedOf, datasetStandard, db, DETAIL, EXPORT_MODE, findJoinable, getDatasetColumns, GROUP_BY, indexInfo, listTopics, MAX_LIMIT, MAX_TOP_PER_GROUP, NoIndexError, RANK_POOL_MAX, RESPONSE_BUDGET_BYTES, searchDatasets, setSourcesBytes, toolJson, whatsNew } from "./datasets.js";
import { awaitIndex, downloadState } from "./fetchindex.js";
import { indexExists } from "./db.js";
import { indexStatus } from "./refresh.js";
import { annotateTools, BETANYC_INSTRUCTIONS, provenance, toolError, createBetanycTools, FRESHNESS_NOT_FETCHED, officialKind, whatWasDone } from "./betanyc-tools.js";
import { registry } from "./registry.js";
import { govBodies } from "./govbodies.js";
import { hideLocalPaths, hideLocalPathsDeep, REGISTRY_PAGE, VERSION } from "./paths.js";
import { topicRules } from "./topics.js";
import { STANDARDS } from "./standards/build.js";

/**
 * whats_changed, about_betanyc and about_data, the three tools BetaNYC adds to each of its MCP
 * servers (betanyc-ai-workspace platform/system/whats-changed-standard.md § 7 and
 * about-data-standard.md). betanyc-tools.ts is a copy of the workspace's canonical file: never
 * edit it here. WHATS-CHANGED.md and DATA-SOURCES.json ship in the npm package (package.json
 * `files`), one level above dist/. There is no website, so links go to the files on GitHub.
 * whats_changed is about this server; whats_new (below) is about datasets on the portals.
 *
 * How current each source is comes from real state, never typed into DATA-SOURCES.json:
 * the loaded portal list's own `generated` date, when the master list of government bodies was
 * read (or the bundled copy's snapshot date), and the installed index's last harvest. Each
 * portal's catalog reports that portal's own last good read from the index, because portals are
 * read on different schedules and a failed read keeps the datasets from an earlier one. The
 * index is downloaded on first run, so before that its sources say "not fetched yet". The
 * hand-kept places and join-key files carry no date, so they report none.
 */
export const SERVER_INSTRUCTIONS =
  "New York open data portals and their datasets, from BetaNYC's registry and a nightly index of the portals' catalogs. " +
  "It describes datasets; it does not hold the data itself. " +
  // Said once here, not in each tool description (#45).
  "Source rows (find_sources, list_sources_for_place, how_to_query, check_source) and dataset rows carry registry_id when the row has one: the id of the row's government body in BetaNYC/ny-gov-web-registry, for joining the two. " +
  "Source rows also carry runs_it, the government body that runs the site (name, government_level, classification, website), looked up by registry_id in that list; null when the row has no id, found: false when the list lacks it. runs_it_source says which copy of the list answered. " +
  "Every registry and index answer carries data_source: the source, its publisher, a link and how current it is, a cite line to quote, and its about_data_topic. " +
  "Rows from several sources list each in data_sources. " +
  BETANYC_INSTRUCTIONS;

/** The last harvest of the installed index, or "not fetched yet" before the first download. */
function indexHarvestedAt(): string | typeof FRESHNESS_NOT_FETCHED | null {
  if (!indexExists()) return FRESHNESS_NOT_FETCHED;
  const v = indexInfo()?.last_harvest;
  return typeof v === "string" ? v : null;
}

/** A portal catalog's freshness key in DATA-SOURCES.json: this prefix plus the portal's registry source_id. */
export const PORTAL_HARVESTED = "portal_harvested:";

/**
 * When the installed index last read one portal's catalog successfully. After an ok or partial
 * read, that read's time. After a failed, blocked or refused read the index keeps the datasets
 * from earlier reads, so the answer is when those were last seen, never the failed attempt.
 * null when the index has never read the portal; "not fetched yet" before the first download.
 */
export function portalHarvestedAt(portalId: string): string | typeof FRESHNESS_NOT_FETCHED | null {
  if (!indexExists()) return FRESHNESS_NOT_FETCHED;
  try {
    const d = db();
    const p = d.prepare("SELECT harvest_status, last_harvested FROM portals WHERE id = ?").get(portalId) as
      | { harvest_status: string | null; last_harvested: string | null }
      | undefined;
    if (!p || !p.harvest_status) return null;
    if (p.harvest_status === "ok" || p.harvest_status === "partial") return p.last_harvested ?? null;
    const r = d.prepare("SELECT MAX(last_seen) AS t FROM datasets WHERE portal_id = ? AND removed_at IS NULL").get(portalId) as { t: string | null } | undefined;
    return r?.t ?? null;
  } catch {
    return null;
  }
}

/** One freshness hook per portal catalog named in DATA-SOURCES.json. */
function portalHooks(dataSourcesText: string): Record<string, () => ReturnType<typeof portalHarvestedAt>> {
  const hooks: Record<string, () => ReturnType<typeof portalHarvestedAt>> = {};
  let sources: { freshness?: { key?: unknown } }[] = [];
  try {
    sources = (JSON.parse(dataSourcesText) as { sources?: typeof sources }).sources ?? [];
  } catch {
    return hooks; // the shared module reports the broken file itself
  }
  for (const s of sources) {
    const key = s.freshness?.key;
    if (typeof key === "string" && key.startsWith(PORTAL_HARVESTED)) {
      const id = key.slice(PORTAL_HARVESTED.length);
      hooks[key] = () => portalHarvestedAt(id);
    }
  }
  return hooks;
}

/** When the master list of government bodies was read from GitHub, or the bundled copy's date. */
function govBodiesAsOf(): string | null {
  const g = govBodies();
  return g.origin === "bundled" ? g.snapshot_date : g.fetched_at;
}

const DATA_SOURCES_PATH = new URL("../DATA-SOURCES.json", import.meta.url);
const DATA_SOURCES_TEXT = readFileSync(DATA_SOURCES_PATH, "utf8");

/** How current each source is, by its DATA-SOURCES.json freshness key. about_data and the
 * data_source of every answer read the same hooks. */
function freshnessHooks(text: string): Record<string, () => string | typeof FRESHNESS_NOT_FETCHED | null> {
  return {
    ...portalHooks(text),
    registry_generated: () => registry().generated || null,
    gov_bodies_snapshot: govBodiesAsOf,
    index_harvested: indexHarvestedAt,
    bundled_files: () => null,
  };
}
const FRESHNESS_HOOKS = freshnessHooks(DATA_SOURCES_TEXT);

/** `dataSourcesText` is for tests. Throws at startup if DATA-SOURCES.json does not describe this server. */
export function betanycTools(opts: { dataSourcesText?: string } = {}) {
  const text = opts.dataSourcesText ?? DATA_SOURCES_TEXT;
  return createBetanycTools({
    serverName: "ny-data-registry-mcp",
    version: VERSION,
    repoUrl: "https://github.com/BetaNYC/ny-data-registry-mcp",
    whatsChangedPath: new URL("../WHATS-CHANGED.md", import.meta.url),
    dataSourcesPath: DATA_SOURCES_PATH,
    dataSourcesText: text,
    freshness: text === DATA_SOURCES_TEXT ? FRESHNESS_HOOKS : freshnessHooks(text),
  });
}

const betanyc = betanycTools();

const INDEX_TOOLS = new Set(["search_datasets", "list_topics", "get_dataset_columns", "find_joinable", "whats_new"]);
/** How long a dataset tool waits for a first-run download before answering "still downloading". */
const INDEX_WAIT_MS = 45_000;

async function requireIndex(): Promise<void> {
  if (indexExists()) return;
  const st = await awaitIndex(INDEX_WAIT_MS);
  if (indexExists()) return;
  if (st.status === "downloading") {
    throw new NoIndexError(`It is downloading now (started ${st.started_at}). Try again in a minute.`);
  }
  if (st.status === "failed" || st.status === "skipped") throw new NoIndexError(`The automatic download did not run: ${st.error}.`);
  throw new NoIndexError();
}

const FAMILY_ENUM = [...FAMILIES];
const TOPIC_IDS = topicRules().topics.map((t) => t.id) as [string, ...string[]];
const STATUS_ENUM = ["live", "no-portal", "UNCONFIRMED", "dead", "any"] as const;

/**
 * Every tool only reads. openWorldHint (MCP ToolAnnotations): true only for check_source, which
 * makes one live request to a portal; the rest answer from the registry and the downloaded index.
 */
const LIVE_TOOLS = new Set(["check_source"]);

const DOMAIN_TOOLS = [
  {
    name: "find_sources",
    description:
      "Find New York open data portals and sources (state, county, city, agency, library, nonprofit) in BetaNYC's registry by topic, name or place. Returns each source's portal URL, platform family, API type, dataset count, status and last-verified date. Searches portal names and notes, not dataset titles (use search_datasets for datasets). Default status filter is 'live'.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Free text, e.g. 'health', 'parcels', 'Erie County', 'transit'" },
        place: { type: "string", description: "County, city, NYC borough or region, e.g. 'Erie County', 'Buffalo', 'Brooklyn', 'Capital Region'" },
        tier: { type: "integer", enum: [1, 2, 3, 4], description: "1 statewide portals, 2 state agencies/authorities, 3 local government, 4 nonprofit/academic" },
        platform_family: { type: "string", enum: FAMILY_ENUM },
        has_api: { type: "boolean", description: "Only sources with (true) or without (false) a queryable API" },
        key_required: { type: "string", enum: ["Y", "N", "UNCONFIRMED", "—"] },
        status: { type: "string", enum: [...STATUS_ENUM], description: "Default 'live'. Use 'any' to include no-portal, dead and UNCONFIRMED rows" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 10" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_sources_for_place",
    description:
      "Everything the registry knows for one New York place (county, one of the 62 cities, an NYC borough, or a region): its own portal(s), sources for cities inside it, regional sources, and statewide sources that cover it. Says plainly whether the place has a portal, was checked and has none ('no-portal-exists'), or is not in the registry ('not-in-registry', which means unchecked, not absent).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        place: { type: "string", description: "e.g. 'Erie County', 'Syracuse', 'Queens', 'NYC', 'North Country'" },
        include_statewide: { type: "boolean", description: "List the statewide sources too (default true)" },
        limit: { type: "integer", minimum: 1, maximum: PLACE_LIST_MAX, description: `Most rows in each list (own, within, regional, statewide). Default ${PLACE_LIST_DEFAULT}` },
      },
      required: ["place"],
    },
  },
  {
    name: "how_to_query",
    description:
      "How to get data from one registry source: its endpoint (copied verbatim, never guessed), API type, whether a key is needed and which env var holds it, an example request, and which MCP server to hand off to (the `socrata` MCP with the right domain, or the matching @betanyc MCP). Flags UNCONFIRMED, undocumented, gated, dead and no-portal rows.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        source_id: { type: "string", description: "From find_sources / list_sources_for_place results" },
        registry_id: { type: "string", description: "Government body id from BetaNYC/ny-gov-web-registry. Several sources can share one; then the reply lists them" },
        entity: { type: "string", description: "Entity name, e.g. 'NYS Department of Health'" },
        limit: { type: "integer", minimum: 1, maximum: CANDIDATES_MAX, description: "When several rows match: most to list. Default 25" },
        offset: { type: "integer", minimum: 0, description: "When several rows match: skip this many (next_offset)" },
      },
    },
  },
  {
    name: "check_source",
    description:
      "Live check of one source's portal URL: exactly one request (no retry), redirects reported (not followed), HTTP status, response time, and whether that matches the registry's status. A url is never fetched itself: it picks a registry row by host and path, and when no row clearly matches, the rows on that host are listed and nothing is fetched. Never calls key-required or account-gated sources, and reports a bot block rather than working around it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        source_id: { type: "string" },
        registry_id: { type: "string", description: "Government body id from BetaNYC/ny-gov-web-registry" },
        url: { type: "string", description: "A portal URL; matched to its registry row by host" },
      },
    },
  },
  {
    name: "registry_info",
    description: "Registry row counts by status, tier and platform family, and how many rows carry a registry_id; which copy of the master list of government bodies (BetaNYC/ny-gov-web-registry) is loaded and which row ids it lacks; when the registry was generated and where this copy came from (bundled or refreshed from GitHub Pages); unmapped platform strings; and the harvested index's size and last harvest date. index_status says how old the index is, whether automatic updates are on (and if not, which setting turned them off), and what the last update check found.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "search_datasets",
    description:
      "Search dataset titles, descriptions, tags and column names across the harvested Socrata and ArcGIS portals in New York (needs the harvested index). Filter by topic, place, portal, platform family, download format (csv, geojson, shapefile, kml, api, xlsx) or last-updated date. " +
      "topic is one of 24 shared topics (list_topics), assigned from each dataset's own categories, tags and department; a dataset can have several. Give a query, a topic, or both; a topic alone lists that topic, most-viewed first. Rows carry their topic ids. " +
      "One call gives the whole answer. total_matches is the true number of matching datasets. When they all fit, the reply lists them. When they do not, the reply summarizes every match by portal (count and top titles per portal, auto_grouped: true), lists the best-ranked rows that fit, and writes every match to a CSV file on this machine (export.path, export.rows; also a resource_link). " +
      "Use group_by to summarize by entity, county or platform_family instead. " +
      "Rows are compact (id, name, portal, type, update date, link, formats); detail: 'full' adds description, API endpoint, views, column count and, for Socrata, the domain + 4x4 to hand to the `socrata` MCP. " +
      `Replies aim for about ${Math.round(RESPONSE_BUDGET_BYTES / 1000)} KB. Each reply also lists registry portals the index does not search, so no result is not proof that no data exists. ` +
      "When the index is more than 14 days old (NY_DATA_INDEX_STALE_DAYS), the reply carries index_note saying so and how to update it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "e.g. 'rodent', 'tax parcels', 'lead service lines'. Optional when topic is given" },
        topic: { type: "string", enum: TOPIC_IDS, description: "One of the 24 shared topics (list_topics has names and counts), e.g. 'housing', 'transportation', 'elections'" },
        place: { type: "string", description: "County, city, borough or region. Statewide portals are always included" },
        portal: { type: "string", description: "source_id, registry_id (every site of that government) or part of a portal name" },
        platform_family: { type: "string", enum: FAMILY_ENUM },
        format: { type: "string", description: "csv, json, geojson, shapefile, kml, api, arcgis, xlsx, geopackage, pdf" },
        updated_since: { type: "string", description: "YYYY-MM-DD" },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "Most rows to list in the reply. Default 10. More matches than this are summarized by portal and written to the CSV. Not with group_by" },
        offset: { type: "integer", minimum: 0, maximum: RANK_POOL_MAX, description: "Rarely needed: skip this many ranked rows to page by hand (next_offset). Turns off the auto-summary and the automatic CSV. Not with group_by" },
        detail: { type: "string", enum: [...DETAIL], description: "'compact' (default) or 'full'. Not with group_by" },
        group_by: { type: "string", enum: [...GROUP_BY], description: "Group every match by portal, entity, county or platform_family, with counts and top titles per group, instead of a page of results" },
        top_per_group: { type: "integer", minimum: 0, maximum: MAX_TOP_PER_GROUP, description: "Titles listed per group with group_by. Default 3" },
        export: { type: "string", enum: [...EXPORT_MODE], description: "'auto' (default): write the CSV of every match when the reply cannot list them all. 'always' or 'never'" },
      },
    },
  },
  {
    name: "list_topics",
    description:
      "The 24 shared topics for New York open data, with how many datasets and portals each has in the harvested index, and the share of datasets with at least one topic. Topics are built from the categories, tags and departments the portals already use; a dataset can have several. Use a topic id with search_datasets. Also links the crosswalk (each portal label and its topics), published with every index.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { portal: { type: "string", description: "Count one portal only: source_id or part of a portal name" } },
    },
  },
  {
    name: "get_dataset_columns",
    description:
      "Column names, field names, types and descriptions for one dataset from the index, plus every distribution (format + URL), license, publisher, extent and per-field provenance (from the portal vs derived here). " +
      "With standard 'croissant' (read by AI and ML tools) or 'dcat-us' (DCAT-US 3.0, read by government catalogs and data.gov), returns the dataset's description in that standard instead, with which required fields the portal did not give. " +
      "A license is never inferred: where the portal gives none, a terms page may be linked, labeled 'terms page, not a license'.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        dataset: { type: "string", description: "dataset_id from search_datasets, a Socrata 4x4, an ArcGIS item id, or the dataset URL" },
        standard: { type: "string", enum: [...STANDARDS], description: "Return the description as Croissant 1.1 ('croissant') or DCAT-US 3.0 ('dcat-us') instead of the column list" },
        limit: { type: "integer", minimum: 1, maximum: COLUMNS_MAX, description: `Most columns to list. Default ${COLUMNS_DEFAULT}` },
        offset: { type: "integer", minimum: 0, description: "Skip this many columns (columns_shown.next_offset)" },
      },
      required: ["dataset"],
    },
  },
  {
    name: "find_joinable",
    description:
      "Datasets that share a join key with this one, grouped by key: BBL, BIN, borough, community district, council district, census tract, SWIS, FIPS, ZIP. Uses a curated key-column map, not raw column-name equality.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        dataset: { type: "string", description: "dataset_id, Socrata 4x4, ArcGIS item id or URL" },
        column: { type: "string", description: "Limit to one key (a field name in the dataset, or a key label like 'BBL')" },
        limit_per_key: { type: "integer", minimum: 1, maximum: 50, description: "Datasets listed per key. Default 10" },
      },
      required: ["dataset"],
    },
  },
  {
    name: "whats_new",
    annotations: { title: "What's new on the portals" },
    description:
      "Datasets added, changed or removed in the index since a date, and datasets whose portal says they were updated since then. Optional portal filter. " +
      "For changes to this server itself (new tools, fixes, corrections), use whats_changed instead.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        since: { type: "string", description: "YYYY-MM-DD" },
        portal: { type: "string", description: "source_id, registry_id (every site of that government) or part of a portal name" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Most rows in each list. Default 50" },
      },
      required: ["since"],
    },
  },
];

/** about_data's definition with its topic described as this server answers it. */
function withShortAboutData<T extends { inputSchema: any }>(t: T): T {
  const topic = t.inputSchema?.properties?.topic;
  if (!topic) return t;
  const description =
    "A source id, or any tool's name for the data behind it. Any case. Default: a short list of all sources; \"all\": each in full.";
  return { ...t, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, topic: { ...topic, description } } } };
}

export const TOOLS = annotateTools(
  [
    ...DOMAIN_TOOLS,
    // BetaNYC standard tools: what's changed in this server, who built it, and where its data
    // comes from. They declare their own annotations. about_data's topic says what no topic gives
    // here (aboutData below): a short list, not every source in full.
    ...betanyc.tools.map((t) => (t.name === "about_data" ? withShortAboutData(t) : t)),
  ],
  Object.fromEntries(DOMAIN_TOOLS.map((t) => [t.name, LIVE_TOOLS.has(t.name)])),
);

const family = z.enum(FAMILIES);
const ARG_SHAPES = {
  find_sources: {
    query: z.string(),
    place: z.string().optional(),
    tier: z.number().int().min(1).max(4).optional(),
    platform_family: family.optional(),
    has_api: z.boolean().optional(),
    key_required: z.enum(["Y", "N", "UNCONFIRMED", "—"]).optional(),
    status: z.enum(STATUS_ENUM).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  },
  list_sources_for_place: { place: z.string().min(1), include_statewide: z.boolean().optional(), limit: z.number().int().min(1).max(PLACE_LIST_MAX).optional() },
  how_to_query: { source_id: z.string().optional(), registry_id: z.string().optional(), entity: z.string().optional(), limit: z.number().int().min(1).max(CANDIDATES_MAX).optional(), offset: z.number().int().min(0).optional() },
  check_source: { source_id: z.string().optional(), registry_id: z.string().optional(), url: z.string().optional() },
  registry_info: {},
  search_datasets: {
    query: z.string().min(1).optional(),
    topic: z.string().min(1).optional(),
    place: z.string().optional(),
    portal: z.string().optional(),
    platform_family: family.optional(),
    format: z.string().optional(),
    updated_since: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    offset: z.number().int().min(0).max(RANK_POOL_MAX).optional(),
    detail: z.enum(DETAIL).optional(),
    group_by: z.enum(GROUP_BY).optional(),
    top_per_group: z.number().int().min(0).max(MAX_TOP_PER_GROUP).optional(),
    export: z.enum(EXPORT_MODE).optional(),
  },
  list_topics: { portal: z.string().optional() },
  get_dataset_columns: { dataset: z.string().min(1), standard: z.enum(STANDARDS).optional(), limit: z.number().int().min(1).max(COLUMNS_MAX).optional(), offset: z.number().int().min(0).optional() },
  find_joinable: { dataset: z.string().min(1), column: z.string().optional(), limit_per_key: z.number().int().min(1).max(50).optional() },
  whats_new: { since: z.string(), portal: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
};

/** Strict parse: unknown keys are rejected, naming the key and the accepted ones (same rule as nyc-311-mcp #7). */
export function parseToolArgs<K extends keyof typeof ARG_SHAPES>(tool: K, args: unknown): z.infer<z.ZodObject<(typeof ARG_SHAPES)[K]>> {
  const shape = ARG_SHAPES[tool];
  const parsed = z.object(shape).strict().safeParse(args ?? {});
  if (parsed.success) return parsed.data as z.infer<z.ZodObject<(typeof ARG_SHAPES)[K]>>;
  const rejected = parsed.error.issues.flatMap((i) => (i.code === "unrecognized_keys" ? i.keys : []));
  if (rejected.length === 0) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; "));
  }
  throw new Error(
    `${tool} does not accept ${rejected.slice(0, 5).map((k) => `'${echo(k)}'`).join(", ")}${rejected.length > 5 ? ` and ${rejected.length - 5} more` : ""}. ` +
      `The parameters it accepts are: ${Object.keys(shape).join(", ") || "(none)"}. ` +
      `Unknown parameters are rejected rather than ignored, because ignoring one would return results that look right but answer a different question.`
  );
}

/**
 * The `data_source` block every domain answer carries (#36, #37): the source, its publisher, a
 * link and how current it is, from the shared provenance() helper. `cite` is the same as one
 * plain line.
 *
 * Every block is made from one DATA-SOURCES.json entry (sourceFrom), so an answer and about_data
 * can never disagree: the same source name and publisher, and the same answer on whether it is
 * official ("BetaNYC modified this data: <what BetaNYC did>" or "BetaNYC produced this"), worked
 * out by the shared officialKind() from that entry. `about_data_topic` names the entry, so
 * about_data with that topic gives the source in full. Which entry, by kind of row:
 *   registry rows: portal-registry (BetaNYC opens each portal and records what it finds: produced)
 *   dataset rows: the catalog-* entry of the row's portal (the portal's own catalog record, which
 *     the harvest filtered, reshaped, joined to the registry and, for most portals, cleaned:
 *     modified, with the portal's page as the official record); a hand-kept row: hand-kept
 *   a check that reached a portal: portal-check (BetaNYC's record of the portal's reply: produced)
 *   topics, join keys, coverage, standard descriptions: their own entries (produced)
 */
type Prov = ReturnType<typeof provenance>;
type Cited = Prov["provenance"] & { cite: string; about_data_topic: string | null; about_data_note?: string; portal_id?: string };
type DsEntry = {
  id: string;
  source_name: string;
  publisher: { name: string; url?: string | null };
  source_url: string;
  official: boolean;
  changes: { changed: boolean; steps: string[]; detail: string | null };
  freshness?: { kind?: string; key?: string | null } | null;
};
const DS_ENTRIES: Map<string, DsEntry> = new Map(
  (JSON.parse(DATA_SOURCES_TEXT) as { sources: DsEntry[] }).sources.map((s) => [s.id, s]),
);
/** registry source_id → the catalog-* entry that describes that portal's catalog. */
const CATALOG_OF_PORTAL: Map<string, string> = new Map(
  [...DS_ENTRIES.values()]
    .filter((s) => typeof s.freshness?.key === "string" && s.freshness.key.startsWith(PORTAL_HARVESTED))
    .map((s) => [s.freshness!.key!.slice(PORTAL_HARVESTED.length), s.id]),
);
/** The entry's own freshness, the same hook about_data reads; null when it has no usable date. */
function entryAsOf(s: DsEntry): string | null {
  const key = s.freshness?.kind === "hook" ? s.freshness.key : null;
  const v = key && Object.hasOwn(FRESHNESS_HOOKS, key) ? FRESHNESS_HOOKS[key]() : null;
  return typeof v === "string" ? v : null; // "not fetched yet" (FRESHNESS_NOT_FETCHED) is not a date
}
/** The first sentence of a description, for "What BetaNYC did:" in a produced answer. */
const firstSentence = (s: string) => s.replace(/\s+/g, " ").trim().split(/(?<=[a-z0-9)])\. (?=[A-Z])/)[0];
/** One data_source block from DATA-SOURCES.json entry `id`. `sourceUrl` replaces the entry's link
 * when the answer has a more exact one (one dataset's own page, the portal a check reached). */
function sourceFrom(id: string, opts: { kind?: "live" | "snapshot"; asOf?: string | null; sourceUrl?: string | null } = {}): Cited {
  const s = DS_ENTRIES.get(id);
  if (!s) throw new Error(`DATA-SOURCES.json has no source ${id}`);
  const k = officialKind(s.official, s.changes.changed, s.changes.steps);
  const p = provenance({
    sourceName: s.source_name,
    publisher: s.publisher.name,
    sourceUrl: opts.sourceUrl || s.source_url,
    kind: opts.kind ?? "snapshot",
    asOf: opts.asOf === undefined ? entryAsOf(s) : opts.asOf,
    changedByBetanyc:
      k === "published-as-is"
        ? null
        : { kind: k, detail: k === "modified-by-betanyc" ? whatWasDone(s.changes.steps) : firstSentence(s.changes.detail ?? s.source_name) },
  });
  return { ...p.provenance, cite: p.text, about_data_topic: id };
}
const registrySource = () => sourceFrom("portal-registry");
/** A check that reached the portal: BetaNYC's record of the portal's reply, fetched now. Not
 * checked, no answer, or blocked: the registry row it was compared with. */
function checkSourceSource(b: Record<string, any>): Cited {
  if (b.checked !== true || b.request_error || b.blocked) return registrySource();
  try {
    return sourceFrom("portal-check", { kind: "live", asOf: null, sourceUrl: b.url });
  } catch {
    return registrySource();
  }
}
/** The DATA-SOURCES.json entry that says what BetaNYC does to every portal's catalog, for a portal
 * this release has no catalog-* entry for. */
const ANY_CATALOG = "portal-catalogs";
const oneLine = (s: unknown) => (typeof s === "string" ? s.replace(/[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim() : "");
const httpUrl = (s: unknown) => {
  const u = oneLine(s).split(" ")[0];
  return /^https?:\/\/[^/\s@]+\.[^/\s@]+/i.test(u) ? u : "";
};
/** A portal's name, publisher and link, from the index (what the harvest recorded) and the registry. */
function portalFacts(portalId: string): { name: string; publisher: string; url: string } {
  let row: { name?: string; entity?: string; base_url?: string } | undefined;
  try {
    row = db().prepare("SELECT name, entity, base_url FROM portals WHERE id = ?").get(portalId) as typeof row;
  } catch {
    row = undefined;
  }
  const reg = registry().sources.find((s) => s.source_id === portalId) as Record<string, any> | undefined;
  const name = oneLine(row?.name) || oneLine(reg?.portal_name) || oneLine(reg?.entity) || portalId;
  const publisher = oneLine(row?.entity) || oneLine(reg?.entity) || name;
  const url = httpUrl(row?.base_url) || httpUrl(reg?.portal_url) || httpUrl(reg?.url) || REGISTRY_PAGE;
  return { name, publisher, url };
}
/**
 * One portal's catalog. A portal with a catalog-* entry gets it. A portal this release's
 * DATA-SOURCES.json does not have (the index is rebuilt every night; the list of sources changes
 * only with a release, so a portal the registry added or renamed since has none) still gets
 * "BetaNYC modified this data", in the words of the portal-catalogs entry, naming the portal and
 * its publisher as the official record, with a note that about_data has no fuller entry for it.
 * No dataset row is ever left without a source or called "produced".
 */
function portalSource(portalId: string, opts: { asOf?: string | null; sourceUrl?: string | null } = {}): Cited {
  const id = CATALOG_OF_PORTAL.get(portalId);
  if (id) return { ...sourceFrom(id, opts), portal_id: portalId };
  const g = DS_ENTRIES.get(ANY_CATALOG);
  if (!g) throw new Error(`DATA-SOURCES.json has no source ${ANY_CATALOG}`);
  const f = portalFacts(portalId);
  const harvested = portalHarvestedAt(portalId);
  const p = provenance({
    sourceName: f.name,
    publisher: f.publisher,
    sourceUrl: httpUrl(opts.sourceUrl) || f.url,
    kind: "snapshot",
    asOf: opts.asOf !== undefined ? opts.asOf : typeof harvested === "string" ? harvested : null,
    changedByBetanyc: { kind: "modified-by-betanyc", detail: whatWasDone(g.changes.steps) },
  });
  return {
    ...p.provenance,
    cite: p.text,
    about_data_topic: ANY_CATALOG,
    portal_id: portalId,
    about_data_note: `This server's about_data has no entry of its own for ${f.name} yet. about_data topic ${ANY_CATALOG} says what BetaNYC does to every portal's catalog.`,
  };
}
/** The source of one dataset, from its dataset_id ("<portal source_id>:<native id>"). */
function datasetSource(datasetId: string, opts: { asOf?: string | null; sourceUrl?: string | null } = {}): Cited | null {
  const i = datasetId.indexOf(":");
  if (i < 1) return null;
  if (datasetId.slice(i + 1).startsWith("hand-kept:")) return sourceFrom("hand-kept", { sourceUrl: opts.sourceUrl });
  return portalSource(datasetId.slice(0, i), opts);
}
/** Parts of an answer that are not catalog content: its own source blocks and the coverage list
 * of registry portals the index does not search. */
const NOT_CATALOG = new Set(["data_source", "data_sources", "registry_source", "coverage"]);
/**
 * Every portal whose catalog an answer draws on, with how much of the answer comes from it:
 * the portals an index function counted (countedOf: every match behind total_matches, groups,
 * exports, whats_new totals, topic counts, the index's per-portal counts), the portal of every
 * dataset_id, and every other portal_id (find_joinable's by_portal). Hand-kept rows are apart.
 */
function catalogContent(body: unknown): { portals: Map<string, number>; handKept: number } {
  const portals = new Map<string, number>();
  let handKept = 0;
  const add = (id: string, n: number) => portals.set(id, (portals.get(id) ?? 0) + (Number.isFinite(n) && n > 0 ? n : 1));
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const c = countedOf(o);
    if (c) {
      for (const [id, n] of c.portals) add(id, n);
      for (const n of c.handKept.values()) handKept += n;
    }
    if (typeof o.dataset_id === "string" && o.dataset_id.includes(":")) {
      const [pid, ...rest] = o.dataset_id.split(":");
      if (rest.join(":").startsWith("hand-kept:")) handKept++;
      else add(pid, 1);
    } else if (typeof o.portal_id === "string") add(o.portal_id, Number(o.n ?? o.matches ?? 1));
    for (const [k, x] of Object.entries(o)) if (!NOT_CATALOG.has(k)) visit(x);
  };
  visit(body);
  return { portals, handKept };
}
/** The sources of an answer: `lead` first, then every portal catalog it draws on (most first),
 * the hand-kept list when it shows hand-kept rows, then `also`; `whenEmpty` when that is nothing. */
function answerSources(body: unknown, o: { lead?: (Cited | null)[]; also?: Cited[]; whenEmpty?: Cited } = {}): Cited[] {
  const w = catalogContent(body);
  const list = [
    ...(o.lead ?? []).filter((x): x is Cited => !!x),
    ...[...w.portals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => portalSource(id)),
    ...(w.handKept ? [sourceFrom("hand-kept")] : []),
    ...(o.also ?? []),
  ];
  return list.length ? list : o.whenEmpty ? [o.whenEmpty] : [];
}
/** What a source says about being official: the first sentences of its cite, the same words as
 * about_data's ("BetaNYC modified this data: <what>. This copy should not be considered the
 * official record." or "BetaNYC produced this. It is not an official record."). */
const saysOf = (c: Cited) =>
  c.cite.match(/^(BetaNYC modified this data: .*?This copy should not be considered the official record\.|BetaNYC produced this\. It is not an official record\.)/)?.[1] ?? c.cite;
/**
 * Adds the answer's sources. `data_source` is the main one in full (with `cite`). When there is
 * more than one, `data_sources` lists every one, grouped by what it says, each with its
 * about_data_topic, name, publisher, link and date: an answer counting 60 portals stays short.
 * A failure gets none.
 */
function withSources(body: unknown, sources: Cited[]): unknown {
  if (!body || typeof body !== "object" || failureOf(body) !== null || !sources.length) return body;
  const seen = new Set<string>();
  const all = sources.filter((s) => {
    const key = `${s.about_data_topic}|${s.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (all.length === 1) return { ...(body as object), data_source: all[0] };
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const s of all) {
    const says = saysOf(s);
    const item: Record<string, unknown> = { about_data_topic: s.about_data_topic, source: s.source, publisher: s.publisher, source_url: s.source_url, as_of: s.as_of };
    if (s.portal_id) item.portal_id = s.portal_id;
    if (s.about_data_note) item.about_data_note = s.about_data_note;
    groups.set(says, [...(groups.get(says) ?? []), item]);
  }
  return { ...(body as object), data_source: all[0], data_sources: [...groups].map(([says, items]) => ({ says, sources: items })) };
}
const withSource = (body: unknown, s: Cited) => withSources(body, [s]);
const SOURCES_MARGIN_BYTES = 400;
/** How many bytes a search answer's sources take, for the portals it counted: the search keeps
 * its rows and groups to what is left of its size budget (datasets.ts, setSourcesBytes). */
setSourcesBytes((counted) => {
  const body = {};
  Object.defineProperty(body, COUNTED, { value: counted, enumerable: false });
  const probe = { p: 0 };
  const sized = withSources(probe, answerSources(body, { also: [sourceFrom("coverage")] }));
  // The answer's own rows can change which portal leads (its block is in full), so allow for a
  // longer name and link than the one measured here.
  return Buffer.byteLength(toolJson(sized), "utf8") - Buffer.byteLength(toolJson(probe), "utf8") + SOURCES_MARGIN_BYTES;
});
/** The message when an answer is a failure and nothing else: an object whose only field is a
 * string `error` (unknown dataset, source or date) or `place_error` (a place this server does
 * not know). An answer that carries a problem next to real content (check_source's
 * request_error, with its verdict) is an answer, not a failure. */
function failureOf(v: unknown): string | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 1 || (keys[0] !== "error" && keys[0] !== "place_error")) return null;
  const m = (v as Record<string, unknown>)[keys[0]];
  return typeof m === "string" ? m : null;
}

/** Keys this package reads from env. No error text repeats them (#39). */
const secrets = () => [process.env.SOCRATA_APP_TOKEN, process.env.GITHUB_TOKEN];
/** An isError result: a plain sentence, stack lines dropped, keys redacted (#43), and no
 * personal folder (hideLocalPaths: the home folder reads "~"). */
const fail = (message: string) => toolError(hideLocalPaths(message), { secrets: secrets() });

/** The JSON answer, or an isError result when the answer is a failure and nothing else (failureOf). */
export const text = (v: unknown) => {
  const err = failureOf(v);
  if (err !== null) return fail(err);
  // No tool answer carries a personal folder: every string, at any depth, has the home folder as
  // "~" and the temp folder as "<temp>" (index.path, index_download.path, export.path, errors).
  return { content: [{ type: "text", text: toolJson(hideLocalPathsDeep(v)) }] as Record<string, any>[] };
};

/**
 * about_data, kept short. The shared module (betanyc-tools.ts 1.5.2) answers with every source
 * in full: with no topic, all 69 (about 200,000 characters of text, and the same again as
 * structuredContent), and for an index tool such as search_datasets, 67 of them, because each of
 * the 60 portal catalogs is its own source and each names all the index tools. This layer works on
 * the shared answer's own structuredContent, so the words and the outputSchema stay the shared
 * module's; it never edits betanyc-tools.ts:
 *   no topic: a short list, one line per source (topic, source name, publisher, official answer),
 *     with how to ask for more. `sources` is empty; `overview` has the list.
 *   a tool name whose sources include more than one portal catalog: BetaNYC's own sources in
 *     full, and the catalogs one line each (topic, name, publisher, link, how current, official
 *     answer) in `portal_catalogs`.
 *   one source id, or "all": the shared answer, unchanged (every source in full, on request).
 * Every source stays reachable: about_data with its topic gives it in full.
 * To drop this layer, the shared module needs the same (reported to the workspace).
 */
/** A portal catalog: one per portal (catalog-*), and portal-catalogs, what the harvest does to any. */
const CATALOG = (topic: string) => topic.startsWith("catalog-") || topic === "portal-catalogs";
type AdSource = {
  topic: string; source: string; publisher: string; source_url: string; official: boolean;
  changed_by_betanyc: { changed: boolean; steps: string[]; detail: string | null }; as_of: string; as_of_status: string;
};
const kindOf = (s: AdSource) => officialKind(s.official, s.changed_by_betanyc.changed, s.changed_by_betanyc.steps);
/** The official answer in a few words, as the shared module words its first sentence. */
function shortAnswer(s: AdSource): string {
  const k = kindOf(s);
  if (k === "produced-by-betanyc") return "BetaNYC produced this";
  if (k === "modified-by-betanyc") return `BetaNYC modified this data: ${whatWasDone(s.changed_by_betanyc.steps)}`;
  return "BetaNYC did not modify it";
}
const ABOUT_DATA_MORE =
  "For one source in full (what it is, how it is gathered, what BetaNYC did, how current it is, what it covers, terms and credit line, where to report an error), call about_data with its topic. For the sources behind one tool, give the tool's name as topic. topic \"all\" gives every source in full, which is long.";

/** The three shared tools describe this server, not data: about_data with one of their names says
 * so (the shared module answers "no data topic or tool named …"). */
const SERVER_TOOLS: Record<string, string> = {
  whats_changed: "whats_changed reads this server's WHATS-CHANGED.md, its own record of changes. It uses no data source.",
  about_betanyc: "about_betanyc says who built this server and how to reach BetaNYC. It uses no data source.",
  about_data: "about_data reads this server's DATA-SOURCES.json, the list of its data sources. Call it with no topic for that list.",
};
function aboutData(args: unknown) {
  const asked = args && typeof args === "object" && typeof (args as any).topic === "string" ? (args as any).topic.trim().toLowerCase() : "";
  if (Object.hasOwn(SERVER_TOOLS, asked) && Object.keys(args as object).length === 1) {
    const base = betanyc.call("about_data", {});
    const sc = base.structuredContent as Record<string, any> | undefined;
    if (!base.isError && sc) {
      const note = `${SERVER_TOOLS[asked]} ${ABOUT_DATA_MORE}`;
      return { content: [{ type: "text", text: note }], structuredContent: { ...sc, topic: asked, sources: [], note } };
    }
  }
  const full = betanyc.call("about_data", args);
  const sc = full.structuredContent as Record<string, any> | undefined;
  if (full.isError || !sc || !Array.isArray(sc.sources) || !sc.sources.length) return full;
  const askedAll = !!args && typeof args === "object" && typeof (args as any).topic === "string" && (args as any).topic.trim().toLowerCase() === "all";
  const sources = sc.sources as AdSource[];
  const parts = String(full.content[0].text).split("\n\n");
  // [head, one block per source, contact and who built it, the note when there is one]
  if (parts.length < sources.length + 2) return full;
  const head = parts[0].split("\n");
  const tail = parts.slice(sources.length + 1);
  const officialLine = head[1];
  const fileLine = head[head.length - 1];

  if (sc.topic === null && !askedAll) {
    const groups = new Map<string, AdSource[]>();
    for (const s of sources) {
      const k = kindOf(s);
      groups.set(k, [...(groups.get(k) ?? []), s]);
    }
    const heading: Record<string, string> = {
      "produced-by-betanyc": "BetaNYC produced these. They are not official records:",
      "modified-by-betanyc": "BetaNYC modified these. Each copy should not be considered the official record; the source named is:",
      "published-as-is": "Published as is (BetaNYC did not modify them):",
    };
    const lines = [
      `Where the data in ${sc.server.name} ${sc.server.version} comes from: ${sources.length} sources, listed short (topic: source, publisher).`,
      ABOUT_DATA_MORE,
      officialLine,
    ];
    for (const k of ["produced-by-betanyc", "modified-by-betanyc", "published-as-is"]) {
      const g = groups.get(k);
      if (!g) continue;
      lines.push("", heading[k], ...g.map((s) => `- ${s.topic}: ${s.source} (${s.publisher})`));
    }
    lines.push("", fileLine);
    const text = [lines.join("\n"), ...tail].join("\n\n");
    const overview = sources.map((s) => ({ topic: s.topic, source: s.source, publisher: s.publisher, official_answer: kindOf(s) }));
    return { content: [{ type: "text", text }], structuredContent: { ...sc, sources: [], overview, more: ABOUT_DATA_MORE } };
  }

  const catalogs = sources.filter((s) => CATALOG(s.topic));
  if (sc.topic === null || catalogs.length < 2) return full;
  const keep = sources.map((s, i) => [s, parts[i + 1]] as const).filter(([s]) => !CATALOG(s.topic));
  // Before the index is downloaded every catalog has the same undated state: say it once.
  const sameState = catalogs.every((s) => s.as_of === catalogs[0].as_of) && !/^\d/.test(catalogs[0].as_of) ? catalogs[0].as_of : null;
  const line = (s: AdSource) =>
    `- ${s.topic}: ${s.source} (${s.publisher}), ${s.source_url}` + (sameState ? "" : /^\d/.test(s.as_of) ? `, as of ${s.as_of}` : `, how current: ${s.as_of}`);
  const byAnswer = new Map<string, AdSource[]>();
  for (const s of catalogs) byAnswer.set(shortAnswer(s), [...(byAnswer.get(shortAnswer(s)) ?? []), s]);
  const text = [
    [
      `Where the data in ${sc.server.name} ${sc.server.version} comes from, for '${sc.topic}': ${sources.length} sources. BetaNYC's own sources in full, then ${catalogs.length} portal catalogs one line each.`,
      officialLine,
      fileLine,
    ].join("\n"),
    ...keep.map(([, block]) => block),
    [
      `Portal catalogs behind '${sc.topic}' (${catalogs.length}). Each is that portal's own catalog, copied by BetaNYC's nightly harvest; the portal named is the official record. For one in full (terms, credit line, caveats, where to report an error), call about_data with its topic.` + (sameState ? ` How current, for all of them: ${sameState}.` : ""),
      ...[...byAnswer].flatMap(([answer, g]) => [`${answer}. This copy should not be considered the official record (${g.length}):`, ...g.map(line)]),
    ].join("\n"),
    ...tail,
  ].join("\n\n");
  const portal_catalogs = catalogs.map((s) => ({
    topic: s.topic, source: s.source, publisher: s.publisher, source_url: s.source_url,
    official_answer: kindOf(s), as_of: s.as_of,
  }));
  return {
    content: [{ type: "text", text }],
    structuredContent: { ...sc, sources: keep.map(([s]) => s), portal_catalogs, more: ABOUT_DATA_MORE },
  };
}

export async function callTool(name: string, args: unknown) {
  // The shared tools answer in plain text plus structuredContent, and need no index.
  if (name === "about_data") return hideLocalPathsDeep(aboutData(args));
  if (betanyc.handles(name)) return hideLocalPathsDeep(betanyc.call(name, args));
  try {
    if (INDEX_TOOLS.has(name)) await requireIndex();
    switch (name) {
      case "find_sources":
        return text(withSource(findSources(parseToolArgs("find_sources", args)), registrySource()));
      case "list_sources_for_place": {
        const a = parseToolArgs("list_sources_for_place", args);
        return text(withSource(listSourcesForPlace(a.place, a.include_statewide ?? true, a.limit), registrySource()));
      }
      case "how_to_query": {
        const a = parseToolArgs("how_to_query", args);
        if (!a.source_id && !a.registry_id && !a.entity) throw new Error("give one of source_id, registry_id or entity");
        return text(withSource(howToQuery(a), registrySource()));
      }
      case "check_source": {
        const a = parseToolArgs("check_source", args);
        if (!a.source_id && !a.registry_id && !a.url) throw new Error("give one of source_id, registry_id or url");
        const r = (await checkSource(a)) as Record<string, any>;
        const out = withSource(r, checkSourceSource(r)) as Record<string, any>;
        // A live check cites BetaNYC's record of the portal's reply (data_source, portal-check). The
        // registry row it was compared with is cited on its own (registry_source), so the two never blur.
        if (out?.data_source?.about_data_topic === "portal-check") out.registry_source = registrySource();
        return text(out);
      }
      case "registry_info":
        parseToolArgs("registry_info", args);
      {
        // The registry, then the catalog of every portal whose datasets the index counts (index.datasets, portals_detail).
        const r = { ...registryInfo(indexInfo()), index_download: downloadState(), index_status: indexStatus() };
        return text(withSources(r, answerSources(r, { lead: [registrySource()] })));
      }
      case "search_datasets": {
        const r = searchDatasets(parseToolArgs("search_datasets", args)) as Record<string, any>;
        // The catalog of every portal with a match (rows, groups, total_matches and the export
        // count them all), the hand-kept list for its rows, and the coverage list the answer
        // carries (registry portals the index does not search); the coverage list alone when
        // nothing matched.
        const out = text(withSources(r, answerSources(r, { also: r.coverage ? [sourceFrom("coverage")] : [], whenEmpty: sourceFrom("coverage") })));
        // MCP resource_link content (spec 2025-06-18 and later, "Resource Links" under Tool Result).
        // The JSON text block above stays the answer; this lets a client open or attach the file.
        if (r.export?.uri) {
          (out.content as unknown[]).push({
            type: "resource_link",
            uri: r.export.uri,
            name: basename(r.export.path),
            title: `All ${r.export.rows} matches for '${r.query ?? r.topic?.name}' (CSV)`,
            description: `Every dataset matching '${r.query ?? r.topic?.name}', best-ranked first, one row each.`,
            mimeType: "text/csv",
            size: r.export.bytes,
          });
        }
        return out;
      }
      case "list_topics":
      {
        // BetaNYC's topics, then the catalog of every portal whose datasets the counts include.
        const r = listTopics(parseToolArgs("list_topics", args));
        return text(withSources(r, answerSources(r, { lead: [sourceFrom("topics")] })));
      }
      case "get_dataset_columns": {
        const a = parseToolArgs("get_dataset_columns", args);
        // One dataset: its portal's catalog, with the dataset's own page as the official record, as
        // of the harvest that last saw it. A description in a standard also cites the mapping.
        const r = getDatasetColumns(a.dataset, a.standard ? 1 : a.limit, a.standard ? 0 : a.offset) as Record<string, any>;
        const own = typeof r.dataset_id === "string" ? datasetSource(r.dataset_id, { asOf: r.last_seen ?? null, sourceUrl: r.url }) : null;
        if (a.standard) {
          const std = datasetStandard(a.dataset, a.standard);
          return text(withSources(std, own ? answerSources(std, { lead: [own], also: [sourceFrom("standard-descriptions")] }) : []));
        }
        return text(withSources(r, own ? answerSources(r, { lead: [own] }) : []));
      }
      case "find_joinable": {
        const a = parseToolArgs("find_joinable", args);
        const r = findJoinable(a.dataset, a.column, a.limit_per_key) as Record<string, any>;
        const own = typeof r.dataset?.dataset_id === "string" ? datasetSource(r.dataset.dataset_id) : null;
        return text(withSources(r, answerSources(r, { lead: [own], also: [sourceFrom("join-keys")] })));
      }
      case "whats_new": {
        const a = parseToolArgs("whats_new", args);
        const r = whatsNew(a.since, a.portal, a.limit);
        return text(withSources(r, answerSources(r, { whenEmpty: sourceFrom("coverage") })));
      }
      default:
        return fail(`Unknown tool: ${echo(name)}. The tools are: ${TOOLS.map((t) => t.name).join(", ")}.`);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
