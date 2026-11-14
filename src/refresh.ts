/**
 * Keep an installed index current (issue #15).
 *
 * The nightly harvest publishes `index.json` beside every index (src/publish/prepare.ts):
 * schema version, harvest time, both SHA-256 sums and sizes. A check reads it (under 1 KB),
 * compares it with the installed file, and downloads only when the published index is newer
 * and this package can read it. The download is verified against the manifest's sums before
 * it replaces anything (fetchindex.ts).
 *
 * - The server checks NY_DATA_INDEX_CHECK_DELAY_SECONDS (300) after it starts, then every
 *   NY_DATA_INDEX_CHECK_HOURS (24), on unref'ed timers. A check never blocks a tool call: a
 *   call made during a download answers from the old index.
 * - An automatic check downloads only when the installed index is at least
 *   NY_DATA_INDEX_REFRESH_DAYS (5) old, and asks nothing of the network before that.
 * - `ny-data-registry update` checks now, regardless of age or the automatic-update switch.
 * When automatic updates are off: src/indexage.ts.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION } from "./db.js";
import { indexPath, USER_AGENT } from "./paths.js";
import { closeDb, db } from "./datasets.js";
import {
  downloadIndex, indexUrl, installPendingIndex, isLoopback, pendingPath, readSource, sourcePath, writeSource, SQLITE_NAME, type IndexSource,
} from "./fetchindex.js";
import { ageDays, updateConfig, UPDATE_COMMAND } from "./indexage.js";

const MANIFEST_NAME = "index.json";
const MANIFEST_TIMEOUT_MS = 20_000;
const HEX64 = /^[0-9a-f]{64}$/i;

/** The fields of the published index.json this client reads. */
export interface PublishedManifest {
  schema_version: number | null;
  last_harvest: string | null;
  sqlite_sha256: string;
  gz_sha256: string;
  sqlite_bytes?: number;
}

export type Outcome =
  | "off" // automatic updates are off (automatic checks only)
  | "not-due" // the installed index is younger than REFRESH_DAYS (automatic checks only)
  | "current" // the installed index is the published one
  | "kept-local" // the installed index is as new or newer than the published one, or is not ours to replace
  | "package-too-old" // the published index needs a newer package
  | "available" // a newer index is published (update --check)
  | "updated" // a newer index was downloaded, verified and installed
  | "ready-on-restart" // downloaded and verified, waiting as <index>.next because the index is in use
  | "busy" // another process is downloading
  | "failed"; // nothing changed; see error

/**
 * Exit codes of `ny-data-registry update`: 0 current, updated, or left alone because the
 * installed index is as new as the published one; 1 failed (nothing changed) or another process
 * is downloading; 2 usage (cli.ts); 3 the published index needs a newer package; 4 (--check) a
 * newer index is published; 5 downloaded and verified but the index is in use, so it waits as
 * `<index>.next` until nothing holds it.
 */
export const UPDATE_EXIT_CODES: Record<Outcome, number> = {
  current: 0,
  updated: 0,
  "kept-local": 0,
  "not-due": 0,
  failed: 1,
  busy: 1,
  off: 1,
  "package-too-old": 3,
  available: 4,
  "ready-on-restart": 5,
};

export interface CheckResult {
  outcome: Outcome;
  message: string;
  installed_last_harvest: string | null;
  published_last_harvest: string | null;
  error?: string;
}

export interface IndexStatus {
  update: string;
  checked_at: string | null;
  published_last_harvest: string | null;
  last_error: string | null;
  note: string | null;
}

const status: IndexStatus = { update: "not checked yet", checked_at: null, published_last_harvest: null, last_error: null, note: null };
let running: Promise<CheckResult> | null = null;

function manifestUrl(url: string): string {
  return url.replace(/[^/]+$/, MANIFEST_NAME);
}

function parseManifest(v: unknown): PublishedManifest {
  const m = v as Record<string, unknown>;
  if (!m || typeof m !== "object") throw new Error("index.json is not a JSON object");
  if (typeof m.sqlite_sha256 !== "string" || !HEX64.test(m.sqlite_sha256) || typeof m.gz_sha256 !== "string" || !HEX64.test(m.gz_sha256)) {
    throw new Error("index.json does not carry both SHA-256 sums; refusing an unverified index");
  }
  return {
    schema_version: typeof m.schema_version === "number" ? m.schema_version : null,
    last_harvest: typeof m.last_harvest === "string" ? m.last_harvest : null,
    sqlite_sha256: m.sqlite_sha256.toLowerCase(),
    gz_sha256: m.gz_sha256.toLowerCase(),
    sqlite_bytes: typeof m.sqlite_bytes === "number" ? m.sqlite_bytes : undefined,
  };
}

async function getText(url: string): Promise<{ status: number; text: string }> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow", signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS) });
  return { status: res.status, text: res.ok ? await res.text() : "" };
}

/** The published manifest, or null when the release has none (404: a release from before index.json). */
export async function fetchManifest(url = indexUrl()): Promise<PublishedManifest | null> {
  const r = await getText(manifestUrl(url));
  if (r.status === 404) return null;
  if (r.status < 200 || r.status > 299) throw new Error(`HTTP ${r.status} for ${manifestUrl(url)}`);
  return parseManifest(JSON.parse(r.text));
}

/** The sqlite sum listed in SHA256SUMS (releases from before index.json). */
async function publishedSumFallback(url: string): Promise<string | null> {
  const r = await getText(url.replace(/[^/]+$/, "SHA256SUMS"));
  if (r.status < 200 || r.status > 299) throw new Error(`HTTP ${r.status} for SHA256SUMS`);
  for (const line of r.text.split(/\r?\n/)) {
    const hit = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (hit && hit[2].trim() === SQLITE_NAME) return hit[1].toLowerCase();
  }
  return null;
}

/** `last_harvest` from an index file's meta table, or null. */
export function fileLastHarvest(path: string): string | null {
  let d: DatabaseSync | null = null;
  try {
    d = new DatabaseSync(path, { readOnly: true });
    return (d.prepare("SELECT value FROM meta WHERE key = 'last_harvest'").get() as { value: string } | undefined)?.value ?? null;
  } catch {
    return null;
  } finally {
    d?.close();
  }
}

/**
 * The installed file's SHA-256: from its record when the record still matches the file,
 * otherwise by hashing it once (a stream, so the event loop keeps running) and recording it.
 */
export async function installedSum(path: string): Promise<string> {
  const rec = readSource(path);
  if (rec) return rec.sqlite_sha256;
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  const sum = h.digest("hex");
  try {
    writeSource(path, { url: null, sqlite_sha256: sum, gz_sha256: null, last_harvest: fileLastHarvest(path), installed_at: null });
  } catch {
    /* read-only folder: hash again next time */
  }
  return sum;
}

const newer = (a: string | null, b: string | null) => {
  const x = a ? Date.parse(a) : NaN;
  const y = b ? Date.parse(b) : NaN;
  return Number.isFinite(x) && Number.isFinite(y) && x > y;
};

function record(r: CheckResult): CheckResult {
  status.checked_at = new Date().toISOString();
  if (r.published_last_harvest) status.published_last_harvest = r.published_last_harvest;
  status.last_error = r.error ?? null;
  status.update = r.outcome === "failed" ? `failed: ${r.error}` : r.outcome === "off" ? r.message : r.outcome;
  status.note = r.message;
  return r;
}

/**
 * One update check. Never throws: a failure is `{ outcome: "failed" }` and leaves the
 * installed index as it was.
 *
 * `manual` (the update command) ignores NY_DATA_INDEX_REFRESH_DAYS and the automatic-update
 * switch, and installs the index if it is missing. `checkOnly` reports and changes nothing.
 */
export async function checkForUpdate(
  opts: { manual?: boolean; checkOnly?: boolean; path?: string; url?: string; now?: number; rename?: (a: string, b: string) => void } = {}
): Promise<CheckResult> {
  const path = opts.path ?? indexPath();
  const url = opts.url ?? indexUrl();
  const manual = opts.manual ?? false;
  const cfg = updateConfig(url);
  const res = (outcome: Outcome, message: string, extra: Partial<CheckResult> = {}): CheckResult =>
    record({ outcome, message, installed_last_harvest: null, published_last_harvest: null, ...extra });

  if (!manual && !cfg.auto) return res("off", `off: ${cfg.off_reason}`);
  if (process.env.NY_DATA_OFFLINE === "1" && !isLoopback(url)) {
    return res("failed", "offline mode (NY_DATA_OFFLINE=1): no update check", { error: "offline mode (NY_DATA_OFFLINE=1)" });
  }
  try {
    // The server's own handle must not hold the file during a swap (Windows), and it must
    // reopen afterwards (macOS, Linux). Only the server's default index uses that handle.
    const beforeSwap = path === indexPath() ? closeDb : undefined;
    if (!opts.checkOnly && existsSync(pendingPath(path))) {
      beforeSwap?.();
      installPendingIndex(path, opts.rename);
    }

    if (!existsSync(path)) {
      if (!manual) return res("not-due", "no index installed yet; the first-run download handles it");
      if (opts.checkOnly) return res("available", `no index installed at ${path}; \`update\` downloads it`);
      const r = await downloadIndex({ path, url, busyOk: true, beforeSwap, rename: opts.rename });
      if (r.busy) return res("busy", "another process is downloading the index; try again in a minute");
      return res("updated", `installed ${path} (harvested ${r.last_harvest ?? "unknown"}), checksums verified`, { installed_last_harvest: r.last_harvest ?? null, published_last_harvest: r.last_harvest ?? null });
    }

    const local = fileLastHarvest(path);
    const age = ageDays(local, opts.now);
    const base = { installed_last_harvest: local };
    if (!manual && age !== null && age < cfg.refresh_days) {
      return res("not-due", `the index is ${age} days old; automatic updates download after ${cfg.refresh_days}`, base);
    }

    const m = await fetchManifest(url);
    let expect: PublishedManifest | undefined;
    if (m) {
      const pub = { ...base, published_last_harvest: m.last_harvest };
      if (m.schema_version !== SCHEMA_VERSION) {
        return res("package-too-old", `the published index has schema version ${m.schema_version ?? "(none)"} and this package reads ${SCHEMA_VERSION}; update the package (npx -y @betanyc/ny-data-registry-mcp@latest). The installed index stays.`, pub);
      }
      if ((await installedSum(path)) === m.sqlite_sha256) return res("current", `already current (harvested ${local ?? m.last_harvest})`, pub);
      if (!newer(m.last_harvest, local)) {
        return res("kept-local", `the installed index (harvested ${local ?? "unknown"}) is as new as or newer than the published one (${m.last_harvest ?? "unknown"}); left alone. \`download --force\` replaces it anyway.`, pub);
      }
      if (opts.checkOnly) return res("available", `a newer index is published (harvested ${m.last_harvest}); installed: ${local ?? "unknown"}`, pub);
      expect = m;
    } else {
      // A release from before index.json: compare the sqlite sum in SHA256SUMS.
      const sum = await publishedSumFallback(url);
      if (!sum) throw new Error("the release has neither index.json nor a SHA256SUMS line for the index");
      if ((await installedSum(path)) === sum) return res("current", `already current (harvested ${local ?? "unknown"})`, base);
      const rec = readSource(path);
      if (!manual && !rec?.installed_at) {
        return res("kept-local", "the release has no index.json to compare harvest times, and the installed file was not installed by this server; left alone", base);
      }
      if (opts.checkOnly) return res("available", "the published index differs from the installed one (no index.json to compare harvest times)", base);
    }

    status.update = "downloading";
    const r = await downloadIndex({
      path,
      url,
      force: true,
      busyOk: true,
      beforeSwap,
      rename: opts.rename,
      expect: expect ? { gz_sha256: expect.gz_sha256, sqlite_sha256: expect.sqlite_sha256, sqlite_bytes: expect.sqlite_bytes } : undefined,
    });
    const done = { installed_last_harvest: r.pending ? local : (r.last_harvest ?? null), published_last_harvest: expect?.last_harvest ?? r.last_harvest ?? null };
    if (r.busy) return res("busy", "another process is downloading the index; try again in a minute", done);
    if (r.pending) return res("ready-on-restart", `downloaded and verified the index harvested ${r.last_harvest}, but ${r.note}. Restart the server (or close what has the file open) to use it.`, done);
    return res("updated", `updated to the index harvested ${r.last_harvest}, checksums verified${r.note ? `; ${r.note}` : ""}`, done);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res("failed", `update failed, the installed index is unchanged: ${msg}`, { error: msg });
  }
}

/** Run a check unless one is running; concurrent callers share it. */
export function runCheck(opts: Parameters<typeof checkForUpdate>[0] = {}): Promise<CheckResult> {
  if (!running) running = checkForUpdate(opts).finally(() => (running = null));
  return running;
}

let timers: NodeJS.Timeout[] = [];

/** Start the server's automatic checks. Never blocks; the timers do not keep the process alive. */
export function startAutoUpdate(log: (s: string) => void = (s) => console.error(s)): void {
  const cfg = updateConfig();
  for (const w of cfg.warnings) log(`ny-data-registry-mcp: ${w}`);
  if (!cfg.auto) {
    status.update = `off: ${cfg.off_reason}`;
    return;
  }
  const first = setTimeout(() => {
    void runCheck();
    const every = setInterval(() => void runCheck(), cfg.check_hours * 3_600_000);
    every.unref();
    timers.push(every);
  }, cfg.check_delay_seconds * 1000);
  first.unref();
  timers.push(first);
}

export function stopAutoUpdate(): void {
  for (const t of timers) clearTimeout(t);
  timers = [];
}

/** registry_info's `index_status`. */
export function indexStatus(now = Date.now()): Record<string, unknown> {
  const cfg = updateConfig();
  const path = indexPath();
  let lastHarvest: string | null = null;
  try {
    lastHarvest = (db().prepare("SELECT value FROM meta WHERE key = 'last_harvest'").get() as { value: string } | undefined)?.value ?? null;
  } catch {
    /* not installed */
  }
  const age = ageDays(lastHarvest, now);
  const rec: IndexSource | null = existsSync(path) ? readSource(path) : null;
  return {
    last_harvest: lastHarvest,
    age_days: age,
    stale: age !== null && age > cfg.stale_days,
    stale_after_days: cfg.stale_days,
    auto_update: cfg.auto ? { on: true, refresh_after_days: cfg.refresh_days, check_every_hours: cfg.check_hours } : { on: false, reason: cfg.off_reason },
    update: !cfg.auto && status.update === "not checked yet" ? `off: ${cfg.off_reason}` : status.update,
    checked_at: status.checked_at,
    published_last_harvest: status.published_last_harvest,
    last_error: status.last_error,
    note: status.note,
    installed_from: rec?.url ?? null,
    pending_update: existsSync(pendingPath(path)) && existsSync(sourcePath(pendingPath(path))),
    settings_warnings: cfg.warnings,
    update_command: UPDATE_COMMAND,
    bytes: existsSync(path) ? statSync(path).size : null,
  };
}
