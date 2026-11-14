import { z } from "zod";
import { basename } from "node:path";
import { FAMILIES } from "./families.js";
import { findSources, howToQuery, listSourcesForPlace, registryInfo } from "./sources.js";
import { checkSource } from "./check.js";
import { DETAIL, EXPORT_MODE, findJoinable, getDatasetColumns, GROUP_BY, indexInfo, MAX_LIMIT, MAX_TOP_PER_GROUP, NoIndexError, RANK_POOL_MAX, RESPONSE_BUDGET_BYTES, searchDatasets, toolJson, whatsNew } from "./datasets.js";
import { awaitIndex, downloadState } from "./fetchindex.js";
import { indexExists } from "./db.js";
import { indexStatus } from "./refresh.js";
import { createBetanycTools } from "./betanyc-tools.js";
import { VERSION } from "./paths.js";

/**
 * whats_changed and about_betanyc, the two tools BetaNYC is adding to each of its MCP servers
 * (betanyc-ai-workspace platform/system/whats-changed-standard.md § 7). betanyc-tools.ts is
 * a copy of the workspace's canonical file: never edit it here. WHATS-CHANGED.md ships in
 * the npm package (package.json `files`), one level above dist/. There is no website, so
 * entry links go to the file on GitHub. whats_changed is about this server; whats_new
 * (below) is about datasets on the portals.
 */
const betanyc = createBetanycTools({
  serverName: "ny-data-registry-mcp",
  version: VERSION,
  repoUrl: "https://github.com/BetaNYC/ny-data-registry-mcp",
  whatsChangedPath: new URL("../WHATS-CHANGED.md", import.meta.url),
});

const INDEX_TOOLS = new Set(["search_datasets", "get_dataset_columns", "find_joinable", "whats_new"]);
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
const STATUS_ENUM = ["live", "no-portal", "UNCONFIRMED", "dead", "any"] as const;

export const TOOLS = [
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
        registry_id: { type: "string", description: "ny-gov-web-registry id (only 22 rows carry one)" },
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
        registry_id: { type: "string" },
        url: { type: "string", description: "A portal URL; matched to its registry row by host" },
      },
    },
  },
  {
    name: "registry_info",
    description: "Registry row counts by status, tier and platform family; when the registry was generated and where this copy came from (bundled or refreshed from GitHub Pages); unmapped platform strings; and the harvested index's size and last harvest date. index_status says how old the index is, whether automatic updates are on (and if not, which setting turned them off), and what the last update check found.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "search_datasets",
    description:
      "Search dataset titles, descriptions, tags and column names across the harvested Socrata and ArcGIS portals in New York (needs the harvested index). Filter by place, portal, platform family, download format (csv, geojson, shapefile, kml, api, xlsx) or last-updated date. " +
      "One call gives the whole answer. total_matches is the true number of matching datasets. When they all fit, the reply lists them. When they do not, the reply summarizes every match by portal (count and top titles per portal, auto_grouped: true), lists the best-ranked rows that fit, and writes every match to a CSV file on this machine (export.path, export.rows; also a resource_link). " +
      "Use group_by to summarize by entity, county or platform_family instead. " +
      "Rows are compact (id, name, portal, type, update date, link, formats); detail: 'full' adds description, API endpoint, views, column count and, for Socrata, the domain + 4x4 to hand to the `socrata` MCP. " +
      `Replies stay under about ${Math.round(RESPONSE_BUDGET_BYTES / 1000)} KB. Each reply also lists registry portals the index does not search, so no result is not proof that no data exists. ` +
      "When the index is more than 14 days old (NY_DATA_INDEX_STALE_DAYS), the reply carries index_note saying so and how to update it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "e.g. 'rodent', 'tax parcels', 'lead service lines'" },
        place: { type: "string", description: "County, city, borough or region. Statewide portals are always included" },
        portal: { type: "string", description: "source_id or part of a portal name" },
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
      required: ["query"],
    },
  },
  {
    name: "get_dataset_columns",
    description: "Column names, field names, types and descriptions for one dataset from the index, plus every distribution (format + URL), license, publisher, extent and per-field provenance (from the portal vs derived here).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { dataset: { type: "string", description: "dataset_id from search_datasets, a Socrata 4x4, an ArcGIS item id, or the dataset URL" } },
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
        limit_per_key: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["dataset"],
    },
  },
  {
    name: "whats_new",
    description:
      "Datasets added, changed or removed in the index since a date, and datasets whose portal says they were updated since then. Optional portal filter. " +
      "For changes to this server itself (new tools, fixes, corrections), use whats_changed instead.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        since: { type: "string", description: "YYYY-MM-DD" },
        portal: { type: "string", description: "source_id or part of a portal name" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["since"],
    },
  },
  // What's changed in this server, and who built it (BetaNYC standard tools).
  ...betanyc.tools,
];

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
  list_sources_for_place: { place: z.string().min(1), include_statewide: z.boolean().optional() },
  how_to_query: { source_id: z.string().optional(), registry_id: z.string().optional(), entity: z.string().optional() },
  check_source: { source_id: z.string().optional(), registry_id: z.string().optional(), url: z.string().optional() },
  registry_info: {},
  search_datasets: {
    query: z.string().min(1),
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
  get_dataset_columns: { dataset: z.string().min(1) },
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

const text = (v: unknown) => ({ content: [{ type: "text", text: toolJson(v) }] });

export async function callTool(name: string, args: unknown) {
  // The shared tools answer in plain text plus structuredContent, and need no index.
  if (betanyc.handles(name)) return betanyc.call(name, args);
  try {
    if (INDEX_TOOLS.has(name)) await requireIndex();
    switch (name) {
      case "find_sources":
        return text(findSources(parseToolArgs("find_sources", args)));
      case "list_sources_for_place": {
        const a = parseToolArgs("list_sources_for_place", args);
        return text(listSourcesForPlace(a.place, a.include_statewide ?? true));
      }
      case "how_to_query": {
        const a = parseToolArgs("how_to_query", args);
        if (!a.source_id && !a.registry_id && !a.entity) throw new Error("give one of source_id, registry_id or entity");
        return text(howToQuery(a));
      }
      case "check_source": {
        const a = parseToolArgs("check_source", args);
        if (!a.source_id && !a.registry_id && !a.url) throw new Error("give one of source_id, registry_id or url");
        return text(await checkSource(a));
      }
      case "registry_info":
        parseToolArgs("registry_info", args);
        return text({ ...registryInfo(indexInfo()), index_download: downloadState(), index_status: indexStatus() });
      case "search_datasets": {
        const r = searchDatasets(parseToolArgs("search_datasets", args)) as Record<string, any>;
        const out = text(r);
        // MCP resource_link content (spec 2025-06-18 and later, "Resource Links" under Tool Result).
        // The JSON text block above stays the answer; this lets a client open or attach the file.
        if (r.export?.uri) {
          (out.content as unknown[]).push({
            type: "resource_link",
            uri: r.export.uri,
            name: basename(r.export.path),
            title: `All ${r.export.rows} matches for '${r.query}' (CSV)`,
            description: `Every dataset matching '${r.query}', best-ranked first, one row each.`,
            mimeType: "text/csv",
            size: r.export.bytes,
          });
        }
        return out;
      }
      case "get_dataset_columns":
        return text(getDatasetColumns(parseToolArgs("get_dataset_columns", args).dataset));
      case "find_joinable": {
        const a = parseToolArgs("find_joinable", args);
        return text(findJoinable(a.dataset, a.column, a.limit_per_key));
      }
      case "whats_new": {
        const a = parseToolArgs("whats_new", args);
        return text(whatsNew(a.since, a.portal, a.limit));
      }
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}
