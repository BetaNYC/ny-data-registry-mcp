# What's changed

This page lists the changes to ny-data-registry-mcp that a reader would notice: new tools, new data, and corrections when the server gave a wrong answer. Newest first. Routine data refreshes are not listed. For datasets that are new on New York's open data portals, ask the server's whats_new tool; this page is about the server itself.

- **History begins:** 2026-11-05, the first release. Corrections made before this date may be missing.
- **Data refresh:** The list of New York data sources is checked for a newer copy each time the server starts. The index of datasets and columns is published by hand as a GitHub release; the first is from 2026-11-05.

To report a bug in this server or ask for a new feature, [open an issue on GitHub](https://github.com/BetaNYC/ny-data-registry-mcp/issues).

## Unreleased: A What's changed record, and two tools that explain the server

- **Tags:** MCP
- **What changed:** Two new tools let your AI assistant answer "what has changed in this server?" and "who built this?" with links to BetaNYC and to the place to report a bug in this server or ask for a new feature. The first reads this page. The tool for datasets that are new on the portals, whats_new, is unchanged.
- **MCP version:** [ny-data-registry-mcp 0.2.0](CHANGELOG.md)
- **More detail:** [Release notes](CHANGELOG.md)

## 2026-11-05: First release, with nine tools that find New York open data

- **Tags:** MCP
- **What changed:** The first version, published on npm, had nine tools. Five answer from BetaNYC's list of 140 New York data sources: which sources cover a place or topic, how to query one, and whether it still answers. Four search an index of the datasets and columns on those portals, find datasets that share a join key such as BBL or census tract, and list datasets added or changed since a date. The server downloads the index on first run.
- **MCP version:** [ny-data-registry-mcp 0.1.0](CHANGELOG.md#010--2026-11-05)
- **More detail:** [Release notes](CHANGELOG.md#010--2026-11-05) · [The release on GitHub](https://github.com/BetaNYC/ny-data-registry-mcp/releases/tag/v0.1.0) · [The package on npm](https://www.npmjs.com/package/@betanyc/ny-data-registry-mcp)

## 2026-11-05: An index of 9,569 datasets from 35 New York data portals

- **Tags:** Data
- **What changed:** The first published index holds the titles, descriptions, column names and types, formats and links of 9,569 datasets and 185,352 columns on 35 Socrata and ArcGIS portals. It holds no dataset contents and no row counts. About 1,163 ArcGIS datasets did not have their columns yet, and portals with no API, those that need a key or an account, and a few others were left out.
- **More detail:** [The index release](https://github.com/BetaNYC/ny-data-registry-mcp/releases/tag/index-2026-11-05) · [The dataset index](README.md#the-dataset-index)
