# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- README: a "Questions to try" section with sample questions for every tool,
  what each found on 2026-11-05, and search tips.
- `.github/workflows/publish-mcp.yml`: publishes `server.json` to the official
  MCP Registry as `io.github.BetaNYC/ny-data-registry-mcp`. Runs after each
  successful Release of a `v*` tag, or by hand for a given tag. GitHub OIDC
  login, no stored secret; `mcp-publisher` pinned to v1.8.8 and checked with
  cosign.
- `glama.json`: lets BetaNYC claim this server's listing on Glama
  (maintainer: `noneck`).

## [0.1.0] — unreleased

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
