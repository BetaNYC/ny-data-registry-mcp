// The question set's portal-status invariant (issue #30). Since 2026-11-14 the harvest reads some
// "no portal" rows on purpose (allow_no_portal, epic #7 D4; the hand-kept list, D6). The invariant
// judges each row with the harvester's own planFor, so the two cannot disagree. No network.
import "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { nonLivePortalViolation } from "../dist/eval.js";
import { loadBundled } from "../dist/registry.js";
import { readDataJson } from "../dist/paths.js";

const cfg = readDataJson("harvest-config.json");
const reg = loadBundled();
const src = (id) => {
  const s = reg.sources.find((x) => x.source_id === id);
  assert.ok(s, `${id} is in the bundled registry`);
  return s;
};
// The dataset the 2026-11-16 to 11-18 harvests were blocked on.
const MOUNT_VERNON_DS = "city-of-mount-vernon:858f5327af894eeb9ce28881f82aebe6";

test("a dataset from an allow-listed 'no portal' row is not a violation", () => {
  assert.equal(src("city-of-mount-vernon").status, "no-portal");
  assert.equal(nonLivePortalViolation(MOUNT_VERNON_DS, src("city-of-mount-vernon"), cfg), null);
  assert.equal(nonLivePortalViolation("city-of-utica:abc123", src("city-of-utica"), cfg), null);
  assert.equal(nonLivePortalViolation("cayuga-county:https://ccgis2.cayugacounty.us/x", src("cayuga-county"), cfg), null);
});

test("a dataset from a 'no portal' row the harvest does not read is a violation", () => {
  const kingston = src("city-of-kingston");
  assert.equal(kingston.status, "no-portal");
  assert.equal(cfg.allow_no_portal[kingston.entity], undefined);
  const v = nonLivePortalViolation("city-of-kingston:abc123", kingston, cfg);
  assert.match(v, /^city-of-kingston:abc123 from a portal the registry marks no-portal, which the harvest does not read/);
});

test("an allow-listed row whose endpoint no longer appears in the registry row is a violation", () => {
  const moved = { ...src("city-of-mount-vernon"), api_endpoint: "https://gis.example.gov/portal/sharing/rest" };
  const v = nonLivePortalViolation(MOUNT_VERNON_DS, moved, cfg);
  assert.match(v, /registry marks no-portal/);
  assert.match(v, /no longer contains/);
});

test("when a moved row falls back to its hand-kept links, old adapter datasets are flagged and the links are not", () => {
  const essex = { ...src("essex-county"), api_endpoint: "https://gis.essexcountyva.gov/arcgis/rest/services" };
  assert.match(nonLivePortalViolation("essex-county:https://essex-gis.co.essex.ny.us/x", essex, cfg), /as an adapter dataset, but the harvest now reads it as hand-kept/);
  assert.equal(nonLivePortalViolation("essex-county:hand-kept:0123456789abcdef", essex, cfg), null);
});

test("a 'no portal' row with hand-kept links: its links pass, anything else from it is flagged", () => {
  const allegany = src("allegany-county");
  assert.equal(allegany.status, "no-portal");
  assert.equal(nonLivePortalViolation("allegany-county:hand-kept:0123456789abcdef", allegany, cfg), null);
  assert.match(nonLivePortalViolation("allegany-county:abc123", allegany, cfg), /as an adapter dataset, but the harvest now reads it as hand-kept/);
});

test("a skip rule or a key still stops an allow-listed row", () => {
  const utica = src("city-of-utica");
  const skipped = { ...cfg, skip: { by_entity: { "City of Utica": "test skip" } } };
  assert.match(nonLivePortalViolation("city-of-utica:abc123", utica, skipped), /test skip/);
  assert.match(nonLivePortalViolation("city-of-utica:abc123", { ...utica, key_required: "Y" }, cfg), /key required/);
});

test("an adapter switched off keeps its last read, as for live rows", () => {
  const off = { ...cfg, adapters: { ...cfg.adapters, enterprise: { enabled: false } } };
  assert.equal(nonLivePortalViolation(MOUNT_VERNON_DS, src("city-of-mount-vernon"), off), null);
});

test("dead and UNCONFIRMED rows are still violations, even when their entity is on the allow list", () => {
  assert.equal(nonLivePortalViolation("city-of-albany:abc123", src("city-of-albany"), cfg), "city-of-albany:abc123 from a portal the registry marks dead");
  const baruch = src("baruch-college-cuny-newman-library");
  assert.equal(nonLivePortalViolation("baruch-college-cuny-newman-library:x", baruch, cfg), "baruch-college-cuny-newman-library:x from a portal the registry marks UNCONFIRMED");
  const deadMv = { ...src("city-of-mount-vernon"), status: "dead" };
  assert.equal(nonLivePortalViolation(MOUNT_VERNON_DS, deadMv, cfg), `${MOUNT_VERNON_DS} from a portal the registry marks dead`);
});

test("a live row is never a violation here (the other invariants cover it)", () => {
  assert.equal(nonLivePortalViolation("nys-department-of-health:abcd-1234", src("nys-department-of-health"), cfg), null);
});
