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
