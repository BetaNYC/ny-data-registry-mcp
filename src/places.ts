/**
 * Place resolution. The registry has a `region` but no county field, so the county a
 * row covers is derived here from the entity name. Every derived place says so.
 */
import { readDataJson } from "./paths.js";

interface PlacesDoc {
  counties: string[];
  cities: Record<string, string>;
  new_york_city: { boroughs: Record<string, string>; aliases: string[] };
  regions: string[];
  ny_bbox: [number, number, number, number];
}

let doc: PlacesDoc | null = null;
export function places(): PlacesDoc {
  return (doc ??= readDataJson<PlacesDoc>("ny-places.json"));
}

export type PlaceKind = "state" | "region" | "county" | "city" | "nyc" | "borough" | "other";

export interface RowPlace {
  /** What the row covers. */
  scope: "statewide" | "regional" | "county" | "city" | "nyc" | "bi-state" | "unknown";
  counties: string[];
  city: string | null;
  region: string;
}

export interface ResolvedPlace {
  input: string;
  kind: PlaceKind;
  name: string;
  counties: string[];
  city: string | null;
  region: string | null;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\bst\.?\s/g, "st ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const NYC_COUNTIES = ["Bronx", "Kings", "New York", "Queens", "Richmond"];

/** Entities that are NYC-wide without saying "NYC" in a parseable way. */
const NYC_ENTITY = /^(nyc\b|new york city\b|board of elections in the city of new york|office of the new york city comptroller|intro\.nyc|justfix|citizens' committee for children|nyu furman|nyc crash mapper|social science research council|new york public library|lehman college|baruch college|association for neighborhood and housing)/i;

export function placeForRow(row: { entity: string; entity_type: string; region: string }): RowPlace {
  const p = places();
  const e = row.entity;
  const region = row.region;
  if (region === "Statewide") return { scope: "statewide", counties: [], city: null, region };
  if (region.startsWith("Bi-state")) return { scope: "bi-state", counties: [...NYC_COUNTIES], city: null, region };
  const county = e.match(/^(.+?) County$/);
  if (county && p.counties.includes(county[1])) return { scope: "county", counties: [county[1]], city: null, region };
  const city = e.match(/^City of (.+)$/);
  if (city && p.cities[city[1]]) return { scope: "city", counties: [p.cities[city[1]]], city: city[1], region };
  if (e === "New York City" || NYC_ENTITY.test(e) || /New York City|\bNYC\b/.test(e)) {
    return { scope: "nyc", counties: [...NYC_COUNTIES], city: "New York City", region };
  }
  if (/Long Island/i.test(e)) return { scope: "regional", counties: ["Nassau", "Suffolk"], city: null, region };
  return { scope: "regional", counties: [], city: null, region };
}

/** Resolve free text ("Erie County", "Buffalo", "Brooklyn", "NYC", "Capital Region"). */
export function resolvePlace(input: string): ResolvedPlace | null {
  const p = places();
  const q = norm(input).replace(/^(the )/, "");
  if (!q) return null;
  if (["new york state", "nys", "statewide", "state", "new york state wide"].includes(q)) {
    return { input, kind: "state", name: "New York State", counties: [], city: null, region: "Statewide" };
  }
  if (p.new_york_city.aliases.includes(q) || q === "new york" || q === "new york ny") {
    return { input, kind: "nyc", name: "New York City", counties: [...NYC_COUNTIES], city: "New York City", region: "NYC Metro / Long Island" };
  }
  for (const [b, c] of Object.entries(p.new_york_city.boroughs)) {
    if (q === norm(b) || q === `${norm(b)} county` || q === `borough of ${norm(b)}`) {
      return { input, kind: "borough", name: b, counties: [c], city: "New York City", region: "NYC Metro / Long Island" };
    }
  }
  if (q === "kings county" || q === "richmond county" || q === "new york county" || q === "queens county" || q === "bronx county") {
    const c = p.counties.find((x) => `${norm(x)} county` === q)!;
    return { input, kind: "borough", name: `${c} County`, counties: [c], city: "New York City", region: "NYC Metro / Long Island" };
  }
  for (const r of p.regions) {
    if (q === norm(r) || norm(r).startsWith(q + " ") || (q.length > 6 && norm(r).includes(q))) {
      return { input, kind: "region", name: r, counties: [], city: null, region: r };
    }
  }
  const wantsCounty = /\bcounty\b/.test(q);
  const wantsCity = /^(city of )/.test(q) || /\bcity$/.test(q);
  const bare = q.replace(/\bcounty\b/, "").replace(/^city of /, "").replace(/ city$/, "").trim();
  const county = p.counties.find((c) => norm(c) === bare);
  const city = Object.keys(p.cities).find((c) => norm(c) === bare);
  if (county && (wantsCounty || !city || !wantsCity)) {
    if (!(city && wantsCity)) {
      return { input, kind: "county", name: `${county} County`, counties: [county], city: null, region: null };
    }
  }
  if (city) return { input, kind: "city", name: `City of ${city}`, counties: [p.cities[city]], city, region: null };
  return null;
}

/**
 * True only for a plausible WGS84 longitude/latitude box. ArcGIS returns [0,0,0,0] for
 * tables and some items, and projected (State Plane) numbers for others; both mean
 * "extent unknown", never "outside New York".
 */
export function isLonLatBox(b: [number, number, number, number] | null): b is [number, number, number, number] {
  if (!b || b.length !== 4 || b.some((x) => !Number.isFinite(x))) return false;
  if (b.every((x) => x === 0)) return false;
  if (Math.abs(b[0]) > 180 || Math.abs(b[2]) > 180 || Math.abs(b[1]) > 90 || Math.abs(b[3]) > 90) return false;
  return b[0] <= b[2] && b[1] <= b[3];
}

export function bboxIntersectsNY(b: [number, number, number, number] | null): boolean | null {
  if (!isLonLatBox(b)) return null;
  const [minx, miny, maxx, maxy] = places().ny_bbox;
  return !(b[2] < minx || b[0] > maxx || b[3] < miny || b[1] > maxy);
}

export function bboxCenterInNY(b: [number, number, number, number] | null): boolean | null {
  if (!isLonLatBox(b)) return null;
  const [minx, miny, maxx, maxy] = places().ny_bbox;
  const cx = (b[0] + b[2]) / 2;
  const cy = (b[1] + b[3]) / 2;
  return cx >= minx && cx <= maxx && cy >= miny && cy <= maxy;
}
