// @ts-nocheck
/**
 * Shared agent UX constants — builtin fallback slug and display labels used
 * before the project catalog loads or when the API is unavailable.
 */

/** Builtin fallback agent slug (matches seeded `general` in package store). */
export const DEFAULT_AGENT_SLUG = "general";

/** Human label when the catalog has not resolved yet. */
export const DEFAULT_AGENT_NAME = "General";

/** Converts UI-only default selections into the API wire value. */
export function wireAgentSlug(slug: string | null | undefined): string | undefined {
  if (!slug || slug === DEFAULT_AGENT_SLUG) return undefined;
  return slug;
}
