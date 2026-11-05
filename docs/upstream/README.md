---
title: "Proposed upstream change: platform_family in the NY data portal registry"
created: 2026-11-05
type: proposal
status: draft
tags: [type/proposal, domain/engineering, topic/open-data]
---

# Proposed upstream change (not applied)

`0001-add-platform-family.patch` adds one field, `platform_family`, to every row of
`BetaNYC/grounding-ai-with-ny-open-data` `resources/ny-data-portal-registry.json`, right
after `platform`, and adds it to the `fields` list. It is additions only (141 added lines).
It was generated from `data/platform-families.json` and the bundled registry dated
2026-11-05. **It has not been applied.** That repo is being edited in another session
(issue #27), and publishing there goes through QA.

Values: `socrata`, `arcgis-hub`, `arcgis-enterprise`, `arcgis-server`, `ckan`,
`geoblacklight`, `custom-api`, `none`, or `null` where the registry itself cannot say how
the data is reached (8 rows whose platform or API is UNCONFIRMED: Custom site, 511NY,
WordPress ×2, Confluence, Custom web map, Unknown, Vue app). `null` is a flag for research,
not a guess.

The registry has **101 distinct `platform` strings**, not the ~30 estimated in the scoping
doc, so a normalized column is worth having.

If accepted, the same column should be added to `ny-data-portal-registry.csv` and, if
wanted, to the Markdown tables. The MCP already reads an upstream `platform_family` when
present and prefers it to its local table (`src/registry.ts`).

Judgment calls in the mapping worth a second look:
- "ArcGIS Online" REST directories (DEC, Parks, DCP) → `arcgis-server`. There is no
  `arcgis-online` family in the agreed list.
- ArcGIS Online / Experience Builder *viewer apps* with no API → `none`.
- Viewer apps backed by a county ArcGIS Server (Greene, Washington, Cayuga, Utica) → `arcgis-server`.
- "Retired" / "Map Warper (retired)" → `none`; "Socrata (retired)" (City of Albany) stays `socrata` with status `dead`.
