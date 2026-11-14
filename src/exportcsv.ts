/**
 * Full-result CSV files for search_datasets: one call can hand back every match even
 * when the reply itself only has room for a summary.
 *
 * CSV follows RFC 4180 (https://www.rfc-editor.org/rfc/rfc4180): CRLF line ends, a header
 * row, and a field wrapped in double quotes when it holds a comma, a double quote, CR or
 * LF, with inner quotes doubled. Values are written as the portal published them, with one
 * exception for spreadsheet safety: a text value that starts with =, +, -, @, tab or CR gets a
 * leading apostrophe, so Excel, Numbers, LibreOffice and Google Sheets show it as text instead
 * of running it as a formula (OWASP "CSV Injection"). Numbers are never changed.
 */
import { lstatSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportDir } from "./paths.js";

/** Keep at most this many export files, and none older than EXPORT_MAX_AGE_MS. */
export const EXPORT_KEEP = 50;
export const EXPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** The only names this package writes, and the only names pruning will ever remove. */
export const EXPORT_NAME = /^search-\d{8}T\d{9}Z-\d{3}-[a-z0-9-]{1,60}\.csv$/;

/** Leading characters a spreadsheet may treat as the start of a formula. */
export const FORMULA_START = /^[=+\-@\t\r]/;

export function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (typeof v === "string" && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

export function slugFor(parts: (string | number | undefined | null)[]): string {
  const s = parts
    .filter((p) => p !== undefined && p !== null && p !== "")
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return s || "search";
}

let seq = 0;
function stamp(now: Date): string {
  // 20261112T221800123Z: sortable, no colons (safe on every file system)
  return now.toISOString().replace(/[-:]/g, "").replace(".", "");
}

export interface WrittenExport {
  path: string;
  rows: number;
  bytes: number;
  pruned: number;
}

/** Write the CSV atomically (temp file + rename), then prune old exports. */
export function writeExport(slug: string, header: string[], rows: unknown[][], now = new Date()): WrittenExport {
  const dir = exportDir();
  mkdirSync(dir, { recursive: true });
  const name = `search-${stamp(now)}-${String(seq++ % 1000).padStart(3, "0")}-${slug}.csv`;
  const path = join(dir, name);
  const body = toCsv(header, rows);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, path);
  const pruned = pruneExports(now.getTime(), name);
  return { path, rows: rows.length, bytes: Buffer.byteLength(body, "utf8"), pruned };
}

/**
 * Remove old export files. Looks only at regular files directly inside the export folder
 * whose names match EXPORT_NAME: no recursion, no symlinks, nothing else is touched.
 */
export function pruneExports(nowMs = Date.now(), keepName?: string): number {
  const dir = exportDir();
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const ours = entries
    .filter((e) => e.isFile() && EXPORT_NAME.test(e.name))
    .map((e) => ({ name: e.name, mtime: lstatSync(join(dir, e.name)).mtimeMs }))
    .sort((a, b) => b.name.localeCompare(a.name)); // newest first: names start with the timestamp
  let removed = 0;
  ours.forEach((f, i) => {
    if (f.name === keepName) return;
    if (i >= EXPORT_KEEP || nowMs - f.mtime > EXPORT_MAX_AGE_MS) {
      try {
        unlinkSync(join(dir, f.name));
        removed++;
      } catch {
        /* already gone */
      }
    }
  });
  return removed;
}
