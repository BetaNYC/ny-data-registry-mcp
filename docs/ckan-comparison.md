# CKAN: a one-time comparison, no adapter

Written 2026-11-14 for issue [#16](https://github.com/BetaNYC/ny-data-registry-mcp/issues/16), milestone 7 (epic [#7](https://github.com/BetaNYC/ny-data-registry-mcp/issues/7), decision D7: CKAN gets a one-time comparison only, no adapter). Data current as of: the registry of 2026-11-13 and the published index harvested 2026-11-05. **No CKAN site was called for this note.** Every number below comes from the registry's own evidence or from the index.

## What the registry lists

| Row | What it is | Datasets (registry) | API |
|---|---|---|---|
| State of New York (as harvested by data.gov) | catalog.data.gov's copy of State catalogs (`/organization/new-york`) | 1,164 (2026-11-05) | none found: the old CKAN action API (`/api/3/action/*`) returns 404 on the rebuilt catalog |
| City of New York (as harvested by data.gov) | catalog.data.gov's copy of NYC Open Data (`/organization/nyc-ny`) | 2,716 (2026-11-12) | the same: none found |
| Stony Brook University (Geospatial Center, SoMAS) | a real CKAN 2.11 site, Peconic Estuary Partnership material | 90 (2026-11-12) | CKAN Action API, but robots.txt disallows `/api/` to crawlers |

The two data.gov rows are copies of catalogs this index already reads at the source. The Stony Brook site is the only CKAN in New York these sources found.

## The data.gov copies against the index

The index counts every Socrata asset type; data.gov harvests datasets. So compare against the index's `dataset` type.

| Source catalog | Index, all types | Index, `dataset` type only | data.gov copy (registry) |
|---|---|---|---|
| data.ny.gov (`nys-office-of-information-technology-services-open-ny-progra`) | 1,291 | 1,036 | State of New York: 1,164, which may also cover health.data.ny.gov |
| health.data.ny.gov (`nys-department-of-health`) | 500 | 324 | (inside the 1,164, if data.gov harvests it) |
| data.cityofnewyork.us (`new-york-city`) | 3,014 | 2,416 | City of New York: 2,716 |

What this says, and what it does not:

- data.ny.gov and health.data.ny.gov together have 1,360 `dataset` assets in the index; data.gov's State copy lists 1,164. NYC Open Data has 2,416 `dataset` assets; data.gov's NYC copy lists 2,716. Neither copy matches its source. The counts were taken on different days (index 2026-11-05, data.gov 2026-11-05 and 2026-11-12), and data.gov may harvest other asset types or keep withdrawn ones.
- Which datasets differ cannot be said from counts alone. That needs data.gov's list of identifiers, and the registry found no working API for the rebuilt catalog.
- Nothing suggests the copies hold New York datasets the index lacks. They are federal mirrors of catalogs harvested at the source every night.

## Why no adapter

- **data.gov:** the copies duplicate catalogs harvested directly, with less metadata and on data.gov's schedule. No API for the rebuilt catalog was identified. An adapter would add duplicates and nothing new.
- **Stony Brook:** robots.txt disallows the CKAN API to crawlers, and this package honors robots.txt. Its 90 datasets could go on the hand-kept list (`data/hand-kept.json`) as one entry pointing to its dataset page, if wanted.

## If a live check is wanted later

One request per data.gov organization would settle the identifier question, if data.gov documents an API for the rebuilt catalog. It needs the operator's approval first; none was made for this note. Check data.gov's current developer documentation for that API before writing any call.
