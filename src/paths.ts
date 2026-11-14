import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

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

export const VERSION = "0.3.0";

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
