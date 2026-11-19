import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, realpathSync } from "node:fs";

/** Package `data/` directory (bundled registry and the human-editable tables). */
export const DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));

export function readDataJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(DATA_DIR, name), "utf8")) as T;
}

/** Cache root: ${HOME}/.cache/betanyc/ny-data-registry, overridable for tests and CI. */
export function cacheDir(): string {
  return process.env.NY_DATA_CACHE_DIR || join(homedir(), ".cache", "betanyc", "ny-data-registry");
}

/** SQLite index location. */
export function indexPath(): string {
  return process.env.NY_DATA_INDEX || join(cacheDir(), "ny-data-index.sqlite");
}

export const VERSION = "0.4.0";

/** Descriptive User-Agent. No email address, by design. */
export const USER_AGENT = `ny-data-registry-mcp/${VERSION} (BetaNYC read-only open data catalog index; +https://beta.nyc)`;

export const REGISTRY_URL =
  "https://betanyc.github.io/grounding-ai-with-ny-open-data/resources/ny-data-portal-registry.json";

export const REGISTRY_PAGE =
  "https://betanyc.github.io/grounding-ai-with-ny-open-data/resources/ny-data-portal-registry.html";

/** Where search_datasets writes its full-result CSV files. Only files this package names are ever pruned there. */
export function exportDir(): string {
  return process.env.NY_DATA_EXPORT_DIR || join(cacheDir(), "exports");
}

/** The temp folder's stand-in in tool answers. */
export const TEMP_LABEL = "<temp>";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One folder as it can appear in text: as given, with either kind of slash, and its real path
 * (macOS's /var is /private/var). No trailing slash. */
function spellings(dir: string): string[] {
  const out = new Set<string>();
  const add = (p: string) => {
    const t = p.replace(/[\\/]+$/, "");
    if (t.length < 2) return;
    out.add(t);
    out.add(t.replace(/\\/g, "/"));
    out.add(t.replace(/\//g, "\\"));
  };
  add(dir);
  try {
    add(realpathSync.native(dir));
  } catch {
    /* gone or unreadable: the given spelling is enough */
  }
  if (/^\/private\//.test(dir)) add(dir.slice("/private".length));
  else if (/^\/(var|tmp)\//.test(dir)) add(`/private${dir}`);
  return [...out];
}

/**
 * `text` with this machine's personal folders replaced: the home folder by "~" and the temp
 * folder by "<temp>" (the home folder holds the account name; the temp folder is per machine
 * and, on Windows, inside the home folder). Each is matched as written, with / or \\, and by its
 * real path; on Windows without regard to case. A folder only matches whole (/Users/jo does not
 * match inside /Users/joan). Every tool answer goes through this (src/tools.ts); the CLI's own
 * terminal output keeps full paths. `opts` is for tests.
 */
export function hideLocalPaths(text: string, opts: { home?: string; temp?: string; platform?: string } = {}): string {
  const platform = opts.platform ?? process.platform;
  const swaps: [string, string][] = [];
  for (const [dir, label] of [[opts.home ?? homedir(), "~"], [opts.temp ?? tmpdir(), TEMP_LABEL]] as const) {
    if (dir) for (const sp of spellings(dir)) swaps.push([sp, label]);
  }
  let out = text;
  // Longest first, so a temp folder inside the home folder (Windows) is named as the temp folder.
  for (const [dir, label] of swaps.sort((a, b) => b[0].length - a[0].length)) {
    const re = new RegExp(`${escapeRe(dir)}(?![^\\\\/\\s"'\`)\\]},;:])`, platform === "win32" ? "gi" : "g");
    out = out.replace(re, label);
  }
  return out;
}

/** `v` with hideLocalPaths applied to every string in it, at any depth (keys too). */
export function hideLocalPathsDeep<T>(v: T): T {
  if (typeof v === "string") return hideLocalPaths(v) as T;
  if (Array.isArray(v)) return v.map((x) => hideLocalPathsDeep(x)) as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [hideLocalPaths(k), hideLocalPathsDeep(x)])) as T;
  }
  return v;
}
