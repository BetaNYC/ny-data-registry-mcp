// In server mode, stdout carries only MCP protocol messages; diagnostics go to stderr (#44).
// Starts the real server, calls every tool over raw stdio, and checks every stdout line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { tempIndexPath, buildFixtureIndex } from "./helpers.mjs";

const index = await buildFixtureIndex(tempIndexPath());
const server = fileURLToPath(new URL("../dist/index.js", import.meta.url));

test("every line the server writes to stdout is a JSON-RPC message", async () => {
  const child = spawn(process.execPath, [server], {
    env: { ...process.env, NY_DATA_INDEX: index, NY_DATA_OFFLINE: "1", NY_DATA_REGISTRY_REFRESH: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.resume();
  const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const waitFor = async (id) => {
    for (let i = 0; i < 400; i++) {
      if (out.split("\n").some((l) => l.includes(`"id":${id}`))) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`no response to request ${id}`);
  };
  try {
    send({ id: 1, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "stdout-test", version: "0" } } });
    await waitFor(1);
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list" });
    await waitFor(2);
    const tools = JSON.parse(out.split("\n").find((l) => l.includes('"id":2'))).result.tools;
    let id = 3;
    for (const t of tools) {
      // Wrong arguments on purpose for some: the error path must stay clean too.
      send({ id, method: "tools/call", params: { name: t.name, arguments: t.name === "registry_info" ? {} : { nonsense: 1 } } });
      await waitFor(id++);
    }
    send({ id, method: "tools/call", params: { name: "search_datasets", arguments: { query: "zoning" } } });
    await waitFor(id);
  } finally {
    child.kill();
  }
  const lines = out.split("\n").filter((l) => l.length);
  assert.ok(lines.length >= 3);
  for (const l of lines) {
    let m;
    assert.doesNotThrow(() => (m = JSON.parse(l)), `not JSON on stdout: ${l.slice(0, 200)}`);
    assert.equal(m.jsonrpc, "2.0", l.slice(0, 200));
  }
});
