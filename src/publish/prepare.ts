/**
 * Make the files a harvest publishes: a clean copy of the index, its .gz, SHA256SUMS and
 * index.json (the manifest).
 *
 * The published copy uses the rollback journal, not WAL. WAL mode is persistent in the
 * file header (https://www.sqlite.org/wal.html, "Persistence of WAL mode"; header bytes
 * 18-19 are 1 for rollback journal and 2 for WAL, https://www.sqlite.org/fileformat2.html
 * § 1.3.3), and a WAL-mode file makes every reader create -wal and -shm files beside it.
 * `VACUUM INTO` writes a compacted, consistent copy (https://www.sqlite.org/lang_vacuum.html),
 * then `PRAGMA journal_mode = DELETE` (https://www.sqlite.org/pragma.html#pragma_journal_mode)
 * sets the rollback journal on it.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { indexSummary, type IndexSummary } from "./summary.js";
import type { GateResult } from "./gate.js";

export const SQLITE_NAME = "ny-data-index.sqlite";
export const GZ_NAME = "ny-data-index.sqlite.gz";
export const SUMS_NAME = "SHA256SUMS";
export const MANIFEST_NAME = "index.json";
export const MANIFEST_VERSION = 1;

export interface Manifest {
  manifest_version: number;
  schema_version: number | null;
  last_harvest: string | null;
  registry_generated: string | null;
  sqlite_sha256: string;
  gz_sha256: string;
  sqlite_bytes: number;
  gz_bytes: number;
  datasets: number;
  portals_ok: number;
  portals_failed: number;
  run_url: string | null;
  code_sha: string | null;
  gate: { passed: boolean; overridden: boolean; override_reason: string | null; override_by: string | null; reasons: string[] } | null;
  /** Portals this harvest dropped because their ids left the registry (issue #21). */
  dropped_portals: { portal_id: string; datasets: number; reason: string }[];
}

export function buildManifest(
  s: IndexSummary,
  files: { sqlite_sha256: string; gz_sha256: string; sqlite_bytes: number; gz_bytes: number },
  meta: { run_url?: string | null; code_sha?: string | null; gate?: GateResult | null; dropped_portals?: Manifest["dropped_portals"] }
): Manifest {
  const g = meta.gate ?? null;
  return {
    manifest_version: MANIFEST_VERSION,
    schema_version: s.schema_version,
    last_harvest: s.last_harvest,
    registry_generated: s.registry_generated,
    ...files,
    datasets: s.datasets,
    portals_ok: s.portals_ok,
    portals_failed: s.portals_failed,
    run_url: meta.run_url ?? null,
    code_sha: meta.code_sha ?? null,
    gate: g ? { passed: g.passed, overridden: g.overridden, override_reason: g.override_reason, override_by: g.override_by, reasons: g.reasons } : null,
    dropped_portals: meta.dropped_portals ?? [],
  };
}

/** Lines in the format `sha256sum` writes and the server's downloader reads. */
export function sumsFile(gzSha: string, sqliteSha: string): string {
  return `${gzSha}  ${GZ_NAME}\n${sqliteSha}  ${SQLITE_NAME}\n`;
}

async function sha256(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** Header bytes 18-19 of a SQLite file: [1, 1] rollback journal, [2, 2] WAL. */
export function journalHeaderBytes(path: string): [number, number] {
  const fd = openSync(path, "r");
  try {
    const b = Buffer.alloc(2);
    readSync(fd, b, 0, 2, 18);
    return [b[0], b[1]];
  } finally {
    closeSync(fd);
  }
}

/** Write a compacted rollback-journal copy of `src` to `dest`. Throws if the copy is not in that mode. */
export function writePublishCopy(src: string, dest: string): void {
  if (existsSync(dest)) unlinkSync(dest); // VACUUM INTO needs a missing or empty target
  const db = new DatabaseSync(src);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.prepare("VACUUM INTO ?").run(dest);
  } finally {
    db.close();
  }
  const out = new DatabaseSync(dest);
  try {
    const mode = (out.prepare("PRAGMA journal_mode = DELETE").get() as { journal_mode: string }).journal_mode;
    if (mode !== "delete") throw new Error(`could not set the rollback journal on ${dest} (journal_mode = ${mode})`);
  } finally {
    out.close();
  }
  const hdr = journalHeaderBytes(dest);
  if (hdr[0] !== 1 || hdr[1] !== 1) throw new Error(`${dest} header bytes 18-19 are ${hdr.join(",")}, expected 1,1 (rollback journal)`);
}

export async function preparePublish(opts: {
  index: string;
  dir: string;
  gate?: GateResult | null;
  runUrl?: string | null;
  codeSha?: string | null;
  droppedPortals?: Manifest["dropped_portals"];
}): Promise<Manifest> {
  mkdirSync(opts.dir, { recursive: true });
  const sqlite = join(opts.dir, SQLITE_NAME);
  const gz = join(opts.dir, GZ_NAME);
  writePublishCopy(opts.index, sqlite);
  await pipeline(createReadStream(sqlite), createGzip({ level: 9 }), createWriteStream(gz));
  const [sqliteSha, gzSha] = [await sha256(sqlite), await sha256(gz)];
  writeFileSync(join(opts.dir, SUMS_NAME), sumsFile(gzSha, sqliteSha));
  const manifest = buildManifest(
    indexSummary(sqlite),
    { sqlite_sha256: sqliteSha, gz_sha256: gzSha, sqlite_bytes: statSync(sqlite).size, gz_bytes: statSync(gz).size },
    { run_url: opts.runUrl, code_sha: opts.codeSha, gate: opts.gate, dropped_portals: opts.droppedPortals }
  );
  writeFileSync(join(opts.dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
