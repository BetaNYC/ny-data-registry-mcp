import { BlockedError, OfflineError, politeFetch } from "./http.js";
import { CANDIDATES_DEFAULT, candidatePage, lookupSource, sourceSummary } from "./sources.js";
import { errorSummary } from "./betanyc-tools.js";
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

/** check_source's one request may take this long (ms) before it counts as no answer. */
export const CHECK_TIMEOUT_MS = 20_000;
/** Most characters of a redirect's Location header passed on in redirect_to. */
export const REDIRECT_MAX = 500;

/**
 * Exactly one request (no retry) to the row's portal URL (not its API), redirects reported not
 * followed, and the result compared with the registry's status. The URL a caller gives is only
 * matched to registry rows by host and path; it is never fetched itself. One row is checked
 * only when it clearly matches (urlMatch); otherwise the rows on that host come back as a list
 * and nothing is fetched. With several rows on the host and a clear match, `url_matches` says
 * how many there were.
 */
export async function checkSource(ref: { source_id?: string; registry_id?: string; url?: string }) {
  const found = lookupSource(ref);
  if (found.error) return { error: found.error };
  if (found.candidates) {
    return {
      ambiguous: true,
      message: ref.url
        ? "No registry row clearly matches this URL (its host is shared, and no row has this page or path), so nothing was fetched. Call again with a source_id."
        : "Several rows share this registry_id, so nothing was fetched. Call again with a source_id.",
      ...candidatePage(found.candidates, undefined, undefined, ref.url ? "use find_sources to narrow it" : "use how_to_query with this registry_id and offset"),
      runs_it_source: runsItSource(),
    };
  }
  const s = found.source!;
  const matched = found.matched ?? [];
  const urlMatches = matched.length > 1
    ? {
        total: matched.length,
        checked: s.source_id,
        others: matched.filter((x) => x !== s).slice(0, CANDIDATES_DEFAULT - 1).map((x) => x.source_id),
        note: `${matched.length} registry rows share this host; this row's page or path matches the URL, so only it was checked. Pass a source_id to check another.`,
      }
    : undefined;
  const base = { source: sourceSummary(s), ...(urlMatches ? { url_matches: urlMatches } : {}), runs_it_source: runsItSource(), registry_status: s.status };
  const refuse = refuseReason(s);
  if (refuse) return { ...base, checked: false, reason: refuse };
  const target = s.portal_url;
  if (!target) return { ...base, checked: false, reason: "the registry row has no usable portal URL to check" };
  try {
    // One user-initiated page view, like a browser visit: robots.txt (and its crawl-delay) governs crawlers, so it is not applied here.
    // No retry: one check is one request, and a 500 is the answer.
    const r = await politeFetch(target, { manualRedirect: true, timeoutMs: CHECK_TIMEOUT_MS, skipRobots: true, noRetry: true });
    const location = r.status >= 300 && r.status < 400 ? r.headers.location ?? null : null;
    const redirect = location === null ? null : [...location].length > REDIRECT_MAX ? `${[...location].slice(0, REDIRECT_MAX - 1).join("")}…` : location;
    const redirectCut = location !== null && redirect !== location;
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
      ...(redirectCut ? { redirect_note: `The Location header was ${[...location!].length} characters; redirect_to shows the first ${REDIRECT_MAX}.` } : {}),
      response_ms: r.elapsedMs,
      checked_at: new Date().toISOString(),
      matches_registry: agrees,
      verdict:
        agrees === false
          ? live
            ? `DRIFT: registry says live, portal answered HTTP ${r.status}`
            : `DRIFT: registry says ${s.status}, portal answered HTTP ${r.status}`
          : redirect
          ? `redirects to ${redirectCut ? "a long address (see redirect_to)" : redirect}; registry URL may need updating`
          : agrees === null
          ? `page answered HTTP ${r.status}; the registry says '${s.status}', so this is the entity's page, not a confirmed portal`
          : "consistent with the registry",
    };
  } catch (e) {
    if (e instanceof OfflineError) return { ...base, checked: false, reason: e.message };
    if (e instanceof BlockedError) return { ...base, checked: true, url: target, blocked: true, reason: e.reason, verdict: "blocked automated access; not worked around" };
    // One plain line (errorSummary): no stack, no cause chain, at most 300 characters.
    const msg = errorSummary(e);
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
