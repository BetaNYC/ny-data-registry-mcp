# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] — Unreleased

Adds `about_data`, the third tool BetaNYC is adding to each of its MCP servers. Tracking:
BetaNYC/betanyc-ai-workspace#1655 (epic #1652).

### Added

- `about_data`: where each kind of data comes from, whether it is an official record, how
  current it is on this machine, its terms, where to check it and where to report an error,
  with BetaNYC's contact address for data questions (lab@beta.nyc). Optional `topic`: a source
  id or a tool name. No network request.
- `DATA-SOURCES.json`, three sources: `portal-registry` (BetaNYC's registry, published by
  BetaNYC and marked as BetaNYC's curation, not an official record), `socrata-catalogs` and
  `arcgis-catalogs` (the catalogs of the portals run by New York State, New York City and other
  New York governments, which the harvested index is built from). An error in a dataset or its
  description goes to the contact on that dataset's own portal page. How current: the `generated` date
  of the registry copy this server loaded, and the index's `last_harvest` (or "not fetched yet"
  when there is no index on this machine).
- `data.json`, a DCAT-US 3.0 catalog built from `DATA-SOURCES.json` by
  `scripts/whats_changed.py about-data catalog`. Never edit it by hand. Both files ship in the
  npm package (`files`).
- The server now sends MCP `instructions` saying when to call `about_data`, `about_betanyc`
  and `whats_changed`.
- `scripts/tests/catalog_validate.py`, `scripts/mcp_shared/data-sources.schema.json` and
  `scripts/mcp_shared/vendor/dcat-us-3.0.0/`, copied unchanged from the BetaNYC workspace.
- CI: an `about-data` job checks that every tool has a source, that `data.json` is current,
  and validates both files against their JSON Schemas (pinned validators, CI only).
  `release.yml` runs `about-data check --release` before `npm publish`.
- Tests: `test/about-data.test.mjs`; the tool-list tests now expect twelve tools.

### Changed

- `src/betanyc-tools.ts` and `scripts/whats_changed.py` updated to shared module 1.3.7
  (from 1.2.4), copied unchanged.
- README: the data license of `data/ny-data-portal-registry.json` (CC BY-SA 4.0, adapted
  from grounding-ai-with-ny-open-data) inside the MIT package.

## [0.3.0] — 2026-11-13

`search_datasets` gives the whole answer in one call. Its reply has a new shape, which is
why this is 0.3.0 and not 0.2.1: see Changed and Removed below. See
[#8](https://github.com/BetaNYC/ny-data-registry-mcp/issues/8) (epic [#7](https://github.com/BetaNYC/ny-data-registry-mcp/issues/7)).

### Added

- `search_datasets`: `total_matches`, the true number of matching datasets
  (an uncapped count with the same filters), and `ranked_pool`, which says
  plainly when only the best 5,000 text matches were re-ranked.
- `search_datasets` answers in one call. When the matches do not all fit in the
  reply (over `limit`, or over the size budget), the reply counts every match by
  portal (`auto_grouped: true`, top titles per portal), lists the best-ranked
  rows that fit, and writes every match to a CSV file (`export`: path, rows,
  bytes, columns). The tool result also carries an MCP `resource_link` to the
  file. Small answers come back as plain rows, with no file.
- Synonyms can be two-word phrases that match only when the words sit together in
  the query. New: `tax lot` / `tax lots` also search `parcel`, `parcels`, `tax parcel`
  and `tax map`, so "tax lot" finds county layers named just "Parcels" (785 to 900
  matches on the 2026-11-05 index) while "parking lot" does not expand.
- Synonyms from a review of how 35 New York portals label their data: bike ↔ bicycle,
  covid ↔ coronavirus, tax map, assessment roll, voting, garbage, broadband, police.
- Ranking puts datasets that contain the words actually typed ahead of synonym-only
  matches (those count at `SYNONYM_WEIGHT` = 0.5), and a title holding the typed words
  together, in order, gets a bonus (`PHRASE_BONUS`). "tax lot" keeps PLUTO first.
- CSV exports are spreadsheet-safe: a text value starting with `=`, `+`, `-`, `@`, tab or CR
  gets a leading `'` so Excel, Numbers, LibreOffice and Google Sheets never run it as a formula.
- CSV exports: RFC 4180, UTF-8, best-ranked first, in
  `${HOME}/.cache/betanyc/ny-data-registry/exports/` or `NY_DATA_EXPORT_DIR`.
  `export: "auto" | "always" | "never"` (default `auto`). The newest 50 are
  kept, none older than 7 days; pruning only removes files with the export
  name pattern, directly inside that folder.
- `search_datasets` `offset` / `next_offset` for paging by hand. Optional;
  passing `offset` turns off the auto-summary and the automatic CSV. Ties are
  broken by dataset id, so the order is the same on every page.
- `search_datasets` `group_by` (`portal`, `entity`, `county`,
  `platform_family`): every group with its exact match count and its top titles
  (`top_per_group`, default 3), covering all matches. `county` counts a
  dataset in each county it covers.
- `search_datasets` `detail`: `compact` (default) or `full`.
- `search_datasets` `coverage`: the registry portals the index does not search,
  and why (no portal, not harvested, failed or partial harvest). With a place,
  the ones that cover it are listed; otherwise counted.

### Changed

- Synonyms removed because they pulled in wrong results: `schools` → `district`,
  `elections` → `enrollment`, `crime` → `complaints`.
- `search_datasets` rows are compact by default (id, name, portal, type, update
  date, link, formats). Pass `detail: "full"` for the earlier shape (description,
  API endpoint, views, column count, `query_with`, score).
- `search_datasets` answers are kept under 20 KB (`RESPONSE_BUDGET_BYTES`).
  Rows past the budget are left out and counted in `omitted_for_size`; the CSV
  has them. Fifty full rows were about 60 KB, more than some MCP
  clients accept from one tool call.
- `search_datasets` re-ranks up to 5,000 matches instead of 400, so ranking and
  paging reach past the 400th match. On the 2026-11-05 index a typical query
  takes under 10 ms; a query matching 7,000 datasets takes about 45 ms.

### Removed

- `search_datasets` `total_candidates`. It stopped at 400 and read like a real
  total. Use `total_matches`.

## [0.2.0] — 2026-11-13

Adds the two tools BetaNYC is adding to each of its MCP servers. Tracking:
BetaNYC/betanyc-ai-workspace#1645 (epic #1637).

### Added

- `whats_changed`: what changed in this server, newest first, from `WHATS-CHANGED.md`
  (filters: `since`, `tag`, `limit`). Answers with readable text and `structuredContent`
  matching a declared `outputSchema`. Not to be confused with `whats_new`, which lists
  datasets added or changed on the portals and is unchanged.
- `about_betanyc`: who built the server, the repository, where to report a bug in this server or ask for a new feature, and
  BetaNYC's links.
- `src/betanyc-tools.ts`, copied unchanged from the workspace's
  `scripts/mcp_shared/betanyc-tools.ts` (v1.2.1). Never edit the copy; change the canonical
  file and copy it again.
- `WHATS-CHANGED.md`, the reader-facing record of changes, backfilled to 0.1.0, and shipped
  in the npm package (`files`). There is no website; GitHub's rendering of the file is the
  page.
- `scripts/whats_changed.py`, copied unchanged from the workspace. CI runs
  `check --base-ref` (append-only, and a version bump needs an entry), and the release
  workflow runs `check --release` before `npm publish`, so a release cannot ship while the
  `WHATS-CHANGED.md` entry still says `Unreleased`.
- README: a "Questions to try" section with sample questions for every tool,
  what each found on 2026-11-05, and search tips.
- `.github/workflows/publish-mcp.yml`: publishes `server.json` to the official
  MCP Registry as `io.github.BetaNYC/ny-data-registry-mcp`. Runs after each
  successful Release of a `v*` tag, or by hand for a given tag. GitHub OIDC
  login, no stored secret; `mcp-publisher` pinned to v1.8.8 and checked with
  cosign.
- `glama.json`: lets BetaNYC claim this server's listing on Glama
  (maintainer: `noneck`).

### Changed

- Eleven tools instead of nine: README, tool-list and smoke tests.
- `whats_new`'s description ends with one sentence pointing to `whats_changed` for changes
  to the server itself, so an assistant picks the right one. Its inputs and answers are
  unchanged.
- The `0.1.0` heading below carries its release date, 2026-11-05 (npm publish
  2026-11-05T21:13Z), in place of "unreleased".

## [0.1.0] — 2026-11-05

First public release.

### Added

- **First-run download of the dataset index.** When the index is missing, the
  server fetches it from the fixed `index-latest` release in the background
  (about 19 MB), checks both SHA-256 sums and the schema version, and installs
  it atomically. A dataset tool asked during the download waits up to 45 s. Off
  with `NY_DATA_INDEX_AUTO_DOWNLOAD=0` and in offline mode. An existing index is
  never replaced on its own.
- `ny-data-registry download [--force]` to fetch or refresh the index by hand.
- `registry_info` reports the download state (`index_download`).
- `mcpName` and `server.json` for the official MCP Registry, and a tag-driven
  `release.yml` (npm publish with provenance; code releases never marked latest).

- Registry tools: `find_sources`, `list_sources_for_place`, `how_to_query`,
  `check_source`, `registry_info`, over the bundled NY data portal registry
  (140 rows, generated 2026-11-05) with conditional refresh from GitHub Pages.
- Index tools: `search_datasets`, `get_dataset_columns`, `find_joinable`,
  `whats_new`, over a SQLite (FTS5) index built by `ny-data-registry harvest`.
- Harvest adapters for the Socrata Discovery API, ArcGIS Hub (OGC API - Records
  and DCAT-US 1.1), ArcGIS Enterprise portal search, and ArcGIS Online org search,
  with Esri-content exclusion, an out-of-state guard, robots.txt and Crawl-delay,
  per-host throttling and ETag caching.
- `data/platform-families.json` mapping all 101 registry platform strings to a
  fixed family list, and a proposed upstream patch adding `platform_family`
  (`docs/upstream/`, not applied).
- Index schema as a superset of Scout's Portal / Dataset / DatasetColumn / Tag
  (`docs/scout-mapping.md`).
- Offline tests with recorded fixtures, a stdio smoke test, and a fixed question
  set scored against the real index (`eval/`).
- `harvest.yml` (nightly harvest, not enabled) and `ci.yml` (tests on Node 22.16
  and 26). Node 22.16 is the floor: official Node builds before it ship SQLite
  without FTS5, and the index needs it. Opening the index on such a build gives a
  clear error naming the fix.
