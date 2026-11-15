# ny-data-registry-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that finds open data across every New York data portal in BetaNYC's [NY data portal registry](https://betanyc.github.io/grounding-ai-with-ny-open-data/resources/ny-data-portal-registry.html): which portal covers a place or topic, how to query it, and, with the harvested index, which datasets and columns exist and in what formats.

It complements the [`socrata`](https://www.npmjs.com/package/socrata-mcp-server) MCP rather than replacing it. This server knows *where* data is (140 sources across state, county, city, agency, library and nonprofit portals) and hands the agent the right Socrata domain or ArcGIS service. Querying the data stays with `socrata` and the other BetaNYC MCPs.

Built by [BetaNYC](https://beta.nyc). **Status: 0.3.0.** Package: `@betanyc/ny-data-registry-mcp`.

What changed in this server, newest first, including corrections: [WHATS-CHANGED.md](WHATS-CHANGED.md).

---

## What it does

Eleven tools, in three groups.

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
| `search_datasets` | Dataset titles, descriptions, tags and **column names** across Socrata and ArcGIS portals. Filters: place, portal, platform family, format (csv, geojson, shapefile, kml, api, xlsx …), updated since. One call gives the whole answer: the true number of matches, a count per portal when they don't all fit, the best rows, and a CSV file with every match. `group_by` summarizes by entity, county or platform family instead |
| `get_dataset_columns` | Fields and types, every distribution (format + URL), license, publisher, extent, and per-field provenance |
| `find_joinable` | Datasets sharing a join key (BBL, BIN, borough, community district, council district, census tract, SWIS, FIPS, ZIP), from a curated key-column map, not raw name equality |
| `whats_new` | Datasets added, changed or removed since a date |

**About this server** (the two tools BetaNYC is adding to each of its MCP servers; no index needed):

| Tool | What it answers |
|---|---|
| `whats_changed` | What changed in **this server**, newest first, from [WHATS-CHANGED.md](WHATS-CHANGED.md): new tools, fixes and corrections. Filters: since, tag (Site, Data, MCP, Correction), limit. For datasets that are new on the portals, use `whats_new` |
| `about_betanyc` | Who built the server, its version, where to report a bug in this server or ask for a new feature, and BetaNYC's links |

These two come from `src/betanyc-tools.ts`, a copy of a file BetaNYC is adding to each of its MCP servers: change it in the BetaNYC workspace, never here. They answer in plain text plus `structuredContent` matching a declared `outputSchema`.

All tool inputs are strict: an unknown parameter is rejected by name, never silently dropped (same rule as `nyc-311-mcp`).

**How `search_datasets` answers.** One call gives the whole answer. `total_matches` counts every dataset that matches, with no cap. If they all fit in the reply (10 rows by default, up to 50), the reply lists them. If they don't, the reply does three things at once: it counts every match by portal (`auto_grouped: true`, with each portal's top titles), it lists the best-ranked rows that fit, and it writes every match to a CSV file on your computer (`export.path`, plus an MCP `resource_link`). So "which portals have tax lot data?" comes back complete in one call, and the CSV holds the full list for a spreadsheet. `group_by` summarizes by entity, county or platform family instead of portal. Replies stay under about 20 KB so they fit in an AI client's tool-result limit. Each reply also lists the registry portals the index does not search (no portal, not harvested, or a failed harvest), so an empty result is not read as "no such data".

**`registry_id`: joining a data site to its government.** Each registry row can carry a `registry_id`, the id of its government body in [BetaNYC/ny-gov-web-registry](https://github.com/BetaNYC/ny-gov-web-registry) (`data/registry.json`). Use it to join a data site to that registry's record of the government. Several data sites can share one id (a city's main portal and its GIS site, say). Not every row has one yet; ids are copied from the registry and never made up.

- Source rows from `find_sources`, `list_sources_for_place`, `how_to_query` and `check_source` always include `registry_id`, `null` when the row has none.
- Dataset rows carry their portal's id. `search_datasets` compact rows, its portal groups and coverage list, and `find_joinable`'s `by_portal` include it only when there is one, to keep replies small. Full rows (`detail: "full"`), `get_dataset_columns`, `find_joinable`'s `dataset` and the CSV always include it (an empty cell when there is none).
- To start from a government: `how_to_query` and `check_source` accept `registry_id` (when several sources share it, the reply lists them), and `portal` in `search_datasets` and `whats_new` accepts it to mean every data site of that government. `registry_info` counts the rows that carry one.
- Dataset rows read the id from the registry when they answer, not from the index, so ids added to the registry show up without a new harvest.

**The CSV files.** One row per matching dataset, best-ranked first: id, name, portal, portal id, `registry_id`, type, update date, link, formats, API endpoint, Socrata domain and 4x4, platform, counties, geometry type and column count. Standard CSV (RFC 4180), UTF-8, values as the portal published them, with one safety exception: a text value that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'`, so a spreadsheet shows it as text instead of running it as a formula. Numbers are never changed. They go in `${HOME}/.cache/betanyc/ny-data-registry/exports/` (change with `NY_DATA_EXPORT_DIR`). The newest 50 are kept, none older than 7 days; nothing else in that folder is touched. `export: "never"` turns the file off and `export: "always"` writes one even for a short answer. `offset` still pages by hand for clients that need it, but nothing depends on it.

---

## Questions to try

Ask your AI assistant these once the server is connected. Where we ran a question on 2026-11-05, what it found is noted. Portals change, so your results may differ.

**Which datasets match my words?** (`search_datasets`)

- "Which New York cities publish housing code violation data? Search for 'housing code violations' and 'code enforcement', and list the results by city." Finds New York City (HPD violations, NYCHA violations, tenant complaints, DOB violations), Buffalo (code violations) and Syracuse (code violations, unfit properties, rental registry).
- "Do any New York cities publish zoning data? If so, what formats do they publish them in?" Finds New York City, Buffalo, Rochester, Glens Falls and Cortland, plus zoning layers on the Westchester, Albany, Dutchess, Tioga, Wayne, Oswego and Warren county portals.
- "Find flood zones, as GeoJSON." Finds the statewide FEMA flood hazard layer, plus Buffalo and Cortland County.
- "Find restaurant inspection data." Top hit: NYC's DOHMH restaurant inspection results.
- "Where are the farmers markets?" Finds the statewide list on data.ny.gov and Albany County's.
- "Find EV charging stations, as a CSV file." Finds two NYC charging datasets and the statewide alternative fuel stations list.
- "Housing code violations in Syracuse." / "Bike lanes in Buffalo." / "Street trees in Buffalo." Narrow a search to one place.
- "Where are the polling places?" Finds Suffolk and Tompkins counties.
- "Crash data updated since 2026-10-01." Use a date to see only datasets that changed recently.

**Who has data, and for where?** (`find_sources`, `list_sources_for_place`)

- "Which New York portals have health data?"
- "Which state agencies have a real API?" / "Which portals need an API key?"
- "What open data does Erie County have?" Erie County was checked and has no portal; the answer says so.
- "What can I get for Syracuse?" / "What covers Queens, or the North Country?"

**How do I use it?** (`how_to_query`, `get_dataset_columns`, `find_joinable`)

- "How do I pull data from the NYS Department of Health portal?"
- "Does Westchester County publish zoning data, and what columns does it have?"
- "What columns does Buffalo's code violations dataset have?"
- "What other datasets can I join to NYC's housing violations by BBL?"

**Is it current?** (`whats_new`, `check_source`, `registry_info`)

- "What datasets were added or changed since October 1?"
- "Is Albany's data portal still working?"
- "How many sources do you track, and when was the list last updated?"

**Tips**

- **Try more than one wording.** Cities name the same thing differently: "code enforcement" finds datasets that "housing code violations" misses.
- **New York City crowds the results.** NYC's matches tend to fill the top of the list. To see the rest of the state, name a place or ask a second time for results outside New York City.
- **Add a date to skip old data.** "School enrollment" alone returns NYC tables from 2010–2011; add a date, such as "updated since 2025-01-01", to skip them.
- **Ask which portals have something.** "Which portals have tax parcel data?" groups every match by portal in one answer, with a count for each.
- **An empty result can still have data elsewhere.** The index covers Socrata and ArcGIS portals only. A city may publish on a site this server does not search.
- **Some maps are not official.** The Westchester and Tioga county zoning layers say they are not the legal boundaries. Check the town's own map before relying on one.
- **It finds the data; another tool fetches it.** Hand a Socrata dataset to the [`socrata`](https://www.npmjs.com/package/socrata-mcp-server) MCP. For an ArcGIS layer, open or download it from the portal.

---

## Install

Requires **Node 22.16 or later** (it uses Node's built-in `node:sqlite`, so there is nothing native to compile; 22.16 is the first official Node whose SQLite includes FTS5 full-text search).

Add it to your MCP client's config (Claude Desktop, Claude Code, Cursor, VS Code and others use this shape):

```json
"ny-data-registry-mcp": {
  "command": "npx",
  "args": ["-y", "@betanyc/ny-data-registry-mcp"]
}
```

That's all. **The first time it starts, it downloads the dataset index by itself** (about 19 MB, unzipped to about 110 MB). This takes a few seconds on a normal connection. The five registry tools work right away. If you ask a dataset question while the download is still running, the tool waits up to 45 seconds and then says "try again in a minute".

From source instead:

```bash
git clone https://github.com/BetaNYC/ny-data-registry-mcp && cd ny-data-registry-mcp
npm install            # also builds
npm test               # offline; no network
```

and point your client at `node /path/to/ny-data-registry-mcp/dist/index.js`.

### The dataset index

The four index tools (`search_datasets`, `get_dataset_columns`, `find_joinable`, `whats_new`) read a prebuilt SQLite index. It holds **metadata only**: titles, descriptions, column names and types, formats and links. No dataset contents.

- **Where it comes from:** the `index-latest` release, at a fixed URL: `https://github.com/BetaNYC/ny-data-registry-mcp/releases/download/index-latest/ny-data-index.sqlite.gz`. Dated snapshots are kept as `index-YYYY-MM-DD` releases.
- **Checked before use:** the server checks both SHA-256 sums in the release's `SHA256SUMS` file (the `.gz` and the unzipped `.sqlite`) and the schema version. A file that fails any check is never installed.
- **Where it goes:** `${HOME}/.cache/betanyc/ny-data-registry/ny-data-index.sqlite` (change with `NY_DATA_INDEX`).
- **When:** only when the file is missing. An existing index is never replaced on its own.
- **Get or refresh it by hand:**

  ```bash
  npx -y -p @betanyc/ny-data-registry-mcp ny-data-registry download          # if missing
  npx -y -p @betanyc/ny-data-registry-mcp ny-data-registry download --force  # replace with the newest
  ```

- **Turn the download off:** set `NY_DATA_INDEX_AUTO_DOWNLOAD=0`. Then the dataset tools reply with these steps instead. Or build your own index with `ny-data-registry harvest` (see "Refresh").

### Environment variables (all optional)

| Variable | Default | Purpose |
|---|---|---|
| `NY_DATA_INDEX` | `${HOME}/.cache/betanyc/ny-data-registry/ny-data-index.sqlite` | Where the index lives |
| `NY_DATA_INDEX_AUTO_DOWNLOAD` | on | `0` = never download the index on first run |
| `NY_DATA_INDEX_URL` | the `index-latest` release | Download the index from somewhere else (it must have a `SHA256SUMS` beside it) |
| `NY_DATA_CACHE_DIR` | `${HOME}/.cache/betanyc/ny-data-registry` | Registry refresh cache and HTTP cache |
| `NY_DATA_REGISTRY_REFRESH` | on | `0` = never fetch the published registry; use the bundled copy |
| `NY_DATA_OFFLINE` | off | `1` = refuse every network call, including the first-run download (tests use this) |
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
- **Index**: re-run `node dist/cli.js harvest`. `.github/workflows/harvest.yml` is written to do this nightly in GitHub Actions and publish the SQLite file as a release asset, but it is **not enabled** (schedule commented out). Index releases are published by hand for now; the first is [`index-2026-11-05`](https://github.com/BetaNYC/ny-data-registry-mcp/releases/tag/index-2026-11-05).

---

## How it was checked

- `npm test`: offline tests from recorded fixtures (`test/fixtures/`, each says which request produced it), including a stdio smoke test that starts the server and calls all eleven tools.
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

## Releases

A tag `vX.Y.Z` runs `.github/workflows/release.yml`: tests, a check that `server.json` matches `package.json`, a check that `WHATS-CHANGED.md` has no `Unreleased` entry, `npm publish`, and a GitHub Release. `publish-mcp.yml` then lists the version in the MCP Registry.

The pull request that bumps the version changes it in `package.json`, both `version` fields in `package-lock.json`, both in `server.json`, `VERSION` in `src/paths.ts`, and "Status" at the top of this README. When the release changes what the server returns or which tools it has, the same pull request adds a `CHANGELOG.md` section headed `## [X.Y.Z] — Unreleased` and a `WHATS-CHANGED.md` entry headed `## Unreleased: Title`, in plain words, tagged `MCP`, with `- **MCP version:** [ny-data-registry-mcp X.Y.Z](CHANGELOG.md)` (no anchor yet). A fix for a wrong answer is also tagged `Correction` and says what to re-check under "If you used the old numbers".

On release day, one commit, which the tag then goes on:

1. `## Unreleased: Title` becomes `## YYYY-MM-DD: Title`, same title, with the New York date of the day the tag lands (`TZ=America/New_York date +%F`). `check` rejects a future date. Once the entry is on `main`, its title never changes, dated or not; CI rejects it.
2. The `CHANGELOG.md` heading gets the same date: `## [X.Y.Z] — YYYY-MM-DD`.
3. The entry's MCP version link gains that heading's anchor. Compute it, never write it by hand: `python3 -c "import sys; sys.path.insert(0,'scripts'); import whats_changed as w; print(w.github_slug('[X.Y.Z] — YYYY-MM-DD'))"`.
4. `python3 scripts/whats_changed.py check WHATS-CHANGED.md --release` passes.

Never rewrite an older entry in `WHATS-CHANGED.md`; add a dated `- **Update YYYY-MM-DD:**` line to it. CI enforces this. `scripts/whats_changed.py` and `src/betanyc-tools.ts` are copies of files in the BetaNYC workspace; never edit them here. A release that changes only metadata gets no entry; its commit carries a `No-whats-changed: <reason>` trailer.

## Terms of use

Read before any adapter was written; details and quotes in [`docs/terms.md`](docs/terms.md).

- **Socrata / Tyler**: the Discovery API's stated purpose is "automated searching, research, and exploration"; read-only access needs no authentication; an app token is recommended. Per-portal terms pages were not found (not verified).
- **Esri**: ArcGIS Online public content is for personal or noncommercial use under each item's own terms, and owners who share publicly grant end users permission to use and reproduce it. The Master Agreement's "may not scrape, download, or store Data" clause defines Data as Esri's own commercial datasets, which are excluded here. Hub robots.txt asks for a 60 s crawl delay, which is honored.

## Related

- Scout field mapping: [`docs/scout-mapping.md`](docs/scout-mapping.md)
- Proposed upstream registry change (`platform_family`): [`docs/upstream/`](docs/upstream/)

## License

MIT
