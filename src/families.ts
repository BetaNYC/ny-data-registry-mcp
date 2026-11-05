import { readDataJson } from "./paths.js";

export const FAMILIES = [
  "socrata",
  "arcgis-hub",
  "arcgis-enterprise",
  "arcgis-server",
  "ckan",
  "geoblacklight",
  "custom-api",
  "none",
] as const;
export type Family = (typeof FAMILIES)[number];

interface Mapping {
  platform: string | null;
  family: Family | null;
  note: string | null;
}

export interface FamilyResult {
  family: Family | null;
  /** mapped: in the table with a family. unconfirmed: in the table, family deliberately null. unmapped: not in the table. */
  status: "mapped" | "unconfirmed" | "unmapped";
  note: string | null;
  platform_raw: string | null;
  api_type_raw: string | null;
}

let table: Map<string, Mapping> | null = null;
const key = (p: string | null) => (p === null ? "\u0000null" : p);

function load(): Map<string, Mapping> {
  if (table) return table;
  const doc = readDataJson<{ families: string[]; mappings: Mapping[] }>("platform-families.json");
  table = new Map();
  for (const m of doc.mappings) {
    if (m.family !== null && !(FAMILIES as readonly string[]).includes(m.family)) {
      throw new Error(`platform-families.json: '${m.platform}' maps to unknown family '${m.family}'`);
    }
    table.set(key(m.platform), m);
  }
  return table;
}

/** Exact-string lookup. Never guesses: a string not in the table comes back `unmapped`. */
export function familyFor(platform: string | null, api_type: string | null): FamilyResult {
  const m = load().get(key(platform));
  if (!m) {
    return { family: null, status: "unmapped", note: "platform string not in data/platform-families.json; add a row", platform_raw: platform, api_type_raw: api_type };
  }
  return { family: m.family, status: m.family === null ? "unconfirmed" : "mapped", note: m.note, platform_raw: platform, api_type_raw: api_type };
}

export function allMappings(): Mapping[] {
  return [...load().values()];
}
