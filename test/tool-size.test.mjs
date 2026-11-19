// The tools/list JSON plus the server instructions is sent to the model on every turn, so its
// size is a cost (#41; the nyc-311-mcp test/tool-size.test.mjs pattern, same measure).
// Text several tools share belongs once in the server instructions, not in each description.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./helpers.mjs";
import { TOOLS, SERVER_INSTRUCTIONS } from "../dist/tools.js";
import { assertEveryToolAnnotated, toolListSize } from "../dist/betanyc-tools.js";

// Measured 2026-11-18 at 26,545 characters (13 tools, shared module 1.5.0, annotations on every
// tool). The budget is just above that. Raise it only on purpose, with a dated line here saying
// how big it was and why.
// Lowered 2026-11-18 to 26,500: the registry_id and runs_it notes moved from five tool
// descriptions into the server instructions (#45). Measured 25,947 after that, with the
// limit and offset parameters #38 added.
// 2026-11-19, budget unchanged: 26,334 with shared module 1.5.1, how_to_query's limit and offset,
// and check_source's one-request, matched-by-host wording (review fixes, epic #33).
const BUDGET_CHARS = 26_500;

test("tool definitions plus server instructions stay within the size budget", () => {
  const size = toolListSize(TOOLS, SERVER_INSTRUCTIONS);
  assert.ok(size <= BUDGET_CHARS, `tools/list JSON + instructions is ${size} characters, over the ${BUDGET_CHARS} budget`);
});

test("every tool is annotated read-only, and only check_source reaches a live outside API", () => {
  assertEveryToolAnnotated(TOOLS);
  for (const t of TOOLS) {
    assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.ok(t.annotations.title, `${t.name} has no title`);
  }
  assert.deepEqual(TOOLS.filter((t) => t.annotations.openWorldHint).map((t) => t.name), ["check_source"]);
});

test("no sentence repeats across tool descriptions: shared text goes in the instructions once (#45)", () => {
  const seen = new Map();
  for (const t of TOOLS) {
    for (const sentence of new Set(t.description.split(/(?<=\.)\s+/).filter((x) => x.length > 40))) {
      assert.ok(!seen.has(sentence), `"${sentence}" is in both ${seen.get(sentence)} and ${t.name}`);
      seen.set(sentence, t.name);
    }
  }
  for (const word of ["registry_id", "runs_it", "data_source"]) assert.match(SERVER_INSTRUCTIONS, new RegExp(word));
});
