// Standard metadata (issue #17): Croissant 1.1 and DCAT-US 3.0 for each dataset, the statewide
// files, the license rules (never invent one), the tool option, and the publish/rollback side
// files. DCAT-US output is checked against GSA's official JSON Schema, vendored in
// test/fixtures/dcat-us-3.0/ (source and date in its README). Croissant is checked against the
// spec's required fields and mlcroissant 1.1.1's error rules (mlcroissant itself is Python and
// was run by hand; see docs/standard-metadata-plan.md). Offline. Datasets marked SYNTHETIC are
// made up for the test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { tempIndexPath, buildFixtureIndex, FIXTURES } from "./helpers.mjs";

const path = tempIndexPath();
process.env.NY_DATA_INDEX = path;
await buildFixtureIndex(path);

const { openDb, writePortalDatasets, upsertPortal } = await import("../dist/db.js");
const { mapSocrataAsset } = await import("../dist/harvest/socrata.js");
const { portalRecord } = await import("../dist/harvest/run.js");
const { registry } = await import("../dist/registry.js");
const L = await import("../dist/standards/license.js");
const B = await import("../dist/standards/build.js");
const S = await import("../dist/standards/statewide.js");
const { callTool } = await import("../dist/tools.js");
const { closeDb } = await import("../dist/datasets.js");
const { OPTIONAL_SIDE_FILES, REQUIRED_SIDE_FILES, preparePublish } = await import("../dist/publish/prepare.js");
const { rollbackSideFiles, rollbackCommands } = await import("../dist/publish/rollback.js");

// SYNTHETIC datasets on two portals, one per license case.
const LICENSE_CASES = {
  "syn-lic1": "Creative Commons Attribution 4.0 International",
  "syn-lic2": "Public Domain",
  "syn-url1": "https://www.dutchessny.gov/terms-and-conditions.htm",
  "syn-trm1": "This data was made available by the City of Rochester. For details, please see the Terms of Use page here: https://example.org/terms-of-use",
  "syn-ptr1": "See Terms of Use",
  "syn-dis1": "The County makes no warranty of any kind. &quot;As is&quot;.",
  "syn-none": "None",
};
{
  const db = openDb(path);
  const mk = (id, license, extra = {}) =>
    mapSocrataAsset(
      {
        resource: { id, name: `SYNTHETIC ${id}`, type: "dataset", attribution: "SYNTHETIC Agency", description: "<p>A made-up dataset for tests.</p>", createdAt: "2024-01-02T03:04:05.000Z", updatedAt: "2025-06-07T08:09:10.000Z", ...extra },
        classification: { domain_category: "Health", domain_tags: ["synthetic"], domain_metadata: [{ key: "Update_Frequency", value: "Monthly" }] },
        metadata: license === undefined ? {} : { license },
        permalink: `https://data.example.org/d/${id}`,
      },
      "data.example.org"
    );
  const nyc = portalRecord(registry().sources.find((s) => s.source_id === "new-york-city"));
  upsertPortal(db, nyc);
  writePortalDatasets(db, nyc, [...Object.entries(LICENSE_CASES).map(([id, lic]) => mk(id, lic)), mk("syn-null", undefined), mk("syn-nodesc", undefined, { description: "" })], 2, false);
  (await import("../dist/topics.js")).buildTopics(db);
  db.close();
}

const db = openDb(path);
const recs = B.loadRecords(db);
const byId = new Map(recs.map((r) => [r.id, r]));
const harvestedAt = B.indexHarvestTime(db);
db.close();
const rec = (native) => byId.get(`new-york-city:${native}`);
const NO_TERMS = { portals: {} };
const NYC_TERMS = { portals: { "new-york-city": { url: "https://example.org/nyc-terms", checked: "2026-11-14" } } };

// --- DCAT-US 3.0: the official schema --------------------------------------------------------
const schemaDir = join(FIXTURES, "dcat-us-3.0");
// unicodeRegExp: false, because GSA's mailto pattern uses escapes ("\_", "\~") that are an error
// in a JavaScript /u regular expression. Ajv has no "iri" format: an absolute URL is required.
const ajv = new Ajv2020({ allErrors: true, strict: false, unicodeRegExp: false });
addFormats(ajv);
ajv.addFormat("iri", (s) => {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
});
for (const f of readdirSync(schemaDir).filter((f) => f.endsWith(".json"))) ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, f), "utf8")));
const validateDataset = ajv.getSchema("https://resources.data.gov/dcat-us/3.0.0/definitions/dataset");
const validateCatalog = ajv.getSchema("https://resources.data.gov/dcat-us/3.0.0/definitions/catalog");

/** Schema errors other than the Mandatory fields we leave out on purpose (listed in `missing`). */
function unexpectedDcatErrors(doc, missing) {
  if (validateDataset(doc)) return [];
  const allowed = new Set(missing.filter((m) => m.required).map((m) => m.field));
  return validateDataset.errors.filter((e) => !(e.keyword === "required" && e.instancePath === "" && allowed.has(e.params.missingProperty)));
}

test("the vendored schema is GSA's DCAT-US 3.0 and rejects a dataset with no title", () => {
  assert.equal(readdirSync(schemaDir).filter((f) => f.endsWith(".json")).length, 26);
  assert.match(readFileSync(join(schemaDir, "README.md"), "utf8"), /a1dbaa040bab275abefc6df4fb77ed2ca18d920f/);
  assert.equal(validateDataset({ "@type": "Dataset", description: "x", identifier: "x", contactPoint: { fn: "x", hasEmail: "mailto:x@example.org" } }), false);
  assert.equal(validateDataset({ "@type": "Dataset", title: "x", description: "x", identifier: "x", contactPoint: { fn: "x", hasEmail: "mailto:x@example.org" } }), true);
});

test("every dataset's DCAT-US passes the official schema, except the required fields we leave out and say so", () => {
  assert.ok(recs.length >= 15, `${recs.length} datasets`);
  for (const r of recs) {
    const b = B.toDcatUs(r, { terms: NO_TERMS });
    assert.deepEqual(unexpectedDcatErrors(b.document, b.missing), [], r.id);
    assert.ok(b.missing.some((m) => m.field === "contactPoint"), "contactPoint is always named as missing");
    assert.ok(!("contactPoint" in b.document), "no made-up contact");
    if (!b.document.description) assert.ok(b.missing.some((m) => m.field === "description"), r.id);
  }
});

test("DCAT-US maps the fields from the plan", () => {
  const d = B.toDcatUs(rec("syn-lic1"), { terms: NO_TERMS }).document;
  assert.equal(d.title, "SYNTHETIC syn-lic1");
  assert.equal(d.identifier, "new-york-city:syn-lic1");
  assert.equal(d.description, "A made-up dataset for tests.", "HTML stripped");
  assert.equal(d.issued, "2024-01-02T03:04:05.000Z");
  assert.equal(d.modified, "2025-06-07T08:09:10.000Z");
  assert.equal(d.accrualPeriodicity, "monthly");
  assert.deepEqual(d.publisher, { "@type": "Organization", name: "SYNTHETIC Agency" });
  assert.equal(d.landingPage.accessURL, "https://data.example.org/d/syn-lic1");
  const csv = d.distribution.find((x) => x.title === "CSV");
  assert.equal(csv.downloadURL, "https://data.example.org/resource/syn-lic1.csv");
  assert.match(csv.description, /built by BetaNYC/);
  assert.ok(d.distribution.find((x) => x.title === "API (SODA)").accessURL, "an API is reached, not downloaded");
  assert.ok(d.theme.includes("Health"));
  const topic = d.theme.find((t) => t["@type"] === "Concept");
  assert.ok(topic && topic.inScheme.title.startsWith("BetaNYC shared topics"), "our topic, as a Concept");
});

test("an unknown update frequency and an out-of-range extent are left out, not guessed", () => {
  assert.equal(B.frequencyCode("Historical data"), null);
  assert.equal(B.frequencyCode("As needed"), "asNeeded");
  assert.equal(B.lonLatBox([-76.3, 42.4, -75.9, 42.8]).length, 4);
  assert.equal(B.lonLatBox([1e6, 2e6, 3e6, 4e6]), null);
  const cortland = recs.find((r) => r.portal_id === "cortland-county");
  assert.equal(B.toDcatUs(cortland).document.spatial.bbox.type, "Polygon");
});

// --- License: never invented ------------------------------------------------------------------
test("license present: in `license`, in both standards, with a URL only when the name gives the version", () => {
  for (const [id, url] of [["syn-lic1", "https://creativecommons.org/licenses/by/4.0/"], ["syn-lic2", "Public Domain"]]) {
    const c = B.toCroissant(rec(id), { harvestedAt, terms: NYC_TERMS });
    const d = B.toDcatUs(rec(id), { terms: NYC_TERMS });
    assert.equal(c.license.kind, "license", id);
    assert.equal(c.document.license, url);
    assert.equal(d.document.license, url);
    assert.ok(!("usageInfo" in c.document) && !("rights" in d.document), "a real license needs no terms page");
  }
  assert.deepEqual(L.classifyLicense("Attribution   CC BY", "x", NO_TERMS).license, { name: "Attribution CC BY", url: null }, "no version, no URL");
});

test("license absent with a terms page: linked and labeled 'terms page, not a license', never in `license`", () => {
  // From the portal's own text for the dataset.
  for (const [id, url] of [["syn-url1", LICENSE_CASES["syn-url1"]], ["syn-trm1", "https://example.org/terms-of-use"]]) {
    const c = B.toCroissant(rec(id), { harvestedAt, terms: NO_TERMS });
    const d = B.toDcatUs(rec(id), { terms: NO_TERMS });
    assert.equal(c.license.kind, "terms-page", id);
    assert.equal(c.license.terms_page.source, "dataset");
    assert.equal(c.license.terms_page.label, "terms page, not a license");
    assert.ok(!("license" in c.document) && !("license" in d.document), id);
    const usage = [c.document.usageInfo].flat();
    assert.ok(usage.some((u) => u.name === "Terms page, not a license" && u.url === url), id);
    assert.ok(d.document.rights.includes(`Terms page, not a license: ${url}`), id);
    assert.ok(c.missing.some((m) => m.field === "license" && /terms page, not a license/.test(m.why)));
  }
  // From data/terms-pages.json for the portal, when the dataset has no license.
  for (const id of ["syn-null", "syn-none", "syn-ptr1", "syn-dis1"]) {
    const d = B.toDcatUs(rec(id), { terms: NYC_TERMS });
    assert.equal(d.license.kind, "terms-page", id);
    assert.equal(d.license.terms_page.source, "portal");
    assert.ok(d.document.rights.includes("Terms page, not a license: https://example.org/nyc-terms"), id);
    assert.ok(!("license" in d.document));
  }
  // A platform vendor's page (kind "platform") says so, and is still never a license.
  const PLATFORM = { portals: { "new-york-city": { url: "https://example.org/vendor-terms", checked: "2026-11-14", kind: "platform" } } };
  const d = B.toDcatUs(rec("syn-null"), { terms: PLATFORM });
  const c = B.toCroissant(rec("syn-null"), { harvestedAt, terms: PLATFORM });
  assert.equal(d.license.terms_page.platform, true);
  assert.ok(d.document.rights.includes("Terms page, not a license (the platform vendor's page, linked by the portal): https://example.org/vendor-terms"));
  assert.match(c.document.usageInfo.name, /^Terms page, not a license \(the platform vendor's page/);
  assert.ok(!("license" in d.document) && !("license" in c.document));
  assert.ok(!("platform" in B.toDcatUs(rec("syn-null"), { terms: NYC_TERMS }).license.terms_page), "a portal's own page is not marked platform");
});

test("no license and no terms page: no license field and no terms link; portal text is kept word for word", () => {
  for (const id of ["syn-null", "syn-none"]) {
    const c = B.toCroissant(rec(id), { harvestedAt, terms: NO_TERMS });
    const d = B.toDcatUs(rec(id), { terms: NO_TERMS });
    assert.equal(c.license.kind, "none", id);
    for (const doc of [c.document, d.document]) for (const k of ["license", "usageInfo", "rights"]) assert.ok(!(k in doc), `${id} ${k}`);
  }
  for (const id of ["syn-ptr1", "syn-dis1"]) {
    const c = B.toCroissant(rec(id), { harvestedAt, terms: NO_TERMS });
    const d = B.toDcatUs(rec(id), { terms: NO_TERMS });
    assert.equal(c.license.kind, "statement", id);
    assert.ok(!("license" in c.document) && !("license" in d.document));
    const text = L.cleanLicenseText(LICENSE_CASES[id]);
    assert.deepEqual(d.document.rights, [text]);
    assert.equal(c.document.usageInfo.text, text);
    assert.match(c.document.usageInfo.name, /not a license/);
  }
  assert.equal(L.cleanLicenseText(LICENSE_CASES["syn-dis1"]), 'The County makes no warranty of any kind. "As is".');
});

test("data/terms-pages.json: every portal entry was checked by hand and says how it was found", async () => {
  const f = JSON.parse(readFileSync(new URL("../data/terms-pages.json", import.meta.url), "utf8"));
  const { assignSourceIds } = await import("../dist/registry.js");
  const sourceIds = new Set(assignSourceIds(JSON.parse(readFileSync(new URL("../data/ny-data-portal-registry.json", import.meta.url), "utf8")).rows));
  assert.ok(Object.keys(f.portals).length > 0);
  for (const [id, v] of Object.entries(f.portals)) {
    assert.match(v.url, /^https?:\/\/\S+$/, id);
    assert.match(v.checked, /^\d{4}-\d{2}-\d{2}$/, id);
    assert.ok(typeof v.title === "string" && v.title.trim(), `${id}: exact page title`);
    assert.ok(typeof v.found === "string" && v.found.trim(), `${id}: how it was found`);
    assert.ok(["portal", "platform"].includes(v.kind), `${id}: kind`);
    assert.ok(!(id in f.checked_without_terms), `${id} is listed both ways`);
  }
  // Keys are the bundled registry's portal ids: a typo would silently never match a dataset.
  for (const id of [...Object.keys(f.portals), ...Object.keys(f.checked_without_terms).filter((k) => !k.startsWith("_"))]) {
    assert.ok(sourceIds.has(id), `${id} is not a portal id in the bundled registry`);
  }
});

// --- Croissant 1.1 -----------------------------------------------------------------------------
/** The spec's required fields and mlcroissant 1.1.1's error rules. Returns the problems found. */
function croissantProblems(doc) {
  const p = [];
  for (const k of ["@context", "@type", "conformsTo", "name"]) if (!(k in doc)) p.push(`missing ${k}`);
  if (doc["@type"] !== "sc:Dataset") p.push("@type is not sc:Dataset");
  if (doc["@context"]["@vocab"] !== "https://schema.org/" || doc["@context"].sc !== "https://schema.org/") p.push("schema.org must be https (mlcroissant)");
  if (doc.conformsTo !== "http://mlcommons.org/croissant/1.1") p.push("conformsTo");
  if ("license" in doc && typeof doc.license !== "string") p.push("license must be text or CreativeWork");
  if ("keywords" in doc && !doc.keywords.every((k) => typeof k === "string")) p.push("keywords must be text (mlcroissant)");
  if ("recordSet" in doc) p.push("no recordSet: its fields would need a source we cannot name");
  if (!Array.isArray(doc.distribution)) p.push("distribution must be a list");
  const ids = new Set();
  for (const f of doc.distribution ?? []) {
    if (f["@type"] !== "cr:FileObject") p.push("distribution holds FileObjects");
    for (const k of ["@id", "contentUrl", "encodingFormat"]) if (!f[k]) p.push(`FileObject without ${k}`);
    if (!f.md5 && !f.sha256 && doc.isLiveDataset !== true) p.push("FileObject without a checksum in a dataset that is not live");
    if (ids.has(f["@id"])) p.push(`duplicate @id ${f["@id"]}`);
    ids.add(f["@id"]);
  }
  return p;
}

test("every dataset's Croissant has the required fields and passes mlcroissant's rules", () => {
  for (const r of recs) {
    const b = B.toCroissant(r, { harvestedAt, terms: NO_TERMS });
    assert.deepEqual(croissantProblems(b.document), [], r.id);
    for (const k of ["description", "url", "datePublished", "creator", "license"]) {
      if (!(k in b.document)) assert.ok(b.missing.some((m) => m.field === k), `${r.id}: ${k} left out without saying so`);
    }
    assert.equal(b.document.isLiveDataset, true);
    assert.equal(b.document.sdDatePublished, harvestedAt, "names the index it came from");
  }
  const c = B.toCroissant(rec("syn-lic1"), { harvestedAt }).document;
  assert.equal(c.url, "https://data.example.org/d/syn-lic1");
  assert.equal(c.datePublished, "2024-01-02T03:04:05.000Z");
  assert.deepEqual(c.creator, { "@type": "sc:Organization", name: "SYNTHETIC Agency" });
  assert.ok(c.keywords.includes("synthetic") && c.keywords.includes("Health"));
  assert.deepEqual(c.distribution.map((f) => f.encodingFormat), ["text/csv"], "files only: the SODA API is not a file");
});

// --- Statewide files, several portals ---------------------------------------------------------
const out = mkdtempSync(join(tmpdir(), "nydr-std-"));
const stats = S.writeStatewide(path, out, { terms: NO_TERMS });

test("statewide files: one DCAT-US Catalog and one Croissant line per dataset, across portals", () => {
  assert.equal(stats.datasets, recs.length);
  assert.equal(Object.values(stats.license_kinds).reduce((a, b) => a + b, 0), recs.length);
  assert.deepEqual(stats.license_kinds, { license: 2, "terms-page": 2, statement: 3, none: recs.length - 7 });
  const cat = JSON.parse(gunzipSync(readFileSync(join(out, S.DCAT_FILE))).toString("utf8"));
  const { dataset, ...head } = cat;
  assert.equal(validateCatalog({ ...head, dataset: [] }), true, JSON.stringify(validateCatalog.errors));
  assert.equal(cat.modified, harvestedAt);
  assert.equal(dataset.length, recs.length);
  const portals = new Set(dataset.map((d) => d.identifier.split(":")[0]));
  assert.ok(portals.size >= 4, [...portals].join(", "));
  const publishers = new Set(dataset.map((d) => d.publisher.name));
  assert.ok(publishers.has("Putnam County, NY") && publishers.has("SYNTHETIC Agency"));
  assert.ok(publishers.has("New York City"), "a dataset with no publisher gets the registry entity that runs its portal");
  for (const d of dataset) {
    const m = [{ field: "contactPoint", required: true }, { field: "description", required: true }];
    assert.deepEqual(unexpectedDcatErrors(d, m), [], d.identifier);
  }
  const lines = gunzipSync(readFileSync(join(out, S.CROISSANT_FILE))).toString("utf8").trim().split("\n");
  assert.equal(lines.length, recs.length);
  for (const l of lines) assert.deepEqual(croissantProblems(JSON.parse(l)), []);
  assert.deepEqual(stats.files.map((f) => f.name), S.STANDARD_FILES);
});

test("the publish step writes the statewide files next to the index", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nydr-pub-"));
  await preparePublish({ index: path, dir });
  for (const f of S.STANDARD_FILES) assert.ok(readdirSync(dir).includes(f), f);
  const lines = gunzipSync(readFileSync(join(dir, S.CROISSANT_FILE))).toString("utf8").trim().split("\n");
  assert.equal(lines.length, recs.length);
});

// --- Rollback: optional side files that never describe the wrong index -------------------------
test("rollback: the statewide files are optional side files, like the crosswalk", () => {
  for (const f of S.STANDARD_FILES) assert.ok(OPTIONAL_SIDE_FILES.includes(f), f);
  const required = REQUIRED_SIDE_FILES;
  const all = [...required, ...OPTIONAL_SIDE_FILES];
  // A snapshot from before #17: still a target; the newer files leave index-latest, last.
  const old = rollbackSideFiles({ required, optional: OPTIONAL_SIDE_FILES, targetFiles: [...required, "topic-crosswalk.csv", "index.json"], latestFiles: all });
  assert.deepEqual(old.check, required);
  assert.deepEqual(old.upload, [...required, "topic-crosswalk.csv"]);
  assert.deepEqual(old.removeFromLatest, S.STANDARD_FILES);
  const cmds = rollbackCommands({ dir: "/r", sideFiles: old.upload, manifest: { last_harvest: "2026-11-10T00:00:00Z" }, rec: { from: null, to: "index-2026-11-10", reason: "x", at: "2026-11-14T00:00:00Z", by: null }, releases: [], removeFromLatest: old.removeFromLatest });
  assert.deepEqual(cmds.slice(-2).map((c) => c.args.slice(0, 4)), S.STANDARD_FILES.map((f) => ["release", "delete-asset", "index-latest", f]), "removed last");
  // A snapshot that has them: copied over index-latest, nothing removed.
  const fresh = rollbackSideFiles({ required, optional: OPTIONAL_SIDE_FILES, targetFiles: [...all, "index.json"], latestFiles: all });
  assert.deepEqual(fresh.upload, all);
  assert.deepEqual(fresh.removeFromLatest, []);
});

// --- The tool option --------------------------------------------------------------------------
test("get_dataset_columns with standard returns that document; without it, the reply is unchanged", async () => {
  const parse = (r) => JSON.parse(r.content[0].text);
  const plain = parse(await callTool("get_dataset_columns", { dataset: "new-york-city:syn-lic1" }));
  assert.ok(Array.isArray(plain.columns) && !("document" in plain));
  const c = parse(await callTool("get_dataset_columns", { dataset: "new-york-city:syn-lic1", standard: "croissant" }));
  assert.equal(c.standard, "croissant");
  assert.equal(c.document.conformsTo, "http://mlcommons.org/croissant/1.1");
  assert.equal(c.license.kind, "license");
  assert.match(c.statewide_file.url, /index-latest\/ny-data-croissant\.jsonl\.gz$/);
  const d = parse(await callTool("get_dataset_columns", { dataset: "new-york-city:syn-null", standard: "dcat-us" }));
  assert.equal(d.conforms_to, "DCAT-US v3.0");
  assert.equal(d.license.kind, "terms-page", "the bundled terms table has New York City's page");
  assert.equal(d.license.terms_page.source, "portal");
  assert.equal(d.license.terms_page.url, "https://www.nyc.gov/main/terms-of-use");
  assert.ok(!("license" in d.document));
  assert.deepEqual(unexpectedDcatErrors(d.document, d.missing), []);
  const bad = await callTool("get_dataset_columns", { dataset: "new-york-city:syn-lic1", standard: "schema.org" });
  assert.equal(bad.isError, true);
  const missing = parse(await callTool("get_dataset_columns", { dataset: "nope", standard: "croissant" }));
  assert.match(missing.error, /no dataset/);
  closeDb();
});
