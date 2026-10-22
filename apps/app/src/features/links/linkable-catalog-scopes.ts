/**
 * Which context catalogs the scope's document index walks.
 *
 * The project catalog (manuscript, kb, and Unfiled, whatever the Work), the
 * writer's user catalog, the scope Work's Scratch by row id (including No
 * Work), a No Work chat's lineage Scratch, and the chat's uploads. Unresolved surfaces have no
 * scope. These are the catalogs a contextual
 * address resolves in on the server, so the local index can answer any
 * address they hold.
 */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { aggregateCatalogScope } from "@/client/query/useContextCatalog";

export const LINKABLE_SCHEMES = [
  "manuscript",
  "kb",
  "unfiled",
  "user",
  "scratch",
  "uploads",
] as const satisfies readonly ProjectContextTreeScheme[];

export type LinkableCatalogScopes = {
  projectId: string;
  /**
   * The row whose Scratch the index holds, including No Work.
   * The resolver returns no scope until the surface's Work is known.
   */
  workId: string | null;
  /**
   * The lineage whose Scratch a bare `scratch://` means: a No Work chat's, or
   * a note in a lineage. Its Scratch replaces the Work's.
   */
  rootThreadId: string | null;
  /** The chat whose uploads the index holds: a subagent's top chat. Null outside a chat. */
  chatId: string | null;
};

/** Null without a project: nothing internal can be resolved there. */
export function linkableCatalogScopes({
  projectId,
  workId,
  rootThreadId,
  chatId,
}: {
  projectId: string | null;
  workId: string | null;
  rootThreadId?: string | null;
  chatId?: string | null;
}): LinkableCatalogScopes | null {
  if (!projectId || !workId) return null;
  return { projectId, workId, rootThreadId: rootThreadId ?? null, chatId: chatId ?? null };
}

/**
 * The linkable schemes this surface owns a catalog for. An unowned one (uploads
 * outside a chat) is absent, so it cannot hold the index's completeness hostage.
 */
export function ownedLinkableSchemes(scopes: LinkableCatalogScopes | null) {
  if (!scopes) return [];
  return LINKABLE_SCHEMES.filter((scheme) =>
    aggregateCatalogScope(scopes.projectId, scheme, scopes),
  );
}
