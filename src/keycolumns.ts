import { readDataJson } from "./paths.js";

interface KeyDoc {
  keys: Record<string, { scope: string; fields: string[] }>;
}

let lookup: Map<string, { label: string; scope: string }> | null = null;

export function normalizeField(f: string): string {
  return f
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Curated key label for a column, or null. Exact match on the normalized field name only. */
export function keyLabel(field: string | null | undefined, name?: string | null): { label: string; scope: string } | null {
  if (!lookup) {
    lookup = new Map();
    const doc = readDataJson<KeyDoc>("key-columns.json");
    for (const [label, k] of Object.entries(doc.keys)) for (const f of k.fields) lookup.set(f, { label, scope: k.scope });
  }
  // Socrata ':@computed_region_*' columns hold internal region ids, not the real codes,
  // so they never join on their display name ("Community Districts").
  if (field && field.startsWith(":@")) return null;
  for (const cand of [field, name]) {
    if (!cand) continue;
    const hit = lookup.get(normalizeField(cand));
    if (hit) return hit;
  }
  return null;
}

export function keyLabels(): string[] {
  return Object.keys(readDataJson<KeyDoc>("key-columns.json").keys);
}
