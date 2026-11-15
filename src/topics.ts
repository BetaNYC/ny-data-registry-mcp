/**
 * Topic search (issue #18): 24 shared topics for New York open data, assigned to each dataset
 * from its own labels (categories, tags, department).
 *
 * The rules are data, not code: data/topics.json (the 24 topics and their match rules, plus
 * label cleanup) and data/topic-hand-assigned.json (broad or ambiguous words, decided by hand).
 * Method: docs/topics.md. This file is a port of the scripts behind BetaNYC's 2026-11-12
 * taxonomy research, so the crosswalk can be rebuilt with every index.
 */
import type { DatabaseSync } from "node:sqlite";
import { readDataJson } from "./paths.js";
import { toCsv } from "./exportcsv.js";

export type LabelType = "category" | "tag" | "department";
export const LABEL_TYPES: LabelType[] = ["category", "tag", "department"];

export interface TopicDef {
  id: string;
  name: string;
  iso_19115: string[];
  match: string[];
}

export interface TopicsFile {
  version: number;
  topics: TopicDef[];
  normalize: { compound: Record<string, string>; variant: Record<string, string>; no_singular: string[] };
  non_topical: { year: string; place: string; format: string; publisher: string };
}

export interface HandEntry {
  label: string;
  /** Only for this kind of label. Missing = every kind. */
  label_type?: LabelType;
  /** Empty = no topic, on purpose. */
  topics: string[];
  why: string;
}

export interface HandFile {
  labels: HandEntry[];
  /** Tags that look like an agency acronym but must not inherit that agency's topics. */
  acronym_tags_never_inherit: string[];
}

export interface TopicRules {
  version: number;
  topics: TopicDef[];
  byId: Map<string, TopicDef>;
  compiled: { id: string; rx: RegExp }[];
  normalize: TopicsFile["normalize"] & { noSingular: Set<string> };
  nonTopical: { kind: string; rx: RegExp; departmentOnly: boolean }[];
  hand: HandEntry[];
  neverInherit: Set<string>;
}

/** A fragment starting with ^ is anchored; any other must start at a word boundary. */
export function compileMatch(fragments: string[]): RegExp {
  return new RegExp(fragments.map((f) => (f.startsWith("^") ? f : `\\b${f}`)).join("|"));
}

/** Load and check the two rule files. Throws on an unknown topic id, a duplicate, or a bad pattern. */
export function loadTopicRules(file: TopicsFile = readDataJson<TopicsFile>("topics.json"), handFile: HandFile = readDataJson<HandFile>("topic-hand-assigned.json")): TopicRules {
  const byId = new Map<string, TopicDef>();
  for (const t of file.topics) {
    if (!/^[a-z_]+$/.test(t.id)) throw new Error(`topic id '${t.id}' must be lowercase letters and _`);
    if (byId.has(t.id)) throw new Error(`topic id '${t.id}' appears twice`);
    if (!t.match.length) throw new Error(`topic '${t.id}' has no match rules`);
    byId.set(t.id, t);
  }
  const seen = new Set<string>();
  for (const h of handFile.labels) {
    for (const id of h.topics) if (!byId.has(id)) throw new Error(`hand-assigned label '${h.label}' names unknown topic '${id}'`);
    if (h.label_type && !LABEL_TYPES.includes(h.label_type)) throw new Error(`hand-assigned label '${h.label}' has unknown label_type '${h.label_type}'`);
    if (!h.why?.trim()) throw new Error(`hand-assigned label '${h.label}' needs a why`);
    const key = `${h.label_type ?? "*"}|${h.label}`;
    if (seen.has(key)) throw new Error(`hand-assigned label '${h.label}' appears twice`);
    seen.add(key);
  }
  const nt = file.non_topical;
  return {
    version: file.version,
    topics: file.topics,
    byId,
    compiled: file.topics.map((t) => ({ id: t.id, rx: compileMatch(t.match) })),
    normalize: { ...file.normalize, noSingular: new Set(file.normalize.no_singular) },
    nonTopical: [
      { kind: "year", rx: new RegExp(nt.year), departmentOnly: false },
      { kind: "place", rx: new RegExp(nt.place), departmentOnly: false },
      { kind: "format or housekeeping", rx: new RegExp(nt.format), departmentOnly: false },
      { kind: "publisher (GIS or IT office, or generic)", rx: new RegExp(nt.publisher), departmentOnly: true },
    ],
    hand: handFile.labels,
    neverInherit: new Set(handFile.acronym_tags_never_inherit),
  };
}

let defaultRules: TopicRules | null = null;
export function topicRules(): TopicRules {
  return (defaultRules ??= loadTopicRules());
}

function singular(w: string, keep: Set<string>): string {
  if (keep.has(w) || w.length <= 3) return w;
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("xes") || w.endsWith("ches") || w.endsWith("shes")) return w.slice(0, -2);
  if (w === "buses") return "bus";
  if (w.endsWith("s") && !/(ss|us|is|ous)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Lowercase plain words. Categories keep their last path segment; tags and categories get a singular last word. */
export function normalizeLabel(raw: string, type: LabelType, rules: TopicRules = topicRules()): string {
  const { compound, variant, noSingular } = rules.normalize;
  let s = raw.replace(/\n/g, " ").trim();
  if (type === "category" && s.includes("/")) s = s.replace(/\/+$/, "").split("/").pop()!;
  s = s.toLowerCase().replace(/&/g, " and ").replace(/_/g, " ").replace(/-/g, " ");
  s = s.replace(/[’']/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  s = compound[s] ?? s;
  if (type !== "department") {
    const ws = s.split(" ");
    if (ws.length && ws[ws.length - 1]) ws[ws.length - 1] = singular(ws[ws.length - 1], noSingular);
    s = ws.join(" ");
    s = compound[s] ?? s;
  }
  return variant[s] ?? s;
}

/**
 * A department name: pull out a trailing "(ACRONYM)", turn "Health, Department of" into
 * "Department of Health", normalize, and drop a leading "nyc", "new york city", "new york
 * state" or "nys".
 */
export function departmentLabel(raw: string, rules: TopicRules = topicRules()): { normalized: string; acronym: string | null } {
  let s = raw.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  let acronym: string | null = null;
  const a = s.match(/^(.*?)\s*\(([A-Z][A-Za-z&]{1,9})\)$/);
  if (a && !a[1].includes(",") && !/^\d/.test(a[1]) && a[1].length < 80) {
    s = a[1];
    acronym = a[2];
  }
  const f = s.match(/^(.+?), (Department|Division|Office|Office for) of$/) ?? s.match(/^(.+?), (Office for)$/);
  if (f) s = f[2].includes("for") ? `Office for ${f[1]}` : `${f[2]} of ${f[1]}`;
  const n = normalizeLabel(s, "department", rules).replace(/^(nyc|new york city|new york state|nys) /, "");
  return { normalized: n, acronym };
}

export interface Classified {
  normalized: string;
  acronym: string | null;
  topics: string[];
  /** hand: topic-hand-assigned.json; rule: a match rule; acronym: an agency acronym used as a tag; none. */
  by: "hand" | "rule" | "acronym" | "none";
  non_topical: string | null;
}

/** Agency acronyms from the index's own department strings ("Department of Buildings (DOB)"): acronym -> normalized name. */
export function agencyAcronyms(departments: { label: string; count: number }[], rules: TopicRules = topicRules()): Map<string, string> {
  const pairs = new Map<string, Map<string, number>>();
  for (const d of departments) {
    const { normalized, acronym } = departmentLabel(d.label, rules);
    if (!acronym) continue;
    const m = pairs.get(acronym) ?? new Map<string, number>();
    m.set(normalized, (m.get(normalized) ?? 0) + d.count);
    pairs.set(acronym, m);
  }
  const out = new Map<string, string>();
  for (const [acro, m] of pairs) {
    // most common expansion; ties go to the first seen
    let best = "";
    let n = -1;
    for (const [name, c] of m) if (c > n) [best, n] = [name, c];
    out.set(acro.toLowerCase(), best);
  }
  return out;
}

function ruleTopics(n: string, rules: TopicRules): string[] {
  return rules.compiled.filter((c) => c.rx.test(n)).map((c) => c.id);
}

/** Topics for one label. Hand-assigned words win; then the match rules; then an agency acronym used as a tag. */
export function classifyLabel(raw: string, type: LabelType, acronyms: Map<string, string> = new Map(), rules: TopicRules = topicRules()): Classified {
  let normalized: string;
  let acronym: string | null = null;
  if (type === "department") ({ normalized, acronym } = departmentLabel(raw, rules));
  else normalized = normalizeLabel(raw, type, rules);
  const hand = rules.hand.find((h) => h.label === normalized && h.label_type === type) ?? rules.hand.find((h) => h.label === normalized && !h.label_type);
  let topics: string[];
  let by: Classified["by"];
  if (hand) {
    topics = [...hand.topics];
    by = "hand";
  } else {
    topics = ruleTopics(normalized, rules);
    by = topics.length ? "rule" : "none";
    if (!topics.length && type !== "department" && acronyms.has(normalized) && !rules.neverInherit.has(normalized)) {
      topics = ruleTopics(acronyms.get(normalized)!, rules);
      if (topics.length) by = "acronym";
    }
  }
  let non_topical: string | null = null;
  if (!topics.length) {
    for (const f of rules.nonTopical) {
      if (f.departmentOnly && type !== "department") continue;
      if (f.rx.test(normalized)) {
        non_topical = f.kind;
        break;
      }
    }
  }
  return { normalized, acronym, topics, by, non_topical };
}

/** One label as a portal uses it, with the live datasets that carry it. */
interface PortalLabel {
  portal_id: string;
  label_type: LabelType;
  label: string;
  datasets: Set<string>;
}

/** Every category, tag and department on live datasets, per portal. */
export function indexLabels(db: DatabaseSync): PortalLabel[] {
  const out = new Map<string, PortalLabel>();
  const add = (portal_id: string, label_type: LabelType, label: string, dataset: string) => {
    const k = `${portal_id}\u0000${label_type}\u0000${label}`;
    let e = out.get(k);
    if (!e) out.set(k, (e = { portal_id, label_type, label, datasets: new Set() }));
    e.datasets.add(dataset);
  };
  const rows = db.prepare("SELECT id, portal_id, categories, department FROM datasets WHERE removed_at IS NULL").all() as {
    id: string;
    portal_id: string;
    categories: string | null;
    department: string | null;
  }[];
  for (const r of rows) {
    let cats: unknown = [];
    try {
      cats = JSON.parse(r.categories || "[]");
    } catch {
      cats = [];
    }
    if (Array.isArray(cats)) for (const c of cats) if (typeof c === "string" && c.trim()) add(r.portal_id, "category", c, r.id);
    const dep = r.department?.trim();
    if (dep) add(r.portal_id, "department", dep, r.id);
  }
  const tags = db
    .prepare("SELECT t.portal_id AS portal_id, t.name AS name, d.id AS id FROM tags t JOIN dataset_tags dt ON dt.tag_id = t.id JOIN datasets d ON d.id = dt.dataset_id WHERE d.removed_at IS NULL")
    .all() as { portal_id: string; name: string; id: string }[];
  for (const t of tags) if (t.name?.trim()) add(t.portal_id, "tag", t.name, t.id);
  return [...out.values()];
}

export interface CrosswalkRow {
  portal_id: string;
  label_type: LabelType;
  original_label: string;
  normalized_label: string;
  topic_ids: string[];
  assigned_by: Classified["by"];
  non_topical: string | null;
  dataset_count: number;
}

export interface TopicBuild {
  rules_version: number;
  datasets: number;
  datasets_with_topic: number;
  /** Share of live datasets with at least one topic, as a percent with one decimal. */
  coverage_percent: number;
  by_topic: { id: string; name: string; datasets: number; portals: number }[];
  crosswalk: CrosswalkRow[];
  /** dataset id -> topic ids */
  assignments: Map<string, Set<string>>;
}

/** Work out every live dataset's topics and the crosswalk, without writing anything. */
export function computeTopics(db: DatabaseSync, rules: TopicRules = topicRules()): TopicBuild {
  const labels = indexLabels(db);
  const acronyms = agencyAcronyms(labels.filter((l) => l.label_type === "department").map((l) => ({ label: l.label, count: l.datasets.size })), rules);
  const cache = new Map<string, Classified>();
  const assignments = new Map<string, Set<string>>();
  const crosswalk: CrosswalkRow[] = [];
  for (const l of labels) {
    const k = `${l.label_type}\u0000${l.label}`;
    let c = cache.get(k);
    if (!c) cache.set(k, (c = classifyLabel(l.label, l.label_type, acronyms, rules)));
    crosswalk.push({
      portal_id: l.portal_id,
      label_type: l.label_type,
      original_label: l.label.replace(/\s+/g, " ").trim(),
      normalized_label: c.normalized,
      topic_ids: c.topics,
      assigned_by: c.by,
      non_topical: c.non_topical,
      dataset_count: l.datasets.size,
    });
    if (!c.topics.length) continue;
    for (const ds of l.datasets) {
      let s = assignments.get(ds);
      if (!s) assignments.set(ds, (s = new Set()));
      for (const t of c.topics) s.add(t);
    }
  }
  const datasets = Number((db.prepare("SELECT COUNT(*) AS n FROM datasets WHERE removed_at IS NULL").get() as { n: number }).n);
  const portalOf = new Map((db.prepare("SELECT id, portal_id FROM datasets WHERE removed_at IS NULL").all() as { id: string; portal_id: string }[]).map((r) => [r.id, r.portal_id]));
  const by_topic = rules.topics.map((t) => {
    const ps = new Set<string>();
    let n = 0;
    for (const [ds, ts] of assignments)
      if (ts.has(t.id)) {
        n++;
        ps.add(portalOf.get(ds) ?? "");
      }
    return { id: t.id, name: t.name, datasets: n, portals: ps.size };
  });
  crosswalk.sort(
    (a, b) => a.portal_id.localeCompare(b.portal_id) || LABEL_TYPES.indexOf(a.label_type) - LABEL_TYPES.indexOf(b.label_type) || b.dataset_count - a.dataset_count || a.original_label.localeCompare(b.original_label)
  );
  return {
    rules_version: rules.version,
    datasets,
    datasets_with_topic: assignments.size,
    coverage_percent: coveragePercent(assignments.size, datasets),
    by_topic,
    crosswalk,
    assignments,
  };
}

export function coveragePercent(withTopic: number, total: number): number {
  return total ? Math.round((1000 * withTopic) / total) / 10 : 0;
}

export const TOPICS_SQL = `
CREATE TABLE IF NOT EXISTS topics (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL, iso_19115 TEXT);
CREATE TABLE IF NOT EXISTS dataset_topics (dataset_id TEXT NOT NULL, topic_id TEXT NOT NULL, PRIMARY KEY (dataset_id, topic_id));
CREATE INDEX IF NOT EXISTS dataset_topics_topic ON dataset_topics(topic_id);
`;

/** Rebuild the topics and dataset_topics tables from the index's own labels. Run at the end of every harvest. */
export function buildTopics(db: DatabaseSync, rules: TopicRules = topicRules()): Omit<TopicBuild, "assignments" | "crosswalk"> & { crosswalk_rows: number } {
  const t = computeTopics(db, rules);
  db.exec(TOPICS_SQL);
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM dataset_topics; DELETE FROM topics;");
    const insT = db.prepare("INSERT INTO topics(id, name, position, iso_19115) VALUES (?,?,?,?)");
    rules.topics.forEach((x, i) => insT.run(x.id, x.name, i + 1, JSON.stringify(x.iso_19115)));
    const ins = db.prepare("INSERT INTO dataset_topics(dataset_id, topic_id) VALUES (?, ?)");
    for (const [ds, ts] of t.assignments) for (const id of ts) ins.run(ds, id);
    const meta = db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)");
    meta.run("topics_rules_version", String(rules.version));
    meta.run("topics_built", new Date().toISOString());
    meta.run("topic_coverage", JSON.stringify({ datasets: t.datasets, datasets_with_topic: t.datasets_with_topic, coverage_percent: t.coverage_percent }));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  const { assignments, crosswalk, ...rest } = t;
  void assignments;
  return { ...rest, crosswalk_rows: crosswalk.length };
}

export const CROSSWALK_NAME = "topic-crosswalk.csv";
export const CROSSWALK_HEADER = ["portal_id", "label_type", "original_label", "normalized_label", "topic_ids", "topic_names", "assigned_by", "non_topical", "dataset_count"];

/** The crosswalk as CSV: one row per label per portal, with its topics (or why it has none). */
export function crosswalkCsv(rows: CrosswalkRow[], rules: TopicRules = topicRules()): string {
  return toCsv(
    CROSSWALK_HEADER,
    rows.map((r) => [
      r.portal_id,
      r.label_type,
      r.original_label,
      r.normalized_label,
      r.topic_ids.join("; "),
      r.topic_ids.map((id) => rules.byId.get(id)?.name ?? id).join("; "),
      r.assigned_by,
      r.non_topical ?? "",
      r.dataset_count,
    ])
  );
}

/** Whether this index has the topic tables (indexes built before 0.4.0 do not). */
export function hasTopics(db: DatabaseSync): boolean {
  const r = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('topics', 'dataset_topics')").get() as { n: number };
  if (Number(r.n) < 2) return false;
  return Number((db.prepare("SELECT COUNT(*) AS n FROM topics").get() as { n: number }).n) > 0;
}

/** A topic by id or name, any case. */
export function resolveTopic(v: string, rules: TopicRules = topicRules()): TopicDef | null {
  const k = v.trim().toLowerCase();
  return rules.topics.find((t) => t.id === k || t.name.toLowerCase() === k) ?? null;
}
