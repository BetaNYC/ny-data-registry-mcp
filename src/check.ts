import { BlockedError, OfflineError, politeFetch } from "./http.js";
import { candidatePage, lookupSource, sourceSummary } from "./sources.js";
import { runsItSource } from "./govbodies.js";
import { readDataJson } from "./paths.js";
import type { Source } from "./registry.js";

/** Rows this server must never call, whatever the tool. */
export function refuseReason(s: Source): string | null {
  const skip = readDataJson<{ skip: { by_entity: Record<string, string> } }>("harvest-config.json").skip.by_entity;
  if (/^Association for Neighborhood and Housing Development/.test(s.entity)) return skip[s.entity] ?? "account-gated";
  if (s.key_required === "Y") return "key required (key_required = Y); this server never calls keyed sources";
  if (s.entity === "Rockland County") return skip[s.entity];
  return null;
}

/**
 * Exactly one request (no retry) to the row's portal URL (not its API), redirects reported not
 * followed, and the result compared with the registry's status. The URL a caller gives is only
 * matched to a registry row by host; it is never fetched itself. When several rows share that
 * host, only the best match is checked and `url_matches` says how many there were.
 */
export async function checkSource(ref: { source_id?: string; registry_id?: string; url?: string }) {
  const found = lookupSource(ref);
  if (found.error) return { error: found.error };
  let urlMatches: { total: number; checked: string; others: string[]; note: string } | undefined;
  if (found.candidates && ref.url) {
    const [best, ...others] = found.candidates; // best match first (byUrlMatch)
    urlMatches = {
      total: found.candidates.length,
      checked: best.source_id,
      others: others.slice(0, 24).map((x) => x.source_id),
      note: `${found.candidates.length} registry rows share this host; only the best match was checked. Pass a source_id to check another.`,
    };
    found.source = best;
  } else if (found.candidates) {
    return {
      ambiguous: true,
      ...candidatePage(found.candidates, undefined, undefined, "use how_to_query with this registry_id and offset"),
      runs_it_source: runsItSource(),
    };
  }
  const s = found.source!;
  const base = { source: sourceSummary(s), ...(urlMatches ? { url_matches: urlMatches } : {}), runs_it_source: runsItSource(), registry_status: s.status };
  const refuse = refuseReason(s);
  if (refuse) return { ...base, checked: false, reason: refuse };
  const target = s.url ? s.url.trim().split(/\s/)[0] : null;
  if (!target) return { ...base, checked: false, reason: "the registry row has no URL to check" };
  try {
    // One user-initiated page view, like a browser visit: robots.txt (and its crawl-delay) governs crawlers, so it is not applied here.
    // No retry: one check is one request, and a 500 is the answer.
    const r = await politeFetch(target, { manualRedirect: true, timeoutMs: 20000, skipRobots: true, noRetry: true });
    const redirect = r.status >= 300 && r.status < 400 ? r.headers.location ?? null : null;
    const reachable = r.status < 400;
    const live = s.status === "live";
    let agrees: boolean | null = null;
    if (s.status === "live") agrees = reachable;
    else if (s.status === "dead") agrees = !reachable;
    return {
      ...base,
      checked: true,
      url: target,
      http_status: r.status,
      redirect_to: redirect,
      response_ms: r.elapsedMs,
      checked_at: new Date().toISOString(),
      matches_registry: agrees,
      verdict:
        agrees === false
          ? live
            ? `DRIFT: registry says live, portal answered HTTP ${r.status}`
            : `DRIFT: registry says ${s.status}, portal answered HTTP ${r.status}`
          : redirect
          ? `redirects to ${redirect}; registry URL may need updating`
          : agrees === null
          ? `page answered HTTP ${r.status}; the registry says '${s.status}', so this is the entity's page, not a confirmed portal`
          : "consistent with the registry",
    };
  } catch (e) {
    if (e instanceof OfflineError) return { ...base, checked: false, reason: e.message };
    if (e instanceof BlockedError) return { ...base, checked: true, url: target, blocked: true, reason: e.reason, verdict: "blocked automated access; not worked around" };
    const msg = e instanceof Error ? e.message : String(e);
    // A full answer, not a failure of the tool: an unreachable portal is the finding. Named
    // request_error (not error) so the answer is not turned into a bare isError message.
    return {
      ...base,
      checked: true,
      url: target,
      request_error: msg,
      matches_registry: s.status === "dead" ? true : s.status === "live" ? false : null,
      verdict: s.status === "live" ? `DRIFT: registry says live, request failed (${msg})` : `request failed (${msg})`,
    };
  }
}
