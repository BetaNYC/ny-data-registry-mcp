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
const BUDGET_CHARS = 27_000;

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
