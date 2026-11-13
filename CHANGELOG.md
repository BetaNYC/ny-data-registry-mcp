# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
