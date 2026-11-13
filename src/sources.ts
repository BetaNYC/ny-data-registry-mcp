/**
 * Phase 1: answers from the registry alone (no harvest needed).
 */
import { readDataJson } from "./paths.js";
import { registry, type Source } from "./registry.js";
import { resolvePlace, NYC_COUNTIES, type ResolvedPlace } from "./places.js";

// ─── text helpers ────────────────────────────────────────────────────────────

const STOP = new Set(
  "a an and are any as at be by can data dataset datasets do does find for from get have how i in is it me my new of on or portal portals publish publishes source sources that the there this to what where which who with york ny nys anything something about".split(
    " "
  )
);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 1 && !STOP.has(t));
}

let syn: Record<string, string[]> | null = null;
export function expandTerms(tokens: string[]): { term: string; weight: number }[] {
  syn ??= readDataJson<{ terms: Record<string, string[]> }>("synonyms.json").terms;
  const out = new Map<string, number>();
  // Two-word keys ("tax lot") match only the adjacent pair, so "parking lot" never expands.
  const pairs = tokens.slice(1).map((t, i) => `${tokens[i]} ${t}`);
  for (const pair of pairs) {
    for (const s of syn[pair] ?? []) {
      const p = s.toLowerCase().trim();
      if (p && !out.has(p)) out.set(p, 0.5);
    }
  }
  for (const t of tokens) {
    out.set(t, 1);
    const stem = t.endsWith("s") && t.length > 3 ? t.slice(0, -1) : null;
    if (stem && !out.has(stem)) out.set(stem, 0.9);
    // Synonyms are kept as whole phrases ("tax parcel"), never split into loose words.
    for (const s of syn[t] ?? []) {
      const p = s.toLowerCase().trim();
      if (p && !out.has(p)) out.set(p, 0.5);
    }
  }
  return [...out].map(([term, weight]) => ({ term, weight }));
}

// ─── output shape ────────────────────────────────────────────────────────────

export function sourceSummary(s: Source) {
  return {
    source_id: s.source_id,
    entity: s.entity,
    portal_name: s.portal_name,
    url: s.url,
    status: s.status,
    platform_family: s.platform_family,
    platform_family_status: s.platform_family_status,
    platform: s.platform,
    api_type: s.api_type,
    has_api: hasApi(s),
    key_required: s.key_required,
    dataset_count: s.dataset_count,
    region: s.region,
    covers: s.place.scope === "statewide" ? "New York State" : s.place.city ?? (s.place.counties.length === 1 ? `${s.place.counties[0]} County` : s.region),
    last_verified: s.last_verified,
    registry_page: s.page_url,
  };
}

export function hasApi(s: Source): boolean {
  const fam = s.platform_family;
  return !!fam && fam !== "none" && !!s.api_endpoint && s.api_endpoint !== "—";
}

// ─── find_sources ────────────────────────────────────────────────────────────

export interface FindArgs {
  query: string;
  place?: string;
  tier?: number;
  platform_family?: string;
  has_api?: boolean;
  key_required?: string;
  status?: string;
  limit?: number;
}

function fieldScore(text: string | null | undefined, terms: { term: string; weight: number }[], w: number): number {
  if (!text) return 0;
  const toks = new Set(tokenize(text));
  const low = text.toLowerCase();
  let s = 0;
  for (const { term, weight } of terms) {
    if (term.includes(" ")) {
      if (low.includes(term)) s += w * weight;
    } else if (toks.has(term)) s += w * weight;
    else if (term.length >= 4 && low.includes(term)) s += 0.5 * w * weight;
  }
  return s;
}

export function placeMatches(s: Source, p: ResolvedPlace): "direct" | "contains" | "covers" | null {
  if (p.kind === "state") return s.place.scope === "statewide" ? "direct" : null;
  if (p.kind === "region") {
    if (s.region === p.region) return "direct";
    return s.place.scope === "statewide" ? "covers" : null;
  }
  if (s.place.scope === "statewide") return "covers";
  const overlap = s.place.counties.some((c) => p.counties.includes(c));
  if (p.kind === "nyc" || p.kind === "borough") {
    if (s.place.scope === "nyc") return "direct";
    if (s.place.scope === "bi-state") return "covers";
    return null;
  }
  if (p.kind === "county") {
    if (s.place.scope === "county" && overlap) return "direct";
    if (s.place.scope === "city" && overlap) return "contains";
    if (s.place.scope === "regional" && s.region && regionOfCounty(p.counties[0]) === s.region && s.place.counties.length === 0) return "covers";
    return null;
  }
  if (p.kind === "city") {
    if (s.place.scope === "city" && s.place.city === p.city) return "direct";
    if (s.place.scope === "county" && overlap) return "covers";
    return null;
  }
  return null;
}

/** A county's region, read from that county's own registry row. */
export function regionOfCounty(county: string): string | null {
  const row = registry().sources.find((s) => s.place.scope === "county" && s.place.counties[0] === county);
  if (row) return row.region;
  if (NYC_COUNTIES.includes(county)) return "NYC Metro / Long Island";
  return null;
}

export function findSources(args: FindArgs) {
  const reg = registry();
  const status = args.status ?? "live";
  const limit = Math.min(args.limit ?? 10, 50);
  let place: ResolvedPlace | null = null;
  if (args.place) {
    place = resolvePlace(args.place);
    if (!place) {
      return { query: args.query, place_error: `'${args.place}' is not a New York county, city, borough or region this server knows. Try list_sources_for_place.`, results: [] };
    }
  }
  const terms = expandTerms(tokenize(args.query));
  const scored = reg.sources
    .filter((s) => status === "any" || s.status === status)
    .filter((s) => args.tier === undefined || s.tier === args.tier)
    .filter((s) => !args.platform_family || s.platform_family === args.platform_family)
    .filter((s) => args.has_api === undefined || hasApi(s) === args.has_api)
    .filter((s) => !args.key_required || s.key_required === args.key_required)
    .map((s) => {
      const pm = place ? placeMatches(s, place) : null;
      let score =
        fieldScore(s.entity, terms, 3) +
        fieldScore(s.portal_name, terms, 2) +
        fieldScore(s.notes, terms, 1) +
        fieldScore(s.evidence, terms, 0.5) +
        fieldScore(`${s.platform ?? ""} ${s.platform_family ?? ""} ${s.api_type ?? ""}`, terms, 1) +
        fieldScore(s.region, terms, 1);
      if (place) score += pm === "direct" ? 6 : pm === "contains" ? 4 : pm === "covers" ? 2 : 0;
      if (s.status === "live") score += 0.25;
      if (s.tier === 1) score += 0.25;
      return { s, score, pm };
    })
    .filter((x) => (place ? x.pm !== null : true))
    .filter((x) => x.score > (place ? 0 : 0.6) || terms.length === 0)
    .sort((a, b) => b.score - a.score || a.s.tier - b.s.tier);
  return {
    query: args.query,
    place: place ? { resolved: place.name, kind: place.kind } : null,
    status_filter: status,
    registry_generated: reg.generated,
    total_matches: scored.length,
    results: scored.slice(0, limit).map((x) => ({ ...sourceSummary(x.s), match: x.pm ?? "keyword", score: Math.round(x.score * 100) / 100 })),
    note:
      scored.length === 0
        ? "No registry row matched. This searches portal names and notes, not dataset titles; try search_datasets (needs the harvested index) or list_sources_for_place."
        : "Ranked by keyword match on entity, portal name and notes. Dataset-level search is search_datasets.",
  };
}

// ─── list_sources_for_place ──────────────────────────────────────────────────

export function listSourcesForPlace(placeInput: string, includeStatewide = true) {
  const reg = registry();
  const place = resolvePlace(placeInput);
  if (!place) {
    return {
      place: placeInput,
      resolved: null,
      answer: "unknown-place",
      message: `'${placeInput}' is not a New York county, city (one of the 62), NYC borough, or registry region. Towns and villages are not in the registry; try their county.`,
    };
  }
  const own: Source[] = [];
  const within: Source[] = [];
  const covering: Source[] = [];
  const statewide: Source[] = [];
  for (const s of reg.sources) {
    const pm = placeMatches(s, place);
    if (pm === "direct") own.push(s);
    else if (pm === "contains") within.push(s);
    else if (pm === "covers" && s.place.scope === "statewide") statewide.push(s);
    else if (pm === "covers") covering.push(s);
  }
  const liveOwn = own.filter((s) => s.status === "live");
  let answer: string;
  let message: string;
  if (place.kind === "state" || place.kind === "region") {
    answer = own.length ? "listed" : "not-in-registry";
    message = `${own.length} registry rows for ${place.name}.`;
  } else if (own.length === 0) {
    answer = "not-in-registry";
    message = `${place.name} has no row in the registry. That means it has not been checked, NOT that no portal exists.`;
  } else if (liveOwn.length > 0) {
    answer = "portal-exists";
    message = `${place.name}: ${liveOwn.length} live source(s).`;
  } else if (own.every((s) => s.status === "no-portal")) {
    answer = "no-portal-exists";
    message = `${place.name} was checked (last ${own.map((s) => s.last_verified).sort().pop()}) and has no open data portal. See notes for what it does publish.`;
  } else if (own.some((s) => s.status === "dead")) {
    answer = "portal-dead";
    message = `${place.name}'s portal is dead. Do not use it.`;
  } else {
    answer = "unconfirmed";
    message = `${place.name} is in the registry but its status is UNCONFIRMED.`;
  }
  const detail = (s: Source) => ({ ...sourceSummary(s), notes: s.notes });
  return {
    place: placeInput,
    resolved: place,
    answer,
    message,
    own: own.map(detail),
    within: within.map(detail),
    regional: covering.map(sourceSummary),
    statewide: includeStatewide
      ? statewide.filter((s) => s.status === "live").map(sourceSummary)
      : `${statewide.filter((s) => s.status === "live").length} live statewide sources also cover this place (include_statewide=true to list them)`,
    registry_generated: reg.generated,
  };
}

// ─── how_to_query ────────────────────────────────────────────────────────────

interface Handoff {
  entity: string;
  host?: string;
  mcp: string;
  package: string | null;
  env: string[];
  note: string;
}

let handoffs: Handoff[] | null = null;

export function lookupSource(ref: { source_id?: string; registry_id?: string; entity?: string; url?: string }): { source?: Source; candidates?: Source[]; error?: string } {
  const reg = registry().sources;
  if (ref.source_id) {
    const s = reg.find((x) => x.source_id === ref.source_id);
    return s ? { source: s } : { error: `no source with source_id '${ref.source_id}'` };
  }
  if (ref.registry_id) {
    const m = reg.filter((x) => x.registry_id === ref.registry_id);
    if (m.length === 1) return { source: m[0] };
    if (m.length > 1) return { candidates: m };
    return { error: `no row with registry_id '${ref.registry_id}' (only 22 of 140 rows carry one; try entity)` };
  }
  if (ref.url) {
    const host = safeHost(ref.url);
    const m = reg.filter((x) => (x.url && safeHost(x.url) === host) || (x.api_endpoint && safeHost(x.api_endpoint) === host));
    if (m.length === 1) return { source: m[0] };
    if (m.length > 1) return { candidates: m };
    return { error: `no registry row with host ${host}` };
  }
  if (ref.entity) {
    const q = ref.entity.toLowerCase().trim();
    const exact = reg.filter((x) => x.entity.toLowerCase() === q || x.source_id === q);
    if (exact.length === 1) return { source: exact[0] };
    if (exact.length > 1) return { candidates: exact };
    const loose = reg.filter((x) => x.entity.toLowerCase().includes(q) || (x.portal_name ?? "").toLowerCase().includes(q));
    if (loose.length === 1) return { source: loose[0] };
    if (loose.length > 1) return { candidates: loose };
    return { error: `no registry row matches '${ref.entity}'` };
  }
  return { error: "give one of source_id, registry_id, entity or url" };
}

export function safeHost(u: string): string | null {
  try {
    return new URL(u.trim().split(/\s/)[0]).host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** The Socrata domain for a socrata-family row: the host of its SODA `/resource/` endpoint, else its portal host. */
export function socrataDomain(s: Source): string | null {
  const m = (s.api_endpoint ?? "").match(/https?:\/\/([^/\s]+)\/resource\//);
  if (m) return m[1];
  return s.url ? safeHost(s.url) : null;
}

export function isUnconfirmed(s: Source): string[] {
  const why: string[] = [];
  if (s.status === "UNCONFIRMED") why.push("row status is UNCONFIRMED");
  if (/UNCONFIRMED/i.test(s.api_type ?? "")) why.push(`api_type says '${s.api_type}'`);
  if (s.key_required === "UNCONFIRMED") why.push("whether a key is required is UNCONFIRMED");
  if (s.platform_family_status !== "mapped") why.push(`platform family is ${s.platform_family_status}`);
  return why;
}

export function howToQuery(ref: { source_id?: string; registry_id?: string; entity?: string }) {
  const found = lookupSource(ref);
  if (found.error) return { error: found.error };
  if (found.candidates) {
    return { ambiguous: true, message: "Several rows match; call again with a source_id.", candidates: found.candidates.map(sourceSummary) };
  }
  const s = found.source!;
  handoffs ??= readDataJson<{ servers: Handoff[] }>("handoffs.json").servers;
  const warnings: string[] = [];
  const unconfirmed = isUnconfirmed(s);
  if (unconfirmed.length) warnings.push(`UNCONFIRMED: ${unconfirmed.join("; ")}.`);
  if (s.status === "dead") warnings.push("DEAD: this portal is retired or unreachable. Do not query it.");
  if (s.status === "no-portal") warnings.push("NO PORTAL: this entity has no open data portal. The notes say what it does publish.");
  if (/undocumented/i.test(`${s.api_type ?? ""} ${s.notes ?? ""} ${s.platform_family_note ?? ""}`)) {
    warnings.push("UNDOCUMENTED: this endpoint was found by inspection, not from published docs. Described here only; this server never calls it.");
  }
  const gated = /account|data-access policy|by request|login-gated/i.test(`${s.api_type ?? ""} ${s.platform_family_note ?? ""}`);
  if (gated) warnings.push("GATED: access is by account or request under the publisher's policy. The endpoint is not given as queryable.");

  const endpoint = gated ? null : s.api_endpoint && s.api_endpoint !== "—" ? s.api_endpoint : null;
  let use: Record<string, unknown> | null = null;

  const ho = handoffs.find((h) => h.entity === s.entity && (!h.host || [s.url, s.api_endpoint].some((u) => u && u.includes(h.host!))));
  if (ho && s.status !== "dead") {
    use = { mcp: ho.mcp, package: ho.package, env: ho.env, note: ho.note };
  } else if (s.platform_family === "socrata" && s.status === "live") {
    const domain = socrataDomain(s);
    use = {
      mcp: "socrata",
      domain,
      how: `Use the socrata MCP's get_data tool with domain='${domain}': type='catalog' to search this portal, type='metadata' or 'query' with a dataset_id (4x4) to read one dataset.`,
      note: "Do not reimplement SoQL; the socrata MCP owns querying.",
    };
  } else if (s.status === "live" && (s.platform_family === "arcgis-hub" || s.platform_family === "arcgis-enterprise" || s.platform_family === "arcgis-server")) {
    use = {
      mcp: null,
      how: "No MCP queries ArcGIS services yet. Use this server's search_datasets / get_dataset_columns to find a layer and its fields; each result carries its FeatureServer URL.",
    };
  }
  return {
    source: sourceSummary(s),
    platform_family_note: s.platform_family_note,
    endpoint,
    api_type: s.api_type,
    key_required: s.key_required,
    key_env_var: ho?.env?.[0] ?? null,
    example_request: gated ? null : s.example_request,
    use,
    warnings,
    notes: s.notes,
    evidence: s.evidence,
    never_guessed: "Every endpoint above is copied verbatim from the registry row. If the row has none, none is given.",
  };
}

export function registryInfo(index: Record<string, unknown> | null) {
  const reg = registry();
  const count = (f: (s: Source) => string | number | null) => {
    const m: Record<string, number> = {};
    for (const s of reg.sources) {
      const k = String(f(s));
      m[k] = (m[k] ?? 0) + 1;
    }
    return m;
  };
  const generatedDays = Math.floor((Date.now() - Date.parse(reg.generated + "T12:00:00Z")) / 86400000);
  return {
    rows: reg.sources.length,
    generated: reg.generated,
    age_days: generatedDays,
    origin: reg.origin,
    fetched_at: reg.fetched_at,
    refresh_error: reg.refresh_error,
    by_status: count((s) => s.status),
    by_tier: count((s) => s.tier),
    by_platform_family: count((s) => s.platform_family ?? `(${s.platform_family_status})`),
    unmapped_platform_strings: reg.sources.filter((s) => s.platform_family_status === "unmapped").map((s) => s.platform),
    unconfirmed_platform_strings: [...new Set(reg.sources.filter((s) => s.platform_family_status === "unconfirmed").map((s) => s.platform))],
    source: "BetaNYC/grounding-ai-with-ny-open-data resources/ny-data-portal-registry.json",
    index,
  };
}
