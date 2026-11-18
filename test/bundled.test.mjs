// Bundled copies of other repos' data record where they came from, when, and a checksum (#42).
// The other files in data/ are written in this repo, so git is their record.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DATA = fileURLToPath(new URL("../data/", import.meta.url));
// Git on Windows may check text out with CRLF; the sums are of the LF file, as committed.
const sha = (name) => createHash("sha256").update(readFileSync(DATA + name, "utf8").replace(/\r\n/g, "\n")).digest("hex");
const HOW = "If you rebundled it on purpose, record the new sum: (cd data && shasum -a 256 gov-bodies.json ny-data-portal-registry.json > BUNDLED.sha256)";

const sums = new Map(
  readFileSync(DATA + "BUNDLED.sha256", "utf8").split(/\r?\n/).filter(Boolean).map((l) => {
    const m = l.match(/^([0-9a-f]{64}) [ *](.+)$/);
    assert.ok(m, `bad line in data/BUNDLED.sha256: ${l}`);
    return [m[2], m[1]];
  })
);

test("both bundled copies are listed in data/BUNDLED.sha256 and match it", () => {
  assert.deepEqual([...sums.keys()].sort(), ["gov-bodies.json", "ny-data-portal-registry.json"]);
  for (const [name, want] of sums) assert.equal(sha(name), want, `data/${name} changed. ${HOW}`);
});

test("each bundled copy names its source and when it was taken", () => {
  const g = JSON.parse(readFileSync(DATA + "gov-bodies.json", "utf8"));
  assert.match(g.source, /^https:\/\/raw\.githubusercontent\.com\/BetaNYC\/ny-gov-web-registry\//);
  assert.match(g.snapshot_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(g.source_commit, /^[0-9a-f]{40}$/);
  const r = JSON.parse(readFileSync(DATA + "ny-data-portal-registry.json", "utf8"));
  assert.match(r.source, /^BetaNYC\/grounding-ai-with-ny-open-data /);
  assert.match(r.generated, /^\d{4}-\d{2}-\d{2}$/);
});
