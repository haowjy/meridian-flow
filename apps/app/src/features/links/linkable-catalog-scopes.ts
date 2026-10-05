/**
 * Which context catalogs the scope's document index walks.
 *
 * The project catalog (manuscript, kb, and Unfiled, whatever the Work), the
 * writer's user catalog, and the current Work's catalog, where a null Work
 * means the project's locked No Work row. These are the catalogs a contextual
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
   * The Work whose Scratch and Uploads the index holds: the selected Work, or
   * the No Work row. Null while the No Work row is not known yet, which leaves
   * those catalogs unasked and the index incomplete.
   */
  workId: string | null;
};

/** Null without a project: nothing internal can be resolved there. */
export function linkableCatalogScopes({
  projectId,
  workId,
}: {
  projectId: string | null;
  workId: string | null;
}): LinkableCatalogScopes | null {
  if (!projectId || !workId) return null;
  return { projectId, workId };
}
