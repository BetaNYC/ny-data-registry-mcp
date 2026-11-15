#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, callTool } from "./tools.js";
import { refreshRegistry } from "./registry.js";
import { VERSION } from "./paths.js";
import { ensureIndex } from "./fetchindex.js";
import { startAutoUpdate } from "./refresh.js";

const server = new Server({ name: "ny-data-registry-mcp", version: VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// The first call waits (max 5 s) for the conditional registry refresh; it falls back to the bundled copy.
const ready = refreshRegistry().catch(() => undefined);

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  await ready;
  return callTool(request.params.name, request.params.arguments) as any;
});

const transport = new StdioServerTransport();
await server.connect(transport);

// First run: fetch the prebuilt dataset index in the background (about 19 MB), so the
// dataset tools work without a manual step. Never blocks startup; errors surface in
// registry_info and in the dataset tools' replies.
void ensureIndex();

// Keep the index current (issue #15): a first check a few minutes after startup, then daily,
// on timers that never block a tool call or keep the process alive. A download happens only
// when the installed index is at least NY_DATA_INDEX_REFRESH_DAYS (5) old and a newer one is
// published. NY_DATA_INDEX_AUTO_UPDATE=0, or a NY_DATA_INDEX of your own, turns it off.
startAutoUpdate();
