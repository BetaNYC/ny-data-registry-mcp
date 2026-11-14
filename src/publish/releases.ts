/**
 * Index releases on GitHub: names, labels, the order of uploads, and retention. Pure
 * functions that return `gh` argument lists; src/publish/cli.ts runs them.
 *
 * Rules (issue #14, decisions B5 and B6):
 * - An index release is never marked "Latest". Every `gh release create` and `edit` this
 *   module emits carries `--latest=false` (REST `make_latest: "false"`; without it, a newly
 *   published release defaults to `true`). The code release (`vX.Y.Z`) keeps the badge.
 * - `index-latest` is the fixed link the server downloads from. Dated snapshots are
 *   `index-YYYY-MM-DD` (a second publish the same day gets `-2`, `-3`, ...).
 * - The newest snapshot's title says "(current)"; when a newer one is published, older ones
 *   are relabeled "(superseded)".
 * - Retention keeps the newest 14 snapshots plus the first snapshot of every month, forever.
 *   Nothing else matching `index-YYYY-MM-DD` survives; nothing else is ever touched.
 *
 * gh flags used are those of `gh release create|edit|upload|delete --help` (gh 2.x):
 * `--latest[=true|false]`, `--title`, `--notes-file`, `--target`, `--clobber`,
 * `--cleanup-tag`, `--yes`.
 */
import { join } from "node:path";
import { GZ_NAME, MANIFEST_NAME, SUMS_NAME, type Manifest } from "./prepare.js";

export const LATEST_TAG = "index-latest";
export const REPO_URL = "https://github.com/BetaNYC/ny-data-registry-mcp";
export const KEEP_DAILY = 14;
const SNAPSHOT_RE = /^index-(\d{4})-(\d{2})-(\d{2})(?:-(\d+))?$/;

export interface Snapshot {
  tag: string;
  date: string;
  seq: number;
}

export function parseSnapshotTag(tag: string): Snapshot | null {
  const m = tag.match(SNAPSHOT_RE);
  if (!m) return null;
  return { tag, date: `${m[1]}-${m[2]}-${m[3]}`, seq: m[4] ? Number(m[4]) : 1 };
}

/** Newest first. */
function bySnapshotDesc(a: Snapshot, b: Snapshot): number {
  return a.date === b.date ? b.seq - a.seq : a.date < b.date ? 1 : -1;
}

/** The New York calendar date (YYYY-MM-DD) of a moment. */
export function newYorkDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** `index-YYYY-MM-DD`, or `-2`, `-3` ... when that date already has a snapshot. */
export function nextSnapshotTag(date: string, existingTags: string[]): string {
  const taken = new Set(existingTags);
  if (!taken.has(`index-${date}`)) return `index-${date}`;
  for (let n = 2; ; n++) if (!taken.has(`index-${date}-${n}`)) return `index-${date}-${n}`;
}

export type SnapshotStatus = "current" | "superseded";

export function snapshotTitle(tag: string, status: SnapshotStatus): string {
  const s = parseSnapshotTag(tag);
  if (!s) throw new Error(`not a snapshot tag: ${tag}`);
  return `Index ${s.date}${s.seq > 1 ? ` #${s.seq}` : ""} (${status})`;
}

export interface ReleaseInfo {
  tagName: string;
  name: string;
  isLatest?: boolean;
  body?: string;
}

export interface RetentionPlan {
  keep: { tag: string; why: ("daily" | "monthly")[] }[];
  delete: string[];
}

/** Which dated snapshots to keep and which to delete. Ignores every release that is not a dated snapshot. */
export function planRetention(releases: { tagName: string }[], keepDaily = KEEP_DAILY): RetentionPlan {
  const snaps = releases.map((r) => parseSnapshotTag(r.tagName)).filter((s): s is Snapshot => !!s).sort(bySnapshotDesc);
  const why = new Map<string, ("daily" | "monthly")[]>();
  const add = (tag: string, w: "daily" | "monthly") => why.set(tag, [...(why.get(tag) ?? []), w]);
  snaps.slice(0, Math.max(keepDaily, 1)).forEach((s) => add(s.tag, "daily"));
  const firstOfMonth = new Map<string, Snapshot>();
  for (const s of [...snaps].reverse()) if (!firstOfMonth.has(s.date.slice(0, 7))) firstOfMonth.set(s.date.slice(0, 7), s);
  for (const s of firstOfMonth.values()) add(s.tag, "monthly");
  return {
    keep: snaps.filter((s) => why.has(s.tag)).map((s) => ({ tag: s.tag, why: why.get(s.tag)! })),
    delete: snaps.filter((s) => !why.has(s.tag)).map((s) => s.tag),
  };
}

export function retentionCommands(plan: RetentionPlan): GhCommand[] {
  return plan.delete.map((tag) => ({ args: ["release", "delete", tag, "--cleanup-tag", "--yes"] }));
}

/** One `gh` call. When `notes` is set, the runner writes it to a file and adds `--notes-file <file>`. */
export interface GhCommand {
  args: string[];
  notes?: string;
}

const fmt = (n: number) => n.toLocaleString("en-US");

function gateLine(m: Manifest): string {
  if (!m.gate) return "";
  if (m.gate.passed) return "- **Quality gate:** passed.";
  return `- **Quality gate:** failed and was overridden by ${m.gate.override_by ?? "a person"}. Reason given: ${m.gate.override_reason}. Failed checks: ${m.gate.reasons.join("; ")}`;
}

export function snapshotNotes(tag: string, m: Manifest): string {
  return [
    `A dated copy of the harvested New York open data index. It holds **metadata only**: dataset titles, descriptions, column names and types, formats and links. No dataset contents.`,
    ``,
    `- **Harvested:** ${m.last_harvest ?? "unknown"} (registry generated ${m.registry_generated ?? "unknown"})`,
    `- **Contents:** ${fmt(m.datasets)} datasets; ${m.portals_ok} portals read in full, ${m.portals_failed} failed or blocked (their datasets are kept as of their last good read).`,
    gateLine(m),
    m.dropped_portals?.length
      ? `- **Dropped:** ${m.dropped_portals.map((d) => `\`${d.portal_id}\` (${d.datasets} datasets)`).join(", ")}, because their ids are no longer in the registry.`
      : "",
    `- **Built by:** ${m.run_url ? `[the harvest workflow run](${m.run_url})` : "the harvest workflow"}${m.code_sha ? ` from commit ${m.code_sha.slice(0, 7)}` : ""}.`,
    ``,
    `The server downloads the newest index from the [\`${LATEST_TAG}\`](${REPO_URL}/releases/tag/${LATEST_TAG}) release, not from here. To pin this copy, set \`NY_DATA_INDEX_URL\` to \`${REPO_URL}/releases/download/${tag}/${GZ_NAME}\`.`,
    ``,
    `Kept for 14 days; the first snapshot of each month is kept for good. \`index.json\` describes the files; \`SHA256SUMS\` checks them.`,
    ``,
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n");
}

export function supersededNote(newTag: string, date: string): string {
  return `**Superseded** on ${date} by [${newTag}](${REPO_URL}/releases/tag/${newTag}). The newest index is always at [\`${LATEST_TAG}\`](${REPO_URL}/releases/tag/${LATEST_TAG}).\n\n`;
}

export function latestNotes(tag: string, m: Manifest): string {
  return [
    `The rolling copy of the harvested New York open data index. **The MCP server downloads this release by itself on first run.** Its URL never changes:`,
    ``,
    `\`${REPO_URL}/releases/download/${LATEST_TAG}/${GZ_NAME}\``,
    ``,
    `It holds **metadata only**: dataset titles, descriptions, column names and types, formats and links. No dataset contents. Each file is checked against \`SHA256SUMS\` before it is installed; \`index.json\` describes the current files.`,
    ``,
    `Current contents: the harvest of ${m.last_harvest ?? "unknown"}, the same files as [${tag}](${REPO_URL}/releases/tag/${tag}). ${fmt(m.datasets)} datasets; ${m.portals_ok} portals read in full, ${m.portals_failed} failed or blocked.`,
    m.gate && !m.gate.passed ? `\nThis copy was published with the quality gate overridden. Reason given: ${m.gate.override_reason}` : "",
    ``,
    `Rebuilt by the harvest workflow. Dated snapshots are kept as \`index-YYYY-MM-DD\` releases: the last 14, plus the first of each month for good.`,
    ``,
  ].join("\n");
}

/**
 * Every gh call for one publish, in order:
 * 1. Create the dated snapshot with all its files (never changes after this).
 * 2. Update `index-latest`: the .gz first, SHA256SUMS second, the side files, index.json last.
 *    Between uploads a server can see a .gz and SHA256SUMS that do not match; it refuses the
 *    file and tries again later (src/fetchindex.ts), so the window costs a retry, never a bad install.
 * 3. Rewrite `index-latest`'s notes.
 * 4. Relabel every older snapshot not yet marked superseded.
 */
export function publishCommands(o: {
  tag: string;
  date: string;
  target: string;
  dir: string;
  sideFiles: string[];
  manifest: Manifest;
  releases: ReleaseInfo[];
}): GhCommand[] {
  const f = (n: string) => join(o.dir, n);
  const all = [f(GZ_NAME), f(SUMS_NAME), ...o.sideFiles.map(f), f(MANIFEST_NAME)];
  const cmds: GhCommand[] = [
    {
      args: ["release", "create", o.tag, "--target", o.target, "--title", snapshotTitle(o.tag, "current"), "--latest=false", ...all],
      notes: snapshotNotes(o.tag, o.manifest),
    },
  ];
  if (!o.releases.some((r) => r.tagName === LATEST_TAG)) {
    cmds.push({ args: ["release", "create", LATEST_TAG, "--target", o.target, "--title", "Latest harvested index", "--latest=false"], notes: latestNotes(o.tag, o.manifest) });
  }
  cmds.push({ args: ["release", "upload", LATEST_TAG, f(GZ_NAME), "--clobber"] });
  cmds.push({ args: ["release", "upload", LATEST_TAG, f(SUMS_NAME), "--clobber"] });
  if (o.sideFiles.length) cmds.push({ args: ["release", "upload", LATEST_TAG, ...o.sideFiles.map(f), "--clobber"] });
  cmds.push({ args: ["release", "upload", LATEST_TAG, f(MANIFEST_NAME), "--clobber"] });
  cmds.push({ args: ["release", "edit", LATEST_TAG, "--latest=false"], notes: latestNotes(o.tag, o.manifest) });
  for (const r of o.releases) {
    const s = parseSnapshotTag(r.tagName);
    if (!s || r.tagName === o.tag || /\(superseded\)\s*$/.test(r.name)) continue;
    cmds.push({
      args: ["release", "edit", r.tagName, "--title", snapshotTitle(r.tagName, "superseded"), "--latest=false"],
      notes: supersededNote(o.tag, o.date) + (r.body ?? ""),
    });
  }
  return cmds;
}

/**
 * The commit a new snapshot tag points at: the newest first-parent commit whose own change
 * does not touch `.github/workflows/`. GitHub's REST docs for creating and updating a release
 * say a GitHub App installation token needs the Workflows permission when the target commit
 * modifies workflow files, and the Actions GITHUB_TOKEN cannot be given that permission.
 * The commit that built the index is recorded separately (`code_sha` in index.json).
 */
export function pickTagTarget(commits: { sha: string; files: string[] }[]): string | null {
  return commits.find((c) => !c.files.some((f) => f.startsWith(".github/workflows/")))?.sha ?? null;
}
