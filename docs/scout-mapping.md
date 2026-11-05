---
title: "ny-data-registry-mcp → Scout field mapping"
created: 2026-11-05
type: reference
status: draft
tags: [type/reference, domain/engineering, project/scout, topic/open-data]
---

# Field mapping: this index → Scout

The index (`ny-data-index.sqlite`) is a superset of Scout's TypeORM entities in
`BetaNYC/scout` `packages/server/src` (Portal, Dataset, DatasetColumn, Tag), so Scout could
later read it. "Source" says where each value comes from: **portal** (copied from the
portal's own API response), **derived** (computed here; the `provenance` JSON on each
dataset row says which), or **null** (not collected; never invented).

Scout's entity field lists are taken from the 2026-11-05 Scout evaluation, not re-read from
Scout's source in this build. **Not verified against the current Scout code.**

## Portal

| This index (`portals`) | Scout `Portal` | Source |
|---|---|---|
| `id` (registry source id, e.g. `new-york-city`) | `id` | derived (slug of the registry entity, plus host when an entity has several rows) |
| `name` | `name` | registry `portal_name` (falls back to `entity`) |
| `base_url` | `baseURL` | registry `url` |
| `logo` | `logo` | null (not collected) |
| `admin_level` | `adminLevel` | derived from the registry's place: state, county, city, or the registry `entity_type` |
| `dataset_count` | `datasetCount` | derived: count of live (not removed) datasets after the harvest |
| `abbreviation` | `abbreviation` | null (not collected) |
| `entity`, `region`, `place_scope`, `place_counties`, `place_city` | — | registry, place derived |
| `platform_family`, `platform_raw`, `api_type_raw`, `api_endpoint` | — | family derived (`data/platform-families.json`); the rest registry, verbatim |
| `registry_dataset_count`, `registry_status`, `registry_last_verified` | — | registry |
| `harvest_adapter`, `harvest_status`, `harvest_note`, `last_harvested` | — | harvest |
| `socrata_domain`, `arcgis_org_id` | — | Socrata: from the registry's `/resource/` endpoint; ArcGIS: `portals/self` or item `orgId` |

## Dataset

| This index (`datasets`) | Scout `Dataset` | Socrata source | ArcGIS source |
|---|---|---|---|
| `native_id` | `id` | `resource.id` (the exact 4x4) | item `id` |
| `id` | — | `<portal>:<4x4>` (portal-namespaced; the 4x4 maps 1:1 to Scout) | `<portal>:<item id>` |
| `name` | `name` | `resource.name` | item `title` |
| `description` | `description` | `resource.description` | item `description`, else `snippet` |
| `department` | `department` | `domain_metadata` key matching agency/department, else `resource.attribution` | item `accessInformation`, else `source` |
| `categories` (JSON) | `categories[]` | `classification.domain_category` + `categories` | item `categories` |
| tags (`tags` + `dataset_tags`) | `Tag` | `classification.domain_tags` + `tags` | item `tags` |
| `metadata_updated_at` | `metadataUpdatedAt` | `resource.metadata_updated_at` | item `modified` (one date only on ArcGIS) |
| `updated_at` | `updatedAt` | `resource.data_updated_at` (else `updatedAt`) | item `modified` |
| `created_at` | `createdAt` | `resource.createdAt` | item `created` |
| `type` | `type` | `resource.type` (dataset, map, file, href) | item `type` (Feature Service, Map Service, CSV …) |
| `permalink` | `permalink` | asset `permalink` | DCAT `landingPage` (portal) or the item page URL (derived) |
| `downloads` | `downloads` | `resource.download_count` | **null** (ArcGIS gives none) |
| `views` | `views` | `resource.page_views.page_views_total` | item `numViews` |
| `update_frequency` | `updateFrequency` | `domain_metadata` key containing "frequency" | **null** |
| `portal_id` | `portalId` | — | — |
| `is_test` | `isTest` | always 0 | always 0 |
| `platform_family` | — | derived | derived |
| `api_endpoint` | — | `https://<domain>/resource/<4x4>.json` (derived, SODA pattern) | item `url` (FeatureServer/MapServer) |
| `formats` (JSON list of `{format, media_type, url, provenance}`) | — | derived: API (SODA), CSV, GeoJSON if a geo column exists; file mime type for `file` assets | DCAT `distribution` (portal) + the service URL |
| `place_counties`, `place_city` | — | derived from the portal's registry row | same |
| `extent` (`[minx, miny, maxx, maxy]`, WGS84) | — | null (Discovery gives none) | item `extent`, else DCAT `spatial` |
| `license` | — | `metadata.license` | item `licenseInfo`, else DCAT `license` |
| `publisher` | — | `resource.attribution` | item `source` / `accessInformation`, else DCAT `publisher.name` (unrendered `{{…}}` templates dropped) |
| `row_count` | — | **null** (Discovery gives none) | **null** (would need one extra query per layer; not collected) |
| `geometry_type` | — | derived from a geo column's datatype | layer `geometryType` (portal) |
| `owner`, `org_id` | — | null | item `owner`, `orgId` |
| `columns_status`, `column_count` | — | `from-search` | `fetched`, `not-fetched` (per-portal cap), `none`, `error` |
| `first_seen`, `last_seen`, `removed_at` | — | harvest | harvest |
| `content_hash` | — | derived | derived |
| `provenance` (JSON) | — | derived | derived |

## DatasetColumn

| This index (`dataset_columns`) | Scout `DatasetColumn` | Socrata source | ArcGIS source |
|---|---|---|---|
| `id` | `id` | autoincrement | autoincrement |
| `name` | `name` | `columns_name[i]` | field `alias` |
| `field` | `field` | `columns_field_name[i]` | field `name` |
| `type` | `type` | `columns_datatype[i]` | field `type` (`esriFieldType…`) |
| `description` | `description` | `columns_description[i]` | null |
| `portal_id` | `portal` | — | — |
| `dataset_id` | `dataset` | — | — |
| `layer` | — | null | layer name when a service has several layers |
| `key_label`, `key_scope` | — | derived from `data/key-columns.json` | same |

## Tag

`tags(id, portal_id, name)` and `dataset_tags(dataset_id, tag_id)` map to Scout's
`Tag(id, name, portal, datasets)`.
