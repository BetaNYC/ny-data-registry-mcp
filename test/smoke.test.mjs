// Stdio smoke test: start the real server as a child process and call every tool
// through the MCP client. Offline: the index is built from fixtures, and the server
// runs with NY_DATA_OFFLINE=1 so nothing can reach the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tempIndexPath, buildFixtureIndex } from "./helpers.mjs";

const index = await buildFixtureIndex(tempIndexPath());
const server = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const CALLS = [
  ["find_sources", { query: "health" }],
  ["list_sources_for_place", { place: "Erie County", include_statewide: false }],
  ["how_to_query", { entity: "Nassau County" }],
  ["check_source", { source_id: "nys-department-of-health" }],
  ["registry_info", {}],
  ["search_datasets", { query: "zoning" }],
  ["get_dataset_columns", { dataset: "dea35a11cfbf4adeb083df6d63cf1f88" }],
  ["find_joinable", { dataset: "test-0001" }],
  ["whats_new", { since: "2000-01-01" }],
];
// The two BetaNYC standard tools answer in plain text plus structuredContent, not JSON text.
const SHARED_CALLS = [
  ["whats_changed", { limit: 2 }],
  ["about_betanyc", {}],
];

test("stdio server starts, lists 11 tools, and answers every one", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    env: { ...process.env, NY_DATA_INDEX: index, NY_DATA_OFFLINE: "1", NY_DATA_REGISTRY_REFRESH: "0" },
  });
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 11);
    for (const [name, args] of CALLS) {
      const r = await client.callTool({ name, arguments: args });
      assert.notEqual(r.isError, true, `${name}: ${r.content?.[0]?.text}`);
      const body = JSON.parse(r.content[0].text);
      assert.ok(body && typeof body === "object", name);
    }
    for (const [name, args] of SHARED_CALLS) {
      // Client.callTool validates structuredContent against the tool's outputSchema.
      const r = await client.callTool({ name, arguments: args });
      assert.notEqual(r.isError, true, `${name}: ${r.content?.[0]?.text}`);
      assert.equal(r.structuredContent.server.name, "ny-data-registry-mcp", name);
    }
    const erie = JSON.parse((await client.callTool({ name: "list_sources_for_place", arguments: { place: "Erie County" } })).content[0].text);
    assert.equal(erie.answer, "no-portal-exists");
  } finally {
    await client.close();
  }
});
