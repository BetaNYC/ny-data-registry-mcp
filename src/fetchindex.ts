/**
 * Download, check and install the prebuilt dataset index from the GitHub release.
 *
 * - First run: `ensureIndex()` downloads the index when the file is missing.
 * - Updates: `refresh.ts` decides when a newer index should replace the installed one
 *   (issue #15) and calls `downloadIndex({ force: true, expect })` with the sums from the
 *   release's `index.json` manifest. `ny-data-registry download --force` replaces it by hand.
 * - Verifies both SHA-256 sums (the .gz and the unzipped .sqlite; from the manifest, or else
 *   from the release's SHA256SUMS) and the schema version before installing. An unverified
 *   file is never installed, and the installed index is not touched until the new one passes.
 * - Writes to `<index>.part` and renames, so a half-finished download is never read.
 * - If the rename fails because another process has the index open (Windows: EBUSY or EPERM,
 *   see `SWAP_BLOCKED`), the verified file waits as `<index>.next` and is installed the next
 *   time the index is opened with nothing holding it (`installPendingIndex`).
 * - `<index>.source.json` records what was installed (URL, SHA-256, harvest time).
 * - A `<index>.lock` file keeps two processes from downloading at once.
 * - Off when NY_DATA_INDEX_AUTO_DOWNLOAD=0, and in offline mode (NY_DATA_OFFLINE=1),
 *   except for a loopback URL, which is how the tests serve a fixture release.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, createWriteStream, writeFileSync } from "node:fs";
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
export const SQLITE_NAME = "ny-data-index.sqlite";
const MAX_COMPRESSED_BYTES = 500 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 2 * 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const STALE_LOCK_MS = 15 * 60 * 1000;

export function indexUrl(): string {
  return process.env.NY_DATA_INDEX_URL || DEFAULT_INDEX_URL;
}

export function isLoopback(url: string): boolean {
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

/** Try once to take the lock. False when a live process holds it (a lock older than STALE_LOCK_MS is cleared). */
function tryLock(lock: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(lock, "wx"));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs <= STALE_LOCK_MS) return false;
    } catch {
      continue; // released between our open and stat: try again
    }
    safeUnlink(lock); // left behind by a process that died mid-download
  }
  return false;
}

/** What `<index>.source.json` records about the installed file. */
export interface IndexSource {
  url: string | null;
  sqlite_sha256: string;
  gz_sha256: string | null;
  last_harvest: string | null;
  /** Size and modification time of the file this describes; a mismatch means the record is out of date. */
  bytes: number;
  mtime_ms: number;
  /** When this server installed it; null when the record was made by hashing a file already there. */
  installed_at: string | null;
}

export const sourcePath = (path: string) => `${path}.source.json`;
export const pendingPath = (path: string) => `${path}.next`;

/** Write a JSON file by writing a temporary file and renaming it over the target. */
function writeJsonAtomic(path: string, v: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n");
  renameSync(tmp, path);
}

/** The record for the file at `path`, or null when there is none or it no longer matches the file. */
export function readSource(path: string): IndexSource | null {
  try {
    const s = JSON.parse(readFileSync(sourcePath(path), "utf8")) as IndexSource;
    const st = statSync(path);
    if (typeof s.sqlite_sha256 !== "string" || s.bytes !== st.size || s.mtime_ms !== st.mtimeMs) return null;
    return s;
  } catch {
    return null;
  }
}

export function writeSource(path: string, s: Omit<IndexSource, "bytes" | "mtime_ms">): void {
  const st = statSync(path);
  writeJsonAtomic(sourcePath(path), { ...s, bytes: st.size, mtime_ms: st.mtimeMs });
}

/**
 * Rename error codes that mean "something has the file open", not "this cannot work".
 * libuv's rename on Windows is MoveFileExW with MOVEFILE_REPLACE_EXISTING, and its error table
 * (src/win/error.c, uv_translate_sys_error) turns ERROR_SHARING_VIOLATION and
 * ERROR_LOCK_VIOLATION into EBUSY and ERROR_ACCESS_DENIED into EPERM. SQLite's own docs say
 * Windows does not allow renaming a database file while it is open
 * (https://www.sqlite.org/howtocorrupt.html § 2.5). EACCES is included for safety.
 */
export const SWAP_BLOCKED = new Set(["EBUSY", "EPERM", "EACCES"]);

type RenameFn = (from: string, to: string) => void;

/**
 * Remove the SQLite side files an older WAL-mode index left beside `path`, which would be
 * mispaired with the new file (https://www.sqlite.org/howtocorrupt.html). Only a 0-byte -wal is
 * removed, with its -shm. A non-empty -wal means someone wrote to the index: it is kept and
 * reported, never deleted.
 */
function clearSideFiles(path: string): string | null {
  const wal = `${path}-wal`;
  let size: number;
  try {
    size = statSync(wal).size;
  } catch {
    return null;
  }
  if (size > 0) return `kept ${wal} (${size} bytes): it holds writes that are not in the index file`;
  safeUnlink(wal);
  safeUnlink(`${path}-shm`);
  return null;
}

/**
 * Install a waiting `<index>.next` if there is one. Synchronous and cheap (two renames), so it
 * can run just before the index is opened. `.next` only counts when its record is beside it:
 * the record is written after the verified file is renamed into place, so a `.next` without one
 * may be incomplete and is removed. Returns true when it installed a file.
 */
export function installPendingIndex(path = indexPath(), rename: RenameFn = renameSync): boolean {
  const next = pendingPath(path);
  if (!existsSync(next)) return false;
  if (!existsSync(sourcePath(next))) {
    safeUnlink(next);
    return false;
  }
  try {
    rename(next, path);
  } catch (e) {
    if (SWAP_BLOCKED.has((e as NodeJS.ErrnoException).code ?? "")) return false; // still in use; try again later
    throw e;
  }
  clearSideFiles(path);
  try {
    renameSync(sourcePath(next), sourcePath(path));
  } catch {
    safeUnlink(sourcePath(path)); // a stale record would describe the old file; it is rebuilt by hashing
  }
  return true;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  skipped?: boolean;
  /** Another process holds the download lock; nothing was done. */
  busy?: boolean;
  /** Verified and saved as `<index>.next`, because the index is open elsewhere. */
  pending?: boolean;
  sqlite_sha256?: string;
  last_harvest?: string | null;
  note?: string | null;
}

/**
 * Download, verify and install the index. Resolves with the installed path and size.
 * Throws DownloadError (or a network error) on any failure; nothing partial is left at `path`,
 * and an index already at `path` is left exactly as it was.
 *
 * `expect` gives the sums (and size) from the release's index.json; without it they come from
 * SHA256SUMS. `beforeSwap` runs just before the rename (the server closes its own handle
 * there). With `busyOk`, a held lock returns `{ busy: true }` instead of throwing.
 */
export async function downloadIndex(
  opts: {
    path?: string;
    url?: string;
    force?: boolean;
    lockWaitMs?: number;
    expect?: { gz_sha256: string; sqlite_sha256: string; sqlite_bytes?: number };
    beforeSwap?: () => void;
    busyOk?: boolean;
    /** For tests: stands in for fs.renameSync when moving the verified file into place. */
    rename?: RenameFn;
  } = {}
): Promise<DownloadResult> {
  const path = opts.path ?? indexPath();
  const url = opts.url ?? indexUrl();
  if (!opts.force && existsSync(path)) return { path, bytes: statSync(path).size, skipped: true };
  if (process.env.NY_DATA_OFFLINE === "1" && !isLoopback(url)) throw new DownloadError(`offline mode (NY_DATA_OFFLINE=1): refused to fetch ${url}`);

  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const part = `${path}.part`;
  if (opts.force) {
    // Replacing: the index exists, so there is nothing to wait for. One process at a time.
    if (!tryLock(lock)) {
      if (opts.busyOk) return { path, bytes: 0, busy: true };
      throw new DownloadError("another process is downloading the index; try again in a minute");
    }
  } else if (!(await acquireLock(lock, path, opts.lockWaitMs ?? 120_000))) {
    return { path, bytes: statSync(path).size, skipped: true };
  }
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const gzName = basename(new URL(url).pathname);
  try {
    let wantGz: string | undefined;
    let wantDb: string | undefined;
    if (opts.expect) {
      wantGz = opts.expect.gz_sha256.toLowerCase();
      wantDb = opts.expect.sqlite_sha256.toLowerCase();
    } else {
      const sums = parseSums(await (await fetchOk(url.replace(/[^/]+$/, "SHA256SUMS"), signal)).text());
      wantGz = sums.get(gzName);
      wantDb = sums.get(SQLITE_NAME);
      if (!wantGz || !wantDb) throw new DownloadError(`SHA256SUMS does not list both ${gzName} and ${SQLITE_NAME}; refusing an unverified index`);
    }

    const res = await fetchOk(url, signal);
    if (!res.body) throw new DownloadError(`empty response for ${url}`);
    const gz = meter(MAX_COMPRESSED_BYTES, "the download");
    const raw = meter(MAX_UNZIPPED_BYTES, "the unzipped index");
    safeUnlink(part);
    await pipeline(Readable.fromWeb(res.body as never), gz.stream, createGunzip(), raw.stream, createWriteStream(part), { signal });

    const from = opts.expect ? "index.json" : "SHA256SUMS";
    if (gz.digest() !== wantGz) throw new DownloadError(`checksum mismatch for ${gzName} (against ${from}); the file was not installed`);
    const dbSum = raw.digest();
    if (dbSum !== wantDb) throw new DownloadError(`checksum mismatch for ${SQLITE_NAME} (against ${from}); the file was not installed`);
    if (opts.expect?.sqlite_bytes !== undefined && raw.bytes() !== opts.expect.sqlite_bytes) {
      throw new DownloadError(`${SQLITE_NAME} is ${raw.bytes()} bytes and index.json says ${opts.expect.sqlite_bytes}; the file was not installed`);
    }

    let lastHarvest: string | null = null;
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
      lastHarvest = (check.prepare("SELECT value FROM meta WHERE key = 'last_harvest'").get() as { value: string } | undefined)?.value ?? null;
    } finally {
      check.close();
    }
    for (const f of [`${part}-shm`, `${part}-wal`]) safeUnlink(f);

    // The new file is verified. Only now is the installed index touched.
    const record = { url, sqlite_sha256: dbSum, gz_sha256: wantGz, last_harvest: lastHarvest, installed_at: new Date().toISOString() };
    const rename = opts.rename ?? renameSync;
    opts.beforeSwap?.();
    try {
      rename(part, path);
    } catch (e) {
      if (!SWAP_BLOCKED.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
      // Windows: another process has the index open. Keep the verified file for later.
      const next = pendingPath(path);
      safeUnlink(sourcePath(next));
      renameSync(part, next);
      writeSource(next, record);
      return { path, bytes: raw.bytes(), pending: true, sqlite_sha256: dbSum, last_harvest: lastHarvest, note: `the index is in use (${(e as NodeJS.ErrnoException).code}); the new one is saved as ${next} and is installed when nothing holds the index` };
    }
    safeUnlink(pendingPath(path));
    safeUnlink(sourcePath(pendingPath(path)));
    const note = clearSideFiles(path);
    writeSource(path, record);
    return { path, bytes: raw.bytes(), sqlite_sha256: dbSum, last_harvest: lastHarvest, note };
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
