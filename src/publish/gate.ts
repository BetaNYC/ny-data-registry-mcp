/**
 * The publish gate. Compares tonight's index with the one published now and decides
 * whether the harvest workflow may publish it. Pure: no files, no network.
 *
 * A failing gate blocks the publish; the published index stays as it is. A person can
 * override it (workflow input `force_publish` with `force_reason`). An override is never
 * silent: the result keeps `passed: false`, and the reason and who gave it travel into
 * gate.json, index.json and the release notes.
 */
import { HEALTHY_STATUSES, type IndexSummary } from "./summary.js";

export interface GateThresholds {
  eval_must_pass: boolean;
  /** Block when the index loses more than this share of its datasets (percent). */
  max_total_drop_pct: number;
  /** Block when more than this many portals that had data now fail, are blocked, refused or gone. */
  max_ok_portals_lost: number;
  /** Block when one portal loses more than this share of its datasets (percent)... */
  max_portal_drop_pct: number;
  /** ...counting only portals that had at least this many. */
  portal_drop_min_datasets: number;
}

export interface EvalResult {
  passed: boolean;
  score: number;
  questions: number;
  passed_questions: number;
  violations: number;
}

export interface GateInput {
  previous: IndexSummary | null;
  current: IndexSummary;
  evalResult: EvalResult | null;
  packageSchemaVersion: number;
  thresholds: GateThresholds;
  override?: { reason: string; actor: string | null } | null;
  now?: Date;
}

export interface GateCheck {
  id: "index_not_empty" | "schema" | "question_set" | "total_drop" | "portals_lost" | "portal_drop";
  ok: boolean;
  detail: string;
}

export interface GateResult {
  /** Every check passed. */
  passed: boolean;
  /** Publishing may go ahead: passed, or overridden with a reason. */
  publish: boolean;
  overridden: boolean;
  override_reason: string | null;
  override_by: string | null;
  /** One line per failed check. Empty when passed. */
  reasons: string[];
  checks: GateCheck[];
  compared_with: { last_harvest: string | null; datasets: number } | null;
  evaluated_at: string;
}

const pct = (n: number) => `${Math.round(n * 10) / 10}%`;

export function evaluateGate(input: GateInput): GateResult {
  const { previous: prev, current: cur, thresholds: t } = input;
  const checks: GateCheck[] = [];

  checks.push({
    id: "index_not_empty",
    ok: cur.datasets > 0,
    detail: `${cur.datasets} datasets in the new index`,
  });

  const schemaOk = cur.schema_version === input.packageSchemaVersion && (!prev || prev.schema_version === cur.schema_version);
  checks.push({
    id: "schema",
    ok: schemaOk,
    detail: schemaOk
      ? `schema version ${cur.schema_version}`
      : `schema version changed (published ${prev?.schema_version ?? "none"}, new ${cur.schema_version}, package reads ${input.packageSchemaVersion}). Release a package that reads the new schema before publishing an index in it.`,
  });

  if (t.eval_must_pass) {
    const e = input.evalResult;
    checks.push({
      id: "question_set",
      ok: !!e && e.passed,
      detail: e
        ? `question set ${e.passed_questions}/${e.questions} (${pct(e.score * 100)}), ${e.violations} invariant violation(s); needs at least 90% and none`
        : "the question set produced no result",
    });
  }

  if (prev) {
    const drop = prev.datasets > 0 ? ((prev.datasets - cur.datasets) / prev.datasets) * 100 : 0;
    checks.push({
      id: "total_drop",
      ok: drop <= t.max_total_drop_pct,
      detail: `${prev.datasets} → ${cur.datasets} datasets (${drop > 0 ? "-" : "+"}${pct(Math.abs(drop))}); limit -${t.max_total_drop_pct}%`,
    });

    const lost = Object.entries(prev.portals)
      .filter(([, p]) => HEALTHY_STATUSES.has(p.harvest_status ?? ""))
      .filter(([id]) => !HEALTHY_STATUSES.has(cur.portals[id]?.harvest_status ?? "missing"))
      .map(([id]) => `${id} (${cur.portals[id]?.harvest_status ?? "missing"})`);
    checks.push({
      id: "portals_lost",
      ok: lost.length <= t.max_ok_portals_lost,
      detail: lost.length
        ? `${lost.length} portal(s) that had data now do not: ${lost.join(", ")}; limit ${t.max_ok_portals_lost}`
        : `no portal lost; limit ${t.max_ok_portals_lost}`,
    });

    const shrunk = Object.entries(prev.portals)
      .filter(([, p]) => p.datasets >= t.portal_drop_min_datasets)
      .map(([id, p]) => ({ id, before: p.datasets, after: cur.portals[id]?.datasets ?? 0 }))
      .filter((x) => ((x.before - x.after) / x.before) * 100 > t.max_portal_drop_pct)
      .map((x) => `${x.id} ${x.before} → ${x.after}`);
    checks.push({
      id: "portal_drop",
      ok: shrunk.length === 0,
      detail: shrunk.length
        ? `portal(s) lost more than ${t.max_portal_drop_pct}% of their datasets: ${shrunk.join(", ")}`
        : `no portal with ${t.portal_drop_min_datasets}+ datasets lost more than ${t.max_portal_drop_pct}%`,
    });
  }

  const passed = checks.every((c) => c.ok);
  const reason = input.override?.reason?.trim() || null;
  const overridden = !passed && !!reason;
  return {
    passed,
    publish: passed || overridden,
    overridden,
    override_reason: overridden ? reason : null,
    override_by: overridden ? input.override?.actor ?? null : null,
    reasons: checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`),
    checks,
    compared_with: prev ? { last_harvest: prev.last_harvest, datasets: prev.datasets } : null,
    evaluated_at: (input.now ?? new Date()).toISOString(),
  };
}

export function gateMarkdown(g: GateResult): string {
  const head = g.passed
    ? "**Quality gate: PASS**"
    : g.overridden
    ? `**Quality gate: FAIL, overridden by ${g.override_by ?? "a person"}.** Reason given: ${g.override_reason}`
    : "**Quality gate: FAIL. The new index was not published; the published index is unchanged.**";
  const cmp = g.compared_with
    ? `Compared with the published index (harvested ${g.compared_with.last_harvest ?? "?"}, ${g.compared_with.datasets} datasets).`
    : "No published index to compare with (fresh run): only the size, schema and question-set checks apply.";
  return [head, "", cmp, "", "| check | result | detail |", "|---|---|---|", ...g.checks.map((c) => `| ${c.id} | ${c.ok ? "pass" : "**FAIL**"} | ${c.detail.replace(/\|/g, "/")} |`), ""].join("\n");
}
