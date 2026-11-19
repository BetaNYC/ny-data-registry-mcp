// check_source: one request per check, never to the address a caller gives, and an unreachable
// portal is an answer (with its verdict), not a tool failure. how_to_query's candidate lists are
// bounded. Every test stubs global fetch; nothing leaves the machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempIndexPath, buildFixtureIndex } from "./helpers.mjs";
import { politeFetch, resetHttpState } from "../dist/http.js";
import { registry } from "../dist/registry.js";

process.env.NY_DATA_INDEX = await buildFixtureIndex(tempIndexPath());
const { callTool } = await import("../dist/tools.js");

async function withStub(handler, fn) {
  const realFetch = globalThis.fetch;
  const saved = process.env.NY_DATA_OFFLINE;
  process.env.NY_DATA_OFFLINE = "0";
  process.env.NY_DATA_CACHE_DIR = mkdtempSync(join(tmpdir(), "nydr-check-"));
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
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

const unreachable = () => {
  throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED" } });
};
const LIVE = "nys-department-of-health";
const row = (id) => registry().sources.find((s) => s.source_id === id);
// A dead row with a portal URL that this server is allowed to call.
const DEAD = "new-york-public-library--spacetime-nypl-org";

async function answer(args) {
  const r = await callTool("check_source", args);
  assert.notEqual(r.isError, true, r.content[0].text);
  return JSON.parse(r.content[0].text);
}

test("A: unreachable portal, registry says live: a normal answer with a DRIFT verdict", async () => {
  assert.equal(row(LIVE).status, "live");
  await withStub(unreachable, async (calls) => {
    const b = await answer({ source_id: LIVE });
    assert.equal(b.checked, true);
    assert.equal(b.matches_registry, false);
    assert.match(b.verdict, /^DRIFT: registry says live, request failed \(network error for /);
    assert.match(b.request_error, /ECONNREFUSED/);
    assert.equal("error" in b, false);
    assert.equal(b.data_source.source, "NY Data Portal Registry", "a failed request cites the registry row, not a fetch");
    assert.equal(calls.length, 1);
  });
});

test("A: unreachable portal, registry says dead: a normal answer that agrees with the registry", async () => {
  assert.equal(row(DEAD).status, "dead");
  await withStub(unreachable, async (calls) => {
    const b = await answer({ source_id: DEAD });
    assert.equal(b.checked, true);
    assert.equal(b.matches_registry, true);
    assert.doesNotMatch(b.verdict, /DRIFT/);
    assert.ok(b.request_error);
    assert.equal(calls.length, 1);
  });
});

test("B: exactly one request per check on 500, 502, 504, 429 and a timeout, with the timeout kept", async () => {
  for (const status of [500, 502, 504, 429]) {
    await withStub(
      () => new Response("down", { status, headers: { "retry-after": "1" } }),
      async (calls) => {
        const started = Date.now();
        const b = await answer({ source_id: LIVE });
        assert.equal(calls.length, 1, `HTTP ${status}: ${calls.length} requests`);
        assert.ok(Date.now() - started < 900, `HTTP ${status}: waited ${Date.now() - started} ms`);
        assert.ok(calls[0].init.signal instanceof AbortSignal, "the request has its timeout");
        if (status === 429) {
          assert.equal(b.blocked, true);
          assert.match(b.reason, /HTTP 429 \(rate limited\); not retried/);
        } else {
          assert.equal(b.http_status, status);
          assert.equal(b.matches_registry, false);
        }
      }
    );
  }
  await withStub(
    () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    },
    async (calls) => {
      const b = await answer({ source_id: LIVE });
      assert.equal(calls.length, 1, "a timeout is not retried");
      assert.match(b.request_error, /timeout/);
      assert.match(b.verdict, /^DRIFT/);
    }
  );
});

test("B: politeFetch noRetry makes one request on a 503; without it, a 503 is retried", async () => {
  await withStub(
    (url) => (url.endsWith("/robots.txt") ? new Response("", { status: 404 }) : new Response("busy", { status: 503, headers: { "retry-after": "0" } })),
    async (calls) => {
      assert.equal((await politeFetch("https://n.example/x", { noRetry: true, skipRobots: true })).status, 503);
      assert.equal(calls.length, 1);
      await politeFetch("https://m.example/x", { skipRobots: true });
      assert.equal(calls.filter((c) => c.url.startsWith("https://m.example")).length, 3);
    }
  );
});

test("C: how_to_query lists 25 candidates by default, with total, showing and next_offset", async () => {
  const first = JSON.parse((await callTool("how_to_query", { entity: "county" })).content[0].text);
  assert.equal(first.ambiguous, true);
  assert.ok(first.total > 25, `${first.total} rows match 'county'`);
  assert.equal(first.candidates.length, 25);
  assert.equal(first.next_offset, 25);
  assert.match(first.showing, new RegExp(`^Rows 1 to 25 of ${first.total}\\. .*limit \\(up to 100\\) and offset \\(offset 25\\)`));
  const rest = JSON.parse((await callTool("how_to_query", { entity: "county", offset: 25, limit: 100 })).content[0].text);
  assert.equal(rest.candidates.length, first.total - 25);
  assert.equal(rest.next_offset, null);
  const ids = new Set([...first.candidates, ...rest.candidates].map((c) => c.source_id));
  assert.equal(ids.size, first.total, "the two pages cover every row once");
  assert.equal((await callTool("how_to_query", { entity: "county", limit: 101 })).isError, true);
  const one = JSON.parse((await callTool("how_to_query", { entity: "Nassau County" })).content[0].text);
  assert.equal(one.ambiguous, undefined, "a single match is unchanged");
});

test("C: check_source by a URL that several rows share checks only the best match, one request", async () => {
  const shared = registry().sources.filter((s) => /beacon\.schneidercorp\.com/.test(s.url ?? ""));
  assert.ok(shared.length > 1);
  const hamilton = shared.find((s) => /HamiltonCountyNY/.test(s.url));
  await withStub(
    () => new Response("<html></html>", { status: 200 }),
    async (calls) => {
      const b = await answer({ url: "https://beacon.schneidercorp.com/Application.aspx?App=HamiltonCountyNY&PageType=Search" });
      assert.equal(b.source.source_id, hamilton.source_id, "the row with the same App= wins");
      assert.equal(b.url_matches.total, shared.length);
      assert.equal(b.url_matches.checked, hamilton.source_id);
      assert.equal(b.url_matches.others.length, shared.length - 1);
      assert.match(b.url_matches.note, new RegExp(`^${shared.length} registry rows share this host`));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, hamilton.url.trim().split(/\s/)[0], "the registry row's URL, not the caller's");
    }
  );
});

test("G: unsafe addresses match no registry row and make no request", async () => {
  await withStub(
    () => new Response("should not be called", { status: 200 }),
    async (calls) => {
      for (const url of ["127.0.0.1", "http://127.0.0.1/", "file:///etc/passwd", "169.254.169.254", "http://169.254.169.254/latest/meta-data/"]) {
        const r = await callTool("check_source", { url });
        assert.equal(r.isError, true, url);
        assert.match(r.content[0].text, /no registry row/, url);
      }
      assert.equal(calls.length, 0);
    }
  );
});

test("G: a redirect is reported, not followed: exactly one request, redirect: manual", async () => {
  await withStub(
    () => new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
    async (calls) => {
      const b = await answer({ source_id: LIVE });
      assert.equal(b.http_status, 302);
      assert.equal(b.redirect_to, "http://169.254.169.254/latest/meta-data/");
      assert.match(b.verdict, /^redirects to /);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].init.redirect, "manual");
      assert.equal(calls[0].url, row(LIVE).url.trim().split(/\s/)[0]);
    }
  );
});
