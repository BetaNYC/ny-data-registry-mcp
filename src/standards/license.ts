/**
 * Sort a dataset's license text into what it actually is (issue #17, decision E3).
 *
 * The `license` column holds whatever the portal wrote: a license name, "See Terms of Use", a
 * URL, a long disclaimer, or nothing (about 72% of datasets). Never invent a license:
 * - "license": the text is a known license name. A URL is added only when the name says
 *   exactly which license and version.
 * - "terms-page": no license, but a terms-of-use URL, from the portal's own text for this
 *   dataset or from data/terms-pages.json for the portal. Always labeled TERMS_LABEL.
 * - "statement": other portal text (disclaimers, use limits), kept word for word.
 * - "none": nothing.
 */
import { readDataJson } from "../paths.js";

export const TERMS_LABEL = "terms page, not a license" as const;

export type LicenseKind = "license" | "terms-page" | "statement" | "none";

export interface LicenseInfo {
  kind: LicenseKind;
  /** Only for kind "license". */
  license: { name: string; url: string | null } | null;
  /** A terms-of-use page. Never a license. */
  terms_page: { url: string; label: typeof TERMS_LABEL; source: "dataset" | "portal" } | null;
  /** The portal's own text when it is not a license name, cleaned of HTML. */
  statement: string | null;
}

export interface TermsPages {
  portals: Record<string, { url: string; checked: string; note?: string }>;
}

let cachedTerms: TermsPages | null = null;
/** data/terms-pages.json: one checked terms-of-use URL per portal. Empty until someone checks them. */
export function termsPages(): TermsPages {
  if (!cachedTerms) {
    const raw = readDataJson<Partial<TermsPages>>("terms-pages.json");
    cachedTerms = { portals: raw.portals ?? {} };
  }
  return cachedTerms;
}

/**
 * License names we recognize, by their exact words (lowercase, spaces collapsed). The URL is the
 * license's canonical page, and only where the words name one license and version.
 */
const CC_BY_4 = "https://creativecommons.org/licenses/by/4.0/";
export const KNOWN_LICENSES: Record<string, string | null> = {
  "public domain": null,
  "public domain u.s. government": null,
  "attribution cc by": null,
  "cc by": null,
  "creative commons attribution 4.0 international": CC_BY_4,
  "creative commons — attribution 4.0 international — cc by 4.0": CC_BY_4,
  "creative commons attribution 4.0 international (cc by 4.0)": CC_BY_4,
  "cc by 4.0": CC_BY_4,
  "cc-by-4.0": CC_BY_4,
  "creative commons attribution-sharealike 4.0 international": "https://creativecommons.org/licenses/by-sa/4.0/",
  "cc0 1.0 universal": "https://creativecommons.org/publicdomain/zero/1.0/",
  "creative commons cc0 1.0 universal": "https://creativecommons.org/publicdomain/zero/1.0/",
  "cc0-1.0": "https://creativecommons.org/publicdomain/zero/1.0/",
  // Open Data Commons has published one version of each of these: 1.0.
  "open data commons open database license": "https://opendatacommons.org/licenses/odbl/1-0/",
  "open database license (odbl)": "https://opendatacommons.org/licenses/odbl/1-0/",
  "open data commons public domain dedication and license": "https://opendatacommons.org/licenses/pddl/1-0/",
  "open data commons attribution license": "https://opendatacommons.org/licenses/by/1-0/",
};

const EMPTY_WORDS = new Set(["none", "n/a", "na", "null", "no license", "not specified"]);
const TERMS_WORDS = /\bterms\s+(?:of\s+use|of\s+service|and\s+conditions)\b|\blicen[cs]e\s+details\b/i;
const URL_RE = /https?:\/\/[^\s<>"'()]+/gi;

/** Portal text without HTML, entities decoded, whitespace collapsed. */
export function cleanLicenseText(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function urlsIn(text: string): string[] {
  return (text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:]+$/, ""));
}

/** Sort one dataset's license text. `portalId` looks up the portal's checked terms page. */
export function classifyLicense(raw: string | null | undefined, portalId: string, terms: TermsPages = termsPages()): LicenseInfo {
  const text = cleanLicenseText(raw);
  const portalTerms = terms.portals[portalId];
  const fromPortal = portalTerms ? { url: portalTerms.url, label: TERMS_LABEL, source: "portal" as const } : null;
  if (!text || EMPTY_WORDS.has(text.toLowerCase())) {
    return { kind: fromPortal ? "terms-page" : "none", license: null, terms_page: fromPortal, statement: null };
  }
  const key = text.toLowerCase();
  if (key in KNOWN_LICENSES) {
    return { kind: "license", license: { name: text, url: KNOWN_LICENSES[key] }, terms_page: null, statement: null };
  }
  const urls = urlsIn(text);
  // The whole text is one URL: the portal pointing at its terms.
  if (urls.length === 1 && text.replace(/[.,;:]+$/, "") === urls[0]) {
    return { kind: "terms-page", license: null, terms_page: { url: urls[0], label: TERMS_LABEL, source: "dataset" }, statement: null };
  }
  // A short note naming the terms of use with a link to them.
  if (urls.length >= 1 && TERMS_WORDS.test(text) && text.length <= 400) {
    return { kind: "terms-page", license: null, terms_page: { url: urls[0], label: TERMS_LABEL, source: "dataset" }, statement: text };
  }
  return { kind: fromPortal ? "terms-page" : "statement", license: null, terms_page: fromPortal, statement: text };
}
