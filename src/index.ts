#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, callTool } from "./tools.js";
import { refreshRegistry } from "./registry.js";
import { VERSION } from "./paths.js";

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
