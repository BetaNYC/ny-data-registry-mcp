# ny-data-registry-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that finds open data across every New York data portal in BetaNYC's [NY data portal registry](https://betanyc.github.io/grounding-ai-with-ny-open-data/resources/ny-data-portal-registry.html): which portal covers a place or topic, how to query it, and, with the harvested index, which datasets and columns exist and in what formats.

It complements the [`socrata`](https://www.npmjs.com/package/socrata-mcp-server) MCP rather than replacing it. This server knows *where* data is (140 sources across state, county, city, agency, library and nonprofit portals) and hands the agent the right Socrata domain or ArcGIS service. Querying the data stays with `socrata` and the other BetaNYC MCPs.

Built by [BetaNYC](https://beta.nyc). **Status: 0.1.0, local only.** Not published to npm; no GitHub repo yet. The package name `@betanyc/ny-data-registry-mcp` is a working title and not claimed.

---

## What it does

Nine tools, in two groups.

**Registry tools** (work out of the box, no index needed):

| Tool | What it answers |
|---|---|
| `find_sources` | Which portals cover this topic or place? Filters: place, tier, platform family, has API, key required, status (default `live`) |
| `list_sources_for_place` | Everything for one county, city, NYC borough or region. Says whether the place **has a portal**, was **checked and has none**, or is **not in the registry** (unchecked, not absent) |
| `how_to_query` | Endpoint (verbatim from the registry, never guessed), API type, key and env var, example request, and which MCP to hand off to. Flags UNCONFIRMED, undocumented, gated, dead and no-portal rows |
| `check_source` | One live request to a portal URL: status, redirect, response time, and whether that matches the registry |
| `registry_info` | Row counts, registry date and origin, unmapped platform strings, index size and last harvest |

**Index tools** (need the harvested SQLite index):

| Tool | What it answers |
|---|---|
| `search_datasets` | Dataset titles, descriptions, tags and **column names** across Socrata and ArcGIS portals. Filters: place, portal, platform family, format (csv, geojson, shapefile, kml, api, xlsx …), updated since |
| `get_dataset_columns` | Fields and types, every distribution (format + URL), license, publisher, extent, and per-field provenance |
| `find_joinable` | Datasets sharing a join key (BBL, BIN, borough, community district, council district, census tract, SWIS, FIPS, ZIP), from a curated key-column map, not raw name equality |
| `whats_new` | Datasets added, changed or removed since a date |

All tool inputs are strict: an unknown parameter is rejected by name, never silently dropped (same rule as `nyc-311-mcp`).

---

## Install

Requires **Node 22.13 or later** (it uses Node's built-in `node:sqlite`, so there is nothing native to compile).

```bash
cd ~/Code/ny-data-registry-mcp
npm install
npm run build
npm test                       # offline; no network
node dist/cli.js harvest       # build the index (read-only, throttled; see "Refresh")
```

Proposed `.mcp.json` entry (**not added anywhere**; adding it is a separate decision):

```json
"ny-data-registry-mcp": {
  "command": "node",
  "args": ["${HOME}/Code/ny-data-registry-mcp/dist/index.js"],
  "env": {}
}
```

Once published to npm this would become `"command": "npx", "args": ["-y", "@betanyc/ny-data-registry-mcp"]`, with the index downloaded from a release asset instead of built locally.

### Environment variables (all optional)

| Variable | Default | Purpose |
|---|---|---|
| `NY_DATA_INDEX` | `${HOME}/.cache/betanyc/ny-data-registry/ny-data-index.sqlite` | Where the index lives |
| `NY_DATA_CACHE_DIR` | `${HOME}/.cache/betanyc/ny-data-registry` | Registry refresh cache and HTTP cache |
| `NY_DATA_REGISTRY_REFRESH` | on | `0` = never fetch the published registry; use the bundled copy |
| `NY_DATA_OFFLINE` | off | `1` = refuse every network call (tests use this) |
| `NY_DATA_MAX_LAYERS` | 250 | Per-portal cap on ArcGIS field requests per harvest |
| `NY_DATA_MIN_INTERVAL_MS` | 1000 | Minimum gap between requests to one host (cannot be set below 1000) |
| `SOCRATA_APP_TOKEN` | none | Sent as `X-App-Token` to the Socrata Discovery API |

---

## Data sources

- **The registry.** `BetaNYC/grounding-ai-with-ny-open-data` `resources/ny-data-portal-registry.json` (140 rows). A copy is bundled in `data/`. On startup the server makes a conditional request (ETag) for the published copy on GitHub Pages, caches it under `${HOME}/.cache/betanyc/`, and falls back to the bundled copy on any failure. This server never edits the registry.
- **Human-editable tables** in `data/`:
  - `platform-families.json`: maps each of the registry's **101** free-text `platform` strings to one family (`socrata`, `arcgis-hub`, `arcgis-enterprise`, `arcgis-server`, `ckan`, `geoblacklight`, `custom-api`, `none`). A string not in the table is reported as *unmapped*, never guessed; 7 strings are deliberately `null` because the registry marks them UNCONFIRMED.
  - `ny-places.json`: 62 counties, 62 cities, 5 boroughs, 8 regions.
  - `key-columns.json`: the curated join keys.
  - `handoffs.json`: which BetaNYC MCP serves which registry row.
  - `harvest-config.json`: skips (ANHD, Rockland, Columbia GeoBlacklight) and caps.
  - `synonyms.json`: a short civic synonym list ("property" → parcels, tax lots, BBL).
- **The harvested index**, built from the portals themselves (next section).

---

## The harvest

`node dist/cli.js harvest` reads every live registry row and harvests the ones a documented catalog API covers:

| Platform | Adapter | Columns from |
|---|---|---|
| Socrata | Discovery API (`api.us.socrata.com/api/catalog/v1`, `scroll_id` paging) | the search response itself |
| ArcGIS Hub | OGC API - Records (`/api/search/v1/collections/dataset/items`), plus the DCAT-US 1.1 feed for formats; falls back to the `all` collection, then DCAT only, on older sites | `FeatureServer?f=json`, then each layer `?f=json` |
| ArcGIS Enterprise | `<portal>/sharing/rest/search`, filtered to the portal's own org (`portals/self`), or to its own service host when the org id is hidden | same second hop |
| ArcGIS Online org (agency REST directories such as DEC, Parks, DCP) | `www.arcgis.com/sharing/rest/search?q=orgid:<id>` | same second hop |

Everything else (custom APIs, CKAN, GeoBlacklight, standalone ArcGIS Server directories, pages with no API) is described by the registry tools but not harvested in this version.

**Guards**
- **Esri's own content is excluded** (owner `esri…`, org `P3ePLMYs2RVChkJx`). For Enterprise portals and ArcGIS Online orgs, items from another org are not counted under that portal; this is what turns Monroe's 108 search hits into its own content. Hub sites are *not* filtered by org, because a Hub's catalog is curated by its owner and aggregators like the State GIS Clearinghouse deliberately list other agencies' layers.
- **Out-of-state guard**: an item whose extent lies wholly outside New York is dropped; a portal whose items are mostly outside New York is refused and purged. Placeholder extents (`[0,0,0,0]`) and projected coordinates (State Plane) count as *unknown*, never as outside.
- **Stable paging**: Hub pages are requested sorted by `id`. A listing that comes back with fewer unique items than the portal's own total is treated as incomplete, so nothing is marked removed from a shaky listing.
- **Politeness**: one descriptive User-Agent with no email address; at least 1 s between requests to a host; robots.txt Disallow **and Crawl-delay** honored (every Hub site asks for 60 s, so Hub listing is slow on purpose); conditional requests by ETag; one bounded retry on 429; a per-portal cap on layer requests. A bot block is reported, never worked around.
- **Never called**: rows needing a key, ANHD, Rockland County, undocumented endpoints.

The index stores metadata only (titles, descriptions, field names, links). It never downloads data.

**Incremental**: datasets carry `first_seen`, `last_seen` and a content hash. A layer whose `modified` date has not changed keeps its stored columns and is not re-requested. A dataset is marked removed only after a *complete* harvest of its portal.

---

## Refresh

- **Registry**: picked up on next server start (conditional GET of the Pages copy).
- **Index**: re-run `node dist/cli.js harvest`. `.github/workflows/harvest.yml` is written to do this nightly in GitHub Actions and publish the SQLite file as a release asset, but it is **not enabled** (schedule commented out, repo not pushed).

---

## How it was checked

- `npm test`: offline tests from recorded fixtures (`test/fixtures/`, each says which request produced it), including a stdio smoke test that starts the server and calls all nine tools.
- `node dist/cli.js eval`: a fixed set of real questions (`eval/questions.json`) scored against the real index. Results: `eval/runs/`.

Latest results (2026-11-05, office-mac), all in `eval/runs/`:

- `npm test`: **44 / 44 pass**.
- Question set: **27 / 27** in the top 3, **0** invariant violations. The set was written by the same agent that built the tool, so treat 100% as an upper bound; two checks (Q01, Q13) were tightened during the build when a loose check passed on the wrong county's parcels.
- Index: **9,569 datasets, 185,352 columns** (5,729 with a join key) from **35 of 36** harvestable portals; 110 MB SQLite (about 18 MB gzipped). Full harvest: 924 s and 3,694 requests; an ArcGIS-only re-run: 878 s and 1,403 requests (unchanged layers are not re-requested).
- 311 (`erm2-nwe9`) joins: BBL 426, borough 1,073, community district 510, council district 426 datasets (Scout, name equality only: 331 / 512 / 286).

---

## Limits

- **Coverage is the registry's.** A place not in the registry has not been checked; the tools say so.
- **Not harvested yet**: standalone ArcGIS Server REST directories (NYS DOT, ITS, many counties), GeoBlacklight (Cornell), CKAN (catalog.data.gov), custom APIs.
- **Row counts are not collected** (Socrata Discovery does not return them; ArcGIS would need one more request per layer). `downloads` and `update_frequency` exist only for Socrata.
- **Columns for ArcGIS are capped** at 250 layer requests per portal per run; the rest show `columns_status: not-fetched` and fill in on later runs.
- **Search is keyword search** (SQLite FTS5 with a small synonym list), not semantic search.
- **Join keys are by column name only**; values are not compared.
- Orange County's portal is unreachable from Node because its server does not send its intermediate TLS certificate. Certificate checks are not disabled.
- Syracuse's Hub returned 126 unique items of 136 on one run even with sorted paging; the guard kept the index whole, but a short listing can still miss new items until the next run.
- The index is about 110 MB uncompressed, larger than the scoping estimate (low tens of MB), mostly Socrata column metadata and the full-text index.

## Terms of use

Read before any adapter was written; details and quotes in [`docs/terms.md`](docs/terms.md).

- **Socrata / Tyler**: the Discovery API's stated purpose is "automated searching, research, and exploration"; read-only access needs no authentication; an app token is recommended. Per-portal terms pages were not found (not verified).
- **Esri**: ArcGIS Online public content is for personal or noncommercial use under each item's own terms, and owners who share publicly grant end users permission to use and reproduce it. The Master Agreement's "may not scrape, download, or store Data" clause defines Data as Esri's own commercial datasets, which are excluded here. Hub robots.txt asks for a 60 s crawl delay, which is honored.

## Related

- Scout field mapping: [`docs/scout-mapping.md`](docs/scout-mapping.md)
- Proposed upstream registry change (`platform_family`): [`docs/upstream/`](docs/upstream/)

## License

MIT
