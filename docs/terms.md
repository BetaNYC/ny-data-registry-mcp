---
title: "API docs and terms of use read before building the harvester"
created: 2026-11-05
type: reference
status: draft
tags: [type/reference, domain/engineering, topic/open-data, topic/terms-of-use]
---

# API docs and terms of use

Read 2026-11-05, before any adapter was written. This is a reading of the documents, not
legal advice. Where something was not found, it says so.

## Socrata / Tyler Data & Insights

**API docs used**
- Discovery API, official OpenAPI spec: https://dev.socrata.com/apis/discovery.yaml (rendered at
  https://dev.socrata.com/docs/other/discovery). Endpoint `https://api.us.socrata.com/api/catalog/v1`;
  `domains`, `search_context`, `only`, `limit`, `scroll_id` deep paging; asset fields
  `resource.columns_field_name`, `columns_datatype`, `data_updated_at`, `page_views`, `download_count`.
- App tokens and throttling: https://dev.socrata.com/docs/app-tokens.html
- SODA endpoints and formats (for the derived `/resource/<4x4>.json|.csv|.geojson` links):
  https://dev.socrata.com/docs/endpoints

**What they say about automated use**
- The Discovery spec's stated purpose: the API "opens up this corpus of government data for
  automated searching, research, and exploration." Automated catalog search is the intended use.
- "Authentication is not required to use this API for read-only access" to public assets.
- "All programmatic usage of Socrata APIs should include an app token." Without one, requests
  share an IP-based pool with lower limits. The harvester sends `X-App-Token` when
  `SOCRATA_APP_TOKEN` is set. **This build ran without a token** (one request per 500 assets,
  about 15 requests in total).
- App-token page: "Don't be a jerk … Applications that are determined to be abusive or
  malicious, or that otherwise monopolize the use of our API may be throttled."

**Terms of service**
- Tyler's Data & Insights SaaS License Agreement governs Tyler's *customers* (the governments),
  and makes each customer responsible for the terms that apply to its public users:
  https://www.tylertech.com/client-terms/data-insights-software-as-a-service-license-agreement
  (found by search; the agreement text itself was **not read in full**).
- Per-portal terms (NYC, data.ny.gov, Health Data NY, Buffalo, Nassau, Lehman): the URLs tried
  (`nyc.gov/html/data/terms.html`, `data.ny.gov/page/terms-of-use`) returned 404. **Not verified.**
  NYC's Open Data Law (Local Law 11 of 2012) makes public datasets available without
  registration or use restrictions; that is from a search result about the bill text, not
  re-read here.

**Verdict:** nothing found forbids a nightly read-only catalog harvest. Proceeded.

## Esri: ArcGIS Hub, ArcGIS Online, ArcGIS Enterprise

**API docs used**
- Hub feeds (DCAT-US 1.1 at `<siteURL>/api/feed/dcat-us/1.1.json`; OGC API - Records at
  `<siteURL>/api/search/definition`): https://doc.arcgis.com/en/hub/content/federate-data.htm
- Each Hub site's own OpenAPI definition (`/api/search/definition/?f=json`, read on Putnam's site):
  `limit` max 100, `startindex` 1-based, `next` link.
- DCAT-US 1.1 field meanings: https://resources.data.gov/resources/dcat-us/
- Portal search: https://developers.arcgis.com/rest/users-groups-and-items/search/ (`num` max 100,
  `start`, `nextStart`); query fields including `orgid:` and `owner:`:
  https://developers.arcgis.com/rest/users-groups-and-items/search-reference/
- Feature service and layer JSON: https://developers.arcgis.com/rest/services-reference/enterprise/feature-service/
  and https://developers.arcgis.com/rest/services-reference/enterprise/feature-layer/

**Terms read**
- ArcGIS Online terms of use page: https://doc.arcgis.com/en/arcgis-online/reference/terms-of-use.htm
  - Public content "is typically available for your personal or noncommercial use. The specific
    terms of use for content items are provided in the terms of use for that content."
  - Owners who share publicly "expressly grant Esri and end users of ArcGIS Online permission to
    use, reproduce, prepare derivative works of, and distribute content, subject to any use
    constraints you provide."
- Esri Master Agreement E204, current comparison PDF (8-1-25 to 8-14-26):
  https://www.esri.com/content/dam/esrisites/en-us/media/legal/ma-and-prod-spec-scope-of-use-changes/e204-comparison-8-1-25-to-8-14-26.pdf
  - §3.2: "Customer may not otherwise scrape, download, or store Data." But **"Data" is defined as
    "any commercially available digital dataset(s) … that Esri bundles with other Esri Offerings or
    delivers independently"**, that is Esri's own commercial data, not a county's published layers.
  - Older Product-Specific Terms (E300, 2014-2015 change notices) prohibited "systematically
    collecting Content from Online Services through screen or web scraping." The current E300
    (https://www.esri.com/content/dam/esrisites/en-us/media/legal/product-specific-terms-of-use/e300.pdf)
    was searched for "scrap", "systematic", "harvest", "crawl": **no match**.
  - The Master Agreement binds Esri customers. BetaNYC calls these endpoints anonymously, as any
    member of the public does.
- **robots.txt**: every Hub site checked (`data.gis.ny.gov`, Putnam) sends `Crawl-delay: 60`
  and disallows `/sites/`, `/admin/`, `/sessions/`, `/groups/`, `/people/`, `/workspace/`.
  The harvester honors both (one request per 60 s per Hub host). `www.arcgis.com` has no
  Disallow rules.

**Verdict:** harvesting public *metadata* (titles, descriptions, field names, links) of
county-published content is consistent with the terms read. Esri's own content (Living Atlas,
owner `esri…`, org `P3ePLMYs2RVChkJx`) is excluded, which also fixes the Monroe count. The
harvester never downloads data. Proceeded.

## Not called, by rule

- Rows with `key_required = Y` (9 rows).
- ANHD (account-gated, data-access policy).
- Rockland County (blocks bots; skipped, not worked around).
- Any endpoint the registry marks undocumented.
- Columbia University GeoBlacklight (excluded from the harvest: 104,570 records, mostly not NY).
