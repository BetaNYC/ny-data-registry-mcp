// The evaluation set (eval/questions.json) stays well formed (#40): at least 10 questions with
// known answers, each step naming a real tool with arguments that tool accepts and one check.
// Scoring needs the real index, so it runs in the nightly harvest's gate and by hand
// (node dist/cli.js eval --out eval/runs/YYYY-MM-DD-question-set.md), not here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./helpers.mjs";
import { TOOLS, parseToolArgs } from "../dist/tools.js";

const set = JSON.parse(readFileSync(new URL("../eval/questions.json", import.meta.url), "utf8"));
const CHECKS = ["answer", "field", "min", "top3", "top3_any", "none"];

test("at least 10 questions, unique ids, each with a question and steps", () => {
  assert.ok(set.questions.length >= 10, `${set.questions.length} questions`);
  assert.equal(new Set(set.questions.map((q) => q.id)).size, set.questions.length, "ids are unique");
  for (const q of set.questions) {
    assert.ok(q.q && q.q.trim(), q.id);
    assert.ok(Array.isArray(q.steps) && q.steps.length, q.id);
  }
});

test("every step names a real tool, passes its argument check, and has exactly one known check", () => {
  const names = new Set(TOOLS.map((t) => t.name));
  for (const q of set.questions) {
    for (const s of q.steps) {
      assert.ok(names.has(s.tool), `${q.id}: no tool ${s.tool}`);
      assert.doesNotThrow(() => parseToolArgs(s.tool, s.args), `${q.id}: ${s.tool} rejects ${JSON.stringify(s.args)}`);
      const kinds = Object.keys(s.check ?? {});
      assert.equal(kinds.length, 1, `${q.id}: ${kinds}`);
      assert.ok(CHECKS.includes(kinds[0]), `${q.id}: unknown check ${kinds[0]}`);
    }
  }
});

// Lists are paged since 0.4.0 (25 rows per list by default). The eval's invariants read every row
// of list_sources_for_place's lists, so its steps ask for the most rows (limit 100), and against
// the bundled registry each such answer then lists every row. No index and no network needed.
test("list_sources_for_place steps ask for every row, and get them from the bundled registry", async () => {
  const { PLACE_LIST_MAX, listSourcesForPlace } = await import("../dist/sources.js");
  const { cutLists } = await import("../dist/eval.js");
  const steps = set.questions.flatMap((q) => q.steps.filter((s) => s.tool === "list_sources_for_place").map((s) => [q.id, s]));
  assert.ok(steps.length > 0);
  for (const [id, s] of steps) {
    assert.equal(s.args.limit, PLACE_LIST_MAX, `${id}: list_sources_for_place without limit ${PLACE_LIST_MAX}`);
    const body = listSourcesForPlace(s.args.place, s.args.include_statewide ?? true, s.args.limit);
    assert.deepEqual(cutLists(body), [], `${id}: a list is still cut`);
  }
  // cutLists itself: a 25-row page of a longer list is reported.
  const big = listSourcesForPlace("Long Island", true);
  assert.ok(cutLists(big).some((c) => /^own 25 of \d+$/.test(c)), JSON.stringify(cutLists(big)));
});

// Post-merge (epic #33): the eval CLI with no index says so in one plain line and exits 1, with
// no stack trace. Offline, with an empty home folder, so there is no index to find.
test("eval with no index: a plain message on stderr, exit 1, no stack", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const home = mkdtempSync(join(tmpdir(), "nydr-evalhome-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, NY_DATA_OFFLINE: "1", NY_DATA_REGISTRY_REFRESH: "0", NY_DATA_INDEX_AUTO_DOWNLOAD: "0" };
  for (const k of ["NY_DATA_INDEX", "NY_DATA_CACHE_DIR"]) delete env[k];
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "eval"], { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 1, r.stderr);
  // Node's own warnings are not ours: Node 22.16 prints "(node:123) ExperimentalWarning: SQLite is
  // an experimental feature…" and a "(Use `node --trace-warnings …`)" hint first. Everything else
  // on stderr must be exactly one line, the plain message.
  const nodeWarning = /^\(node:\d+\) \w*Warning: |^\(Use `node --trace-warnings/;
  const ours = r.stderr.split(/\r?\n/).filter((l) => l && !nodeWarning.test(l));
  assert.equal(ours.length, 1, r.stderr);
  assert.match(ours[0], /^The dataset index is not installed yet \(looked for /);
  assert.doesNotMatch(r.stderr, /^\s+at\s/m, "no stack frames");
  assert.doesNotMatch(r.stderr, /NoIndexError|Node\.js v/);
  assert.equal(r.stdout, "");
});
