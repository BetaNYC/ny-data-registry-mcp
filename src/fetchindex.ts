/**
 * First-run download of the prebuilt dataset index from the GitHub release.
 *
 * - Runs once, when the index file is missing. It never replaces an existing index
 *   unless asked (`ny-data-registry download --force`).
 * - Verifies both SHA-256 sums in the release's SHA256SUMS (the .gz and the unzipped
 *   .sqlite) and checks the schema version before installing. An unverified file is
 *   never installed.
 * - Writes to `<index>.part` and renames, so a half-finished download is never read.
 * - A `<index>.lock` file keeps two server processes from downloading at once.
 * - Off when NY_DATA_INDEX_AUTO_DOWNLOAD=0, and in offline mode (NY_DATA_OFFLINE=1),
 *   except for a loopback URL, which is how the tests serve a fixture release.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, createWriteStream } from "node:fs";
import { basename, dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { indexPath, USER_AGENT } from "./paths.js";
import { SCHEMA_VERSION } from "./db.js";

export const DEFAULT_INDEX_URL =
  "https://github.com/BetaNYC/ny-data-registry-mcp/releases/download/index-latest/ny-data-index.sqlite.gz";
export const INDEX_RELEASES_PAGE = "https://github.com/BetaNYC/ny-data-registry-mcp/releases";

/** The unzipped file name as it appears in SHA256SUMS. */
const SQLITE_NAME = "ny-data-index.sqlite";
const MAX_COMPRESSED_BYTES = 500 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 2 * 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const STALE_LOCK_MS = 15 * 60 * 1000;

export function indexUrl(): string {
  return process.env.NY_DATA_INDEX_URL || DEFAULT_INDEX_URL;
}

function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
}

/** Whether a first-run download may happen, and if not, why. */
export function autoDownloadAllowed(url = indexUrl()): { allowed: boolean; reason?: string } {
  if (process.env.NY_DATA_INDEX_AUTO_DOWNLOAD === "0") return { allowed: false, reason: "NY_DATA_INDEX_AUTO_DOWNLOAD=0" };
  if (process.env.NY_DATA_OFFLINE === "1" && !isLoopback(url)) return { allowed: false, reason: "offline mode (NY_DATA_OFFLINE=1)" };
  return { allowed: true };
}

export interface DownloadState {
  status: "not-started" | "downloading" | "installed" | "failed" | "skipped";
  url: string;
  path: string;
  started_at?: string;
  finished_at?: string;
  bytes?: number;
  error?: string;
}

let state: DownloadState = { status: "not-started", url: indexUrl(), path: indexPath() };
let inflight: Promise<DownloadState> | null = null;
let lastFailureAt = 0;
/** After a failed download, wait this long before trying again, so a broken release is not fetched on every call. */
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;

export function downloadState(): DownloadState {
  return { ...state };
}

export class DownloadError extends Error {}

async function fetchOk(url: string, signal: AbortSignal): Promise<Response> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow", signal });
  if (!res.ok) throw new DownloadError(`HTTP ${res.status} for ${url}`);
  return res;
}

function parseSums(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const hit = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (hit) m.set(hit[2].trim(), hit[1].toLowerCase());
  }
  return m;
}

/** Hashes and counts bytes as they pass through; fails past `max`. */
function meter(max: number, label: string) {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > max) return cb(new DownloadError(`${label} is larger than ${max} bytes; refusing it`));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  return { stream, digest: () => hash.digest("hex"), bytes: () => bytes };
}

function safeUnlink(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    /* already gone */
  }
}

/** Take the lock, or wait for whoever holds it to finish. Returns false if the index appeared meanwhile. */
async function acquireLock(lock: string, target: string, waitMs: number): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(lock, "wx"));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let age = 0;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      continue; // released between our open and stat: try again
    }
    if (age > STALE_LOCK_MS) {
      safeUnlink(lock); // left behind by a process that died mid-download
      continue;
    }
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      if (existsSync(target)) return false;
      if (!existsSync(lock)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (existsSync(target)) return false;
    if (existsSync(lock)) throw new DownloadError("another process is downloading the index; try again in a minute");
  }
  throw new DownloadError("could not take the download lock");
}

/**
 * Download, verify and install the index. Resolves with the installed path and size.
 * Throws DownloadError (or a network error) on any failure; nothing partial is left at `path`.
 */
export async function downloadIndex(opts: { path?: string; url?: string; force?: boolean; lockWaitMs?: number } = {}): Promise<{ path: string; bytes: number; skipped?: boolean }> {
  const path = opts.path ?? indexPath();
  const url = opts.url ?? indexUrl();
  if (!opts.force && existsSync(path)) return { path, bytes: statSync(path).size, skipped: true };
  if (process.env.NY_DATA_OFFLINE === "1" && !isLoopback(url)) throw new DownloadError(`offline mode (NY_DATA_OFFLINE=1): refused to fetch ${url}`);

  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const part = `${path}.part`;
  if (!(await acquireLock(lock, path, opts.lockWaitMs ?? 120_000)) && !opts.force) {
    return { path, bytes: statSync(path).size, skipped: true };
  }
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  try {
    const sums = parseSums(await (await fetchOk(url.replace(/[^/]+$/, "SHA256SUMS"), signal)).text());
    const gzName = basename(new URL(url).pathname);
    const wantGz = sums.get(gzName);
    const wantDb = sums.get(SQLITE_NAME);
    if (!wantGz || !wantDb) throw new DownloadError(`SHA256SUMS does not list both ${gzName} and ${SQLITE_NAME}; refusing an unverified index`);

    const res = await fetchOk(url, signal);
    if (!res.body) throw new DownloadError(`empty response for ${url}`);
    const gz = meter(MAX_COMPRESSED_BYTES, "the download");
    const raw = meter(MAX_UNZIPPED_BYTES, "the unzipped index");
    safeUnlink(part);
    await pipeline(Readable.fromWeb(res.body as never), gz.stream, createGunzip(), raw.stream, createWriteStream(part), { signal });

    if (gz.digest() !== wantGz) throw new DownloadError(`checksum mismatch for ${gzName}; the file was not installed`);
    if (raw.digest() !== wantDb) throw new DownloadError(`checksum mismatch for ${SQLITE_NAME}; the file was not installed`);

    const check = new DatabaseSync(part, { readOnly: true });
    try {
      const row = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
      const v = Number(row?.value);
      if (v !== SCHEMA_VERSION) {
        throw new DownloadError(
          `the published index has schema version ${row?.value ?? "(none)"}, and this package reads version ${SCHEMA_VERSION}. ` +
            "Update the package (npx -y @betanyc/ny-data-registry-mcp@latest), or build the index with `ny-data-registry harvest`."
        );
      }
    } finally {
      check.close();
    }
    renameSync(part, path);
    return { path, bytes: raw.bytes() };
  } finally {
    // The schema check opens the .part file, and SQLite leaves WAL side files beside it.
    for (const f of [part, `${part}-shm`, `${part}-wal`, lock]) safeUnlink(f);
  }
}

/** Start the first-run download if the index is missing and downloads are allowed. Never throws. */
export function ensureIndex(): Promise<DownloadState> {
  const path = indexPath();
  const url = indexUrl();
  if (existsSync(path)) return Promise.resolve(downloadState());
  if (inflight) return inflight;
  if (state.status === "failed" && Date.now() - lastFailureAt < RETRY_AFTER_FAILURE_MS) return Promise.resolve(downloadState());
  const ok = autoDownloadAllowed(url);
  if (!ok.allowed) {
    state = { status: "skipped", url, path, error: `automatic download is off: ${ok.reason}` };
    return Promise.resolve(downloadState());
  }
  state = { status: "downloading", url, path, started_at: new Date().toISOString() };
  inflight = downloadIndex({ path, url })
    .then((r) => {
      state = { ...state, status: "installed", finished_at: new Date().toISOString(), bytes: r.bytes };
      return downloadState();
    })
    .catch((e) => {
      lastFailureAt = Date.now();
      state = { ...state, status: "failed", finished_at: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) };
      return downloadState();
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Wait up to `waitMs` for a missing index to arrive. Resolves with the download state either way. */
export async function awaitIndex(waitMs: number): Promise<DownloadState> {
  if (existsSync(indexPath())) return downloadState();
  const p = ensureIndex();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<DownloadState>((r) => (timer = setTimeout(() => r(downloadState()), waitMs)));
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
