import { test } from "node:test";
import assert from "node:assert/strict";
import "./helpers.mjs";
import { TOOLS, callTool } from "../dist/tools.js";

test("every advertised tool schema rejects unknown parameters", () => {
  for (const tool of TOOLS) assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
});

test("exactly the eleven planned tools are advertised", () => {
  // The nine registry and index tools, plus whats_changed and about_betanyc (BetaNYC standard tools).
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), [
    "about_betanyc", "check_source", "find_joinable", "find_sources", "get_dataset_columns", "how_to_query",
    "list_sources_for_place", "registry_info", "search_datasets", "whats_changed", "whats_new",
  ]);
});

test("an unknown parameter is rejected by name, with the accepted ones listed", async () => {
  const r = await callTool("find_sources", { query: "parcels", county: "Erie" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /'county'/);
  assert.match(r.content[0].text, /\bplace\b/);
});

test("a bad enum value is an error, not a silent default", async () => {
  const r = await callTool("find_sources", { query: "x", platform_family: "arcgis" });
  assert.equal(r.isError, true);
});
