// First-run index download. A local HTTP server on 127.0.0.1 plays the GitHub release;
// nothing leaves the machine (NY_DATA_OFFLINE=1 stays on; loopback is the one exception).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, readdirSync, mkdtempSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tempIndexPath, buildFixtureIndex } from "./helpers.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const fixtureDb = readFileSync(await buildFixtureIndex(tempIndexPath()));
const fixtureGz = gzipSync(fixtureDb);

let hits = 0;
let sums = `${sha(fixtureGz)}  ny-data-index.sqlite.gz\n${sha(fixtureDb)}  ny-data-index.sqlite\n`;
let body = fixtureGz;
const server = createServer((req, res) => {
  if (req.url.endsWith("/SHA256SUMS")) return res.end(sums);
  if (req.url.endsWith("/ny-data-index.sqlite.gz")) {
    hits++;
    return res.end(body);
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const URL_ = `http://127.0.0.1:${server.address().port}/latest/download/ny-data-index.sqlite.gz`;
after(() => server.close());

const { downloadIndex, autoDownloadAllowed } = await import("../dist/fetchindex.js");
const fresh = () => join(mkdtempSync(join(tmpdir(), "nydr-dl-")), "sub", "ny-data-index.sqlite");
const leftovers = (p) => readdirSync(dirname(p)).filter((f) => f.includes(".part") || f.endsWith(".lock"));

test("downloads, verifies both checksums, and installs the index", async () => {
  const p = fresh();
  const r = await downloadIndex({ path: p, url: URL_ });
  assert.equal(r.bytes, fixtureDb.length);
  assert.deepEqual(readFileSync(p), fixtureDb);
  assert.deepEqual(leftovers(p), []);
});

test("leaves an existing index alone unless forced", async () => {
  const p = fresh();
  await downloadIndex({ path: p, url: URL_ });
  writeFileSync(p, "keep me");
  const before = hits;
  const r = await downloadIndex({ path: p, url: URL_ });
  assert.equal(r.skipped, true);
  assert.equal(readFileSync(p, "utf8"), "keep me");
  assert.equal(hits, before);
  await downloadIndex({ path: p, url: URL_, force: true });
  assert.deepEqual(readFileSync(p), fixtureDb);
});

test("a checksum mismatch installs nothing", async () => {
  const p = fresh();
  sums = `${"0".repeat(64)}  ny-data-index.sqlite.gz\n${sha(fixtureDb)}  ny-data-index.sqlite\n`;
  try {
    await assert.rejects(downloadIndex({ path: p, url: URL_ }), /checksum mismatch/);
    assert.equal(existsSync(p), false);
    assert.deepEqual(leftovers(p), []);
  } finally {
    sums = `${sha(fixtureGz)}  ny-data-index.sqlite.gz\n${sha(fixtureDb)}  ny-data-index.sqlite\n`;
  }
});

test("a SHA256SUMS without the index lines is refused", async () => {
  const p = fresh();
  const saved = sums;
  sums = "nothing useful here\n";
  try {
    await assert.rejects(downloadIndex({ path: p, url: URL_ }), /refusing an unverified index/);
    assert.equal(existsSync(p), false);
  } finally {
    sums = saved;
  }
});

test("a non-index file with matching sums is refused by the schema check", async () => {
  const p = fresh();
  const junk = Buffer.from("not a sqlite file");
  const junkGz = gzipSync(junk);
  const saved = sums;
  body = junkGz;
  sums = `${sha(junkGz)}  ny-data-index.sqlite.gz\n${sha(junk)}  ny-data-index.sqlite\n`;
  try {
    await assert.rejects(downloadIndex({ path: p, url: URL_ }));
    assert.equal(existsSync(p), false);
    assert.deepEqual(leftovers(p), []);
  } finally {
    body = fixtureGz;
    sums = saved;
  }
});

test("two concurrent downloads fetch the file once", async () => {
  const p = fresh();
  const before = hits;
  const [a, b] = await Promise.all([downloadIndex({ path: p, url: URL_ }), downloadIndex({ path: p, url: URL_ })]);
  assert.equal(hits - before, 1);
  assert.ok(a.skipped || b.skipped);
  assert.deepEqual(readFileSync(p), fixtureDb);
});

test("offline mode and the opt-out both stop a real-network download", () => {
  assert.equal(autoDownloadAllowed("https://github.com/x/y.gz").allowed, false);
  assert.equal(autoDownloadAllowed(URL_).allowed, true);
  process.env.NY_DATA_INDEX_AUTO_DOWNLOAD = "0";
  try {
    assert.equal(autoDownloadAllowed(URL_).allowed, false);
  } finally {
    delete process.env.NY_DATA_INDEX_AUTO_DOWNLOAD;
  }
});

test("the stdio server fetches a missing index on first run and the dataset tools answer", async () => {
  const p = fresh();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    env: { ...process.env, NY_DATA_INDEX: p, NY_DATA_INDEX_URL: URL_, NY_DATA_OFFLINE: "1", NY_DATA_REGISTRY_REFRESH: "0" },
  });
  const client = new Client({ name: "dl", version: "0.0.0" });
  await client.connect(transport);
  try {
    const r = await client.callTool({ name: "search_datasets", arguments: { query: "zoning" } });
    assert.notEqual(r.isError, true, r.content?.[0]?.text);
    assert.ok(existsSync(p));
    const info = JSON.parse((await client.callTool({ name: "registry_info", arguments: {} })).content[0].text);
    assert.ok(["installed", "not-started"].includes(info.index_download.status), info.index_download.status);
  } finally {
    await client.close();
  }
});

test("with downloads off, a dataset tool explains how to get the index", async () => {
  const p = fresh();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    env: { ...process.env, NY_DATA_INDEX: p, NY_DATA_INDEX_AUTO_DOWNLOAD: "0", NY_DATA_OFFLINE: "1", NY_DATA_REGISTRY_REFRESH: "0" },
  });
  const client = new Client({ name: "dl-off", version: "0.0.0" });
  await client.connect(transport);
  try {
    const r = await client.callTool({ name: "search_datasets", arguments: { query: "zoning" } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /automatic download is off: NY_DATA_INDEX_AUTO_DOWNLOAD=0/);
    assert.match(r.content[0].text, /ny-data-registry download/);
    assert.equal(existsSync(p), false);
  } finally {
    await client.close();
  }
});
