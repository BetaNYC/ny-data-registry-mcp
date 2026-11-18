// Every failure is isError: true with a plain sentence and what to try (#43), and no error text
// repeats a key from env (#39).
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempIndexPath, buildFixtureIndex } from "./helpers.mjs";

process.env.NY_DATA_INDEX = await buildFixtureIndex(tempIndexPath());
const KEY = "fake-socrata-token-abcdef123456";
process.env.SOCRATA_APP_TOKEN = KEY;
const { callTool } = await import("../dist/tools.js");

const FAILURES = [
  ["get_dataset_columns", { dataset: "no-such-dataset" }, /no dataset 'no-such-dataset'.*search_datasets/],
  ["find_joinable", { dataset: "no-such-dataset" }, /no dataset 'no-such-dataset'.*search_datasets/],
  ["find_joinable", { dataset: "test-0001", column: "nope" }, /not a recognized join key/],
  ["whats_new", { since: "last week" }, /YYYY-MM-DD/],
  ["how_to_query", { source_id: "no-such-source" }, /no source with source_id.*find_sources/],
  ["check_source", { source_id: "no-such-source" }, /no source with source_id/],
  ["find_sources", { query: "parcels", place: "Narnia" }, /not a New York county/],
  ["search_datasets", { query: "parcels", place: "Narnia" }, /not a New York place.*such as/],
  ["how_to_query", {}, /give one of/],
  ["no_such_tool", {}, /Unknown tool: no_such_tool\. The tools are: find_sources/],
  ["find_sources", { query: "x", bogus: 1 }, /does not accept 'bogus'/],
];

test("every failure is isError with a plain sentence, no stack frames", async () => {
  for (const [name, args, re] of FAILURES) {
    const r = await callTool(name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}: ${r.content[0].text}`);
    assert.equal(r.content.length, 1);
    assert.match(r.content[0].text, /^Error: /);
    assert.match(r.content[0].text, re, name);
    assert.doesNotMatch(r.content[0].text, /^\s*at\s+\S/m, "no stack frames");
  }
});

test("no error text repeats the key from env", async () => {
  // An error whose text would carry the key (as an echoed upstream body might) gets it redacted.
  const r = await callTool("how_to_query", { source_id: KEY });
  assert.equal(r.isError, true);
  assert.ok(!r.content[0].text.includes(KEY), r.content[0].text);
  assert.match(r.content[0].text, /source_id '\[redacted\]'/);
  for (const [name, args] of FAILURES) {
    const t = (await callTool(name, args)).content[0].text;
    assert.ok(!t.includes(KEY), `${name}: ${t}`);
  }
});
