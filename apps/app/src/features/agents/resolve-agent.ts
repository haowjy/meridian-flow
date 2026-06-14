// @ts-nocheck
/**
 * Catalog resolution helpers — map a thread-bound slug to display fields for
 * chips and pickers. Degrades to the slug when no catalog row exists.
 */
import type { ProjectAgentSummary } from "@meridian/contracts/agents";

import { DEFAULT_AGENT_NAME, DEFAULT_AGENT_SLUG } from "./constants";

export type ResolvedAgentDisplay = {
  slug: string;
  name: string;
  description: string;
  source: ProjectAgentSummary["source"] | null;
  packageName: string | null;
};

export function resolveAgentFromCatalog(
  slug: string,
  agents: ProjectAgentSummary[] | null | undefined,
): ResolvedAgentDisplay {
  const match = agents?.find((agent) => agent.slug === slug);
  if (match) {
    return {
      slug: match.slug,
      name: match.name,
      description: match.description,
      source: match.source,
      packageName: match.packageName,
    };
  }
  if (slug === DEFAULT_AGENT_SLUG) {
    return {
      slug,
      name: DEFAULT_AGENT_NAME,
      description: "",
      source: "builtin",
      packageName: null,
    };
  }
  return {
    slug,
    name: slug,
    description: "",
    source: null,
    packageName: null,
  };
}

export function sourceBadgeLabel(
  source: ResolvedAgentDisplay["source"],
  packageName: string | null,
): string | null {
  if (!source) return null;
  if (source === "builtin") return "Meridian";
  if (source === "package") return packageName ?? null;
  return packageName;
}
