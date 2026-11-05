import { BlockedError, OfflineError, politeFetch } from "./http.js";
import { lookupSource, sourceSummary } from "./sources.js";
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
 * One request to the row's portal URL (not its API), redirects reported not followed,
 * and the result compared with the registry's status.
 */
export async function checkSource(ref: { source_id?: string; registry_id?: string; url?: string }) {
  const found = lookupSource(ref);
  if (found.error) return { error: found.error };
  if (found.candidates) return { ambiguous: true, candidates: found.candidates.map(sourceSummary) };
  const s = found.source!;
  const base = { source: sourceSummary(s), registry_status: s.status };
  const refuse = refuseReason(s);
  if (refuse) return { ...base, checked: false, reason: refuse };
  const target = s.url ? s.url.trim().split(/\s/)[0] : null;
  if (!target) return { ...base, checked: false, reason: "the registry row has no URL to check" };
  try {
    // One user-initiated page view, like a browser visit: robots.txt (and its crawl-delay) governs crawlers, so it is not applied here.
    const r = await politeFetch(target, { manualRedirect: true, timeoutMs: 20000, skipRobots: true });
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
    return {
      ...base,
      checked: true,
      url: target,
      error: msg,
      matches_registry: s.status === "dead" ? true : s.status === "live" ? false : null,
      verdict: s.status === "live" ? `DRIFT: registry says live, request failed (${msg})` : `request failed (${msg})`,
    };
  }
}
