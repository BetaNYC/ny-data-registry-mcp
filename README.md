# ny-data-registry-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that finds open data across every New York data portal in BetaNYC's [NY data portal registry](https://betanyc.github.io/grounding-ai-with-ny-open-data/resources/ny-data-portal-registry.html): which portal covers a place or topic, how to query it, and, with the harvested index, which datasets and columns exist and in what formats.

It complements the [`socrata`](https://www.npmjs.com/package/socrata-mcp-server) MCP rather than replacing it. This server knows *where* data is (224 sources across state, county, city, agency, library and nonprofit portals) and hands the agent the right Socrata domain or ArcGIS service. Querying the data stays with `socrata` and the other BetaNYC MCPs.

Built by [BetaNYC](https://beta.nyc). **Status: 0.3.0.** Package: `@betanyc/ny-data-registry-mcp`.

What changed in this server, newest first, including corrections: [WHATS-CHANGED.md](WHATS-CHANGED.md).

---

## What it does

Thirteen tools, in three groups.

**Registry tools** (work out of the box, no index needed):

| Tool | What it answers |
|---|---|
| `find_sources` | Which portals cover this topic or place? Filters: place, tier, platform family, has API, key required, status (default `live`) |
| `list_sources_for_place` | Everything for one county, city, NYC borough or region. Says whether the place **has a portal**, was **checked and has none**, or is **not in the registry** (unchecked, not absent). Up to 25 rows per list by default (`limit`, up to 100), with full `counts` |
| `how_to_query` | Endpoint (verbatim from the registry, never guessed), API type, key and env var, example request, and which MCP to hand off to. Flags UNCONFIRMED, undocumented, gated, dead and no-portal rows. When several rows match, lists 25 by default (`limit`, up to 100, and `offset`), with `total` and `showing` |
| `check_source` | Exactly one live request (no retry) to a registry row's portal URL: status, redirect (reported, not followed), response time, and whether that matches the registry. A `url` you give is only matched to a row by host, never fetched itself; when several rows share the host, the best match is checked and `url_matches` says how many there were |
| `registry_info` | Row counts, registry date and origin, unmapped platform strings, index size and last harvest |

**Index tools** (need the harvested SQLite index):

| Tool | What it answers |
|---|---|
| `search_datasets` | Dataset titles, descriptions, tags and **column names** across Socrata and ArcGIS portals. Filters: topic, place, portal, platform family, format (csv, geojson, shapefile, kml, api, xlsx …), updated since. One call gives the whole answer: the true number of matches, a count per portal when they don't all fit, the best rows, and a CSV file with every match. `group_by` summarizes by entity, county or platform family instead |
| `list_topics` | The 24 shared topics, with how many datasets and portals each has, and the share of datasets with a topic. Filter: portal |
| `get_dataset_columns` | Fields and types (100 columns by default; `limit` up to 500 and `offset` page through the rest), every distribution (format + URL), license, publisher, extent, and per-field provenance. With `standard`, the dataset's description as Croissant or DCAT-US instead |
| `find_joinable` | Datasets sharing a join key (BBL, BIN, borough, community district, council district, census tract, SWIS, FIPS, ZIP), from a curated key-column map, not raw name equality |
| `whats_new` | Datasets added, changed or removed since a date |

**About this server** (the three tools BetaNYC is adding to each of its MCP servers; no index needed):

| Tool | What it answers |
|---|---|
| `whats_changed` | What changed in **this server**, newest first, from [WHATS-CHANGED.md](WHATS-CHANGED.md): new tools, fixes and corrections. Filters: since, tag (Site, Data, MCP, Correction), limit. For datasets that are new on the portals, use `whats_new` |
| `about_betanyc` | Who built the server, its version, where to report a bug in this server or ask for a new feature, and BetaNYC's links |
| `about_data` | Where each kind of data comes from, from [DATA-SOURCES.json](DATA-SOURCES.json): the source, its publisher and a link, whether it is an official record, what BetaNYC changed, how current it is on this server, terms of use, and where to report an error. Ask for one topic or one tool's sources |

These three come from `src/betanyc-tools.ts`, a copy of a file BetaNYC is adding to each of its MCP servers: change it in the BetaNYC workspace, never here. They answer in plain text plus `structuredContent` matching a declared `outputSchema`.

All tool inputs are strict: an unknown parameter is rejected by name, never silently dropped (same rule as `nyc-311-mcp`).

**Every answer names its source.** Each answer from the ten registry and index tools carries a `data_source` block: the source and its publisher (the same names as in [DATA-SOURCES.json](DATA-SOURCES.json)), a link a person can open, `as_of` with `as_of_kind`, and `cite`, the same as one plain line to quote. Registry tools cite the NY Data Portal Registry as of its `generated` date; index tools cite the NY Data Registry index as of its last harvest; `get_dataset_columns` cites the dataset's own portal and page as of the harvest that last saw it; `check_source` cites the portal it reached, as of that request (`as_of_kind: "retrieved"`, with `retrieved_at`), and the registry row when it was not checked, was blocked or got no answer.

**Every list is bounded.** Each list has a default size and a maximum in its schema, and the answer says when it was cut and how to get the rest (`showing`, or `columns_shown` for columns). `search_datasets` gives the whole answer in one call (below).

When a tool cannot answer, it says so as an MCP error (`isError: true`) with one plain sentence saying what went wrong and what to try: an unknown dataset, source or place, a bad date, an unknown parameter. No stack traces, upstream bodies cut to 500 characters, and no key from the environment is ever repeated. A portal that does not answer `check_source` is not such a failure: that is the check's finding, so it comes back as a normal answer with its verdict, `matches_registry` and the reason in `request_error`.

Every tool tells the client it only reads (MCP tool annotations: `readOnlyHint: true` and a `title`). `openWorldHint` is `true` only for `check_source`, which makes one live request to a portal; the others answer from the registry and the downloaded index. A test caps the size of the tool list plus the server instructions (`test/tool-size.test.mjs`), since the model reads both on every turn.

**How `search_datasets` answers.** One call gives the whole answer. `total_matches` counts every dataset that matches, with no cap. If they all fit in the reply (10 rows by default, up to 50), the reply lists them. If they don't, the reply does three things at once: it counts every match by portal (`auto_grouped: true`, with each portal's top titles), it lists the best-ranked rows that fit, and it writes every match to a CSV file on your computer (`export.path`, plus an MCP `resource_link`). So "which portals have tax lot data?" comes back complete in one call, and the CSV holds the full list for a spreadsheet. `group_by` summarizes by entity, county or platform family instead of portal. Replies stay under about 20 KB so they fit in an AI client's tool-result limit. Each reply also lists the registry portals the index does not search (no portal, not harvested, or a failed harvest), so an empty result is not read as "no such data".

**`registry_id`: joining a data site to its government.** Each registry row can carry a `registry_id`, the id of its government body in [BetaNYC/ny-gov-web-registry](https://github.com/BetaNYC/ny-gov-web-registry) (`data/registry.json`). Use it to join a data site to that registry's record of the government. Several data sites can share one id (a city's main portal and its GIS site, say). Not every row has one yet; ids are copied from the registry and never made up.

- Source rows from `find_sources`, `list_sources_for_place`, `how_to_query` and `check_source` always include `registry_id`, `null` when the row has none.
- Dataset rows carry their portal's id. `search_datasets` compact rows, its portal groups and coverage list, and `find_joinable`'s `by_portal` include it only when there is one, to keep replies small. Full rows (`detail: "full"`), `get_dataset_columns`, `find_joinable`'s `dataset` and the CSV always include it (an empty cell when there is none).
- To start from a government: `how_to_query` and `check_source` accept `registry_id` (when several sources share it, the reply lists them), and `portal` in `search_datasets` and `whats_new` accepts it to mean every data site of that government. `registry_info` counts the rows that carry one.
- Dataset rows read the id from the registry when they answer, not from the index, so ids added to the registry show up without a new harvest.

**`runs_it`: who runs this data site.** Source rows from `find_sources`, `list_sources_for_place`, `how_to_query` and `check_source` also carry `runs_it`: the government body that runs the site, looked up by `registry_id` in the master list of government bodies ([BetaNYC/ny-gov-web-registry](https://github.com/BetaNYC/ny-gov-web-registry) `data/registry.json`). It gives the body's `name`, `government_level` (state, city, county, authority…), `classification` and `website` (its current primary domain, as the list writes it, such as `mta.info`). `short_name` appears when the list has one, and `status` when the body is not active.

- No `registry_id` means `runs_it: null`. Nothing is guessed from names.
- An id the master list does not have yet gives `runs_it: { "found": false, "note": … }`.
- Each reply has one `runs_it_source` block: which list, which copy (`fresh`, `cache` or `bundled`) and how current it is. `registry_info` adds a `master_list` block that lists the row ids the loaded list lacks.

**The CSV files.** One row per matching dataset, best-ranked first: id, name, portal, portal id, `registry_id`, type, update date, link, formats, API endpoint, Socrata domain and 4x4, platform, counties, geometry type and column count. Standard CSV (RFC 4180), UTF-8, values as the portal published them, with one safety exception: a text value that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'`, so a spreadsheet shows it as text instead of running it as a formula. Numbers are never changed. They go in `${HOME}/.cache/betanyc/ny-data-registry/exports/` (change with `NY_DATA_EXPORT_DIR`). The newest 50 are kept, none older than 7 days; nothing else in that folder is touched. `export: "never"` turns the file off and `export: "always"` writes one even for a short answer. `offset` still pages by hand for clients that need it, but nothing depends on it.

**Topics.** Every dataset gets topics from one shared list of 24, such as Housing and homelessness, Transportation or Elections and civic participation. A dataset can have several. They come from the dataset's own categories, tags and department, so the same topic finds the same kind of data on every portal, whatever each portal calls it. Pass `topic` to `search_datasets`, alone or with a query; a topic alone lists that topic, most-viewed first. Rows carry their topic ids. `list_topics` gives the list with counts. On the 2026-11-05 index, 8,910 of 9,569 datasets (93.1%) get at least one topic; the rest carry no label that fits the list, and text search still finds them. Each published index comes with `topic-crosswalk.csv`: every label on every portal, and the topics it gives. How it works and how to change it: [docs/topics.md](docs/topics.md).

**Standard metadata.** `get_dataset_columns` with `standard: "croissant"` returns one dataset's description as [Croissant 1.1](https://docs.mlcommons.org/croissant/docs/croissant-spec.html), read by AI and ML tools. `standard: "dcat-us"` returns it as [DCAT-US 3.0](https://resources.data.gov/resources/dcat-us3/), read by government catalogs and data.gov. Each published index also comes with two statewide files: `ny-data-dcat-us.json.gz` (one DCAT-US catalog with every dataset, about 3 MB) and `ny-data-croissant.jsonl.gz` (one Croissant document per line, about 3 MB). `ny-data-registry standards` builds them from your installed index. Metadata only, as everywhere here. **Licenses are never inferred.** About 72% of datasets get no license from their portal. Where there is none, the reply links the portal's terms-of-use page if we have one, labeled "terms page, not a license". The registry has no terms-of-use field yet, so these come from links a portal put in a dataset's own license text, or from [data/terms-pages.json](data/terms-pages.json), which lists a portal only after someone has opened its page (10 of the 35 portals harvested have one, checked 2026-11-14). Other text a portal puts in its license field, such as a disclaimer, is kept word for word as a rights statement, not as a license. Fields the standards require that portals do not give are left out and listed in `missing`: DCAT-US's contact email always, and a description for about 13% of datasets. Field mapping and validation: [docs/standard-metadata-plan.md](docs/standard-metadata-plan.md).

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
- "List election data in Tompkins County." / "Which housing datasets does Buffalo have?" A topic finds data whatever words a portal uses for it. (`list_topics` shows all 24.)

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

The five index tools (`search_datasets`, `list_topics`, `get_dataset_columns`, `find_joinable`, `whats_new`) read a prebuilt SQLite index. It holds **metadata only**: titles, descriptions, column names and types, formats and links. No dataset contents.

- **Where it comes from:** the `index-latest` release, at a fixed URL: `https://github.com/BetaNYC/ny-data-registry-mcp/releases/download/index-latest/ny-data-index.sqlite.gz`. It is rebuilt every night (see "The nightly harvest"). Dated snapshots are kept as `index-YYYY-MM-DD` releases: the last 14, plus the first of each month for good. Each release also carries `index.json`, which describes the files (schema version, harvest time, sizes, both SHA-256 sums, dataset and portal counts, and the quality-gate result).
- **Checked before use:** the server checks both SHA-256 sums in the release's `SHA256SUMS` file (the `.gz` and the unzipped `.sqlite`) and the schema version. A file that fails any check is never installed.
- **Where it goes:** `${HOME}/.cache/betanyc/ny-data-registry/ny-data-index.sqlite` (change with `NY_DATA_INDEX`).
- **When:** on first run when the file is missing, then whenever it is more than **5 days** old and a newer one is published, and at once if the published index was rolled back past yours (see "Keeping the index current").
- **Get or refresh it by hand:**

  ```bash
  npx -y -p @betanyc/ny-data-registry-mcp ny-data-registry update            # install, or update if a newer one is published
  npx -y -p @betanyc/ny-data-registry-mcp ny-data-registry update --check    # only say whether a newer one is published
  npx -y -p @betanyc/ny-data-registry-mcp ny-data-registry download --force  # replace it with the published one, no questions
  ```

- **Turn the download off:** set `NY_DATA_INDEX_AUTO_DOWNLOAD=0`. Then the dataset tools reply with these steps instead. Or build your own index with `ny-data-registry harvest` (see "Refresh").

### Keeping the index current

A running server checks for a newer index 5 minutes after it starts and then once a day. It never makes you wait: the check runs in the background, and a question asked during a download is answered from the index you have.

1. **Is it due?** If your index is less than 5 days old (`NY_DATA_INDEX_REFRESH_DAYS`), the server reads only `index.json`, to see whether the index was rolled back (below). Nothing else is fetched.
2. **Is there a newer one?** The server reads `index.json`, the small file published beside each index (under 1 KB). It does nothing when that is the file you have, when yours is as new or newer (an index you built yourself, say), or when the published index needs a newer version of this package. In that last case it says so and keeps your index.
3. **Download and check.** The new index is saved beside the old one as `ny-data-index.sqlite.part`, and both SHA-256 sums in `index.json` (the `.gz` and the unzipped file) and the schema version are checked. A file that fails any check is deleted. Your index is not touched until the new one passes.
4. **Swap.** The checked file is renamed over the old one, and the server reopens it. `ny-data-index.sqlite.source.json` records what was installed, from where, and its SHA-256. If the old index was in WAL mode, its empty `-wal` and `-shm` files are removed; a `-wal` with data in it is kept and reported.
5. **On Windows**, a file that another program has open cannot be replaced. Then the checked file waits as `ny-data-index.sqlite.next`, and it is installed the next time the index is opened with nothing holding it (usually the next start). `registry_info` says `ready-on-restart`.

**If the index was rolled back.** When a published index turns out bad, BetaNYC can point `index-latest` back at an older snapshot (see "Roll back a bad index"). Its `index.json` then says `rolled_back`, with the snapshot it went back to and why. At its next check, a server whose index is newer than that snapshot replaces it with the snapshot, even if its index is less than 5 days old. A server already on that snapshot, or on an older one, does nothing special. `update --check` reports a rollback (exit 4) and `update` makes the swap (exit 0). On Windows the swap can wait as `.next`, like any update. `registry_info.index_status.rolled_back` shows the rollback, and an `index_note` about an old index also says the index was rolled back, and why.

If anything fails, the server keeps the index it has and tries again at the next check. `registry_info` shows `index_status`: the index's age, whether automatic updates are on (and if not, which setting turned them off), and what the last check found. When your index is more than **14 days** old, every `search_datasets` reply carries an `index_note` saying so, with the `update` command.

**Turn automatic updates off** with `NY_DATA_INDEX_AUTO_UPDATE=0`. They are also off when you set `NY_DATA_INDEX` (the index is then a file you manage), when `NY_DATA_INDEX_URL` names a dated snapshot (`.../download/index-YYYY-MM-DD/...`, a pin), when `NY_DATA_INDEX_AUTO_DOWNLOAD=0`, and in offline mode. The `update` command still works in all of these but offline mode.

**`update` exit codes:** 0 already current, updated, rolled back, or yours was left alone because it is as new as the published one; 1 failed (nothing changed), or another process is downloading; 2 usage error; 3 the published index needs a newer version of this package; 4 (`--check`) a newer index is published, or the index was rolled back; 5 downloaded and checked, but the index is in use (Windows), so it is installed when nothing holds it.

### Environment variables (all optional)

| Variable | Default | Purpose |
|---|---|---|
| `NY_DATA_INDEX` | `${HOME}/.cache/betanyc/ny-data-registry/ny-data-index.sqlite` | Where the index lives. Setting it turns automatic updates off |
| `NY_DATA_INDEX_AUTO_DOWNLOAD` | on | `0` = never download the index on first run |
| `NY_DATA_INDEX_URL` | the `index-latest` release | Download the index from somewhere else (it must have `index.json` or `SHA256SUMS` beside it). A dated snapshot URL pins the index and turns automatic updates off |
| `NY_DATA_INDEX_AUTO_UPDATE` | on | `0` = never replace an installed index on its own (`update` still can) |
| `NY_DATA_INDEX_REFRESH_DAYS` | 5 | Automatic updates download only when the installed index is at least this many days old |
| `NY_DATA_INDEX_STALE_DAYS` | 14 | Past this age, `search_datasets` replies carry an `index_note` |
| `NY_DATA_INDEX_CHECK_HOURS` | 24 | How often a running server checks (at least 1) |
| `NY_DATA_INDEX_CHECK_DELAY_SECONDS` | 300 | When a server makes its first check after starting |
| `NY_DATA_CACHE_DIR` | `${HOME}/.cache/betanyc/ny-data-registry` | Registry refresh cache and HTTP cache |
| `NY_DATA_REGISTRY_REFRESH` | on | `0` = never fetch the published registry or the master list of government bodies; use the bundled copies |
| `NY_DATA_OFFLINE` | off | `1` = refuse every network call, including the first-run download and update checks (tests use this) |
| `NY_DATA_MAX_LAYERS` | 250 | Per-portal cap on ArcGIS field requests per harvest |
| `NY_DATA_MIN_INTERVAL_MS` | 1000 | Minimum gap between requests to one host (cannot be set below 1000; Socrata hosts always get at least 2000) |
| `SOCRATA_APP_TOKEN` | none | Sent as `X-App-Token` to the Socrata Discovery API |

---

## Data sources

- **The registry.** `BetaNYC/grounding-ai-with-ny-open-data` `resources/ny-data-portal-registry.json` (224 rows, 2026-11-13). A copy is bundled in `data/`. On startup the server makes a conditional request (ETag) for the published copy on GitHub Pages, caches it under `${HOME}/.cache/betanyc/`, and falls back to the bundled copy on any failure. This server never edits the registry.
- **The master list of government bodies.** `BetaNYC/ny-gov-web-registry` `data/registry.json`, read from `raw.githubusercontent.com` on the `main` branch. It answers `runs_it`. The server fetches it the same way as the registry (a conditional request with the ETag, side by side with the registry refresh), keeps only the few fields a reply uses in `${HOME}/.cache/betanyc/ny-data-registry/gov-bodies.json`, and falls back to that cache, then to `data/gov-bodies.json`. The bundled copy holds only the bodies the bundled registry's rows point to (154 today, of 2,151 on the list), not the whole list. Rebuild it with `npm run build && node scripts/bundle_gov_bodies.mjs` (`--from <file>` to use a local copy). This server never edits the master list.
- **Human-editable tables** in `data/`:
  - `platform-families.json`: maps each of the registry's **156** free-text `platform` strings to one family (`socrata`, `arcgis-hub`, `arcgis-enterprise`, `arcgis-server`, `ckan`, `geoblacklight`, `custom-api`, `none`). A string not in the table is reported as *unmapped*, never guessed; 4 strings are deliberately `null` because the registry cannot say how the data is reached.
  - `ny-places.json`: 62 counties, 62 cities, 5 boroughs, 8 regions.
  - `key-columns.json`: the curated join keys.
  - `handoffs.json`: which BetaNYC MCP serves which registry row.
  - `harvest-config.json`: skips (ANHD, Rockland, Columbia GeoBlacklight), caps, one on/off switch per adapter, the "no portal" rows let through (`allow_no_portal`), and the settings for the ArcGIS Server, GeoBlacklight and InvenioRDM adapters.
  - `hand-kept.json`: what rows with no data link offer (see "Hand-kept list").
  - `parcel-sources.json`: the State's parcel layer, read once, its per-county links, and the hand-reviewed registry parcel layers (see "Tax parcel coverage").
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
| ArcGIS Server REST directory (the State's GIS servers, DOT, DEC, Broome, Ulster) | `<root>/rest/services?f=json`, then each folder and each `MapServer`, `FeatureServer` or `ImageServer` `?f=json`; one dataset per service | each layer `?f=json` (up to 5 per service) |

| GeoBlacklight (Cornell's CUGIR) | the institution's [OpenGeoMetadata](https://opengeometadata.org/) repository, downloaded as one archive through the GitHub API (`/repos/{owner}/{repo}/tarball/{ref}`); GeoBlacklight 1.0 and Aardvark records; the GeoBlacklight site itself is never called | none (links to downloads, WMS and WFS are kept as formats) |
| InvenioRDM (NYU's UltraViolet, Spatial Data Repository community) | `/api/communities/{id}/records`, oldest first, 25 per page. **Switched off** until a supervised run checks the New York filter | none |
| Hand-kept list (rows with no data link) | `data/hand-kept.json`, edited by hand; no network call | none |

Everything else (custom APIs, CKAN, pages with no API and no hand-kept entry) is described by the registry tools but not harvested. `coverage` lists each row and why. CKAN has no adapter by decision: the registry's CKAN rows are data.gov's copies of catalogs read here at the source, plus one Stony Brook site whose robots.txt disallows its API ([`docs/ckan-comparison.md`](docs/ckan-comparison.md)).

**Guards**
- **Esri's own content is excluded** (owner `esri…`, org `P3ePLMYs2RVChkJx`). For Enterprise portals and ArcGIS Online orgs, items from another org are not counted under that portal; this is what turns Monroe's 108 search hits into its own content. Hub sites are *not* filtered by org, because a Hub's catalog is curated by its owner and aggregators like the State GIS Clearinghouse deliberately list other agencies' layers.
- **Out-of-state guard**: an item whose extent lies wholly outside New York is dropped; a portal whose items are mostly outside New York is refused and purged. Placeholder extents (`[0,0,0,0]`) and projected coordinates (State Plane) count as *unknown*, never as outside.
- **Stable paging**: Hub pages are requested sorted by `id`. A listing that comes back with fewer unique items than the portal's own total is treated as incomplete, so nothing is marked removed from a shaky listing.
- **Politeness**: one descriptive User-Agent with no email address; at least 1 s between requests to a host, and at least 2 s to Socrata (`api.us.socrata.com`), with `X-App-Token` sent when `SOCRATA_APP_TOKEN` is set; robots.txt Disallow **and Crawl-delay** honored (every Hub site asks for 60 s, so Hub listing is slow on purpose); conditional requests by ETag; up to two retries on 429 or a 5xx (500, 502, 503, 504), honoring `Retry-After` (otherwise 5 s, then 10 s; never more than 60 s), and a 429 doubles that host's gap for the rest of the run; a 60 s timeout per request (some state GIS portals take longer than 30 s for one catalog page); a per-portal cap on layer requests. A bot block is reported, never worked around. Keys go only in headers (`X-App-Token`, `Authorization`), and error text never repeats a header's value, even when a server echoes it back, because harvest errors are posted in public issues.
- **The server's own requests to GitHub** (the registry and government-bodies refreshes, the index manifest and the index download) send the same User-Agent, have a timeout (5 s for the two refreshes, 20 s for the manifest, 10 minutes for the ~19 MB download) and retry 429 or a 5xx the same way, but only when the wait ends inside that timeout.
- **Weekly for county servers**: self-hosted county ArcGIS Enterprise portals (Livingston, Monroe, Orange, Wayne, Yates, Mount Vernon) and ArcGIS Server REST directories are read once a week, not every night; their datasets stay in the index in between. `cadence` in `data/harvest-config.json` sets this; `harvest --ignore-cadence` reads everything.
- **Gentle on REST directories** (`arcgis_server` in `data/harvest-config.json`): at most 400 requests per host per read, listing and layers included; 2 s between them, or the robots.txt Crawl-delay if longer; no new request after 30 minutes; ArcGIS Server's own `Utilities` and `System` folders skipped; a folder or service robots.txt disallows is skipped. A host that hits a cap is marked partial, so nothing is marked removed. A service that answers with an error (secured) is not stored. Titles come from the service's own `documentInfo.Title`, else its name; extents in Web Mercator are converted, other projections are left unknown.
- **Never called**: rows needing a key, ANHD, Rockland County, undocumented endpoints.

The index stores metadata only (titles, descriptions, field names, links). It never downloads data.

**Incremental**: datasets carry `first_seen`, `last_seen` and a content hash. A layer whose `modified` date has not changed keeps its stored columns and is not re-requested. A dataset is marked removed only after a *complete* harvest of its portal.


### Coverage

`node dist/cli.js coverage` reports, for every registry row, whether the harvest reads it and why not. It is offline: it reads the newest registry on the machine (the cached published copy, else the bundled one; `--refresh` fetches it first), `data/harvest-config.json` and the index (`--index path`, default the installed one). It never calls a portal. `--json` gives the full report; `--out file` saves it.

Each row gets one state: `harvested`, `read-empty` (read, nothing kept), `failing` (failed, blocked or refused last time), `not-yet-read` (an adapter would read it, the index has no read yet), or `not-harvested`. A not-harvested row carries a fixed code:

| code | meaning |
|---|---|
| `not-live` | the registry says dead or UNCONFIRMED |
| `no-portal` | the registry says no portal |
| `policy` | never called: a key is required, account-gated, blocks automated clients, or excluded in `harvest-config.json` |
| `adapter-off` | its adapter is switched off in `harvest-config.json` |
| `no-adapter` | it has an API, but this build has no adapter for it |
| `described-only` | a custom API the registry describes |
| `no-api` | web pages, viewers or downloads only |
| `unmapped`, `unconfirmed` | the platform string is not in `platform-families.json`, or its family is deliberately null |
| `incomplete-row` | the row lacks the URL or domain an adapter needs |

For a not-harvested row, `documented_endpoint` is the registry's `api_endpoint`, verbatim.

**Adapter switches.** `adapters` in `data/harvest-config.json` holds one `enabled` switch per adapter. Turning one off stops that adapter alone; its portals show as `adapter-off`, and their datasets stay in the index as last read, so the publish gate does not count them as lost.

**"No portal" rows with a data endpoint.** Eight rows the registry marks "no portal" still document a public data endpoint, and are read: the City of Utica and Wyoming County (their ArcGIS Online orgs), the City of Mount Vernon (its ArcGIS Enterprise portal), and the ArcGIS Server REST directories of Greene, Washington, Cayuga, Essex and Chautauqua counties. Each was checked to be New York: Utica's org is "The City of Utica, NY", not the Utica, Minnesota Hub; Wyoming County's org centers on Warsaw, NY, not Wyoming County, Pennsylvania; the five county servers are not the same-named counties in Ohio, Wisconsin, Ontario or Kansas. The five county servers were each read once on 2026-11-14 (`checked_live`). St. Lawrence County is left out: its server is shared by six counties. The list is `allow_no_portal` in `data/harvest-config.json`. Each entry names its adapter and endpoint; if the registry row's endpoint changes, the row is skipped until someone checks it again. Other "no portal" rows with an endpoint show in `coverage` under `no-portal`, with the endpoint.

**GeoBlacklight and InvenioRDM.** Both are read weekly. GeoBlacklight records are kept when public, not suppressed, not listed in the repository's `withdrawn.json`, from the right institution (`provider`), and not wholly outside New York; a repository whose records are mostly outside New York is refused, as with ArcGIS. The repository for each row is set in `geoblacklight.repos_by_source` in `data/harvest-config.json`; in GitHub Actions the run's own token is sent, so the shared runners do not hit GitHub's unauthenticated rate limit. Cornell's OpenGeoMetadata repository was last updated in March 2022, so it may lag CUGIR itself. InvenioRDM records are kept when public and when a location geometry touches New York or, with no geometry, when the title, places or subjects name New York. Locations are optional in InvenioRDM and NYU's repository holds places worldwide, so the `invenio-rdm` adapter starts off. To try it: turn it on in a branch and run `node dist/cli.js harvest --only new-york-university-libraries--ultraviolet-library-nyu-edu --ignore-cadence --stats-out stats.json`, then look at `excluded` and the kept titles.

**Hand-kept list.** Some places have no data link at all: no portal, or only pages, viewers and downloads. `data/hand-kept.json` records what they do offer, one entry per registry row, with each link's kind (`page`, `viewer`, `search`, `download-page`, `dashboard`, `pdf`, `request-form`), where it came from, when it was added, and whether a person has opened it. The harvest adds each link to the index as type `hand-kept <kind>`, with no endpoint and no columns, so search can point to it. An entry is used only while its `source_id` and `entity` both match a registry row, and only while no adapter reads that row. It was seeded on 2026-11-14 with the parcel pages and viewers the State's parcel page lists for 30 counties whose own row has no data link (82 links). Each link was checked once that day (`link_check`: final URL, HTTP status, and ok, redirected, broken or blocked). A broken link stays in the file but is left out of the index; a redirected or blocked one is noted in its description. `checked` stays false until a person opens the link. Edit it in a pull request.

### Tax parcel coverage

`node dist/cli.js parcels` builds a table of all 62 counties. For each it says whether the county shares its tax parcels with the State's public layer, and whether the county (for the five boroughs, New York City) publishes its own parcel layer that the index or the registry knows about. It is offline, like `coverage`, and takes the same options.

- **The State's list** comes from one read of the State's statewide layer, [NYS Tax Parcels Public](https://nysgeohub.ny.gov/arcgis/rest/services/Parcels/NYS_Tax_Parcels_Public/FeatureServer), the endpoint the [NYS GIS Clearinghouse parcels page](https://gis.ny.gov/parcels) documents. It was read once, on 2026-11-14, for its service description only. The response is kept in `docs/parcels/`, and the 38 county names are parsed from it, not typed by hand. `data/parcel-sources.json` records the URL, time, status and ETag.
- **Own layer in the index**: a dataset from the county's own portal whose name says parcel, tax lot, tax map or PLUTO.
- **Own layer in the registry**: a REST layer or download that the county's registry row documents, reviewed by hand, with an exact quote (`registry_parcel_layers`). A viewer, search page or request form does not count.
- **The State page's links** for each county (its parcel page, viewer and extras) are listed too, unchecked.

On 2026-11-14 (registry 2026-11-13, index of 2026-11-05): 38 counties share with the State; 23 have their own parcel layer in the index and 11 more in the registry only; 18 have neither. The table is [`docs/parcels/2026-11-14-parcel-coverage.md`](docs/parcels/2026-11-14-parcel-coverage.md).
---

## Refresh

- **Registry**: picked up on next server start (conditional GET of the Pages copy).
- **Index**: rebuilt every night by `.github/workflows/harvest.yml` (next section). Each server picks up the new one within about 6 days, or at once with `ny-data-registry update` (see "Keeping the index current"). To build your own, run `node dist/cli.js harvest`.

### The nightly harvest

`.github/workflows/harvest.yml` runs at 07:17 UTC every day (02:17 or 03:17 in New York), and by hand from the Actions tab or `gh workflow run harvest.yml`.

1. **Preflight.** It stops at once if the `SOCRATA_APP_TOKEN` secret is missing, if the certificate file below is missing, or if a publishing run was started on a branch other than `main`.
2. **Start from the published index.** It downloads `index-latest` with the same checksum and schema checks every server uses. If that fails, the run fails. It never quietly starts from nothing, which would reset every dataset's `first_seen`. Only the `fresh` input starts empty.
3. **Harvest**, as described above. First, portals whose ids are no longer in the registry are dropped with their datasets, since nothing would ever read them again (portal ids come from registry rows, so a changed row leaves its old id behind). Each drop is listed in the run summary and `index.json`. Nothing is dropped when the registry the run loaded is older than the one the index was built from. Last, every live dataset's topics are rebuilt from its labels, including portals not read that night, so a change to the topic rules reaches the whole index.
4. **Quality gate.** The new index is compared with the published one. Datasets dropped with registry removals are subtracted first (up to 5 portals; more blocks the publish). Publishing is blocked when:
   - the question set (`eval/questions.json`) scores under 90% or finds any invariant violation. The invariants: no source reported live that the registry does not mark live, no dataset from a portal refused as out-of-state or lying wholly outside New York, and no dataset from a row the registry does not mark live. The one exception is a "no portal" row the harvest reads on purpose (`allow_no_portal` with its endpoint still in the row, or a hand-kept entry); the eval asks the harvester's own plan for the row, so the two cannot disagree;
   - the index loses more than 10% of its datasets;
   - more than 3 portals that had data now fail, are blocked, refused or gone;
   - one portal with at least 20 datasets loses more than half of them;
   - the schema version differs from the published index's or the package's;
   - the index is empty.

   **New portals and adapters do not trip the gate.** Every drop check compares only what the published index already had, so growth passes. The first publish after this release adds the REST directories and the three "no portal" rows with no `force_publish` needed. What can still block it: the question set (new datasets can change rankings; it must still score 90%), or a portal that was healthy failing the same night.

   The limits are `publish_gate` in `data/harvest-config.json`. The result goes to `gate.json`, published with every index. When the gate fails, nothing is published and the current index stays. To publish anyway, run the workflow by hand with `force_publish` on and a `force_reason`. The reason, the person who gave it and the failed checks are recorded in `gate.json`, in `index.json` and in the release notes.
5. **Publish.** The published copy uses SQLite's rollback journal, not WAL, so readers do not create `-wal` and `-shm` files beside it. The files are the index, its `SHA256SUMS`, `index.json`, `harvest-stats.json`, `eval.md`, `gate.json`, `topic-crosswalk.csv` and the two statewide standard-metadata files. The run creates a dated snapshot `index-YYYY-MM-DD` titled "(current)" with all files, then updates `index-latest` (the `.gz`, `SHA256SUMS`, the side files, `index.json` last), then relabels older snapshots "(superseded)". Index releases are never marked "Latest"; the code release is.
6. **Retention.** The 14 newest snapshots and the first snapshot of each month are kept. Older dated snapshots and their tags are deleted. `index-latest` and code releases are never touched.
7. **Failures.** A scheduled or publishing run that fails, or whose gate blocks the publish, opens an issue labeled `harvest-failure` (or comments on the open one), with the run link, what failed and the portals that did not come back complete. The next run that publishes closes it. GitHub also emails whoever last changed the schedule line. Every run's summary page shows the portal outcomes and the gate, and its `harvest-run` artifact (kept 14 days) holds the stats, question-set results, gate result, the files built and the log.

Inputs for a run by hand: `publish` (off = dry run; files in the artifact only), `fresh`, `ignore_cadence`, `force_publish` with `force_reason`, `rollback_to` with `rollback_reason`.

**Roll back a bad index.** If a published index turns out bad, run the workflow with `rollback_to`:

```sh
gh workflow run harvest.yml -f rollback_to=index-YYYY-MM-DD -f rollback_reason="why"
```

That run does no harvest. It checks the snapshot, copies its files over `index-latest` (`index.json` last), and adds `rolled_back` to `index.json`: `from` (the bad snapshot), `to`, `reason`, `at`, `by`, and the bad index's harvest time and SHA-256. The bad snapshot is relabeled "(rolled back)" and the target "(current)". No release is deleted. A snapshot made before `topic-crosswalk.csv` or the statewide standard-metadata files existed can still be a target; the newer files are then removed from `index-latest`, last, so they never sit beside an index they do not describe. Add `-f publish=false` to only check.

- **It refuses** a snapshot that does not exist, one that retention is about to delete, one without `index.json` and the other files a nightly publish makes (so not `index-2026-11-05`), one whose schema this package cannot read, one that is not older than `index-latest`, and a missing reason. Nothing changes when it refuses.
- **Servers go back by themselves.** At their next check (within a day for a running server), servers whose index is newer than the target replace it with the target. See "Keeping the index current".
- **The next nightly publish clears it.** That run starts from the rolled-back index, and its `index.json` has no `rolled_back`, so servers move forward as usual. To keep the bad night from coming back, fix the cause first, or **stop the nightly run** with `gh workflow disable harvest.yml`; servers keep the index they have.
- **One machine only?** Pin it to a snapshot with `NY_DATA_INDEX_URL`, or run `ny-data-registry download --force` there.

GitHub turns off scheduled workflows in a public repository after 60 days with no repository activity. A stale `index.json` (`last_harvest` more than a few days old) is the sign.

**Orange County.** Its GIS server sends its own certificate but not the intermediate one that signed it, which Node needs. The harvest step adds that one public Sectigo intermediate with `NODE_EXTRA_CA_CERTS`; certificate checks stay on for every host. Where it came from, how it was checked, and when to remove it: [`certs/README.md`](certs/README.md).

---

## How it was checked

- `npm test`: offline tests from recorded fixtures (`test/fixtures/`, each says which request produced it), including a stdio smoke test that starts the server and calls all thirteen tools.
- `node dist/cli.js eval`: a fixed set of real questions (`eval/questions.json`) scored against the real index. Results: `eval/runs/`. The nightly harvest also runs it as a quality gate before publishing. `test/eval-set.test.mjs` keeps the set well formed (at least 10 questions, each step a real tool with arguments it accepts and one check).
- Other checks in `npm test`: `test/stdout.test.mjs` (in server mode, every stdout line is a JSON-RPC message), `test/tool-size.test.mjs` (the tool list plus instructions stays under its budget, and no sentence repeats across tool descriptions), `test/bundled.test.mjs` (the two bundled copies of other repos' data, `data/gov-bodies.json` and `data/ny-data-portal-registry.json`, name their source and date and match `data/BUNDLED.sha256`).

Latest question-set run: **2026-11-18**, 27 / 27 in the top 3, 0 invariant violations, against the published `index-latest` (last harvest 2026-11-05) and registry 2026-11-13, offline after the download ([eval/runs/2026-11-18-question-set.md](eval/runs/2026-11-18-question-set.md)).

First results (2026-11-05, office-mac), all in `eval/runs/`:

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
- Orange County's server does not send its intermediate TLS certificate. The nightly harvest adds it (`certs/`); a harvest run elsewhere without `NODE_EXTRA_CA_CERTS` set to that file still fails on that portal. Certificate checks are never disabled.
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

Never rewrite an older entry in `WHATS-CHANGED.md`; add a dated `- **Update YYYY-MM-DD:**` line to it. CI enforces this. `scripts/whats_changed.py`, `src/betanyc-tools.ts`, `scripts/tests/catalog_validate.py` and `scripts/mcp_shared/` are copies of files in the BetaNYC workspace; never edit them here. `data.json` (DCAT-US 3.0) is built from `DATA-SOURCES.json` with `python3 scripts/whats_changed.py about-data catalog DATA-SOURCES.json`; CI fails when it is out of date. A release that changes only metadata gets no entry; its commit carries a `No-whats-changed: <reason>` trailer.

## Terms of use

Read before any adapter was written; details and quotes in [`docs/terms.md`](docs/terms.md).

- **Socrata / Tyler**: the Discovery API's stated purpose is "automated searching, research, and exploration"; read-only access needs no authentication; an app token is recommended. Each portal's own terms page, where it has one, is recorded in [data/terms-pages.json](data/terms-pages.json) (checked 2026-11-14).
- **Esri**: ArcGIS Online public content is for personal or noncommercial use under each item's own terms, and owners who share publicly grant end users permission to use and reproduce it. The Master Agreement's "may not scrape, download, or store Data" clause defines Data as Esri's own commercial datasets, which are excluded here. Hub robots.txt asks for a 60 s crawl delay, which is honored.

## Related

- Scout field mapping: [`docs/scout-mapping.md`](docs/scout-mapping.md)
- Proposed upstream registry change (`platform_family`): [`docs/upstream/`](docs/upstream/)

## License

MIT

Data license: `data/ny-data-portal-registry.json` is CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/), adapted from BetaNYC's [grounding-ai-with-ny-open-data](https://github.com/BetaNYC/grounding-ai-with-ny-open-data) registry, and ships inside the MIT-licensed package. Credit: "Source: BetaNYC, New York Data Portal Registry."
