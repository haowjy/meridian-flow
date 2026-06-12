// @ts-nocheck
/**
 * Canonical first-party package catalog for the install gallery.
 *
 * Lifted from `apps/app/src/features/home/first-party-packages.ts` (names and
 * descriptions only — icons stay client-side). TODO(catalog-consumer): the app
 * should fetch `GET /api/packages/catalog` instead of duplicating this list.
 */
import type { FirstPartyCatalogEntry } from "@meridian/contracts/agents";

/** Promoted gallery entries. `sourceUrl` resolves catalog installs when set. */
export interface FirstPartyCatalogRecord extends FirstPartyCatalogEntry {
  /** GitHub repo URL for install; null while the package is gallery-only. */
  sourceUrl: string | null;
}

export const FIRST_PARTY_CATALOG: FirstPartyCatalogRecord[] = [
  {
    id: "literature-review",
    name: "Literature Review",
    description: "Search papers, extract findings, and synthesize a summary across sources.",
    sourceUrl: null,
  },
  {
    id: "data-analysis",
    name: "Data Analysis",
    description: "Plot, transform, and reason over tabular data with code-generating tools.",
    sourceUrl: null,
  },
  {
    id: "lab-notebook",
    name: "Lab Notebook",
    description: "Capture experiments, methods, and observations in a structured log.",
    sourceUrl: null,
  },
  {
    id: "protocol-designer",
    name: "Protocol Designer",
    description: "Draft and iterate on lab protocols with reagent + step suggestions.",
    sourceUrl: null,
  },
];

export function listFirstPartyCatalog(): FirstPartyCatalogEntry[] {
  return FIRST_PARTY_CATALOG.map(({ id, name, description, sourceUrl }) => ({
    id,
    name,
    description,
    sourceUrl,
  }));
}

export function resolveCatalogSource(catalogId: string): { url: string; ref?: string } | undefined {
  const entry = FIRST_PARTY_CATALOG.find((pkg) => pkg.id === catalogId);
  if (!entry?.sourceUrl) return undefined;
  return { url: entry.sourceUrl };
}
