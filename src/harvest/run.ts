import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { readDataJson, indexPath } from "../paths.js";
import { BlockedError, crawlDelays, requestLog } from "../http.js";
import { openDb, upsertPortal, setPortalHarvest, writePortalDatasets, purgePortal, type HarvestedDataset, type PortalRecord } from "../db.js";
import { registry, type Source } from "../registry.js";
import { socrataDomain } from "../sources.js";
import { refuseReason } from "../check.js";
import { harvestSocrata } from "./socrata.js";
import {
  dcatByItem, fetchServiceColumns, filterItems, itemsFromDcat, listHubItems, mapArcgisItem, mergeDcat, mostCommonOrg,
  portalSelf, searchPortal, type ArcgisItem, type FilterResult,
} from "./arcgis.js";

interface HarvestConfig {
  defaults: {
    max_layer_requests_per_portal: number;
    socrata_only: string[];
    enterprise_item_types: string[];
    esri_org_ids: string[];
    esri_owner_pattern: string;
  };
  skip: { by_entity: Record<string, string> };
  cadence?: CadenceConfig;
}

/**
 * How often each portal is read. Nightly by default; self-hosted county ArcGIS servers
 * (the `enterprise` adapter) weekly, to be gentle on small county servers (epic #7, D5).
 */
export interface CadenceConfig {
  /** Days between reads, by plan kind (`socrata`, `hub`, `agol-org`, `enterprise`). Missing = 1. */
  days_by_adapter: Record<string, number>;
  /** Per-portal overrides, by source id. */
  days_by_source?: Record<string, number>;
  /** A portal is due this many hours early, so a scheduled run that starts late does not slip a whole cycle. */
  slack_hours?: number;
}

/** Days between reads for one portal. */
export function cadenceDays(sourceId: string, planKind: string, cfg?: CadenceConfig): number {
  const v = cfg?.days_by_source?.[sourceId] ?? cfg?.days_by_adapter?.[planKind] ?? 1;
  return Number.isFinite(v) && v >= 1 ? v : 1;
}

/**
 * Whether a portal is due tonight. `lastHarvested` is when it was last read (any outcome),
 * from the previous index. A portal never read, or with cadence 1, is always due.
 */
export function cadenceDue(
  lastHarvested: string | null,
  days: number,
  now: Date,
  slackHours = 6
): { due: boolean; next_due?: string } {
  if (days <= 1 || !lastHarvested) return { due: true };
  const last = Date.parse(lastHarvested);
  if (!Number.isFinite(last)) return { due: true };
  const nextDue = last + days * 86_400_000 - slackHours * 3_600_000;
  return now.getTime() >= nextDue ? { due: true } : { due: false, next_due: new Date(nextDue).toISOString() };
}

export type Plan =
  | { kind: "socrata"; domain: string }
  | { kind: "hub"; site: string; agolOrg: string | null }
  | { kind: "enterprise"; portalBase: string }
  | { kind: "agol-org"; orgId: string }
  | { kind: "skip"; reason: string };

const AGOL_SERVICES = /https:\/\/services\d*\.arcgis\.com\/([A-Za-z0-9]{10,})\/arcgis\/rest\/services/;

export function agolOrgOf(s: Source): string | null {
  const m = `${s.api_endpoint ?? ""} ${s.url ?? ""}`.match(AGOL_SERVICES);
  return m ? m[1] : null;
}

export function enterprisePortalBase(s: Source): string | null {
  for (const u of [s.api_endpoint ?? "", s.url ?? ""]) {
    const m = u.match(/(https?:\/\/[^/\s]+\/portal)\b/i);
    if (m) return m[1];
  }
  return null;
}

export function planFor(s: Source, cfg: HarvestConfig): Plan {
  if (s.status !== "live") return { kind: "skip", reason: `registry status '${s.status}'` };
  const refuse = refuseReason(s);
  if (refuse) return { kind: "skip", reason: refuse };
  if (cfg.skip.by_entity[s.entity]) return { kind: "skip", reason: cfg.skip.by_entity[s.entity] };
  switch (s.platform_family) {
    case "socrata": {
      const d = socrataDomain(s);
      return d ? { kind: "socrata", domain: d } : { kind: "skip", reason: "no Socrata domain in the registry row" };
    }
    case "arcgis-hub":
      return s.url ? { kind: "hub", site: s.url.trim().split(/\s/)[0].replace(/\/+$/, ""), agolOrg: agolOrgOf(s) } : { kind: "skip", reason: "no site URL" };
    case "arcgis-enterprise": {
      const b = enterprisePortalBase(s);
      return b ? { kind: "enterprise", portalBase: b } : { kind: "skip", reason: "ArcGIS Enterprise without a portal (server REST directory only): no catalog adapter in this build" };
    }
    case "arcgis-server": {
      const org = agolOrgOf(s);
      return org ? { kind: "agol-org", orgId: org } : { kind: "skip", reason: "standalone ArcGIS Server REST directory: no catalog adapter in this build" };
    }
    case "geoblacklight":
      return { kind: "skip", reason: "GeoBlacklight: no adapter in this build" };
    case "ckan":
      return { kind: "skip", reason: "CKAN (catalog.data.gov): a re-harvest of portals indexed directly; no adapter in this build" };
    case "custom-api":
      return { kind: "skip", reason: "custom API: described by the registry, not harvested" };
    case "none":
      return { kind: "skip", reason: "no API (web pages, viewers or downloads only)" };
    default:
      return { kind: "skip", reason: `platform family ${s.platform_family_status}` };
  }
}

export function portalRecord(s: Source): PortalRecord {
  const adminLevel =
    s.place.scope === "statewide" ? "state" : s.place.scope === "county" ? "county" : s.place.scope === "city" || s.place.scope === "nyc" ? "city" : s.entity_type;
  return {
    id: s.source_id,
    name: s.portal_name ?? s.entity,
    base_url: s.url,
    admin_level: adminLevel,
    entity: s.entity,
    region: s.region,
    place_scope: s.place.scope,
    place_counties: s.place.counties,
    place_city: s.place.city,
    platform_family: s.platform_family,
    platform_raw: s.platform,
    api_type_raw: s.api_type,
    api_endpoint: s.api_endpoint,
    registry_dataset_count: s.dataset_count,
    registry_status: s.status,
    registry_last_verified: s.last_verified,
  };
}

export interface PortalStats {
  source_id: string;
  entity: string;
  adapter: string;
  outcome: "ok" | "partial" | "failed" | "refused" | "blocked" | "skipped" | "not-due";
  reason?: string;
  listed?: number | null;
  kept?: number;
  excluded?: FilterResult["excluded"];
  other_orgs?: Record<string, number>;
  own_org?: string | null;
  out_of_state_check?: FilterResult["portal_in_ny"];
  datasets?: number;
  added?: number;
  changed?: number;
  removed?: number;
  columns?: number;
  columns_fetched_for?: number;
  columns_not_fetched?: number;
  requests?: number;
  registry_dataset_count?: number | null;
  seconds?: number;
  error?: string | null;
}

interface RunOpts {
  only?: string[];
  maxLayers?: number;
  concurrency?: number;
  /** Read every portal tonight, whatever its cadence. */
  ignoreCadence?: boolean;
  log?: (s: string) => void;
}

function currentColumns(db: DatabaseSync, id: string, updated: string | null): boolean {
  const r = db.prepare("SELECT updated_at, columns_status FROM datasets WHERE id = ?").get(id) as { updated_at: string | null; columns_status: string } | undefined;
  return !!r && r.columns_status === "fetched" && r.updated_at === updated;
}

async function harvestArcgisItems(
  db: DatabaseSync,
  portal: PortalRecord,
  items: ArcgisItem[],
  filter: FilterResult,
  permalink: (it: ArcgisItem) => string | null,
  maxLayers: number,
  dcat: Map<string, any[]> | null
): Promise<{ datasets: HarvestedDataset[]; requests: number; fetched: number; notFetched: number }> {
  const budget = { left: maxLayers };
  let requests = 0;
  let fetched = 0;
  let notFetched = 0;
  const sorted = [...filter.kept].sort((a, b) => (b.numViews ?? 0) - (a.numViews ?? 0));
  const out: HarvestedDataset[] = [];
  for (const it of sorted) {
    const ds = mapArcgisItem(it, { permalink: permalink(it) });
    if (dcat) mergeDcat(ds, dcat.get(it.id.toLowerCase()));
    if (ds.columns_status === "not-fetched" && ds.api_endpoint) {
      if (currentColumns(db, `${portal.id}:${ds.native_id}`, ds.updated_at)) {
        ds.columns = null; // unchanged since last fetch: keep stored columns
      } else if (budget.left > 0) {
        const cf = await fetchServiceColumns(ds.api_endpoint, budget);
        requests += cf.requests;
        if (cf.columns.length) {
          ds.columns = cf.columns;
          ds.columns_status = "fetched";
          ds.geometry_type = cf.geometry_type;
          ds.provenance.columns = "portal";
          ds.provenance.geometry_type = "portal";
          fetched++;
        } else if (cf.error && cf.error !== "budget") {
          ds.columns_status = "error";
          notFetched++;
        } else notFetched++;
      } else notFetched++;
    }
    out.push(ds);
  }
  void items;
  return { datasets: out, requests, fetched, notFetched };
}

export async function runHarvest(opts: RunOpts = {}) {
  const log = opts.log ?? ((s: string) => process.stderr.write(s + "\n"));
  const cfg = readDataJson<HarvestConfig>("harvest-config.json");
  const maxLayers = opts.maxLayers ?? Number(process.env.NY_DATA_MAX_LAYERS ?? cfg.defaults.max_layer_requests_per_portal);
  const esriOwner = new RegExp(cfg.defaults.esri_owner_pattern, "i");
  const reg = registry();
  const db = openDb();
  const started = new Date();
  const runId = Number(db.prepare("INSERT INTO harvest_runs(started_at) VALUES (?)").run(started.toISOString()).lastInsertRowid);
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('registry_generated', ?)").run(reg.generated);

  const sources = reg.sources.filter((s) => !opts.only || opts.only.includes(s.source_id));
  const stats: PortalStats[] = [];
  const work: { s: Source; plan: Plan }[] = [];
  for (const s of sources) {
    const plan = planFor(s, cfg);
    upsertPortal(db, portalRecord(s));
    if (plan.kind === "skip") {
      if (s.status === "live") stats.push({ source_id: s.source_id, entity: s.entity, adapter: "none", outcome: "skipped", reason: plan.reason });
      continue;
    }
    const days = cadenceDays(s.source_id, plan.kind, cfg.cadence);
    if (!opts.ignoreCadence && days > 1) {
      const last = (db.prepare("SELECT last_harvested FROM portals WHERE id = ?").get(s.source_id) as { last_harvested: string | null } | undefined)?.last_harvested ?? null;
      const c = cadenceDue(last, days, started, cfg.cadence?.slack_hours);
      if (!c.due) {
        stats.push({
          source_id: s.source_id, entity: s.entity, adapter: plan.kind, outcome: "not-due",
          reason: `read every ${days} days; last read ${last}; next due after ${c.next_due}`,
        });
        continue;
      }
    }
    work.push({ s, plan });
  }

  async function one(s: Source, plan: Exclude<Plan, { kind: "skip" }>): Promise<PortalStats> {
    const t0 = Date.now();
    const portal = portalRecord(s);
    const st: PortalStats = { source_id: s.source_id, entity: s.entity, adapter: plan.kind, outcome: "ok", registry_dataset_count: s.dataset_count };
    log(`→ ${s.source_id} (${plan.kind})`);
    try {
      let datasets: HarvestedDataset[] = [];
      let complete = false;
      let orgForPortal: string | null = null;
      if (plan.kind === "socrata") {
        const h = await harvestSocrata(plan.domain, cfg.defaults.socrata_only);
        datasets = h.datasets;
        complete = h.complete;
        Object.assign(st, { listed: h.resultSetSize, requests: h.requests, error: h.error, columns_fetched_for: datasets.filter((d) => d.columns_status === "from-search").length });
      } else {
        let items: ArcgisItem[] = [];
        let listingComplete = false;
        let requests = 0;
        let ownOrg: string | null = null;
        let serviceHostOrg: string | null = null;
        let dcat: Map<string, any[]> | null = null;
        let permalink: (it: ArcgisItem) => string | null = () => null;
        let dataTypesOnly = false;
        let serviceHost: string | null = null;
        if (plan.kind === "hub") {
          let l = await listHubItems(plan.site);
          requests += l.requests;
          if (l.items.length === 0 && /Collection with id .*dataset.* not found/.test(l.error ?? "")) {
            l = await listHubItems(plan.site, 40, "all");
            requests += l.requests;
            dataTypesOnly = true;
            st.adapter = "hub(all)";
          }
          items = l.items;
          listingComplete = l.complete;
          st.listed = l.total;
          st.error = l.error;
          if (items.length === 0 && /not found/i.test(l.error ?? "")) {
            const d = await dcatByItem(plan.site);
            requests += d.requests;
            items = itemsFromDcat([...d.byItem.values()].flat());
            listingComplete = !d.error;
            st.listed = items.length;
            st.error = d.error ? `no OGC collection; dcat: ${d.error}` : null;
            st.adapter = "hub(dcat-only)";
            dcat = d.byItem.size ? d.byItem : null;
          }
          if (items.length === 0 && plan.agolOrg) {
            const a = await searchPortal("https://www.arcgis.com/sharing/rest", `orgid:${plan.agolOrg} AND (${typeClause(cfg)})`);
            requests += a.requests;
            items = a.items;
            listingComplete = a.complete;
            st.listed = a.total;
            st.adapter = "hub→agol-org";
            ownOrg = plan.agolOrg;
            serviceHostOrg = plan.agolOrg;
            permalink = (it) => `https://www.arcgis.com/home/item.html?id=${it.id}`;
          } else {
            // A Hub site's catalog is curated by its owner and may deliberately include other
            // orgs' layers (the State GIS Clearinghouse aggregates many agencies). So no
            // own-org filter here; Esri-owned content and out-of-state items are still dropped.
            ownOrg = null;
            st.own_org = mostCommonOrg(items);
            if (!dcat) {
              const d = await dcatByItem(plan.site);
              requests += d.requests;
              dcat = d.byItem.size ? d.byItem : null;
              if (d.error) st.error = [st.error, `dcat: ${d.error}`].filter(Boolean).join("; ");
            }
            permalink = (it) => `https://www.arcgis.com/home/item.html?id=${it.id}`;
          }
        } else if (plan.kind === "enterprise") {
          const self = await portalSelf(plan.portalBase);
          requests++;
          ownOrg = self.id;
          // Some portals (Wayne) do not expose their org id anonymously. Then filter by
          // service host instead: keep items whose service lives on the county's own server.
          if (!ownOrg) {
            serviceHost = new URL(plan.portalBase).host;
            st.adapter = "enterprise(host-filter)";
          }
          const l = await searchPortal(`${plan.portalBase}/sharing/rest`, ownOrg ? `orgid:${ownOrg} AND (${typeClause(cfg)})` : `(${typeClause(cfg)})`);
          requests += l.requests;
          items = l.items;
          listingComplete = l.complete;
          st.listed = l.total;
          if (l.error) st.error = l.error;
          permalink = (it) => `${plan.portalBase}/home/item.html?id=${it.id}`;
        } else if (plan.kind === "agol-org") {
          const l = await searchPortal("https://www.arcgis.com/sharing/rest", `orgid:${plan.orgId} AND (${typeClause(cfg)})`);
          requests += l.requests;
          items = l.items;
          listingComplete = l.complete;
          st.listed = l.total;
          if (l.error) st.error = l.error;
          ownOrg = plan.orgId;
          serviceHostOrg = plan.orgId;
          permalink = (it) => `https://www.arcgis.com/home/item.html?id=${it.id}`;
        }
        orgForPortal = ownOrg;
        const f = filterItems(items, { ownOrg, esriOrgIds: cfg.defaults.esri_org_ids, esriOwner, serviceHostOrg, serviceHost, dataTypesOnly });
        Object.assign(st, { kept: f.kept.length, excluded: f.excluded, other_orgs: f.other_orgs, own_org: ownOrg ?? st.own_org ?? null, out_of_state_check: f.portal_in_ny });
        if (f.portal_in_ny.refuse) {
          purgePortal(db, s.source_id);
          setPortalHarvest(db, s.source_id, { adapter: st.adapter, status: "refused", note: "out-of-state guard: most item extents are outside New York" });
          return { ...st, outcome: "refused", reason: "out-of-state guard", requests, seconds: Math.round((Date.now() - t0) / 1000) };
        }
        const h = await harvestArcgisItems(db, portal, items, f, permalink, maxLayers, dcat);
        datasets = h.datasets;
        complete = listingComplete;
        Object.assign(st, { requests: requests + h.requests, columns_fetched_for: h.fetched, columns_not_fetched: h.notFetched });
      }
      const w = writePortalDatasets(db, portal, datasets, runId, complete);
      st.outcome = complete ? "ok" : "partial";
      Object.assign(st, { datasets: datasets.length, added: w.added, changed: w.changed, removed: w.removed, columns: w.columns });
      setPortalHarvest(db, s.source_id, {
        adapter: st.adapter, status: st.outcome, note: st.error ?? null,
        socrata_domain: plan.kind === "socrata" ? plan.domain : null, arcgis_org_id: orgForPortal,
      });
    } catch (e) {
      const blocked = e instanceof BlockedError;
      st.outcome = blocked ? "blocked" : "failed";
      st.error = e instanceof Error ? e.message : String(e);
      setPortalHarvest(db, s.source_id, { adapter: st.adapter, status: st.outcome, note: st.error });
    }
    st.seconds = Math.round((Date.now() - t0) / 1000);
    log(`✓ ${s.source_id}: ${st.outcome} ${st.datasets ?? 0} datasets, ${st.columns ?? 0} columns, ${st.seconds}s${st.error ? " — " + st.error : ""}`);
    return st;
  }

  const queue = [...work];
  const conc = opts.concurrency ?? 8;
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (queue.length) {
        const w = queue.shift()!;
        stats.push(await one(w.s, w.plan as Exclude<Plan, { kind: "skip" }>));
      }
    })
  );

  const finished = new Date();
  const totals = db.prepare(
    "SELECT (SELECT COUNT(*) FROM datasets WHERE removed_at IS NULL) AS datasets, (SELECT COUNT(*) FROM dataset_columns) AS columns, (SELECT COUNT(*) FROM dataset_columns WHERE key_label IS NOT NULL) AS key_columns"
  ).get() as { datasets: number; columns: number; key_columns: number };
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const summary = {
    run_id: runId,
    started_at: started.toISOString(),
    finished_at: finished.toISOString(),
    run_seconds: Math.round((finished.getTime() - started.getTime()) / 1000),
    registry_generated: reg.generated,
    portals_tried: work.length,
    succeeded: stats.filter((x) => x.outcome === "ok").length,
    partial: stats.filter((x) => x.outcome === "partial").length,
    failed: stats.filter((x) => x.outcome === "failed").length,
    blocked: stats.filter((x) => x.outcome === "blocked").length,
    refused_out_of_state: stats.filter((x) => x.outcome === "refused").length,
    skipped_live_rows: stats.filter((x) => x.outcome === "skipped").length,
    not_due: stats.filter((x) => x.outcome === "not-due").length,
    datasets_in_index: totals.datasets,
    columns_in_index: totals.columns,
    key_columns_in_index: totals.key_columns,
    http_requests: requestLog.length,
    crawl_delays_honored_ms: crawlDelays(),
    index_path: indexPath(),
    index_bytes: statSync(indexPath()).size,
    max_layer_requests_per_portal: maxLayers,
    portals: stats.sort((a, b) => a.source_id.localeCompare(b.source_id)),
  };
  db.prepare("UPDATE harvest_runs SET finished_at = ?, stats = ? WHERE id = ?").run(finished.toISOString(), JSON.stringify(summary), runId);
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('last_harvest', ?)").run(finished.toISOString());
  db.close();
  return summary;
}

function typeClause(cfg: HarvestConfig): string {
  return cfg.defaults.enterprise_item_types.map((t) => `type:"${t}"`).join(" OR ");
}
