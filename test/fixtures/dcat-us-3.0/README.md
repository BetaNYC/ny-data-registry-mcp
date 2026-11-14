# DCAT-US 3.0 JSON Schema (vendored for tests)

The 26 files in this folder are copied unchanged from GSA's DCAT-US repository:

- Source: https://github.com/GSA/dcat-us/tree/a1dbaa040bab275abefc6df4fb77ed2ca18d920f/jsonschema/definitions
- Commit: `a1dbaa040bab275abefc6df4fb77ed2ca18d920f` (2026-10-06), the newest commit touching
  `jsonschema/definitions` when fetched.
- Fetched: 2026-11-14.
- License: CC0 1.0 (the repository's `LICENSE.md`; a work of the United States Government).
- Overview: https://resources.data.gov/resources/dcat-us3/

`test/standards.test.mjs` checks the DCAT-US output against `Catalog.json` and `Dataset.json`
with Ajv (JSON Schema 2020-12). To update, copy the newer files over these and record the new
commit and date here.
