// The nightly harvest's publish side (issue #14): quality gate, retention, release flags,
// failure-issue text, the published file, the Orange County certificate. Offline.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import tls from "node:tls";
import { tempIndexPath, buildFixtureIndex } from "./helpers.mjs";

const { evaluateGate, gateMarkdown } = await import("../dist/publish/gate.js");
const { snapshotNotes, planRetention, retentionCommands, publishCommands, nextSnapshotTag, snapshotTitle, newYorkDate, pickTagTarget, parseSnapshotTag, LATEST_TAG } =
  await import("../dist/publish/releases.js");
const { failureIssueBody, runSummaryMarkdown, whatFailed, FAILURE_LABEL } = await import("../dist/publish/report.js");
const { preparePublish, journalHeaderBytes, buildManifest } = await import("../dist/publish/prepare.js");
const { indexSummary } = await import("../dist/publish/summary.js");
const { SCHEMA_VERSION } = await import("../dist/db.js");
const { readDataJson } = await import("../dist/paths.js");

const ROOT = new URL("../", import.meta.url);
const thresholds = readDataJson("harvest-config.json").publish_gate;

// ---------- quality gate ----------

const portals = (n, ds = 100, status = "ok") => Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, { datasets: ds, harvest_status: status }]));
const summary = (over = {}) => {
  const p = over.portals ?? portals(10);
  return { schema_version: SCHEMA_VERSION, last_harvest: "2026-11-13T07:40:00Z", registry_generated: "2026-11-13", datasets: Object.values(p).reduce((a, x) => a + x.datasets, 0), portals_ok: 10, portals_failed: 0, portals: p, ...over };
};
const evalOk = { passed: true, score: 1, questions: 27, passed_questions: 27, violations: 0 };
const gate = (o) => evaluateGate({ previous: summary(), current: summary(), evalResult: evalOk, packageSchemaVersion: SCHEMA_VERSION, thresholds, ...o });

test("gate thresholds come from harvest-config.json", () => {
  assert.deepEqual(
    { ...thresholds, _note: undefined },
    { _note: undefined, eval_must_pass: true, max_total_drop_pct: 10, max_ok_portals_lost: 3, max_portal_drop_pct: 50, portal_drop_min_datasets: 20, max_registry_removed_portals: 5 }
  );
});

test("gate passes an index as good as the published one", () => {
  const g = gate({});
  assert.equal(g.passed, true);
  assert.equal(g.publish, true);
  assert.equal(g.overridden, false);
  assert.deepEqual(g.reasons, []);
  assert.deepEqual(g.checks.map((c) => c.id), ["index_not_empty", "schema", "question_set", "registry_removals", "total_drop", "portals_lost", "portal_drop"]);
});

test("gate blocks a failing or missing question set", () => {
  const bad = gate({ evalResult: { ...evalOk, passed: false, score: 0.85, passed_questions: 23 } });
  assert.equal(bad.publish, false);
  assert.match(bad.reasons.join(), /^question_set: question set 23\/27/);
  const missing = gate({ evalResult: null });
  assert.equal(missing.publish, false);
  assert.match(missing.reasons.join(), /produced no result/);
});

test("gate blocks a drop of more than 10% of all datasets, not one of 10%", () => {
  const cur = (each) => summary({ portals: portals(10, each) });
  assert.equal(gate({ current: cur(89) }).publish, false, "-11%");
  assert.match(gate({ current: cur(89) }).reasons.join(), /total_drop: 1000 → 890/);
  assert.equal(gate({ current: cur(90) }).publish, true, "-10%");
  assert.equal(gate({ current: cur(150) }).publish, true, "growth is fine");
});

test("gate blocks when more than 3 portals that had data no longer do", () => {
  const lose = (n) => {
    const p = portals(10);
    for (let i = 0; i < n; i++) p[`p${i}`] = { ...p[`p${i}`], harvest_status: i % 2 ? "blocked" : "failed" };
    return summary({ portals: p });
  };
  assert.equal(gate({ current: lose(3) }).publish, true);
  const g = gate({ current: lose(4) });
  assert.equal(g.publish, false);
  assert.match(g.reasons.join(), /portals_lost: 4 portal\(s\).*p0 \(failed\).*p1 \(blocked\)/);
  // A portal gone from the new index entirely counts too; partial still has its data and does not.
  const p = portals(10);
  for (const k of ["p0", "p1", "p2", "p3"]) delete p[k];
  assert.equal(gate({ current: summary({ portals: { ...p, p9: { datasets: 100, harvest_status: "partial" } } }) }).publish, false);
});

test("gate blocks one portal losing more than half its datasets, if it had at least 20", () => {
  const prev = summary({ portals: { ...portals(10), small: { datasets: 10, harvest_status: "ok" } } });
  const shrink = (big, small) => summary({ portals: { ...portals(10), p0: { datasets: big, harvest_status: "ok" }, small: { datasets: small, harvest_status: "ok" } } });
  assert.equal(gate({ previous: prev, current: shrink(50, 10) }).publish, true, "exactly 50% is allowed");
  const g = gate({ previous: prev, current: shrink(49, 10) });
  assert.equal(g.publish, false);
  assert.match(g.reasons.join(), /portal_drop: .*p0 100 → 49/);
  assert.equal(gate({ previous: prev, current: shrink(100, 1) }).publish, true, "portals under 20 datasets are not judged");
});

test("gate blocks a schema change and an empty index", () => {
  assert.equal(gate({ current: summary({ schema_version: SCHEMA_VERSION + 1 }) }).publish, false);
  assert.equal(gate({ previous: summary({ schema_version: SCHEMA_VERSION - 1 }) }).publish, false);
  assert.equal(gate({ current: summary({ portals: {}, datasets: 0 }) }).publish, false);
});

test("gate with no published index (fresh run) checks only size, schema and the question set", () => {
  const g = gate({ previous: null, current: summary({ portals: portals(1, 5) }) });
  assert.equal(g.publish, true);
  assert.deepEqual(g.checks.map((c) => c.id), ["index_not_empty", "schema", "question_set"]);
  assert.equal(g.compared_with, null);
  assert.match(gateMarkdown(g), /fresh run/);
});

test("override: a written reason lets a failing index publish, and the record keeps why", () => {
  const failing = { evalResult: { ...evalOk, passed: false } };
  const g = gate({ ...failing, override: { reason: "Q14 expects a layer the county renamed", actor: "noneck" } });
  assert.equal(g.passed, false, "an override never turns a fail into a pass");
  assert.equal(g.publish, true);
  assert.equal(g.overridden, true);
  assert.equal(g.override_reason, "Q14 expects a layer the county renamed");
  assert.equal(g.override_by, "noneck");
  assert.equal(g.reasons.length, 1);
  assert.match(gateMarkdown(g), /FAIL, overridden by noneck/);
  assert.equal(gate({ ...failing, override: { reason: "   ", actor: "noneck" } }).publish, false, "a blank reason is no override");
  const passing = gate({ override: { reason: "just in case", actor: "noneck" } });
  assert.equal(passing.overridden, false, "nothing to override when the gate passes");
  assert.equal(passing.override_reason, null);
});

test("gate: DEC's old id dropped with the registry change does not count as a loss (issue #21)", () => {
  const prev = summary({ portals: { ...portals(10), "nys-dec": { datasets: 834, harvest_status: "ok" } } });
  const cur = summary({ portals: { ...portals(10), "nys-dec--services6-arcgis-com": { datasets: 842, harvest_status: "ok" } } });
  const removals = [{ portal_id: "nys-dec", datasets: 834 }];
  const g = gate({ previous: prev, current: cur, registryRemovals: removals });
  assert.equal(g.passed, true, g.reasons.join("; "));
  assert.deepEqual(g.registry_removals, removals);
  assert.match(g.checks.find((c) => c.id === "registry_removals").detail, /nys-dec \(834\)/);
});

test("gate: a drop fully explained by registry removals passes; the same drop unexplained blocks", () => {
  const prev = summary({ portals: { ...portals(10), gone: { datasets: 900, harvest_status: "ok" } } }); // 1900
  const cur = summary({ portals: portals(10) }); // 1000: -47%
  const explained = gate({ previous: prev, current: cur, registryRemovals: [{ portal_id: "gone", datasets: 900 }] });
  assert.equal(explained.passed, true, explained.reasons.join("; "));
  assert.match(explained.checks.find((c) => c.id === "total_drop").detail, /1900 - 900 dropped with registry removals = 1000 → 1000/);
  const unexplained = gate({ previous: prev, current: cur });
  assert.equal(unexplained.publish, false);
  assert.deepEqual(unexplained.reasons.map((r) => r.split(":")[0]).sort(), ["portal_drop", "total_drop"]);
});

test("gate: registry removals never hide an unexplained drop elsewhere", () => {
  const prev = summary({ portals: { ...portals(10), gone: { datasets: 900, harvest_status: "ok" } } });
  const cur = summary({ portals: portals(10, 85) }); // the rest lost 15%
  const g = gate({ previous: prev, current: cur, registryRemovals: [{ portal_id: "gone", datasets: 900 }] });
  assert.equal(g.publish, false);
  assert.match(g.reasons.join(), /total_drop: 1900 - 900 .* = 1000 → 850 datasets \(-15%\)/);
});

test("gate: a removal only counts if the portal is really gone, and more than 5 block", () => {
  const prev = summary({ portals: { ...portals(10), x: { datasets: 900, harvest_status: "ok" } } });
  const still = gate({ previous: prev, current: prev, registryRemovals: [{ portal_id: "x", datasets: 900 }, { portal_id: "never-there", datasets: 5 }] });
  assert.deepEqual(still.registry_removals, [], "a portal still in the new index, or never in the old, explains nothing");
  const many = portals(12, 50);
  const prev2 = summary({ portals: { ...portals(10), ...Object.fromEntries(Object.entries(many).map(([k, v]) => [`old-${k}`, v])) } });
  const g = gate({ previous: prev2, current: summary({ portals: portals(10) }), registryRemovals: Object.keys(many).slice(0, 6).map((k) => ({ portal_id: `old-${k}`, datasets: 50 })) });
  assert.equal(g.publish, false);
  assert.match(g.reasons.join(), /registry_removals: 6 portal\(s\) dropped .*limit 5/);
});

// ---------- retention ----------

const days = (from, n) => {
  const out = [];
  const d = new Date(`${from}T12:00:00Z`);
  for (let i = 0; i < n; i++) out.push(`index-${new Date(d.getTime() + i * 86400000).toISOString().slice(0, 10)}`);
  return out;
};
const rel = (tags) => tags.map((tagName) => ({ tagName, name: tagName }));

test("retention keeps the newest 14 snapshots plus the first of each month, and deletes the rest", () => {
  const tags = ["index-2026-09-15", ...days("2026-10-01", 45)]; // to 2026-11-14
  const plan = planRetention(rel([...tags, "index-latest", "v0.3.0", "v0.4.0", "index-notes", "something-else"]));
  const kept = plan.keep.map((k) => k.tag);
  assert.deepEqual(kept.slice(0, 14), days("2026-11-01", 14).reverse(), "newest 14, newest first");
  assert.ok(kept.includes("index-2026-09-15") && kept.includes("index-2026-10-01"), "first of September and October");
  assert.deepEqual(plan.keep.find((k) => k.tag === "index-2026-11-01").why, ["daily", "monthly"]);
  assert.equal(kept.length, 16);
  assert.equal(plan.delete.length, tags.length - 16);
  assert.ok(plan.delete.includes("index-2026-10-31") && plan.delete.includes("index-2026-10-02"));
  for (const t of ["index-latest", "v0.3.0", "v0.4.0", "index-notes", "something-else"]) {
    assert.ok(!plan.delete.includes(t) && !kept.includes(t), `${t} is never touched`);
  }
});

test("retention: same-day re-publishes sort after the first, and the month's first is the earliest", () => {
  const plan = planRetention(rel(["index-2026-12-01-2", "index-2026-12-01", "index-2026-12-02"]), 1);
  assert.deepEqual(plan.keep.map((k) => k.tag), ["index-2026-12-02", "index-2026-12-01"]);
  assert.deepEqual(plan.delete, ["index-2026-12-01-2"]);
  assert.deepEqual(retentionCommands(plan), [{ args: ["release", "delete", "index-2026-12-01-2", "--cleanup-tag", "--yes"] }]);
});

test("retention with 14 or fewer snapshots deletes nothing; the existing 2026-11-05 snapshot is kept for good", () => {
  assert.deepEqual(planRetention(rel(days("2026-11-01", 14))).delete, []);
  const plan = planRetention(rel(["index-2026-11-05", ...days("2026-11-14", 40)]));
  assert.deepEqual(plan.keep.find((k) => k.tag === "index-2026-11-05").why, ["monthly"]);
});

// ---------- release names and flags ----------

test("snapshot tags, titles and the New York date", () => {
  assert.equal(nextSnapshotTag("2026-11-14", ["index-latest", "index-2026-11-13"]), "index-2026-11-14");
  assert.equal(nextSnapshotTag("2026-11-14", ["index-2026-11-14", "index-2026-11-14-2"]), "index-2026-11-14-3");
  assert.deepEqual(parseSnapshotTag("index-2026-11-14-3"), { tag: "index-2026-11-14-3", date: "2026-11-14", seq: 3 });
  assert.equal(parseSnapshotTag("index-latest"), null);
  assert.equal(snapshotTitle("index-2026-11-14", "current"), "Index 2026-11-14 (current)");
  assert.equal(snapshotTitle("index-2026-11-14-2", "superseded"), "Index 2026-11-14 #2 (superseded)");
  assert.equal(newYorkDate(new Date("2026-11-14T07:17:00Z")), "2026-11-14");
  assert.equal(newYorkDate(new Date("2026-11-14T03:00:00Z")), "2026-11-13", "10pm the night before in New York");
});

const manifest = buildManifest(summary(), { sqlite_sha256: "a".repeat(64), gz_sha256: "b".repeat(64), sqlite_bytes: 10, gz_bytes: 5 }, { run_url: "https://example.test/run/1", code_sha: "0123456789abcdef", gate: gate({}) });
const snapshotNotesFor = (m) => snapshotNotes("index-2026-11-14", m);
const publishPlan = (releases) =>
  publishCommands({ tag: "index-2026-11-14", date: "2026-11-14", target: "abc123", dir: "/o", sideFiles: ["harvest-stats.json", "eval.md", "gate.json"], manifest, releases });

test("index releases are never marked Latest: every create and edit says --latest=false", () => {
  const cmds = publishPlan([
    { tagName: "index-2026-11-05", name: "Index 2026-11-05", isLatest: true, body: "old notes" },
    { tagName: "index-2026-11-13", name: "Index 2026-11-13 (current)", body: "b" },
    { tagName: "index-2026-11-12", name: "Index 2026-11-12 (superseded)", body: "c" },
    { tagName: "v0.3.0", name: "v0.3.0" },
  ]);
  const createsOrEdits = cmds.filter((c) => c.args[1] === "create" || c.args[1] === "edit");
  assert.ok(createsOrEdits.length >= 3);
  for (const c of createsOrEdits) assert.ok(c.args.includes("--latest=false"), c.args.join(" "));
  assert.ok(!cmds.some((c) => c.args.includes("v0.3.0")), "the code release is never touched");
  // Also in the workflow files: an index release made with gh anywhere must say --latest=false.
  for (const f of readdirSync(new URL(".github/workflows/", ROOT))) {
    const y = readFileSync(new URL(`.github/workflows/${f}`, ROOT), "utf8");
    for (const line of y.split("\n").filter((l) => /gh release (create|edit)/.test(l) && /index-/.test(l))) assert.match(line, /--latest=false/, `${f}: ${line}`);
  }
});

test("publish order: snapshot first, then index-latest .gz, SHA256SUMS, side files, index.json last; older snapshots relabeled", () => {
  const cmds = publishPlan([
    { tagName: "index-latest", name: "Latest harvested index" },
    { tagName: "index-2026-11-05", name: "Index 2026-11-05", body: "old notes" },
    { tagName: "index-2026-11-12", name: "Index 2026-11-12 (superseded)", body: "c" },
  ]);
  const a = cmds.map((c) => c.args.join(" "));
  assert.match(a[0], /^release create index-2026-11-14 --target abc123 --title Index 2026-11-14 \(current\) --latest=false \/o\/ny-data-index\.sqlite\.gz \/o\/SHA256SUMS .*\/o\/index\.json$/);
  assert.match(cmds[0].notes, /metadata only/);
  assert.deepEqual(a.slice(1, 6), [
    "release upload index-latest /o/ny-data-index.sqlite.gz --clobber",
    "release upload index-latest /o/SHA256SUMS --clobber",
    "release upload index-latest /o/harvest-stats.json /o/eval.md /o/gate.json --clobber",
    "release upload index-latest /o/index.json --clobber",
    "release edit index-latest --latest=false",
  ]);
  assert.match(cmds[5].notes, /index-2026-11-14/);
  assert.equal(a[6], "release edit index-2026-11-05 --title Index 2026-11-05 (superseded) --latest=false");
  assert.match(cmds[6].notes, /^\*\*Superseded\*\* on 2026-11-14 by \[index-2026-11-14\].*\n\nold notes$/s, "old notes are kept under the new line");
  assert.equal(cmds.length, 7, "an already-superseded snapshot is left alone");
});

test("publish creates index-latest when it does not exist yet", () => {
  const a = publishPlan([]).map((c) => c.args.join(" "));
  assert.equal(a[1], "release create index-latest --target abc123 --title Latest harvested index --latest=false");
});

test("an overridden gate is stated in the release notes", () => {
  const g = gate({ evalResult: { ...evalOk, passed: false }, override: { reason: "county renamed a layer", actor: "noneck" } });
  const m = buildManifest(summary(), { sqlite_sha256: "a", gz_sha256: "b", sqlite_bytes: 1, gz_bytes: 1 }, { gate: g });
  const cmds = publishCommands({ tag: "index-2026-11-14", date: "2026-11-14", target: "t", dir: "/o", sideFiles: [], manifest: m, releases: [{ tagName: LATEST_TAG, name: "x" }] });
  assert.match(cmds[0].notes, /overridden by noneck\. Reason given: county renamed a layer/);
  assert.match(cmds.find((c) => c.args[2] === LATEST_TAG && c.args[1] === "edit").notes, /quality gate overridden/);
  assert.deepEqual(m.gate, { passed: false, overridden: true, override_reason: "county renamed a layer", override_by: "noneck", reasons: g.reasons });
});

test("dropped portals go into index.json and the snapshot's release notes", () => {
  const dropped = [{ portal_id: "nys-department-of-environmental-conservation", datasets: 834, reason: "id no longer in the registry" }];
  const m = buildManifest(summary(), { sqlite_sha256: "a", gz_sha256: "b", sqlite_bytes: 1, gz_bytes: 1 }, { gate: gate({}), dropped_portals: dropped });
  assert.deepEqual(m.dropped_portals, dropped);
  const cmds = publishCommands({ tag: "index-2026-11-14", date: "2026-11-14", target: "t", dir: "/o", sideFiles: [], manifest: m, releases: [{ tagName: LATEST_TAG, name: "x" }] });
  assert.match(cmds[0].notes, /\*\*Dropped:\*\* `nys-department-of-environmental-conservation` \(834 datasets\), because their ids are no longer in the registry/);
  assert.doesNotMatch(snapshotNotesFor(manifest), /Dropped/, "no line when nothing was dropped");
});

test("the snapshot tag points at the newest commit that does not change workflow files", () => {
  assert.equal(pickTagTarget([{ sha: "c3", files: [".github/workflows/harvest.yml", "src/x.ts"] }, { sha: "c2", files: ["README.md"] }]), "c2");
  assert.equal(pickTagTarget([{ sha: "c1", files: [] }]), "c1");
  assert.equal(pickTagTarget([{ sha: "c3", files: [".github/workflows/ci.yml"] }]), null);
});

// ---------- failure issue and run summary ----------

const stats = {
  started_at: "2026-11-14T07:17:30Z", run_seconds: 900, portals_tried: 30, succeeded: 27, partial: 1, failed: 1, blocked: 1, refused_out_of_state: 0, not_due: 4,
  skipped_live_rows: 100, datasets_in_index: 9600, columns_in_index: 185000, http_requests: 3700, registry_generated: "2026-11-13",
  portals: [
    { source_id: "orange-county", outcome: "failed", error: "network error: UNABLE_TO_VERIFY_LEAF_SIGNATURE" },
    { source_id: "syracuse", outcome: "partial", reason: "126 unique of 136" },
    { source_id: "somewhere", outcome: "blocked", error: "blocked: HTTP 403 bot challenge" },
    { source_id: "monroe-county", outcome: "not-due", reason: "read every 7 days" },
    { source_id: "nys", outcome: "ok" },
  ],
};
const ctx = (o = {}) => ({ runUrl: "https://github.com/BetaNYC/ny-data-registry-mcp/actions/runs/1", event: "schedule", ref: "main", sha: "0123456789abcdef", at: "2026-11-14T08:00:00Z", steps: { preflight: "success", tests: "success", previous_index: "success", harvest: "success", question_set: "success", gate: "success", prepare: "success", publish: "success", prune: "success" }, gate: null, stats, ...o });

test("failure issue: a blocked gate says the index was not published, and why", () => {
  const g = gate({ evalResult: { ...evalOk, passed: false } });
  const body = failureIssueBody(ctx({ gate: g, steps: { ...ctx().steps, gate: "failure", publish: "skipped", prune: "skipped" } }));
  assert.match(body, /^\*\*The quality gate blocked the publish\.\*\*/);
  assert.match(body, /Effect on users:\*\* none\. The published index is unchanged/);
  assert.match(body, /### Quality gate\n\n- question_set: /);
  assert.match(body, /`orange-county` failed: network error: UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
  assert.match(body, /`syracuse` partial/);
  assert.doesNotMatch(body, /monroe-county|`nys`/, "not-due and ok portals are not trouble");
  assert.match(body, /force_publish.*force_reason/);
  assert.match(body, /closes itself after the next run that publishes/);
  assert.equal(FAILURE_LABEL, "harvest-failure");
});

test("failure issue names the first failed step, and a failed publish asks for a check of index-latest", () => {
  assert.equal(whatFailed(ctx({ steps: { preflight: "success", tests: "success", previous_index: "failure", harvest: "skipped" } })), "The published index could not be downloaded and verified, so the harvest did not start from it.");
  assert.equal(whatFailed(ctx({ steps: { preflight: "success", tests: "success", previous_index: "success", harvest: "failure" } })), "The harvest crashed.");
  assert.match(whatFailed(ctx({ steps: { tests: "success", harvest: "cancelled" } })), /\(cancelled\)$/);
  const body = failureIssueBody(ctx({ gate: gate({}), steps: { ...ctx().steps, publish: "failure", prune: "skipped" } }));
  assert.match(body, /^\*\*Publishing to the GitHub releases failed partway\.\*\*/);
  assert.match(body, /check that `index-latest` holds a matching/);
  assert.match(failureIssueBody(ctx({ stats: null, steps: {} })), /outside the named steps/);
});

test("run summary: counts, trouble portals, not-due portals, gate, and dry-run note", () => {
  const md = runSummaryMarkdown({ stats, gate: gate({}), publish: false });
  assert.match(md, /\| 30 \| 27 \| 1 \| 1 \| 1 \| 0 \| 4 \| 100 \| 9600 \| 185000 \|/);
  assert.match(md, /\| orange-county \| failed \| network error/);
  assert.match(md, /Not due tonight: monroe-county\./);
  assert.doesNotMatch(md, /Dropped because/);
  const withDrop = runSummaryMarkdown({ stats: { ...stats, dropped_portals: [{ portal_id: "nys-dec", datasets: 834, reason: "id no longer in the registry" }], dropped_datasets: 834 }, gate: null, publish: false });
  assert.match(withDrop, /Dropped because their ids are no longer in the registry \(834 datasets\):\n\n\| portal \| datasets \|\n\|---\|---\|\n\| nys-dec \| 834 \|/);
  assert.match(runSummaryMarkdown({ stats: { ...stats, orphan_portals_kept: [{ portal_id: "x", datasets: 3 }], orphan_portals_kept_reason: "the loaded registry (a) is older" }, gate: null, publish: false }), /Not in the registry but kept: x\. the loaded registry/);
  assert.match(md, /Quality gate: PASS/);
  assert.match(md, /Dry run: nothing was published/);
  assert.match(runSummaryMarkdown({ stats: null, gate: null, publish: true, published: { tag: "index-2026-11-14", deleted: ["index-2026-10-20"] } }), /Published\*\* `index-2026-11-14`[\s\S]*Retention removed: index-2026-10-20/);
});

// ---------- the published file ----------

test("the published copy uses the rollback journal, its sums match, and the server's downloader installs it", async () => {
  const src = await buildFixtureIndex(tempIndexPath());
  assert.deepEqual(journalHeaderBytes(src), [2, 2], "the harvest's working copy is WAL");
  const dir = mkdtempSync(join(tmpdir(), "nydr-pub-"));
  const m = await preparePublish({ index: src, dir, gate: gate({}), runUrl: "https://example.test/run/1", codeSha: "abc" });
  const sqlite = join(dir, "ny-data-index.sqlite");
  assert.deepEqual(journalHeaderBytes(sqlite), [1, 1]);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(sqlite, { readOnly: true });
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
  db.close();
  assert.ok(!existsSync(`${sqlite}-wal`) && !existsSync(`${sqlite}-shm`), "no WAL side files");

  for (const k of ["manifest_version", "schema_version", "last_harvest", "registry_generated", "sqlite_sha256", "gz_sha256", "sqlite_bytes", "gz_bytes", "datasets", "portals_ok", "portals_failed", "run_url", "code_sha", "gate", "dropped_portals"]) {
    assert.ok(k in m, `index.json has ${k}`);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")), m);
  assert.equal(m.schema_version, SCHEMA_VERSION);
  assert.equal(m.datasets, indexSummary(src).datasets);
  assert.equal(m.gate.passed, true);
  assert.deepEqual(m.dropped_portals, []);
  assert.equal(readFileSync(join(dir, "SHA256SUMS"), "utf8"), `${m.gz_sha256}  ny-data-index.sqlite.gz\n${m.sqlite_sha256}  ny-data-index.sqlite\n`);

  // Serve the files as a release on loopback and install them with the server's own downloader.
  const server = createServer((req, res) => res.end(readFileSync(join(dir, req.url.split("/").pop()))));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const { downloadIndex } = await import("../dist/fetchindex.js");
  const dest = join(mkdtempSync(join(tmpdir(), "nydr-pubdl-")), "idx.sqlite");
  const r = await downloadIndex({ path: dest, url: `http://127.0.0.1:${server.address().port}/index-latest/ny-data-index.sqlite.gz` });
  assert.equal(r.bytes, m.sqlite_bytes);
  assert.deepEqual(journalHeaderBytes(dest), [1, 1]);
});

test("index summary counts per portal and skips portals the harvest never read", async () => {
  const s = indexSummary(await buildFixtureIndex(tempIndexPath()));
  assert.equal(s.schema_version, SCHEMA_VERSION);
  assert.equal(s.last_harvest, "2026-11-05T00:00:00Z");
  assert.deepEqual(Object.keys(s.portals).sort(), ["cortland-county", "new-york-city", "nys-department-of-health", "putnam-county"]);
  assert.equal(s.portals["new-york-city"].datasets, 2);
  assert.equal(s.datasets, Object.values(s.portals).reduce((a, p) => a + p.datasets, 0));
  assert.equal(s.portals_ok, 4);
});

// ---------- Orange County's missing intermediate certificate ----------

test("the Orange County intermediate is the pinned Sectigo CA, signed by a root Node already trusts", () => {
  const pem = readFileSync(new URL("certs/sectigo-public-server-authentication-ca-ov-r36.pem", ROOT), "utf8");
  assert.equal((pem.match(/BEGIN CERTIFICATE/g) ?? []).length, 1, "exactly one certificate");
  const c = new X509Certificate(pem);
  assert.equal(c.fingerprint256, "65:42:D1:76:BE:D5:0F:19:3C:0C:E2:97:AE:44:EC:D8:A0:A8:6B:EC:2E:DE:68:27:69:34:40:59:B4:E7:85:30");
  assert.equal(c.ca, true);
  assert.match(c.subject, /CN=Sectigo Public Server Authentication CA OV R36/);
  assert.notEqual(c.subject, c.issuer, "an intermediate, not a root");
  const roots = tls.rootCertificates.map((p) => new X509Certificate(p)).filter((r) => c.checkIssued(r) && c.verify(r.publicKey));
  assert.equal(roots.length, 1, "its issuer is in Node's bundled root list and its signature checks");
  assert.match(roots[0].subject, /CN=Sectigo Public Server Authentication Root R46/);
});

test("the harvest step, and only that step, gets NODE_EXTRA_CA_CERTS pointing at the committed file", () => {
  const y = readFileSync(new URL(".github/workflows/harvest.yml", ROOT), "utf8");
  const lines = y.split("\n").filter((l) => /NODE_EXTRA_CA_CERTS:/.test(l));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /certs\/sectigo-public-server-authentication-ca-ov-r36\.pem$/);
  assert.doesNotMatch(y, /NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized/, "verification is never turned off");
});
