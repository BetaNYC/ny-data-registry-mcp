// about_data stays small enough for one assistant turn (review of 0.4.0, 2026-11-19: the
// no-topic answer was 198,462 characters and one tool's 192,235). With no topic it is a short
// list that says how to ask for more; for one tool, BetaNYC's own sources in full and the portal
// catalogs one line each; for one source, that source in full. Nothing is lost: every source is
// still reachable by its topic, with its name, publisher and link, and "all" still gives every
// source in full. No network: about_data reads DATA-SOURCES.json and local state only.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./helpers.mjs";

const { callTool, TOOLS, betanycTools } = await import("../dist/tools.js");
const shared = betanycTools(); // the shared module's own about_data, every source in full
const ask = async (args) => {
  const r = await callTool("about_data", args);
  assert.notEqual(r.isError, true, r.content[0].text);
  return r;
};
const size = (r) => ({ text: r.content[0].text.length, structured: JSON.stringify(r.structuredContent).length });
const ALL = shared.call("about_data", {}).structuredContent.sources;
const required = TOOLS.find((t) => t.name === "about_data").outputSchema.required;
const sourceRequired = TOOLS.find((t) => t.name === "about_data").outputSchema.properties.sources.items.required;
const fitsSchema = (sc) => {
  for (const k of required) assert.ok(Object.hasOwn(sc, k), `structuredContent has ${k}`);
  for (const s of sc.sources) for (const k of sourceRequired) assert.ok(Object.hasOwn(s, k), `${s.topic} has ${k}`);
};

// Budgets, in characters of the text answer (structuredContent in brackets).
const NO_TOPIC = [8_000, 16_000];
const ONE_TOOL = [25_000, 35_000];
const ONE_SOURCE = [6_000, 8_000];

test("with no topic: a short list of every source, and how to ask for more", async () => {
  const r = await ask({});
  const { text, structured } = size(r);
  assert.ok(text <= NO_TOPIC[0], `${text} characters`);
  assert.ok(structured <= NO_TOPIC[1], `${structured} characters of structuredContent`);
  fitsSchema(r.structuredContent);
  assert.match(r.content[0].text, /call about_data with its topic/);
  assert.match(r.content[0].text, /give the tool's name as topic/);
  assert.match(r.content[0].text, /topic "all" gives every source in full/);
  assert.equal(r.structuredContent.overview.length, ALL.length);
  for (const s of ALL) {
    assert.ok(r.content[0].text.includes(`- ${s.topic}: ${s.source} (${s.publisher})`), s.topic);
    assert.ok(r.structuredContent.topics.includes(s.topic), s.topic);
  }
});

test("one tool: only the sources behind it, BetaNYC's in full and portal catalogs one line each", async () => {
  for (const t of TOOLS) {
    const want = shared.call("about_data", { topic: t.name });
    if (want.isError) continue; // whats_changed, about_betanyc, about_data describe the server
    const r = await ask({ topic: t.name });
    const { text, structured } = size(r);
    assert.ok(text <= ONE_TOOL[0], `${t.name}: ${text} characters`);
    assert.ok(structured <= ONE_TOOL[1], `${t.name}: ${structured} characters of structuredContent`);
    fitsSchema(r.structuredContent);
    const got = [...r.structuredContent.sources, ...(r.structuredContent.portal_catalogs ?? [])];
    // Exactly the sources the shared module gives for that tool: none lost, none added.
    assert.deepEqual(got.map((s) => s.topic).sort(), want.structuredContent.sources.map((s) => s.topic).sort(), t.name);
    for (const s of r.structuredContent.portal_catalogs ?? []) {
      assert.ok(r.content[0].text.includes(`- ${s.topic}: ${s.source} (${s.publisher}), ${s.source_url}`), `${t.name}: ${s.topic}`);
    }
  }
});

test("one source: that source in full, with its name, publisher and link; every source is reachable", async () => {
  for (const s of ALL) {
    const r = await ask({ topic: s.topic });
    const { text, structured } = size(r);
    assert.ok(text <= ONE_SOURCE[0], `${s.topic}: ${text} characters`);
    assert.ok(structured <= ONE_SOURCE[1], `${s.topic}: ${structured} characters of structuredContent`);
    assert.deepEqual(r.structuredContent, shared.call("about_data", { topic: s.topic }).structuredContent, `${s.topic}: the shared answer, unchanged`);
    assert.ok(r.content[0].text.includes(s.source) && r.content[0].text.includes(s.source_url), s.topic);
    assert.ok(r.content[0].text.includes(s.publisher) || s.publisher === "BetaNYC", s.topic);
  }
});

test("\"all\" still gives every source in full, as the shared module does", async () => {
  const r = await ask({ topic: "all" });
  assert.equal(r.structuredContent.sources.length, ALL.length);
  assert.equal(r.content[0].text, shared.call("about_data", { topic: "all" }).content[0].text);
});

test("about_data's topic says a short list is the default", () => {
  const d = TOOLS.find((t) => t.name === "about_data").inputSchema.properties.topic.description;
  assert.match(d, /Default: a short list of all sources/);
  assert.match(d, /"all": each in full/);
  assert.doesNotMatch(d, /Default: all/);
});
