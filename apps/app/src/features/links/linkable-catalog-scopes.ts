/**
 * Which context catalogs the scope's document index walks.
 *
 * The project catalog (manuscript, kb, and Unfiled, whatever the Work), the
 * writer's user catalog, the scope Work's catalog by row id (including No
 * Work), and a No Work chat's lineage Scratch. Unresolved surfaces have no
 * scope. These are the catalogs a contextual
 * address resolves in on the server
 * (`apps/server/server/domains/context/document-link-resolution.ts`), so the
 * local index can answer any address they hold.
 */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";

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
   * The row whose Scratch and Uploads the index holds, including No Work.
   * The resolver returns no scope until the surface's Work is known.
   */
  workId: string | null;
  /**
   * The lineage whose Scratch a bare `scratch://` means: a No Work chat's, or
   * a note in a lineage. Its Scratch replaces the Work's; Uploads stay the row's.
   */
  rootThreadId: string | null;
};

/** Null without a project: nothing internal can be resolved there. */
export function linkableCatalogScopes({
  projectId,
  workId,
  rootThreadId,
}: {
  projectId: string | null;
  workId: string | null;
  rootThreadId?: string | null;
}): LinkableCatalogScopes | null {
  if (!projectId || !workId) return null;
  return { projectId, workId, rootThreadId: rootThreadId ?? null };
}
