/**
 * Polite HTTP for every network call this package makes.
 *
 * - One descriptive User-Agent, no email address.
 * - At least `minIntervalMs` (default 1000 ms) between requests to the same host, and at
 *   least 2000 ms to a Socrata host (`*.socrata.com`; the harvest calls only
 *   api.us.socrata.com). Workspace engineering standard § 6, "Polite Socrata querying".
 * - robots.txt is read once per host and honored for our agent and for `*`.
 * - Conditional requests (If-None-Match / If-Modified-Since) against an on-disk cache.
 * - Up to two retries on 429 or a 5xx (500, 502, 503, 504), honoring Retry-After
 *   (delay-seconds or an HTTP-date, RFC 9110 § 10.2.3), otherwise backing off 5 s then 10 s;
 *   every wait is capped at 60 s. A 429 also doubles that host's gap for the rest of the run
 *   (capped at 10 s). Socrata sends 429 and 503 when throttling
 *   (https://dev.socrata.com/docs/response-codes). No other retries.
 * - Timeout: 60 s per request unless the caller passes less. Only the nightly harvest uses the
 *   default: some portals take longer than 30 s to answer one page of a large catalog (the
 *   2026-11-17 run timed out on two state GIS portals at 60 s). The server's own live request,
 *   check_source, passes 20 s, and robots.txt 15 s.
 * - Error text never carries a value from `headers` (an app token, say), even when the
 *   server echoes it back in the body.
 * - A bot block (403/429 challenge, or an HTML page where JSON was expected) is
 *   reported as `blocked` and never worked around.
 * - NY_DATA_OFFLINE=1 makes every call fail fast, so tests can never reach the network.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cacheDir, USER_AGENT } from "./paths.js";

export class OfflineError extends Error {
  constructor(url: string) {
    super(`offline mode (NY_DATA_OFFLINE=1): refused to fetch ${url}`);
  }
}

export class BlockedError extends Error {
  constructor(public url: string, public reason: string) {
    super(`blocked: ${reason} (${url})`);
  }
}

export interface PoliteResponse {
  url: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  fromCache: boolean;
  notModified: boolean;
  headers: Record<string, string>;
  body: string;
  /** The raw bytes, only when `binary` was asked for (then `body` is empty). */
  bytes?: Buffer;
  elapsedMs: number;
}

export interface PoliteOptions {
  /** Use and update the conditional-request cache. */
  cache?: boolean;
  /** Expect JSON: an HTML body is treated as a block page. */
  expectJson?: boolean;
  timeoutMs?: number;
  /** Do not follow redirects; report them (used by check_source). */
  manualRedirect?: boolean;
  /** Skip the robots.txt check (only for robots.txt itself). */
  skipRobots?: boolean;
  /** Extra request headers (e.g. a Socrata X-App-Token). */
  headers?: Record<string, string>;
  /** Read the body as bytes (an archive), not text. Never cached. */
  binary?: boolean;
}

const lastRequestAt = new Map<string, number>();
const hostLocks = new Map<string, Promise<void>>();
const robotsCache = new Map<string, RobotsRules>();
const hostDelayMs = new Map<string, number>();
const widenedGapMs = new Map<string, number>();
const adapterFloorMs = new Map<string, number>();
export const requestLog: { url: string; status: number; at: string }[] = [];

export function minIntervalMs(): number {
  const v = Number(process.env.NY_DATA_MIN_INTERVAL_MS);
  return Number.isFinite(v) && v >= 1000 ? v : 1000;
}

/** Floor for Socrata hosts (engineering standard § 6: at least 2 s between requests). */
export const SOCRATA_MIN_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 60_000;
const MAX_WIDENED_GAP_MS = 10_000;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;

export function isSocrataHost(host: string): boolean {
  return /(^|\.)socrata\.com$/i.test(host);
}

/** The minimum gap this client keeps between two requests to `host`, before any Crawl-delay. */
export function hostFloorMs(host: string): number {
  return Math.max(minIntervalMs(), isSocrataHost(host) ? SOCRATA_MIN_INTERVAL_MS : 0, widenedGapMs.get(host) ?? 0, adapterFloorMs.get(host) ?? 0);
}

/**
 * Widen the gap for one host for the rest of the run (an adapter's own politeness setting, such
 * as the ArcGIS Server adapter's). It can only widen: values under the package floor are ignored.
 */
export function setHostFloorMs(host: string, ms: number): void {
  if (Number.isFinite(ms) && ms > (adapterFloorMs.get(host) ?? 0)) adapterFloorMs.set(host, Math.min(ms, MAX_WAIT_MS));
}

/**
 * How long to wait before retry number `attempt` (1-based) after a 429 or 503.
 * Retry-After may be delay-seconds or an HTTP-date (RFC 9110 § 10.2.3). Capped at 60 s.
 */
export function retryWaitMs(retryAfter: string | null, attempt: number, now = Date.now()): number {
  const backoff = Math.min(5000 * 2 ** (attempt - 1), MAX_WAIT_MS);
  if (!retryAfter) return backoff;
  const v = retryAfter.trim();
  if (/^\d+$/.test(v)) return Math.min(Number(v) * 1000, MAX_WAIT_MS);
  const at = Date.parse(v);
  if (Number.isFinite(at)) return Math.min(Math.max(at - now, 0), MAX_WAIT_MS);
  return backoff;
}

function isOffline(): boolean {
  return process.env.NY_DATA_OFFLINE === "1";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serialize requests per host and keep the minimum gap between them. */
async function withHostSlot<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const prev = hostLocks.get(host) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  hostLocks.set(host, prev.then(() => mine));
  await prev;
  try {
    const wait = (lastRequestAt.get(host) ?? 0) + Math.max(hostFloorMs(host), hostDelayMs.get(host) ?? 0) - Date.now();
    if (wait > 0) await sleep(wait);
    return await fn();
  } finally {
    lastRequestAt.set(host, Date.now());
    release();
  }
}

function cachePaths(url: string) {
  const dir = join(cacheDir(), "http");
  const key = createHash("sha256").update(url).digest("hex").slice(0, 32);
  return { dir, meta: join(dir, `${key}.meta.json`), body: join(dir, `${key}.body`) };
}

export interface RobotsRules {
  disallow: string[];
  /** Seconds, from a Crawl-delay line in our group (or `*`), if any. */
  crawlDelay: number | null;
}

/** Parse the rules that apply to us (our agent token, else `*`). */
export function parseRobots(text: string, agentToken = "ny-data-registry-mcp"): RobotsRules {
  const groups: { agents: string[]; disallow: string[]; delay: number | null }[] = [];
  let cur: { agents: string[]; disallow: string[]; delay: number | null } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], disallow: [], delay: null };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if (field === "disallow" && value) cur.disallow.push(value);
      if (field === "crawl-delay" && Number.isFinite(Number(value))) cur.delay = Number(value);
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && agentToken.toLowerCase().includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  const delays = chosen.map((g) => g.delay).filter((d): d is number => d !== null);
  return { disallow: chosen.flatMap((g) => g.disallow), crawlDelay: delays.length ? Math.max(...delays) : null };
}

export function robotsAllows(disallow: string[], pathAndQuery: string): boolean {
  return !disallow.some((rule) => {
    const anchored = rule.endsWith("$");
    const body = anchored ? rule.slice(0, -1) : rule;
    const re = new RegExp(
      "^" + body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : "")
    );
    return re.test(pathAndQuery);
  });
}

async function robotsFor(origin: string): Promise<RobotsRules> {
  if (robotsCache.has(origin)) return robotsCache.get(origin)!;
  let rules: RobotsRules = { disallow: [], crawlDelay: null };
  try {
    const r = await politeFetch(`${origin}/robots.txt`, { skipRobots: true, timeoutMs: 15000 });
    if (r.status === 200 && !/<html/i.test(r.body.slice(0, 200))) rules = parseRobots(r.body);
  } catch (e) {
    if (e instanceof OfflineError) throw e;
  }
  robotsCache.set(origin, rules);
  if (rules.crawlDelay) hostDelayMs.set(new URL(origin).host, Math.min(rules.crawlDelay, 120) * 1000);
  return rules;
}

/** Crawl-delay currently honored for a host, in ms (for stats). */
export function crawlDelays(): Record<string, number> {
  return Object.fromEntries(hostDelayMs);
}

export async function politeFetch(url: string, opts: PoliteOptions = {}): Promise<PoliteResponse> {
  if (isOffline()) throw new OfflineError(url);
  const u = new URL(url);
  if (!opts.skipRobots) {
    const rules = await robotsFor(u.origin);
    if (!robotsAllows(rules.disallow, u.pathname + u.search)) {
      throw new BlockedError(url, "disallowed by robots.txt");
    }
  }
  const cp = cachePaths(url);
  let cachedMeta: { etag?: string; lastModified?: string } | null = null;
  if (opts.cache && existsSync(cp.meta) && existsSync(cp.body)) {
    try {
      cachedMeta = JSON.parse(readFileSync(cp.meta, "utf8"));
    } catch {
      cachedMeta = null;
    }
  }
  const headers: Record<string, string> = { ...(opts.headers ?? {}), "User-Agent": USER_AGENT, Accept: opts.expectJson ? "application/json" : "*/*" };
  if (cachedMeta?.etag) headers["If-None-Match"] = cachedMeta.etag;
  if (cachedMeta?.lastModified) headers["If-Modified-Since"] = cachedMeta.lastModified;

  const doFetch = () =>
    withHostSlot(u.host, async () => {
      const started = Date.now();
      let res: Response;
      try {
        res = await fetch(url, {
          headers,
          redirect: opts.manualRedirect ? "manual" : "follow",
          signal: AbortSignal.timeout(opts.timeoutMs ?? 60000),
        });
      } catch (e) {
        const c = (e as { cause?: { code?: string; message?: string } }).cause;
        throw new Error(`network error for ${url}: ${c?.code ?? ""} ${c?.message ?? (e as Error).message}`.trim());
      }
      let bytes: Buffer | undefined;
      let body = "";
      if (res.status !== 304) {
        if (opts.binary && res.ok) bytes = Buffer.from(await res.arrayBuffer());
        else body = await res.text();
      }
      requestLog.push({ url, status: res.status, at: new Date().toISOString() });
      return { res, body, bytes, elapsed: Date.now() - started };
    });

  let { res, body, bytes, elapsed } = await doFetch();
  for (let attempt = 1; RETRY_STATUSES.has(res.status) && attempt <= MAX_RETRIES; attempt++) {
    if (res.status === 429) widenedGapMs.set(u.host, Math.min(hostFloorMs(u.host) * 2, MAX_WIDENED_GAP_MS));
    await sleep(retryWaitMs(res.headers.get("retry-after"), attempt));
    ({ res, body, bytes, elapsed } = await doFetch());
  }
  if (res.status === 429) throw new BlockedError(url, `HTTP 429 after ${MAX_RETRIES} retries (rate limited); stopped`);
  const hdrs: Record<string, string> = {};
  res.headers.forEach((v, k) => (hdrs[k] = v));

  if (res.status === 304 && opts.cache) {
    return {
      url, finalUrl: url, status: 304, ok: true, fromCache: true, notModified: true, headers: hdrs,
      body: readFileSync(cp.body, "utf8"), elapsedMs: elapsed,
    };
  }
  if (opts.expectJson && res.status === 200 && /^\s*</.test(body.slice(0, 50))) {
    throw new BlockedError(url, "HTML page returned where JSON was expected (possible bot challenge)");
  }
  if (res.status === 403 && /captcha|challenge|access denied|cloudflare|incapsula|akamai/i.test(body.slice(0, 4000))) {
    throw new BlockedError(url, "HTTP 403 bot challenge");
  }
  if (opts.cache && !opts.binary && res.status === 200 && (hdrs.etag || hdrs["last-modified"])) {
    mkdirSync(cp.dir, { recursive: true });
    writeFileSync(cp.body, body);
    writeFileSync(cp.meta, JSON.stringify({ url, etag: hdrs.etag, lastModified: hdrs["last-modified"] }));
  }
  return {
    url, finalUrl: res.url || url, status: res.status, ok: res.ok, fromCache: false, notModified: false,
    headers: hdrs, body, bytes, elapsedMs: elapsed,
  };
}

/**
 * `text` with every value of `headers` (and, for "Bearer xyz", the token alone) replaced by
 * "[redacted]". For error text that repeats part of a response body: some servers echo the
 * request's headers, and harvest errors end up in public GitHub issues.
 */
export function redactHeaders(text: string, headers: Record<string, string> | undefined): string {
  const values = Object.values(headers ?? {}).flatMap((v) => [v, v.split(/\s+/).pop() ?? ""]).filter((v) => v.length >= 4);
  for (const v of values.sort((a, b) => b.length - a.length)) text = text.split(v).join("[redacted]");
  return text;
}

export async function politeJson<T = any>(url: string, opts: PoliteOptions = {}): Promise<{ data: T; resp: PoliteResponse }> {
  const resp = await politeFetch(url, { ...opts, expectJson: true });
  if (resp.status !== 200 && resp.status !== 304) {
    throw new Error(redactHeaders(`HTTP ${resp.status} from ${url}: ${resp.body.slice(0, 300)}`, opts.headers));
  }
  try {
    return { data: JSON.parse(resp.body) as T, resp };
  } catch {
    throw new Error(redactHeaders(`invalid JSON from ${url}: ${resp.body.slice(0, 200)}`, opts.headers));
  }
}

/**
 * fetch() for the few requests that skip politeFetch: BetaNYC's own files on GitHub (the
 * registry and government-bodies refreshes, the index manifest and the index download), which
 * need no robots.txt or per-host gap. Retries 429 and 5xx up to MAX_RETRIES, honoring
 * Retry-After, but only when the wait ends before `deadline` (ms since the epoch); otherwise it
 * returns the last response as is. Pass the request's own timeout signal in `init`.
 */
export async function fetchWithRetry(url: string, init: RequestInit, deadline: number): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, init);
    if (!RETRY_STATUSES.has(res.status) || attempt > MAX_RETRIES) return res;
    const wait = retryWaitMs(res.headers.get("retry-after"), attempt);
    if (Date.now() + wait >= deadline) return res;
    await res.body?.cancel().catch(() => undefined);
    await sleep(wait);
  }
}

/** Test hook. */
export function resetHttpState(): void {
  lastRequestAt.clear();
  hostLocks.clear();
  robotsCache.clear();
  hostDelayMs.clear();
  widenedGapMs.clear();
  adapterFloorMs.clear();
  requestLog.length = 0;
}
