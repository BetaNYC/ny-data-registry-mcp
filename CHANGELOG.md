# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Dataset search matches every word of the query.

### Changed

- `search_datasets`: a dataset must match every word of the query (the word, its stem or one of
  its synonyms). Before, any one word was enough, so "tax parcels" in Erie County also counted
  opioid excise tax reports: 208 matches, now 113. When no dataset has every word, the search
  falls back to any one word and the reply says so (`match: "any"`, `match_note`). A two-word
  synonym key ("tax lot", and the new "tax parcel" and "tax parcels") is one concept, so its
  words are not also searched alone. The question set scores 27 of 27 before and after.
- `src/betanyc-tools.ts` and `scripts/whats_changed.py`: BetaNYC's shared module 1.4.0 (was
  1.2.4), copied unchanged from betanyc-ai-workspace `main` at 4d72be6, with its validator kit
  (`scripts/tests/catalog_validate.py`, `scripts/mcp_shared/`).

### Added

- `about_data`, the third BetaNYC standard tool (betanyc-ai-workspace #1672): where each kind
  of data comes from, from `DATA-SOURCES.json`. 68 sources: one for each of the 60 portals the
  harvest reads, published by the government or institution that runs it (the platform, such as
  Socrata or ArcGIS, is named but is not the publisher), plus the portal list, who runs each
  site, places, the hand-kept list, topics, coverage, join keys, and the Croissant and DCAT-US
  descriptions. Each gives one of the three answers to "is this official?". A test fails when
  the harvest reads a portal with no source. Each portal source carries the portal's own name
  (its site title; an unnamed ArcGIS services directory is named by its page title and
  address), links the portal itself to check a figure, cites what sets its terms (NYC Open Data and
  NYCMapHub: the Open Data Law, NYC Administrative Code § 23-502(d), with § 23-504's no-warranty
  point as a caveat; other portals: their own terms, policy or disclaimer page) or says "None
  stated by the publisher" with the page looked at, and sends errors in the original records to
  the publisher (Tyler's Contact Dataset Owner guide for Socrata portals, or the publisher's own
  contact page; a shared team address when one is shown, never a person's own). How current
  each source is comes from the loaded portal list, the master list of government bodies and
  the installed index; each portal reports its own last good read, so a weekly or failed portal
  does not borrow the index's date.
- The server now sends MCP `instructions`, ending with BetaNYC's shared ones.
- `data.json`: a DCAT-US 3.0 catalog built from `DATA-SOURCES.json`, shipped in the package.

Bundled copies refreshed after the master list gained counties, cities, towns and villages
(ny-gov-web-registry #59, #60) and the registry linked its rows to it (grounding #37).

### Changed

- `data/ny-data-portal-registry.json`: grounding `main` at 2b5105d. 182 of 224 rows now carry a
  `registry_id` (was 22).
- `data/gov-bodies.json`: rebuilt from ny-gov-web-registry `main` at 4d4250d. It holds the 154
  bodies those rows point to (was 19), out of 2,151 on the list.
- `docs/topics-crosswalk-2026-11-05.csv` (1.5 MB) removed. The crosswalk for every index is
  published with it as `topic-crosswalk.csv`.

The index is rebuilt every night on GitHub Actions, and a quality gate keeps a worse index
from being published. See [#14](https://github.com/BetaNYC/ny-data-registry-mcp/issues/14)
(epic [#7](https://github.com/BetaNYC/ny-data-registry-mcp/issues/7)).

### Added

- `harvest.yml` runs every night at 07:17 UTC (`workflow_dispatch` inputs: `publish`,
  `fresh`, `ignore_cadence`, `force_publish`, `force_reason`). It starts from the published
  index and fails if that cannot be downloaded and verified, instead of starting from nothing.
- Quality gate (`src/publish/gate.ts`, limits in `harvest-config.json` `publish_gate`): the
  question set must pass; no more than a 10% drop in datasets, no more than 3 portals lost, no
  portal of 20+ datasets losing over half, no schema change, no empty index. A failed gate
  blocks the publish. `force_publish` with a `force_reason` overrides it, and the reason and
  who gave it are recorded in `gate.json`, `index.json` and the release notes.
- Each publish makes a dated snapshot `index-YYYY-MM-DD` titled "(current)" and relabels older
  ones "(superseded)". Retention keeps the 14 newest snapshots plus the first of each month.
- `index.json`, a manifest beside every index: schema version, harvest time, registry date,
  both SHA-256 sums and sizes, dataset and portal counts, run link, commit, gate result.
- A failed scheduled or publishing run opens a `harvest-failure` issue, or comments on the open
  one; the next run that publishes closes it.
- `cadence` in `harvest-config.json`: self-hosted county ArcGIS Enterprise portals are read
  weekly, not nightly. New `not-due` portal outcome and `not_due` count in the harvest stats;
  `harvest --ignore-cadence` reads everything.
- The harvest drops portals whose ids are no longer in the registry, with their datasets,
  columns and change history ([#21](https://github.com/BetaNYC/ny-data-registry-mcp/issues/21)).
  Portal ids come from registry rows, so when a row changes its old id was left behind,
  never read again: on the 224-row registry, DEC's old id kept 834 stale datasets next to the
  842 under its new id. Each drop (portal id, dataset count) is listed in the harvest stats
  (`dropped_portals`), the run summary, `index.json` and the snapshot's release notes. The
  registry records no id changes, so nothing is re-keyed. Nothing is dropped when the loaded
  registry is older than the index's (a failed refresh falling back to the bundled copy). The
  gate subtracts these drops before its drop checks, up to 5 portals
  (`max_registry_removed_portals`); any other drop is judged as before.
- `eval --result-out file.json`: the question-set result as JSON.
- `certs/sectigo-public-server-authentication-ca-ov-r36.pem`: the intermediate certificate
  Orange County's server leaves out, added for the harvest step with `NODE_EXTRA_CA_CERTS`.
  Certificate checks stay on. Provenance and removal steps in `certs/README.md`.

### Changed

- The published index uses SQLite's rollback journal instead of WAL, so readers no longer
  create `-wal` and `-shm` files beside it.
- Socrata hosts get at least 2 s between requests (was 1 s). 429 and 503 are retried up to
  twice, honoring `Retry-After` in seconds or as a date (otherwise 5 s, then 10 s; capped at
  60 s), and a 429 doubles that host's gap for the rest of the run. Before, only one retry on
  429.
- Code releases (`vX.Y.Z`) are now created as the repository's "Latest" release; index
  releases never are.

Each install now picks up the new index by itself, and an `update` command gets it on
demand. See [#15](https://github.com/BetaNYC/ny-data-registry-mcp/issues/15) (epic
[#7](https://github.com/BetaNYC/ny-data-registry-mcp/issues/7)).

### Added

- Automatic index updates, on by default. A running server checks 5 minutes after it starts
  and then every 24 hours, on timers that never block startup or a tool call. When the
  installed index is at least 5 days old, it reads the release's `index.json` and downloads
  the index only if the published one is newer and this package can read its schema. The
  download is checked against both SHA-256 sums (and the size) in `index.json` before the
  installed index is touched, then renamed into place. Any failure keeps the installed index.
  The server's open database handle reopens after a swap (it also notices a file replaced by
  another process, checking at most once a minute), so no restart is needed.
- On Windows, where a file another process has open cannot be renamed over (`EBUSY` or
  `EPERM`), the checked file waits as `<index>.next` and is installed the next time the index
  is opened with nothing holding it.
- `<index>.source.json` beside the index: the URL, SHA-256 and harvest time of what was
  installed. An index installed by an older version is hashed once to make one.
- `ny-data-registry update` (download if a newer index is published, regardless of age or
  the automatic-update setting) and `update --check` (report only). Exit codes: 0 current or
  updated, 1 failed, 2 usage, 3 needs a newer package, 4 a newer index is published
  (`--check`), 5 downloaded but waiting for the index to be free.
- Settings: `NY_DATA_INDEX_AUTO_UPDATE` (`0` = off), `NY_DATA_INDEX_REFRESH_DAYS` (5),
  `NY_DATA_INDEX_STALE_DAYS` (14), `NY_DATA_INDEX_CHECK_HOURS` (24),
  `NY_DATA_INDEX_CHECK_DELAY_SECONDS` (300). A setting that cannot be read falls back to its
  default and is reported. Automatic updates are also off when `NY_DATA_INDEX` is set (a file
  you manage), when `NY_DATA_INDEX_URL` names a dated snapshot, when
  `NY_DATA_INDEX_AUTO_DOWNLOAD=0`, and in offline mode.
- `registry_info.index_status`: the index's age, whether it is stale, whether automatic
  updates are on and what turned them off, the last check's result and time, and the
  published harvest time.
- `search_datasets` replies carry `index_note` when the index is more than 14 days old,
  with the `update` command. Other tools do not.
- CI runs the whole test suite on `windows-latest` (Node 22.x) as well.
- Rollback. `harvest.yml` takes `rollback_to` (a kept `index-YYYY-MM-DD` snapshot) with a
  required `rollback_reason`. That run does no harvest: it checks the snapshot's files and
  copies them over `index-latest`, adds `rolled_back` (`from`, `to`, `reason`, `at`, `by`) to
  `index.json`, and relabels the bad snapshot "(rolled back)". It refuses a missing snapshot,
  one retention is about to delete, one without `index.json`, one this package cannot read,
  and one not older than `index-latest`. It deletes nothing. A server whose index is newer than
  the target replaces it with the target at its next check, even inside the 5 days, so an
  automatic check now reads `index.json` every time (under 1 KB). `update --check` reports a
  rollback (exit 4), `update` makes the swap (new outcome `rolled-back`, exit 0), and
  `index_note` and `registry_info.index_status.rolled_back` say why. The next nightly publish
  clears it. Each publish now records its tag in `index.json` (`snapshot_tag`).

### Changed

- `download --force` refuses to start while another process holds the download lock,
  instead of going ahead without it.
- A release without `index.json` (from before the nightly harvest) is still read: the
  sqlite sum in `SHA256SUMS` decides whether the installed index is current. An automatic
  check then leaves alone a file it did not install itself.

Search by topic. See [#18](https://github.com/BetaNYC/ny-data-registry-mcp/issues/18) (epic
[#7](https://github.com/BetaNYC/ny-data-registry-mcp/issues/7)).

### Added

- 24 shared topics, built from the categories, tags and departments New York's portals already
  use. Each dataset gets its topics from its own labels; a dataset can have several.
  `search_datasets` takes `topic` (with a query, or alone: then `query` is optional, and the
  topic is listed most-viewed first), and its rows carry their topic ids. New `list_topics` tool:
  the 24 topics with dataset and portal counts, and the share of datasets with a topic (8,910 of
  9,569, 93.1%, on the 2026-11-05 index). The rules are data: `data/topics.json` and
  `data/topic-hand-assigned.json` (broad and ambiguous words, each with a reason). The harvest
  rebuilds every dataset's topics at the end of each run, and each published index carries
  `topic-crosswalk.csv` (every portal label and its topics). `ny-data-registry topics` rebuilds
  them on a local index. New `topics` and `dataset_topics` tables; the schema version is
  unchanged, so older servers still read new indexes. Method: `docs/topics.md`.

Standard metadata. See [#17](https://github.com/BetaNYC/ny-data-registry-mcp/issues/17) (epic
[#7](https://github.com/BetaNYC/ny-data-registry-mcp/issues/7)).

### Added

- `get_dataset_columns` takes `standard: "croissant" | "dcat-us"` and returns that dataset as
  Croissant 1.1 or DCAT-US 3.0, with its license kind and the required fields its portal does
  not give (`missing`). Each published index carries `ny-data-dcat-us.json.gz` (one DCAT-US
  Catalog) and `ny-data-croissant.jsonl.gz` (one Croissant document per line), about 3 MB
  each on the 2026-11-05 index; `ny-data-registry standards [--out-dir dir]` builds them
  locally. They are optional side files: a rollback treats them like `topic-crosswalk.csv`.
  Licenses are never inferred: a known license name is a license; otherwise a terms-of-use
  link is labeled "terms page, not a license" (from the dataset's own text or
  `data/terms-pages.json`, checked by hand on 2026-11-14: 10 of 35 portals have a terms page,
  25 have none or were blocked), and other portal text is kept as a rights statement. On the
  2026-11-05 index: 791 licenses, 5,312 terms pages, 1,360 statements only, 2,106 nothing.
  DCAT-US's required contact email is always left out (portals do not give one). Tests check
  DCAT-US output against GSA's JSON Schema (vendored in `test/fixtures/dcat-us-3.0/`). Plan
  and field mapping: `docs/standard-metadata-plan.md`.

Cover every portal in the registry. See [#16](https://github.com/BetaNYC/ny-data-registry-mcp/issues/16)
(epic [#7](https://github.com/BetaNYC/ny-data-registry-mcp/issues/7)).

### Added

- `ny-data-registry coverage [--json] [--out file] [--index path] [--refresh]`: for every
  registry row, whether the harvest reads it, and if not, why, as a fixed code (`no-portal`,
  `policy`, `adapter-off`, `no-adapter`, `no-api` and others). Offline: registry, harvest
  config and index only; it never calls a portal.
- `adapters` in `harvest-config.json`: one on/off switch per adapter. An adapter switched off
  stops alone; its portals report `adapter-off` and keep their datasets.
- `allow_no_portal` in `harvest-config.json` (D4): the City of Utica, Wyoming County and the
  City of Mount Vernon are marked "no portal" but document a data endpoint, and are now read
  (ArcGIS Online org, ArcGIS Online org, ArcGIS Enterprise). Each was checked to be New York,
  not Utica, Minnesota or Wyoming County, Pennsylvania. A changed registry endpoint stops the
  row until it is checked again.
- Five more `allow_no_portal` rows, read by the `arcgis-server` adapter: Greene, Washington,
  Cayuga, Essex and Chautauqua counties. Each is New York, not the same-named county in Ohio,
  Wisconsin (and four other states), Ontario or Kansas. Each server answered one read of its
  services directory root on 2026-11-14 and lists the service or folder the registry says holds
  parcels; the entry records the URL, time, status and result (`checked_live`). St. Lawrence
  County was left out: its server is the Development Authority of the North Country's, shared
  with five other counties, so reading it would file their layers under St. Lawrence. The parcel
  table does not change until a harvest reads the five servers.
- ArcGIS Server REST directory adapter (`arcgis-server`, milestone 4): the State's GIS servers
  (`nysgeohub`, `gisservices`, `orthos`, `elevation`), DOT, DEC's server, Broome and Ulster.
  One dataset per map, feature or image service; layer fields for up to 5 layers each. Read
  weekly per host (D5), at most 400 requests and 30 minutes per host, 2 s apart (or the
  robots.txt Crawl-delay), `Utilities` and `System` folders skipped, robots.txt honored.
  Settings in `arcgis_server` in `harvest-config.json`. Switched on.
- GeoBlacklight adapter (`geoblacklight`, milestone 6): Cornell's CUGIR, read from its
  OpenGeoMetadata repository as one GitHub archive per week, never from the GeoBlacklight site.
  GeoBlacklight 1.0 and Aardvark records; public, unsuppressed, not withdrawn, Cornell's own,
  not wholly outside New York. Switched on. The harvest step now gets the run's `GITHUB_TOKEN`
  for this one read.
- InvenioRDM adapter (`invenio-rdm`, milestone 6): NYU UltraViolet's Spatial Data Repository
  community, weekly, oldest first. Keeps public records whose location touches New York, or
  that name New York when they have no location. **Switched off** until a supervised run
  checks that filter: locations are optional in InvenioRDM and the repository is worldwide.
- `docs/ckan-comparison.md` (milestone 7, D7): data.gov's copies of the State and NYC
  catalogs against the index, from counts already on record; no CKAN site called, no adapter.
- `politeFetch` can read a binary body (`binary: true`), never cached.
- Hand-kept list (`data/hand-kept.json`, milestone 5, D6): for rows with no data link, what the
  place does offer (pages, viewers, search pages, request forms). The `hand-kept` adapter adds
  each link to the index as type `hand-kept <kind>`, with no endpoint or columns, and makes no
  network call. Seeded with 82 parcel links the State's parcel page lists for 30 counties.
  Switched on.
- Each hand-kept link was checked once on 2026-11-14 (`link_check`: date, final URL, HTTP status,
  result): 48 ok, 3 redirected, 2 broken, 29 blocked (bot challenges, mostly Beacon's; logins;
  robots.txt; and one TLS error on our side). HEAD first, GET only if HEAD was refused; 2 s
  apart per host; robots.txt honored; no login or CAPTCHA bypassed. A broken link stays in the
  file but is left out of the index; other results are noted in the entry's description.
- The publish gate needs nothing new for the first run with the new adapters: its drop checks
  compare only what the published index had, so growth passes. The question set must still
  pass.
- `ny-data-registry parcels`: a tax parcel table for all 62 counties. 38 share their parcels
  with the State's public layer; 23 have their own parcel layer in the index and 11 more in
  the registry only; 18 have neither (2026-11-14). The State's list comes from one read of the
  State's service description on 2026-11-14 (D3), kept in `docs/parcels/` and recorded in
  `data/parcel-sources.json` with the State page's per-county links and the hand-reviewed
  registry layers. The table: `docs/parcels/2026-11-14-parcel-coverage.md`.

### Changed

- The bundled registry is the 2026-11-13 copy (224 rows, was 140). `platform-families.json`
  maps its 156 platform strings; 3 strings no longer in the registry are gone. Newly mapped:
  two ArcGIS Hub sites on custom domains (NYC's `nycmaps.nyc.gov`, DEC's Bond Act site), two
  self-hosted ArcGIS Enterprise portals (DOT, Watertown), and research repositories
  (`custom-api`, described only). Source ids follow the registry rows, so two changed:
  `nys-department-of-environmental-conservation--services6-arcgis-com` and
  `columbia-university-libraries--geodata-library-columbia-edu`.

See [#10](https://github.com/BetaNYC/ny-data-registry-mcp/issues/10) (part of
[BetaNYC/ny-gov-web-registry#58](https://github.com/BetaNYC/ny-gov-web-registry/issues/58)).

### Added

- `registry_id` in every reply that names a data site: the id of the row's
  government body in BetaNYC/ny-gov-web-registry, for joining the two. Source
  rows (`find_sources`, `list_sources_for_place`, `how_to_query`,
  `check_source`) always carry it, `null` when the row has none. Dataset rows
  carry their portal's id: `search_datasets` compact rows, portal groups, the
  coverage list and `find_joinable`'s `by_portal` only when there is one;
  full rows, `get_dataset_columns`, `find_joinable`'s `dataset` and the CSV
  export (a new `registry_id` column after `portal_id`) always. Dataset rows
  read it from the registry at answer time, so ids added upstream show up
  without a new harvest.
- `search_datasets` and `whats_new`: `portal` also accepts a `registry_id`,
  meaning every data site of that government and nothing else.
- `registry_info`: `with_registry_id`, how many rows carry one.
- `runs_it` on source rows (`find_sources`, `list_sources_for_place`,
  `how_to_query`, `check_source`): the government body that runs the data
  site (name, level, classification, website), looked up by `registry_id` in
  BetaNYC/ny-gov-web-registry `data/registry.json`. `null` with no id;
  `found: false` when the list lacks the id. Each reply's `runs_it_source`
  says which copy answered; `registry_info` gains `master_list`. The list is
  fetched and cached like the registry, with a small bundled fallback
  (`data/gov-bodies.json`, rebuilt by `scripts/bundle_gov_bodies.mjs`)
  ([#19](https://github.com/BetaNYC/ny-data-registry-mcp/issues/19)).

### Changed

- An empty `registry_id`, or the registry's `—` placeholder, is read as no id
  (`null`). Ids are copied from the registry and never derived.
- The "no row with registry_id" error counts the rows that carry one from the
  loaded registry instead of a fixed "22 of 140".

### Fixed

- `search_datasets` could exceed the 20 KB reply limit by a few hundred bytes
  (since 0.3.0). The note saying how many rows were left out was added after
  trimming; it now counts against the limit.
- The question set's invariant flagged every dataset from a "no portal" row, including
  the rows the harvest reads on purpose (`allow_no_portal`, and the hand-kept list), so the
  nightly harvest's quality gate failed from 2026-11-16 on City of Mount Vernon datasets
  ([#30](https://github.com/BetaNYC/ny-data-registry-mcp/issues/30)). It now asks the
  harvester's own plan for the row: a dataset passes when the harvest reads that row and writes
  that kind of dataset. Dead and UNCONFIRMED rows, other "no portal" rows, and allowed rows
  whose endpoint has changed are still violations.

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
