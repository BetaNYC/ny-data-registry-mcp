/**
 * Settings for keeping an installed index current (issue #15), and how old an index is.
 *
 * Automatic updates are on by default. They are off when any of these holds, and
 * `registry_info.index_status.auto_update` names the one that did it:
 * - NY_DATA_INDEX_AUTO_UPDATE=0
 * - NY_DATA_INDEX is set: the file is one you manage, so it is never replaced on its own
 * - NY_DATA_INDEX_URL names a dated snapshot (`.../download/index-YYYY-MM-DD/...`): a pin
 * - NY_DATA_INDEX_AUTO_DOWNLOAD=0: no downloads at all
 * - offline mode (NY_DATA_OFFLINE=1), unless the URL is on this machine (tests)
 * The `ny-data-registry update` command works in every case but offline mode.
 */
import { indexUrl, isLoopback } from "./fetchindex.js";

export const DEFAULT_REFRESH_DAYS = 5;
export const DEFAULT_STALE_DAYS = 14;
export const DEFAULT_CHECK_HOURS = 24;
export const DEFAULT_CHECK_DELAY_SECONDS = 300;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface UpdateConfig {
  auto: boolean;
  off_reason: string | null;
  refresh_days: number;
  stale_days: number;
  check_hours: number;
  check_delay_seconds: number;
  /** Settings that could not be read and fell back to their defaults. */
  warnings: string[];
}

function num(name: string, def: number, min: number, warnings: string[]): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min) {
    warnings.push(`${name}=${raw} is not a number of at least ${min}; using ${def}`);
    return def;
  }
  return v;
}

/** The dated snapshot a URL pins, or null. */
export function pinnedSnapshot(url: string): string | null {
  try {
    const m = new URL(url).pathname.match(/\/(index-\d{4}-\d{2}-\d{2})\//);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function updateConfig(url = indexUrl()): UpdateConfig {
  const warnings: string[] = [];
  const flag = process.env.NY_DATA_INDEX_AUTO_UPDATE;
  if (flag !== undefined && !["", "0", "1"].includes(flag.trim())) warnings.push(`NY_DATA_INDEX_AUTO_UPDATE=${flag} is not 0 or 1; treated as on`);
  const cfg: UpdateConfig = {
    auto: true,
    off_reason: null,
    refresh_days: num("NY_DATA_INDEX_REFRESH_DAYS", DEFAULT_REFRESH_DAYS, 0, warnings),
    stale_days: num("NY_DATA_INDEX_STALE_DAYS", DEFAULT_STALE_DAYS, 1, warnings),
    check_hours: num("NY_DATA_INDEX_CHECK_HOURS", DEFAULT_CHECK_HOURS, 1, warnings),
    check_delay_seconds: num("NY_DATA_INDEX_CHECK_DELAY_SECONDS", DEFAULT_CHECK_DELAY_SECONDS, 0, warnings),
    warnings,
  };
  const pin = pinnedSnapshot(url);
  let off: string | null = null;
  if (flag?.trim() === "0") off = "NY_DATA_INDEX_AUTO_UPDATE=0";
  else if (process.env.NY_DATA_INDEX) off = "NY_DATA_INDEX is set, so the index is a file you manage";
  else if (pin) off = `NY_DATA_INDEX_URL pins the snapshot ${pin}`;
  else if (process.env.NY_DATA_INDEX_AUTO_DOWNLOAD === "0") off = "NY_DATA_INDEX_AUTO_DOWNLOAD=0";
  else if (process.env.NY_DATA_OFFLINE === "1" && !isLoopback(url)) off = "offline mode (NY_DATA_OFFLINE=1)";
  if (off) {
    cfg.auto = false;
    cfg.off_reason = off;
  }
  return cfg;
}

/** Days since `lastHarvest` (an ISO time), to one decimal; null when it cannot be read. */
export function ageDays(lastHarvest: string | null | undefined, now = Date.now()): number | null {
  if (!lastHarvest) return null;
  const t = Date.parse(lastHarvest);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round(((now - t) / DAY_MS) * 10) / 10);
}

export const UPDATE_COMMAND = "npx -y -p @betanyc/ny-data-registry-mcp ny-data-registry update";

/** The short note a dataset search carries when the index is older than NY_DATA_INDEX_STALE_DAYS; null otherwise. */
export function staleNote(lastHarvest: string | null | undefined, now = Date.now()): string | null {
  const age = ageDays(lastHarvest, now);
  const cfg = updateConfig();
  if (age === null || age <= cfg.stale_days) return null;
  const off = cfg.auto ? "" : ` Automatic updates are off (${cfg.off_reason}).`;
  return `This index was harvested ${Math.floor(age)} days ago (${String(lastHarvest).slice(0, 10)}), so newer datasets may be missing.${off} Run \`${UPDATE_COMMAND}\` to get the newest.`;
}
