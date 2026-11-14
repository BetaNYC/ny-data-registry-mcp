---
title: "Standard metadata: Croissant and DCAT-US (issue #17), plan"
created: 2026-11-14
type: plan
status: active
tags: [type/plan, domain/engineering, topic/open-data, topic/metadata-standards]
---

# Standard metadata: Croissant and DCAT-US

Issue [#17](https://github.com/BetaNYC/ny-data-registry-mcp/issues/17), part of #7, for 0.4.0.
Metadata only. No dataset contents are ever copied.

## Specs read (2026-11-14)

- **Croissant 1.1**, published 2026-01-29:
  `docs/croissant-spec-1.1.md` in mlcommons/croissant at commit `fa440f3`. The page at
  docs.mlcommons.org still shows 1.0; 1.1 keeps the same required list. We write
  `conformsTo: http://mlcommons.org/croissant/1.1`.
- **mlcroissant** validator rules, same commit:
  `python/mlcroissant/mlcroissant/_src/structure_graph/nodes/{metadata,file_object,field}.py`,
  then mlcroissant 1.1.1 itself (from PyPI), run on the output. Running it found three things
  the spec text does not say: schema.org must be `https://schema.org/` (the spec's Appendix 1
  prints `http://`, the spec's own 1.1 examples use `https://`); `keywords` must be plain
  text, not DefinedTerm; and every RecordSet field must name a `source` or a `value`.
- **DCAT-US 3.0** JSON Schema (draft 2020-12), GSA/dcat-us `jsonschema/definitions/` at commit
  `a1dbaa0` (2026-10-06), plus resources.data.gov's DCAT-US 3.0 pages and implementation guide.
  CC0. Vendored for tests in `test/fixtures/dcat-us-3.0/`.

## Required fields and what we have

| Standard | Required by the spec | Our source | Gap |
|---|---|---|---|
| Croissant | `@context`, `@type`, `conformsTo` | fixed | none |
| Croissant | `name` | `datasets.name` | none (0 missing) |
| Croissant | `description` | `datasets.description`, HTML stripped | 1,271 of 9,569 have none: left out |
| Croissant | `url` | `datasets.permalink` | none |
| Croissant | `datePublished` | `datasets.created_at` | none |
| Croissant | `license` | see License below | left out when the portal gives none |
| Croissant | `creator` | `datasets.publisher` (Socrata attribution, ArcGIS source/credits) | 842 have none: left out |
| Croissant | `distribution` (FileObject) | `datasets.formats` | 807 list no format: empty list |
| DCAT-US | `title`, `identifier` | `name`, our `dataset_id` | none |
| DCAT-US | `description` | as above | 1,271 left out |
| DCAT-US | `contactPoint` (vCard with a `mailto:` email) | **nothing**: portals do not give us a contact email | always left out |

mlcroissant treats `license`, `datePublished`, `version` and `citeAs` as recommended (a
warning when missing), not errors. It errors on a FileObject with no `@id`, no
`encodingFormat`, or no `contentUrl`, and on one with no `md5`/`sha256` unless the dataset sets
`isLiveDataset: true`. We never download data, so we have no checksums, and portal data changes:
every document sets `isLiveDataset: true`.

The DCAT-US schema marks `contactPoint` and `description` Mandatory. We do not make up a
contact or a description. Those two are the only schema errors we accept; tests check that
nothing else fails.

## Field mapping

| Our field | Croissant 1.1 | DCAT-US 3.0 Dataset |
|---|---|---|
| `name` | `name` | `title` |
| `description` (HTML stripped) | `description` | `description` |
| `dataset_id` (`portal:native`) | `identifier` | `identifier` |
| `permalink` | `url` | `landingPage` (Document: `title`, `accessURL`) |
| `created_at` | `datePublished` | `issued` |
| `updated_at` | `dateModified` | `modified` |
| `publisher` | `creator` and `publisher` (Organization) | `publisher` (Organization) |
| no `publisher` | `publisher` = registry entity that runs the portal | same |
| tags + categories | `keywords` | `keyword` (tags), `theme` (categories, as strings) |
| our topics (derived) | `keywords` (topic names, plain text) | `theme` as Concept in a BetaNYC ConceptScheme |
| `update_frequency` | none | `accrualPeriodicity`, exact words only (table in code); others left out |
| `extent` | `spatialCoverage` (Place, GeoShape `box`) | `spatial` (Location, GeoJSON Polygon `bbox`) |
| `formats[]` | `distribution[]` FileObject: `contentUrl`, `encodingFormat` (MIME type; formats without one are left out) | `distribution[]`: `title`, `mediaType`, `downloadURL` for files, `accessURL` for APIs and pages |
| derived links | FileObject `description` says so | Distribution `description` says so |
| columns (`dataset_columns`) | none: a RecordSet field must say which file column it reads, and we never read the files | none: DCAT-US `describedBy` needs a data dictionary file |
| harvest time | `sdDatePublished`, `sdPublisher` = BetaNYC | Catalog `modified` |

Left blank on purpose: `contactPoint`, `version`, `citeAs`, `sameAs`, checksums,
`accessRights`, `bureauCode`/`programCode` (federal only), `temporal`, and a place name for
the extent (the portal's place is not the dataset's place), and column lists (still in
`get_dataset_columns`).

## License (decision E3)

The `license` column is free text from the portal. On the 2026-11-05 index, 6,884 of 9,569
datasets (71.9%) have none. The rest is a mix: real license names, "See Terms of Use",
URLs, and long disclaimers. Each value is sorted into one of four kinds. Rules are exact
words, not guesses:

1. **License.** The text is a known license name (table in `src/standards/license.ts`:
   Public Domain, CC BY 4.0, ODbL ...). A URL is added only when the name says which
   version (so "Attribution CC BY" keeps its words and gets no URL).
   Croissant `license`; DCAT-US `license`.
2. **Terms page.** No license, but there is a terms-of-use URL: in the portal's own text for
   that dataset, or in `data/terms-pages.json` for the portal. Labeled
   **"terms page, not a license"**. Croissant `usageInfo` (CreativeWork); DCAT-US `rights`.
   Never in `license`.
3. **Statement.** Other text from the portal (disclaimers, use limits). Kept word for word:
   Croissant `usageInfo`; DCAT-US `rights`. Never in `license`.
4. **Nothing.** No text, or "None". No license field, no rights field.

**Where terms pages come from.** The registry has no terms-of-use field. The build makes no
live calls to portals. Terms pages come from two places:

- URLs a portal wrote into a dataset's own license text. These win.
- `data/terms-pages.json`, checked by hand on 2026-11-14: each of the 35 portals in the
  2026-11-05 index was opened (home page, footer, About page) to find its own terms page.
  **10 have one** and are listed with the URL, the exact page title, the date, and how it
  was found. `kind: "platform"` marks a vendor's page that the portal itself links to (only
  Lehman College, which links Tyler's Socrata agreement); the output says so. **25 have none**
  (most ArcGIS Hub sites keep the template's empty "Terms of Use" link) or were blocked
  (Nassau's robots.txt disallows every page). They are listed under `checked_without_terms`
  with the reason.

On the 2026-11-05 index this gives: 791 licenses, 5,312 terms pages (72 from the dataset,
5,240 from the portal table), 1,360 statements only, and 2,106 with nothing.

## Statewide files (decision E4)

Built by `prepare` beside `topic-crosswalk.csv`, from the same published copy, and uploaded
with every snapshot and to `index-latest`:

- `ny-data-dcat-us.json.gz`: one DCAT-US 3.0 Catalog with every live dataset.
- `ny-data-croissant.jsonl.gz`: one Croissant document per line (Croissant describes one
  dataset per document; there is no standard multi-dataset container).

Gzipped, because both are mostly repeated keys. On the 2026-11-05 index (9,569 datasets):
the DCAT-US file is 2.8 MB (19.2 MB unzipped), the Croissant file 3.0 MB (30.3 MB unzipped).
They are optional side files, like the crosswalk: a rollback to a snapshot that has them
copies them; to one that lacks them removes them from `index-latest`, last. They never sit
beside an index they do not describe. Each names its index: the Catalog's `modified` and each
Croissant document's `sdDatePublished` are the index's harvest time.

## Tool and CLI

- `get_dataset_columns` takes `standard: "croissant" | "dcat-us"`. It returns that one
  document, its license kind, which required fields were left out and why, and links to the
  statewide files. Without `standard`, the reply is unchanged.
- `ny-data-registry standards [--out-dir dir]` builds both statewide files from the installed
  index (default `${cacheDir}/standards/`) and prints counts by license kind.

## Validation

- DCAT-US: every Dataset and the Catalog checked with Ajv (draft 2020-12) against the
  vendored GSA schema. Ajv has no `iri` format; tests add one that requires an absolute URL.
  Only `required` errors for `contactPoint` and a missing `description` are allowed.
- Croissant: tests check the spec's required fields and mlcroissant's error rules listed
  above (unique `@id`s, FileObject fields, `isLiveDataset`, license as text, keywords as
  text, no RecordSet). mlcroissant itself is a Python package, so it is not part of
  `npm test`; it was run by hand on all 9,569 documents built from the 2026-11-05 index
  (results in the PR).
