import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./helpers.mjs";
import { politeFetch, OfflineError, BlockedError, resetHttpState } from "../dist/http.js";
import { USER_AGENT } from "../dist/paths.js";

test("offline mode refuses every request", async () => {
  await assert.rejects(politeFetch("https://example.invalid/"), OfflineError);
});

// The tests below stub global fetch; nothing leaves the machine.
async function withStub(handler, fn) {
  const realFetch = globalThis.fetch;
  const saved = process.env.NY_DATA_OFFLINE;
  process.env.NY_DATA_OFFLINE = "0";
  process.env.NY_DATA_CACHE_DIR = mkdtempSync(join(tmpdir(), "nydr-http-"));
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), at: Date.now(), headers: init?.headers ?? {} });
    return handler(String(url), init, calls);
  };
  resetHttpState();
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
    process.env.NY_DATA_OFFLINE = saved;
    resetHttpState();
  }
}

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("one descriptive User-Agent with no email, robots.txt read first, and >= 1 s between requests to a host", async () => {
  await withStub(
    (url) => (url.endsWith("/robots.txt") ? new Response("User-agent: *\nDisallow: /private/\n") : json({ ok: true })),
    async (calls) => {
      await politeFetch("https://a.example/one");
      await politeFetch("https://a.example/two");
      assert.equal(calls[0].url, "https://a.example/robots.txt");
      const gaps = calls.slice(1).map((c, i) => c.at - calls[i].at);
      for (const g of gaps) assert.ok(g >= 990, `gap ${g} ms`);
      assert.equal(calls[1].headers["User-Agent"], USER_AGENT);
      assert.doesNotMatch(USER_AGENT, /@/);
      await assert.rejects(politeFetch("https://a.example/private/x"), BlockedError);
    }
  );
});

test("conditional requests: the ETag is sent back and a 304 is served from cache", async () => {
  await withStub(
    (url, init) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (init.headers["If-None-Match"] === '"v1"') return new Response(null, { status: 304 });
      return json({ n: 1 }, 200, { etag: '"v1"' });
    },
    async () => {
      const a = await politeFetch("https://b.example/feed.json", { cache: true });
      const b = await politeFetch("https://b.example/feed.json", { cache: true });
      assert.equal(a.fromCache, false);
      assert.equal(b.notModified, true);
      assert.deepEqual(JSON.parse(b.body), { n: 1 });
    }
  );
});

test("an HTML page where JSON was expected is a block, not data", async () => {
  await withStub(
    (url) => (url.endsWith("/robots.txt") ? new Response("", { status: 404 }) : new Response("<html><title>Just a moment</title></html>", { status: 200 })),
    async () => {
      await assert.rejects(politeFetch("https://c.example/api", { expectJson: true }), BlockedError);
    }
  );
});

test("a layer blocked by robots.txt is skipped with a note; it does not fail the portal", async () => {
  const { fetchServiceColumns } = await import("../dist/harvest/arcgis.js");
  await withStub(
    (url) => (url.endsWith("/robots.txt") ? new Response("User-agent: *\nDisallow: /arcgis/\n") : json({ fields: [] })),
    async () => {
      const r = await fetchServiceColumns("https://third-party.example/arcgis/rest/services/X/MapServer/0", { left: 5 });
      assert.match(r.error, /^blocked: disallowed by robots.txt/);
      assert.deepEqual(r.columns, []);
    }
  );
});

test("an unstable Hub listing (repeats, short of numberMatched) is incomplete, so nothing gets marked removed", async () => {
  const { listHubItems } = await import("../dist/harvest/arcgis.js");
  const feat = (id) => ({ id, properties: { id, title: id } });
  await withStub(
    (url) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url.includes("startindex=1&")) return json({ features: [feat("a"), feat("b")], numberMatched: 4, links: [{ rel: "next" }] });
      return json({ features: [feat("b"), feat("c")], numberMatched: 4, links: [] });
    },
    async (calls) => {
      const l = await listHubItems("https://hub.example");
      assert.deepEqual(l.items.map((i) => i.id), ["a", "b", "c"]);
      assert.equal(l.complete, false);
      assert.match(l.error, /3 unique of 4/);
      assert.ok(calls.some((c) => c.url.includes("sortBy=%2Bid")), "pages are requested sorted by id");
    }
  );
});
