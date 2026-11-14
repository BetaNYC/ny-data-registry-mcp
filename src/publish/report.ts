/**
 * What a person reads about a harvest run: the workflow's step summary, and the body of
 * the GitHub issue a failed run opens (issue #14, decision B4). Pure.
 */
import { gateMarkdown, type GateResult } from "./gate.js";

export const FAILURE_LABEL = "harvest-failure";
export const FAILURE_TITLE = "Nightly index harvest failed";

/** The harvest stats file (`harvest --stats-out`), as far as these reports read it. */
export interface HarvestStats {
  started_at?: string;
  run_seconds?: number;
  registry_generated?: string;
  portals_tried?: number;
  succeeded?: number;
  partial?: number;
  failed?: number;
  blocked?: number;
  refused_out_of_state?: number;
  skipped_live_rows?: number;
  not_due?: number;
  datasets_in_index?: number;
  columns_in_index?: number;
  http_requests?: number;
  portals?: { source_id: string; outcome: string; reason?: string; error?: string | null; datasets?: number; seconds?: number }[];
}

const clip = (s: string, n = 200) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const cell = (s: string) => clip(s).replace(/\|/g, "/").replace(/\r?\n/g, " ");

/** Portals that were tried tonight and did not come back complete. */
export function troublePortals(stats: HarvestStats | null): { source_id: string; outcome: string; why: string }[] {
  return (stats?.portals ?? [])
    .filter((p) => ["partial", "failed", "blocked", "refused"].includes(p.outcome))
    .map((p) => ({ source_id: p.source_id, outcome: p.outcome, why: p.error ?? p.reason ?? "" }));
}

export function runSummaryMarkdown(o: {
  stats: HarvestStats | null;
  gate: GateResult | null;
  publish: boolean;
  published?: { tag: string; deleted: string[] } | null;
}): string {
  const s = o.stats;
  const out: string[] = ["## Harvest", ""];
  if (!s) out.push("The harvest produced no stats file.", "");
  else {
    out.push(
      `Started ${s.started_at ?? "?"}, ${s.run_seconds ?? "?"} s, ${s.http_requests ?? "?"} requests. Registry generated ${s.registry_generated ?? "?"}.`,
      "",
      "| tried | ok | partial | failed | blocked | refused | not due (weekly) | skipped (no adapter) | datasets | columns |",
      "|---|---|---|---|---|---|---|---|---|---|",
      `| ${s.portals_tried ?? "?"} | ${s.succeeded ?? "?"} | ${s.partial ?? "?"} | ${s.failed ?? "?"} | ${s.blocked ?? "?"} | ${s.refused_out_of_state ?? "?"} | ${s.not_due ?? 0} | ${s.skipped_live_rows ?? "?"} | ${s.datasets_in_index ?? "?"} | ${s.columns_in_index ?? "?"} |`,
      ""
    );
    const t = troublePortals(s);
    if (t.length) out.push("Portals that did not come back complete (their datasets stay as of their last good read):", "", "| portal | outcome | why |", "|---|---|---|", ...t.map((p) => `| ${p.source_id} | ${p.outcome} | ${cell(p.why)} |`), "");
    const nd = (s.portals ?? []).filter((p) => p.outcome === "not-due");
    if (nd.length) out.push(`Not due tonight: ${nd.map((p) => p.source_id).join(", ")}.`, "");
  }
  out.push(o.gate ? gateMarkdown(o.gate) : "**Quality gate: did not run.**", "");
  if (!o.publish) out.push("**Dry run: nothing was published.** The files are in this run's artifact.", "");
  else if (o.published) {
    out.push(`**Published** \`${o.published.tag}\` and updated \`index-latest\`.`);
    out.push(o.published.deleted.length ? `Retention removed: ${o.published.deleted.join(", ")}.` : "Retention removed nothing.", "");
  }
  return out.join("\n");
}

export interface FailureContext {
  runUrl: string;
  event: string;
  ref: string;
  sha: string;
  at: string;
  /** Step id → outcome (success, failure, cancelled, skipped), in run order. */
  steps: Record<string, string>;
  gate: GateResult | null;
  stats: HarvestStats | null;
}

/** The first step that did not succeed, and what it means. */
export function whatFailed(c: FailureContext): string {
  const failed = Object.entries(c.steps).find(([, v]) => v === "failure" || v === "cancelled");
  if (c.gate && !c.gate.publish) return "The quality gate blocked the publish.";
  if (!failed) return "The job failed outside the named steps (setup, a timeout, or a cancelled run).";
  const [id, outcome] = failed;
  const what: Record<string, string> = {
    preflight: "The preflight check failed (a missing secret, a missing certificate file, or a publish requested off the default branch).",
    tests: "The offline test suite failed.",
    previous_index: "The published index could not be downloaded and verified, so the harvest did not start from it.",
    harvest: "The harvest crashed.",
    question_set: "The question set could not run.",
    gate: "The quality gate could not run.",
    prepare: "The files to publish could not be built.",
    publish: "Publishing to the GitHub releases failed partway.",
    prune: "Removing old snapshots failed (the new index was published).",
  };
  return `${what[id] ?? `Step \`${id}\` failed.`}${outcome === "cancelled" ? " (cancelled)" : ""}`;
}

export function failureIssueBody(c: FailureContext): string {
  const out: string[] = [
    `**${whatFailed(c)}**`,
    "",
    `- **Run:** ${c.runUrl}`,
    `- **When:** ${c.at} (${c.event} on \`${c.ref}\`, commit ${c.sha.slice(0, 7)})`,
    `- **Effect on users:** ${c.steps.publish === "failure" ? "a publish was under way when it failed: check that `index-latest` holds a matching `.gz`, `SHA256SUMS` and `index.json` (servers refuse a mismatched pair, so nobody installs a bad file)." : "none. The published index is unchanged."}`,
    "",
  ];
  if (c.gate && !c.gate.passed) out.push("### Quality gate", "", ...c.gate.reasons.map((r) => `- ${r}`), "");
  const t = troublePortals(c.stats);
  if (t.length) out.push("### Portals that did not come back complete", "", ...t.map((p) => `- \`${p.source_id}\` ${p.outcome}: ${clip(p.why, 300)}`), "");
  out.push(
    "### What to do",
    "",
    "- Read the run's summary and its `harvest-run` artifact (stats, question set, gate result, log).",
    "- If the gate was right, fix the cause; the next scheduled run tries again.",
    "- If the gate was wrong, run the workflow by hand with `force_publish` on and a `force_reason`. The reason is recorded in `index.json` and the release notes.",
    "",
    `This issue closes itself after the next run that publishes. Further failures before then are added as comments.`,
    ""
  );
  return out.join("\n");
}
