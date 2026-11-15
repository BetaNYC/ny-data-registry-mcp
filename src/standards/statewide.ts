/**
 * The statewide Croissant and DCAT-US files (issue #17, decision E4), built from one index and
 * published beside it (src/publish/prepare.ts). Metadata only.
 *
 * - DCAT_FILE: one DCAT-US 3.0 Catalog holding every live dataset.
 * - CROISSANT_FILE: one Croissant 1.1 document per line (Croissant describes one dataset per
 *   document and has no multi-dataset container, so this is JSON Lines).
 * Both are gzipped. Each names its index: the Catalog's `modified` and every Croissant line's
 * `sdDatePublished` are the index's harvest time.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { dcatCatalog, indexHarvestTime, loadRecords, toCroissant, toDcatUs } from "./build.js";
import type { LicenseKind, TermsPages } from "./license.js";

export const DCAT_FILE = "ny-data-dcat-us.json.gz";
export const CROISSANT_FILE = "ny-data-croissant.jsonl.gz";
export const STANDARD_FILES = [DCAT_FILE, CROISSANT_FILE];
export const RELEASE_BASE = "https://github.com/BetaNYC/ny-data-registry-mcp/releases/download/index-latest";

export interface StatewideStats {
  harvested_at: string | null;
  datasets: number;
  license_kinds: Record<LicenseKind, number>;
  terms_page_sources: { dataset: number; portal: number };
  files: { name: string; bytes: number; uncompressed_bytes: number }[];
}

/** Build both files for the index at `indexPath` into `dir`. */
export function writeStatewide(indexPath: string, dir: string, opts: { terms?: TermsPages } = {}): StatewideStats {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(indexPath, { readOnly: true });
  let records;
  let harvestedAt: string | null;
  try {
    records = loadRecords(db);
    harvestedAt = indexHarvestTime(db);
  } finally {
    db.close();
  }
  const kinds: Record<LicenseKind, number> = { license: 0, "terms-page": 0, statement: 0, none: 0 };
  const sources = { dataset: 0, portal: 0 };
  const dcat: string[] = [];
  const lines: string[] = [];
  for (const r of records) {
    const d = toDcatUs(r, { terms: opts.terms });
    kinds[d.license.kind]++;
    if (d.license.terms_page) sources[d.license.terms_page.source]++;
    dcat.push(JSON.stringify(d.document));
    lines.push(JSON.stringify(toCroissant(r, { harvestedAt, terms: opts.terms }).document) + "\n");
  }
  const head = JSON.stringify(dcatCatalog({ harvestedAt, datasets: records.length }));
  const catalog = `${head.slice(0, -1)},"dataset":[\n${dcat.join(",\n")}\n]}\n`;
  const files: StatewideStats["files"] = [];
  for (const [name, text] of [[DCAT_FILE, catalog], [CROISSANT_FILE, lines.join("")]] as const) {
    const raw = Buffer.from(text, "utf8");
    const gz = gzipSync(raw, { level: 9 });
    writeFileSync(join(dir, name), gz);
    files.push({ name, bytes: gz.length, uncompressed_bytes: raw.length });
  }
  return { harvested_at: harvestedAt, datasets: records.length, license_kinds: kinds, terms_page_sources: sources, files };
}
