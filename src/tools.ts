import { z } from "zod";
import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { FAMILIES } from "./families.js";
import { findSources, howToQuery, listSourcesForPlace, PLACE_LIST_DEFAULT, PLACE_LIST_MAX, registryInfo } from "./sources.js";
import { checkSource } from "./check.js";
import { COLUMNS_DEFAULT, COLUMNS_MAX, datasetStandard, db, DETAIL, EXPORT_MODE, findJoinable, getDatasetColumns, GROUP_BY, indexInfo, listTopics, MAX_LIMIT, MAX_TOP_PER_GROUP, NoIndexError, RANK_POOL_MAX, RESPONSE_BUDGET_BYTES, searchDatasets, toolJson, whatsNew } from "./datasets.js";
import { awaitIndex, downloadState, INDEX_RELEASES_PAGE } from "./fetchindex.js";
import { indexExists } from "./db.js";
import { indexStatus } from "./refresh.js";
import { annotateTools, BETANYC_INSTRUCTIONS, provenance, toolError, createBetanycTools, FRESHNESS_NOT_FETCHED } from "./betanyc-tools.js";
import { registry } from "./registry.js";
import { govBodies } from "./govbodies.js";
import { REGISTRY_PAGE, VERSION } from "./paths.js";
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
  "Every answer carries data_source: the source, its publisher, a link and how current it is, with a cite line to quote. " +
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

/** `dataSourcesText` is for tests. Throws at startup if DATA-SOURCES.json does not describe this server. */
export function betanycTools(opts: { dataSourcesText?: string } = {}) {
  const dataSourcesPath = new URL("../DATA-SOURCES.json", import.meta.url);
  const text = opts.dataSourcesText ?? readFileSync(dataSourcesPath, "utf8");
  return createBetanycTools({
    serverName: "ny-data-registry-mcp",
    version: VERSION,
    repoUrl: "https://github.com/BetaNYC/ny-data-registry-mcp",
    whatsChangedPath: new URL("../WHATS-CHANGED.md", import.meta.url),
    dataSourcesPath,
    dataSourcesText: text,
    freshness: {
      ...portalHooks(text),
      registry_generated: () => registry().generated || null,
      gov_bodies_snapshot: govBodiesAsOf,
      index_harvested: indexHarvestedAt,
      bundled_files: () => null,
    },
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
      },
    },
  },
  {
    name: "check_source",
    description:
      "Live check of one source's portal URL: one polite request, redirects reported (not followed), HTTP status, response time, and whether that matches the registry's status. Never calls key-required or account-gated sources, and reports a bot block rather than working around it.",
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
      `Replies stay under about ${Math.round(RESPONSE_BUDGET_BYTES / 1000)} KB. Each reply also lists registry portals the index does not search, so no result is not proof that no data exists. ` +
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

export const TOOLS = annotateTools(
  [
    ...DOMAIN_TOOLS,
    // BetaNYC standard tools: what's changed in this server, who built it, and where its data
    // comes from. They declare their own annotations.
    ...betanyc.tools,
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
  how_to_query: { source_id: z.string().optional(), registry_id: z.string().optional(), entity: z.string().optional() },
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
    `${tool} does not accept ${rejected.map((k) => `'${k}'`).join(", ")}. ` +
      `The parameters it accepts are: ${Object.keys(shape).join(", ") || "(none)"}. ` +
      `Unknown parameters are rejected rather than ignored, because ignoring one would return results that look right but answer a different question.`
  );
}

/**
 * The `data_source` block every domain answer carries (#36, #37): the source, its publisher, a
 * link and how current it is, from the shared provenance() helper, with the same names as the
 * sources in DATA-SOURCES.json. `cite` is the same as one plain line.
 */
type Prov = ReturnType<typeof provenance>;
const cite = (p: Prov) => ({ ...p.provenance, cite: p.text });
const registrySource = () =>
  provenance({ sourceName: "NY Data Portal Registry", publisher: "BetaNYC", sourceUrl: REGISTRY_PAGE, kind: "snapshot", asOf: registry().generated || null });
const indexSource = () =>
  provenance({ sourceName: "NY Data Registry index", publisher: "BetaNYC", sourceUrl: INDEX_RELEASES_PAGE, kind: "snapshot", asOf: (indexInfo()?.last_harvest as string | null) ?? null });
/** One dataset: its portal's catalog, the dataset's own page, as of the harvest that last saw it. */
function datasetSource(b: Record<string, any>): Prov {
  try {
    return provenance({ sourceName: `${b.portal} catalog`, publisher: b.entity, sourceUrl: b.url, kind: "snapshot", asOf: b.last_seen ?? null });
  } catch {
    return indexSource(); // no portal name, publisher or link on the row
  }
}
/** check_source: the portal page itself, fetched for this answer; otherwise the registry row. */
function checkSourceSource(b: Record<string, any>): Prov {
  if (b.checked !== true) return registrySource();
  try {
    return provenance({ sourceName: b.source?.portal_name || b.source?.entity, publisher: b.source?.entity, sourceUrl: b.url, kind: "live", asOf: b.checked_at });
  } catch {
    return registrySource();
  }
}
const withSource = (body: unknown, p: Prov) =>
  body && typeof body === "object" && !("error" in body) && !("place_error" in body) ? { ...(body as object), data_source: cite(p) } : body;

/** Keys this package reads from env. No error text repeats them (#39). */
const secrets = () => [process.env.SOCRATA_APP_TOKEN, process.env.GITHUB_TOKEN];
/** An isError result: a plain sentence, stack lines dropped, keys redacted (#43). */
const fail = (message: string) => toolError(message, { secrets: secrets() });

/** The JSON answer, or an isError result when the answer is a failure: a top-level `error`
 * (unknown dataset, source or date) or `place_error` (a place this server does not know). */
const text = (v: unknown) => {
  const o = v as { error?: unknown; place_error?: unknown } | null;
  const err = typeof o?.error === "string" ? o.error : typeof o?.place_error === "string" ? o.place_error : null;
  if (err) return fail(err);
  return { content: [{ type: "text", text: toolJson(v) }] as Record<string, any>[] };
};

export async function callTool(name: string, args: unknown) {
  // The shared tools answer in plain text plus structuredContent, and need no index.
  if (betanyc.handles(name)) return betanyc.call(name, args);
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
        const r = await checkSource(a);
        return text(withSource(r, checkSourceSource(r as Record<string, any>)));
      }
      case "registry_info":
        parseToolArgs("registry_info", args);
        return text(withSource({ ...registryInfo(indexInfo()), index_download: downloadState(), index_status: indexStatus() }, registrySource()));
      case "search_datasets": {
        const r = searchDatasets(parseToolArgs("search_datasets", args)) as Record<string, any>;
        const out = text(withSource(r, indexSource()));
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
        return text(withSource(listTopics(parseToolArgs("list_topics", args)), indexSource()));
      case "get_dataset_columns": {
        const a = parseToolArgs("get_dataset_columns", args);
        if (a.standard) return text(withSource(datasetStandard(a.dataset, a.standard), indexSource()));
        const r = getDatasetColumns(a.dataset, a.limit, a.offset) as Record<string, any>;
        return text(withSource(r, datasetSource(r)));
      }
      case "find_joinable": {
        const a = parseToolArgs("find_joinable", args);
        return text(withSource(findJoinable(a.dataset, a.column, a.limit_per_key), indexSource()));
      }
      case "whats_new": {
        const a = parseToolArgs("whats_new", args);
        return text(withSource(whatsNew(a.since, a.portal, a.limit), indexSource()));
      }
      default:
        return fail(`Unknown tool: ${name}. The tools are: ${TOOLS.map((t) => t.name).join(", ")}.`);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
