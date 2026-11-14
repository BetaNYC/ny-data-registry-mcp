/**
 * Roll `index-latest` back to a kept snapshot, by hand, when a published index turns out bad.
 * Pure functions; src/publish/cli.ts (`rollback`) downloads, verifies and runs the commands.
 *
 * - The target must be a dated snapshot that exists, that retention keeps, that has every file
 *   a publish makes (with `index.json`), whose schema this package reads, and that is older than
 *   what `index-latest` holds now. Anything else is refused, and nothing changes.
 * - The snapshot's files are copied over `index-latest` in the publish order (.gz, SHA256SUMS,
 *   side files, `index.json` last). Its `index.json` gains `rolled_back: {from, to, reason, at,
 *   by, from_last_harvest, from_sqlite_sha256}`. Servers that see it replace an index newer than
 *   the target with the target (src/refresh.ts).
 * - The bad snapshot is relabeled "(rolled back)" and the target "(current)", each with a line
 *   at the top of its notes. Nothing is deleted.
 * - The next normal publish uploads a fresh `index.json` without `rolled_back`, which clears it.
 */
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { GZ_NAME, MANIFEST_NAME, SQLITE_NAME, SUMS_NAME, type Manifest } from "./prepare.js";
import { LATEST_TAG, REPO_URL, parseSnapshotTag, planRetention, snapshotTitle, type GhCommand, type ReleaseInfo } from "./releases.js";

export interface RollbackRecord {
  /** The snapshot `index-latest` held before the rollback, or null when it could not be told. */
  from: string | null;
  to: string;
  reason: string;
  at: string;
  by: string | null;
  from_last_harvest: string | null;
  from_sqlite_sha256: string | null;
}

/**
 * Why a rollback to `to` must be refused; empty when it may go ahead.
 * `current` is `index-latest`'s index.json now (null if it has none); `target` the snapshot's.
 */
export function rollbackProblems(o: {
  to: string;
  reason: string;
  releases: ReleaseInfo[];
  current: Manifest | null;
  target: Manifest | null;
  targetFiles: string[];
  sideFiles: string[];
  schemaVersion: number;
}): string[] {
  const p: string[] = [];
  if (!o.reason.trim()) p.push("a reason is required; it is published in index.json and the release notes");
  if (!parseSnapshotTag(o.to)) return [...p, `${o.to} is not a dated snapshot tag (index-YYYY-MM-DD or index-YYYY-MM-DD-N)`];
  if (!o.releases.some((r) => r.tagName === o.to)) return [...p, `${o.to} does not exist (retention may have deleted it); pick a kept snapshot`];
  if (!planRetention(o.releases).keep.some((k) => k.tag === o.to)) p.push(`${o.to} is due for deletion under retention; pick a kept snapshot`);
  const missing = [GZ_NAME, SUMS_NAME, MANIFEST_NAME, ...o.sideFiles].filter((f) => !o.targetFiles.includes(f));
  if (missing.length) p.push(`${o.to} lacks ${missing.join(", ")}; servers need index.json to see a rollback, so only snapshots made by the nightly harvest can be rollback targets`);
  if (!o.target) return p;
  if (o.target.schema_version !== o.schemaVersion) p.push(`${o.to} has schema version ${o.target.schema_version ?? "(none)"} and this package reads ${o.schemaVersion}; servers would refuse it`);
  if (o.current) {
    if (o.current.sqlite_sha256 === o.target.sqlite_sha256) p.push(`index-latest already holds ${o.to}`);
    else if (!(Date.parse(o.target.last_harvest ?? "") < Date.parse(o.current.last_harvest ?? ""))) {
      p.push(`${o.to} (harvested ${o.target.last_harvest ?? "unknown"}) is not older than index-latest (harvested ${o.current.last_harvest ?? "unknown"}); a rollback only goes back. A normal publish moves forward.`);
    }
  }
  return p;
}

/** Check a downloaded snapshot against its own index.json and SHA256SUMS: the .gz and the unzipped file. */
export async function verifySnapshotFiles(dir: string, m: Manifest): Promise<string[]> {
  const sums = new Map<string, string>();
  for (const line of readFileSync(join(dir, SUMS_NAME), "utf8").split(/\r?\n/)) {
    const hit = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (hit) sums.set(hit[2].trim(), hit[1].toLowerCase());
  }
  const gzHash = createHash("sha256");
  for await (const chunk of createReadStream(join(dir, GZ_NAME))) gzHash.update(chunk as Buffer);
  const dbHash = createHash("sha256");
  await pipeline(createReadStream(join(dir, GZ_NAME)), createGunzip(), async function (src: AsyncIterable<Buffer>) {
    for await (const chunk of src) dbHash.update(chunk as Buffer);
  });
  const [gz, db] = [gzHash.digest("hex"), dbHash.digest("hex")];
  const p: string[] = [];
  if (gz !== m.gz_sha256 || gz !== sums.get(GZ_NAME)) p.push(`${GZ_NAME} does not match its index.json and SHA256SUMS sums`);
  if (db !== m.sqlite_sha256 || db !== sums.get(SQLITE_NAME)) p.push(`the unzipped ${SQLITE_NAME} does not match its index.json and SHA256SUMS sums`);
  return p;
}

/** The snapshot that holds `current`, matched by its index.json: `snapshot_tag` when set, else the sqlite sum. */
export function findSnapshotTag(current: Manifest | null, snapshots: { tag: string; manifest: Manifest | null }[]): string | null {
  if (!current) return null;
  if (current.snapshot_tag) return current.snapshot_tag;
  return snapshots.find((s) => s.manifest?.sqlite_sha256 === current.sqlite_sha256)?.tag ?? null;
}

export function rollbackRecord(o: { to: string; reason: string; at: string; by: string | null; current: Manifest | null; from: string | null }): RollbackRecord {
  return {
    from: o.from,
    to: o.to,
    reason: o.reason.trim(),
    at: o.at,
    by: o.by,
    from_last_harvest: o.current?.last_harvest ?? null,
    from_sqlite_sha256: o.current?.sqlite_sha256 ?? null,
  };
}

/** The index.json `index-latest` gets: the target's own, plus `rolled_back`. */
export function rolledBackManifest(target: Manifest, rec: RollbackRecord): Manifest {
  return { ...target, snapshot_tag: target.snapshot_tag ?? rec.to, rolled_back: rec };
}

const link = (tag: string) => `[${tag}](${REPO_URL}/releases/tag/${tag})`;

export function rollbackLatestNotes(m: Manifest, rec: RollbackRecord): string {
  return [
    `The rolling copy of the harvested New York open data index. **The MCP server downloads this release by itself on first run.** Its URL never changes:`,
    ``,
    `\`${REPO_URL}/releases/download/${LATEST_TAG}/${GZ_NAME}\``,
    ``,
    `**Rolled back** on ${rec.at.slice(0, 10)}${rec.by ? ` by ${rec.by}` : ""}, from ${rec.from ? link(rec.from) : "the index published before"} to ${link(rec.to)}. Reason given: ${rec.reason}`,
    ``,
    `Current contents: the harvest of ${m.last_harvest ?? "unknown"}, the same files as ${link(rec.to)}. Servers holding a newer index replace it with this one at their next check. The next nightly publish moves forward again.`,
    ``,
    `It holds **metadata only**: dataset titles, descriptions, column names and types, formats and links. No dataset contents. Each file is checked against \`SHA256SUMS\` before it is installed; \`index.json\` describes the current files and the rollback.`,
    ``,
  ].join("\n");
}

export function rolledBackNote(rec: RollbackRecord): string {
  return `**Rolled back** on ${rec.at.slice(0, 10)}: \`${LATEST_TAG}\` went back to ${link(rec.to)}. Reason given: ${rec.reason}\n\n`;
}

export function currentAgainNote(rec: RollbackRecord): string {
  return `**Current again** on ${rec.at.slice(0, 10)}: \`${LATEST_TAG}\` was rolled back to this copy${rec.from ? ` from ${link(rec.from)}` : ""}. Reason given: ${rec.reason}\n\n`;
}

/**
 * Every gh call for one rollback, in order: the target's files over `index-latest` (.gz,
 * SHA256SUMS, side files, index.json last), `index-latest`'s notes, then the two snapshot labels.
 * Same order as a publish, for the same reason (src/publish/releases.ts publishCommands).
 */
export function rollbackCommands(o: { dir: string; sideFiles: string[]; manifest: Manifest; rec: RollbackRecord; releases: ReleaseInfo[] }): GhCommand[] {
  const f = (n: string) => join(o.dir, n);
  const body = (tag: string | null) => o.releases.find((r) => r.tagName === tag)?.body ?? "";
  const cmds: GhCommand[] = [
    { args: ["release", "upload", LATEST_TAG, f(GZ_NAME), "--clobber"] },
    { args: ["release", "upload", LATEST_TAG, f(SUMS_NAME), "--clobber"] },
  ];
  if (o.sideFiles.length) cmds.push({ args: ["release", "upload", LATEST_TAG, ...o.sideFiles.map(f), "--clobber"] });
  cmds.push({ args: ["release", "upload", LATEST_TAG, f(MANIFEST_NAME), "--clobber"] });
  cmds.push({ args: ["release", "edit", LATEST_TAG, "--latest=false"], notes: rollbackLatestNotes(o.manifest, o.rec) });
  if (o.rec.from && parseSnapshotTag(o.rec.from) && o.releases.some((r) => r.tagName === o.rec.from)) {
    cmds.push({ args: ["release", "edit", o.rec.from, "--title", snapshotTitle(o.rec.from, "rolled back"), "--latest=false"], notes: rolledBackNote(o.rec) + body(o.rec.from) });
  }
  cmds.push({ args: ["release", "edit", o.rec.to, "--title", snapshotTitle(o.rec.to, "current"), "--latest=false"], notes: currentAgainNote(o.rec) + body(o.rec.to) });
  return cmds;
}

export function rollbackSummaryMarkdown(o: { rec: RollbackRecord | null; problems: string[]; dryRun: boolean }): string {
  if (o.problems.length) return [`## Rollback refused`, ``, `Nothing changed. \`${LATEST_TAG}\` is as it was.`, ``, ...o.problems.map((p) => `- ${p}`), ``].join("\n");
  const r = o.rec!;
  return [
    `## ${o.dryRun ? "Rollback (dry run: nothing changed)" : "Rolled back"}`,
    ``,
    `- **From:** ${r.from ?? "unknown"} (harvested ${r.from_last_harvest ?? "unknown"})`,
    `- **To:** ${r.to}`,
    `- **Reason:** ${r.reason}`,
    `- **By:** ${r.by ?? "unknown"}`,
    ``,
    `Servers with a newer index replace it with ${r.to} at their next check (within a day). The next nightly publish clears the rollback.`,
    ``,
  ].join("\n");
}
