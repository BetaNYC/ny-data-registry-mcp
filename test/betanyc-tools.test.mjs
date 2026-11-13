// whats_changed and about_betanyc, the two tools BetaNYC is adding to each of its MCP servers
// (betanyc-ai-workspace platform/system/whats-changed-standard.md § 7). They read this repo's
// WHATS-CHANGED.md and fixed text, need no dataset index, and never touch the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import "./helpers.mjs";
import { callTool, TOOLS } from "../dist/tools.js";
import { VERSION } from "../dist/paths.js";
import { SHARED_MODULE_VERSION } from "../dist/betanyc-tools.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url)));
const whatsChanged = readFileSync(new URL("../WHATS-CHANGED.md", import.meta.url), "utf8");
const REPO = "https://github.com/BetaNYC/ny-data-registry-mcp";
const FILE = `${REPO}/blob/HEAD/WHATS-CHANGED.md`;
// Dated entries only: the tool leaves out an "## Unreleased:" entry (the version waiting for its tag).
const entryCount = (whatsChanged.match(/^## [0-9]{4}-[0-9]{2}-[0-9]{2}: /gm) ?? []).length;
const unreleased = (whatsChanged.match(/^## Unreleased: /gm) ?? []).length;

const textOf = (r) => r.content[0].text;

test("the version the server reports is package.json's, and server.json agrees", () => {
  // VERSION is written by hand in src/paths.ts; a bump that misses it would misreport.
  assert.equal(VERSION, pkg.version);
  assert.equal(server.version, pkg.version);
  for (const p of server.packages) assert.equal(p.version, pkg.version);
});

test("both shared tools are advertised, read-only, with an output schema", () => {
  for (const name of ["whats_changed", "about_betanyc"]) {
    const t = TOOLS.find((x) => x.name === name);
    assert.ok(t, name);
    assert.equal(t.outputSchema.type, "object", name);
    assert.equal(t.annotations.readOnlyHint, true, name);
    assert.equal(t.inputSchema.additionalProperties, false, name);
  }
});

test("whats_changed and whats_new describe different things, and say so", () => {
  const changed = TOOLS.find((t) => t.name === "whats_changed").description;
  const neu = TOOLS.find((t) => t.name === "whats_new").description;
  assert.match(changed, /^What has changed in this server/);
  assert.match(neu, /^Datasets added, changed or removed in the index since a date/);
  assert.match(neu, /For changes to this server itself \(new tools, fixes, corrections\), use whats_changed instead\./);
  // whats_new keeps its inputs.
  assert.deepEqual(Object.keys(TOOLS.find((t) => t.name === "whats_new").inputSchema.properties), ["since", "portal", "limit"]);
});

test("whats_changed answers from this repo's WHATS-CHANGED.md, with every entry valid", async () => {
  const r = await callTool("whats_changed", { limit: 50 });
  assert.notEqual(r.isError, true, textOf(r));
  const s = r.structuredContent;
  assert.deepEqual(s.server, { name: "ny-data-registry-mcp", version: pkg.version });
  assert.equal(s.source, FILE);
  assert.equal(s.history_begins, "2026-11-05");
  assert.equal(s.total_matching, entryCount);
  assert.equal(s.returned, entryCount);
  if (unreleased) assert.match(s.note, /not released yet/, "the note says an unreleased entry is left out");
  else assert.equal(s.note, null, "no entry was left out for an error");
  assert.doesNotMatch(s.note ?? "", /error/, "no entry was left out for an error");
  for (const e of s.entries) {
    assert.ok(e.url.startsWith(`${FILE}#${e.date}-`), e.url);
    for (const l of e.links) assert.match(l.url, /^https:\/\//, `${e.title}: ${l.url}`);
  }
});

test("the version in package.json has its own MCP entry, dated or Unreleased (release protocol)", async () => {
  assert.ok(unreleased <= 1);
  assert.match(
    whatsChanged,
    new RegExp(`- \\*\\*MCP version:\\*\\* \\[ny-data-registry-mcp ${pkg.version.replace(/\./g, "\\.")}\\]`)
  );
  const r = await callTool("whats_changed", { tag: "data" });
  assert.equal(r.structuredContent.filters.tag, "Data", "any case is accepted; answers use the canonical spelling");
  assert.ok(r.structuredContent.returned >= 1);
  const since = await callTool("whats_changed", { since: "2026-11-06" });
  for (const e of since.structuredContent.entries) assert.ok(e.date >= "2026-11-06", e.date);
});

test("whats_changed rejects bad arguments by name, and does not take whats_new's portal", async () => {
  for (const [args, re] of [
    [{ since: "last week" }, /since must be a real date/],
    [{ tag: "Datasets" }, /tag must be one of/],
    [{ limit: 51 }, /limit must be a whole number from 1 to 50/],
    [{ portal: "data.ny.gov" }, /does not accept 'portal'/],
  ]) {
    const r = await callTool("whats_changed", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(textOf(r), re);
  }
});

test("about_betanyc names the server, its version, and where to report a bug or ask for a new feature", async () => {
  const r = await callTool("about_betanyc", {});
  assert.notEqual(r.isError, true, textOf(r));
  const s = r.structuredContent;
  assert.deepEqual(s.server, {
    name: "ny-data-registry-mcp",
    version: pkg.version,
    repository: REPO,
    shared_module_version: SHARED_MODULE_VERSION,
  });
  assert.equal(s.built_by, "BetaNYC, a project of the Fund for the City of New York");
  assert.deepEqual(s.bugs_and_requests, { issues: `${REPO}/issues`, new_issue: `${REPO}/issues/new` });
  assert.equal(s.whats_changed, FILE);
  const bad = await callTool("about_betanyc", { verbose: true });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /takes no parameters/);
});

test("WHATS-CHANGED.md ships in the npm package", () => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" });
  const files = JSON.parse(out)[0].files.map((f) => f.path);
  assert.ok(files.includes("WHATS-CHANGED.md"), files.join(", "));
  assert.ok(files.includes("dist/betanyc-tools.js"));
});
