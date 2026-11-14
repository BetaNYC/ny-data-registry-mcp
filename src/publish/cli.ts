/**
 * The harvest workflow's publish steps (.github/workflows/harvest.yml). Not a user command.
 *
 *   node dist/publish/cli.js summary --index <sqlite> --out <json>      (or --none)
 *   node dist/publish/cli.js gate --previous <json> --current <json> --eval <json> --out <json>
 *                                 [--override-reason <text> --actor <login>]
 *   node dist/publish/cli.js prepare --index <sqlite> --dir <dir> --gate <json> [--run-url U --code-sha S]
 *   node dist/publish/cli.js report --stats <json> --gate <json> [--publish true|false] [--published <json>]
 *   node dist/publish/cli.js publish --dir <dir> [--dry-run]
 *   node dist/publish/cli.js prune [--dry-run]
 *   node dist/publish/cli.js failure-issue --steps <json> --dir <dir>
 *   node dist/publish/cli.js close-failures
 *
 * `publish`, `prune`, `failure-issue` and `close-failures` call `gh` and `git`, with
 * GH_TOKEN from the workflow. Exit codes: 0 ok, 1 gate blocked or a step failed, 2 usage.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDataJson } from "../paths.js";
import { SCHEMA_VERSION } from "../db.js";
import { indexSummary, type IndexSummary } from "./summary.js";
import { evaluateGate, gateMarkdown, type EvalResult, type GateResult, type GateThresholds } from "./gate.js";
import { preparePublish, MANIFEST_NAME, type Manifest } from "./prepare.js";
import {
  newYorkDate, nextSnapshotTag, pickTagTarget, planRetention, publishCommands, retentionCommands, type GhCommand, type ReleaseInfo,
} from "./releases.js";
import { FAILURE_LABEL, FAILURE_TITLE, failureIssueBody, runSummaryMarkdown, type HarvestStats } from "./report.js";

/** Files beside the index in every snapshot and in index-latest. */
export const SIDE_FILES = ["harvest-stats.json", "eval.md", "gate.json"];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
function need(name: string): string {
  const v = arg(name);
  if (!v) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return v;
}
const readJson = <T>(p: string | undefined): T | null => (p && existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null);
const dryRun = process.argv.includes("--dry-run");

function summaryOut(md: string): void {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) appendFileSync(f, md + "\n");
  else console.log(md);
}

function gh(args: string[], opts: { capture?: boolean } = {}): string {
  if (dryRun && !opts.capture) {
    console.log(`[dry run] gh ${args.join(" ")}`);
    return "";
  }
  return execFileSync("gh", args, { encoding: "utf8", stdio: opts.capture ? ["ignore", "pipe", "inherit"] : "inherit" }) ?? "";
}

function runAll(cmds: GhCommand[]): void {
  const tmp = mkdtempSync(join(tmpdir(), "ndr-notes-"));
  cmds.forEach((c, i) => {
    const args = [...c.args];
    if (c.notes !== undefined) {
      const f = join(tmp, `notes-${i}.md`);
      writeFileSync(f, c.notes);
      args.push("--notes-file", f);
    }
    gh(args);
  });
}

function listReleases(): ReleaseInfo[] {
  return JSON.parse(gh(["release", "list", "--limit", "1000", "--json", "tagName,name,isLatest"], { capture: true }) || "[]");
}

function runUrl(): string | null {
  const { GITHUB_SERVER_URL: s, GITHUB_REPOSITORY: r, GITHUB_RUN_ID: id } = process.env;
  return s && r && id ? `${s}/${r}/actions/runs/${id}` : null;
}

function tagTarget(): string {
  const shas = execFileSync("git", ["log", "--first-parent", "-n", "100", "--format=%H"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const commits = shas.map((sha) => {
    let files: string[] = [];
    try {
      files = execFileSync("git", ["diff", "--name-only", `${sha}^1`, sha], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
    } catch {
      files = []; // root commit, or history beyond the fetch depth
    }
    return { sha, files };
  });
  const t = pickTagTarget(commits);
  if (!t) throw new Error("no commit in the last 100 leaves .github/workflows/ alone; cannot pick a tag target");
  return t;
}

const cmd = process.argv[2];

if (cmd === "summary") {
  const out = need("out");
  const s: IndexSummary | null = process.argv.includes("--none") ? null : indexSummary(need("index"));
  writeFileSync(out, JSON.stringify(s, null, 2));
  console.log(s ? `${s.datasets} datasets, ${s.portals_ok} portals ok, harvested ${s.last_harvest}` : "no previous index");
} else if (cmd === "gate") {
  const current = readJson<IndexSummary>(need("current"));
  if (!current) throw new Error("no current summary");
  const cfg = readDataJson<{ publish_gate: GateThresholds }>("harvest-config.json");
  const g = evaluateGate({
    previous: readJson<IndexSummary>(arg("previous")),
    current,
    evalResult: readJson<EvalResult>(arg("eval")),
    packageSchemaVersion: SCHEMA_VERSION,
    thresholds: cfg.publish_gate,
    override: arg("override-reason") ? { reason: arg("override-reason")!, actor: arg("actor") ?? null } : null,
  });
  writeFileSync(need("out"), JSON.stringify(g, null, 2));
  console.log(gateMarkdown(g));
  process.exitCode = g.publish ? 0 : 1;
} else if (cmd === "prepare") {
  const m = await preparePublish({
    index: need("index"),
    dir: need("dir"),
    gate: readJson<GateResult>(arg("gate")),
    runUrl: arg("run-url") ?? runUrl(),
    codeSha: arg("code-sha") ?? process.env.GITHUB_SHA ?? null,
  });
  console.log(JSON.stringify(m, null, 2));
} else if (cmd === "report") {
  summaryOut(
    runSummaryMarkdown({
      stats: readJson<HarvestStats>(arg("stats")),
      gate: readJson<GateResult>(arg("gate")),
      publish: arg("publish") === "true",
      published: readJson<{ tag: string; deleted: string[] }>(arg("published")),
    })
  );
} else if (cmd === "publish") {
  const dir = need("dir");
  const manifest = readJson<Manifest>(join(dir, MANIFEST_NAME));
  if (!manifest) throw new Error(`no ${MANIFEST_NAME} in ${dir}; run prepare first`);
  const gate = readJson<GateResult>(join(dir, "gate.json"));
  if (!gate?.publish) throw new Error("gate.json is missing or says do not publish; refusing");
  for (const f of SIDE_FILES) if (!existsSync(join(dir, f))) throw new Error(`missing ${f} in ${dir}`);
  const releases = listReleases();
  // Bodies are needed only for snapshots about to be relabeled superseded.
  for (const r of releases) {
    if (/^index-\d{4}-\d{2}-\d{2}/.test(r.tagName) && !/\(superseded\)\s*$/.test(r.name)) {
      r.body = JSON.parse(gh(["release", "view", r.tagName, "--json", "body"], { capture: true })).body ?? "";
    }
  }
  const date = newYorkDate(new Date());
  const tag = nextSnapshotTag(date, releases.map((r) => r.tagName));
  runAll(publishCommands({ tag, date, target: tagTarget(), dir, sideFiles: SIDE_FILES, manifest, releases }));
  if (dryRun) console.log(`[dry run] would publish ${tag}`);
  else {
    writeFileSync(join(dir, "published.json"), JSON.stringify({ tag, deleted: [] }, null, 2));
    console.log(`published ${tag}`);
  }
} else if (cmd === "prune") {
  const plan = planRetention(listReleases());
  console.log(JSON.stringify(plan, null, 2));
  runAll(retentionCommands(plan));
  const pub = arg("published");
  if (pub && existsSync(pub)) {
    const p = JSON.parse(readFileSync(pub, "utf8"));
    writeFileSync(pub, JSON.stringify({ ...p, deleted: plan.delete }, null, 2));
  }
} else if (cmd === "failure-issue") {
  const dir = need("dir");
  const body = failureIssueBody({
    runUrl: runUrl() ?? "(no run URL)",
    event: process.env.GITHUB_EVENT_NAME ?? "?",
    ref: process.env.GITHUB_REF_NAME ?? "?",
    sha: process.env.GITHUB_SHA ?? "",
    at: new Date().toISOString(),
    steps: JSON.parse(need("steps")),
    gate: readJson<GateResult>(join(dir, "gate.json")),
    stats: readJson<HarvestStats>(join(dir, "harvest-stats.json")),
  });
  const tmp = join(mkdtempSync(join(tmpdir(), "ndr-issue-")), "body.md");
  writeFileSync(tmp, body);
  gh(["label", "create", FAILURE_LABEL, "--force", "--color", "d73a4a", "--description", "The nightly index harvest failed or its quality gate blocked a publish"]);
  const open = JSON.parse(gh(["issue", "list", "--label", FAILURE_LABEL, "--state", "open", "--json", "number"], { capture: true }) || "[]") as { number: number }[];
  if (open.length) gh(["issue", "comment", String(open[0].number), "--body-file", tmp]);
  else gh(["issue", "create", "--title", FAILURE_TITLE, "--label", FAILURE_LABEL, "--body-file", tmp]);
} else if (cmd === "close-failures") {
  const open = JSON.parse(gh(["issue", "list", "--label", FAILURE_LABEL, "--state", "open", "--json", "number"], { capture: true }) || "[]") as { number: number }[];
  for (const i of open) gh(["issue", "close", String(i.number), "--reason", "completed", "--comment", `Fixed: ${runUrl() ?? "a later run"} published a new index.`]);
} else {
  console.error("usage: node dist/publish/cli.js <summary|gate|prepare|report|publish|prune|failure-issue|close-failures> [options]");
  process.exitCode = 2;
}
