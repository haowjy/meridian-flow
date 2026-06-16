/**
 * Shared agent UX constants — builtin fallback slug and display labels used
 * before the project catalog loads or when the API is unavailable.
 */

/** Synthetic client-only default — no server agent uses this slug; never send it on the wire. */
export const DEFAULT_AGENT_SLUG = "general";

/** Human label when the catalog has not resolved yet. */
export const DEFAULT_AGENT_NAME = "General";

/** Converts UI-only default selections into the API wire value. */
export function wireAgentSlug(slug: string | null | undefined): string | undefined {
  if (!slug || slug === DEFAULT_AGENT_SLUG) return undefined;
  return slug;
}

/** Optional `currentAgent` field for thread-create bodies after {@link wireAgentSlug}. */
export function threadCreateAgentField(
  slug: string | null | undefined,
): { currentAgent: string } | Record<string, never> {
  const wireSlug = wireAgentSlug(slug);
  return wireSlug ? { currentAgent: wireSlug } : {};
}
