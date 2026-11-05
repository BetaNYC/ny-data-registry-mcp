# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — unreleased

First build. Local only: not published, no remote repository.

### Added

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
- `harvest.yml` (nightly harvest, not enabled) and `ci.yml` (tests on Node 22.13
  and 26).
