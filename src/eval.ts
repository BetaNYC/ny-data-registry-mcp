/**
 * Runs eval/questions.json against the real built index and scores it.
 * Pass mark: right answer in the top 3 for >= 90% of questions, and zero invariant
 * violations (nothing dead or out-of-state reported as live).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { callTool } from "./tools.js";
import { registry } from "./registry.js";
import { db } from "./datasets.js";
import { bboxIntersectsNY } from "./places.js";

interface Step {
  tool: string;
  args: Record<string, unknown>;
  check: {
    answer?: [string, string];
    field?: [string, string];
    min?: [string, number];
    top3?: Record<string, string>;
    top3_any?: Record<string, string>[];
    none?: Record<string, string>;
  };
}
interface Question {
  id: string;
  q: string;
  steps: Step[];
}

const get = (o: any, path: string) => path.split(".").reduce((x, k) => (x == null ? x : x[k]), o);

function resultsOf(body: any): any[] {
  if (Array.isArray(body?.results)) return body.results;
  return [];
}

function matches(r: any, cond: Record<string, string>): boolean {
  return Object.entries(cond).every(([k, v]) => {
    const val = r?.[k];
    if (val == null) return false;
    if (k === "name") return String(val).toLowerCase().includes(v.toLowerCase());
    return String(val) === v;
  });
}

function checkStep(step: Step, body: any): { ok: boolean; why: string } {
  const c = step.check;
  if (c.answer || c.field) {
    const [path, want] = (c.answer ?? c.field)!;
    const got = get(body, path);
    return { ok: got === want, why: `${path} = ${JSON.stringify(got)} (want ${JSON.stringify(want)})` };
  }
  if (c.min) {
    const [path, n] = c.min;
    const got = get(body, path);
    return { ok: typeof got === "number" && got >= n, why: `${path} = ${JSON.stringify(got)} (want >= ${n})` };
  }
  const res = resultsOf(body);
  if (c.top3) {
    const top = res.slice(0, 3);
    const ok = top.some((r) => matches(r, c.top3!));
    return { ok, why: ok ? "found in top 3" : `top 3: ${top.map((r) => `${r.name ?? r.source_id} [${r.portal_id ?? r.source_id}]`).join(" | ") || "(none)"}` };
  }
  if (c.top3_any) {
    const top = res.slice(0, 3);
    const ok = top.some((r) => c.top3_any!.some((cond) => matches(r, cond)));
    return { ok, why: ok ? "found in top 3" : `top 3: ${top.map((r) => `${r.name ?? r.source_id} [${r.portal_id ?? r.source_id}]`).join(" | ") || "(none)"}` };
  }
  if (c.none) {
    const bad = res.filter((r) => matches(r, c.none!));
    return { ok: bad.length === 0, why: bad.length ? `returned ${bad.map((r) => r.source_id).join(", ")}` : "not returned" };
  }
  return { ok: false, why: "no check defined" };
}

/** Invariants on every returned item. */
function invariants(tool: string, body: any): string[] {
  const v: string[] = [];
  const reg = new Map(registry().sources.map((s) => [s.source_id, s]));
  const lists = [body?.results, body?.own, body?.within, body?.regional, Array.isArray(body?.statewide) ? body.statewide : null].filter(Array.isArray) as any[][];
  for (const list of lists) {
    for (const r of list) {
      if (r.source_id && r.status === "live" && reg.get(r.source_id)?.status !== "live") v.push(`${tool}: ${r.source_id} reported live but registry says ${reg.get(r.source_id)?.status}`);
      if (r.dataset_id) {
        const row = db().prepare("SELECT d.extent, p.harvest_status FROM datasets d JOIN portals p ON p.id = d.portal_id WHERE d.id = ?").get(r.dataset_id) as { extent: string | null; harvest_status: string } | undefined;
        if (row?.harvest_status === "refused") v.push(`${tool}: ${r.dataset_id} comes from a portal refused as out-of-state`);
        if (row?.extent && bboxIntersectsNY(JSON.parse(row.extent)) === false) v.push(`${tool}: ${r.dataset_id} lies wholly outside New York`);
        const src = reg.get(r.portal_id);
        if (src && src.status !== "live") v.push(`${tool}: ${r.dataset_id} from a portal the registry marks ${src.status}`);
      }
    }
  }
  return v;
}

export async function runEval(): Promise<{ markdown: string; passed: boolean; score: number; questions: number; passed_questions: number; violations: number }> {
  const qs: Question[] = JSON.parse(readFileSync(fileURLToPath(new URL("../eval/questions.json", import.meta.url)), "utf8")).questions;
  const rows: string[] = [];
  let pass = 0;
  const violations: string[] = [];
  for (const q of qs) {
    let ok = true;
    const why: string[] = [];
    for (const step of q.steps) {
      const r = await callTool(step.tool, step.args);
      const text = r.content[0].text;
      if ((r as any).isError) {
        ok = false;
        why.push(`${step.tool} error: ${text.slice(0, 160)}`);
        continue;
      }
      const body = JSON.parse(text);
      const c = checkStep(step, body);
      if (!c.ok) ok = false;
      why.push(`${step.tool}: ${c.why}`);
      violations.push(...invariants(step.tool, body));
    }
    if (ok) pass++;
    rows.push(`| ${q.id} | ${q.q.replace(/\|/g, "/")} | ${ok ? "PASS" : "**MISS**"} | ${why.join("; ").replace(/\|/g, "/").slice(0, 400)} |`);
  }
  const score = pass / qs.length;
  const passed = score >= 0.9 && violations.length === 0;
  const markdown = [
    `# Question-set results`,
    ``,
    `Run: ${new Date().toISOString()} · registry ${registry().generated} · index last harvest ${(db().prepare("SELECT value FROM meta WHERE key='last_harvest'").get() as any)?.value ?? "?"}`,
    ``,
    `**Score: ${pass}/${qs.length} (${Math.round(score * 1000) / 10}%)** · target >= 90% · invariant violations: ${violations.length} · ${passed ? "PASS" : "FAIL"}`,
    ``,
    `| id | question | result | detail |`,
    `|---|---|---|---|`,
    ...rows,
    ``,
    `## Invariant violations`,
    violations.length ? violations.map((v) => `- ${v}`).join("\n") : "None.",
    ``,
  ].join("\n");
  return { markdown, passed, score, questions: qs.length, passed_questions: pass, violations: violations.length };
}
