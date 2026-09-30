/**
 * Which context catalogs hold a candidate for a link in one scope.
 *
 * Mirrors the server's wikilink rule in
 * `apps/server/server/domains/context/document-link-resolution.ts`: the project
 * catalog (manuscript, kb, and Unfiled, whatever the Work), the writer's user
 * catalog, and the current Work's catalog, where a null Work means the
 * project's locked No Work row. Change the two together; the local index is
 * only allowed to answer because it holds exactly the server's candidates.
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
   * The Work whose Scratch and Uploads are candidates: the selected Work, or
   * the No Work row. Null while the No Work row is not known yet, which leaves
   * those catalogs unasked and the index incomplete.
   */
  workId: string | null;
};

/** Null without a project: nothing internal can be resolved there. */
export function linkableCatalogScopes({
  projectId,
  workId,
  noWorkId,
}: {
  projectId: string | null;
  workId: string | null;
  noWorkId: string | null;
}): LinkableCatalogScopes | null {
  if (!projectId) return null;
  return { projectId, workId: workId ?? noWorkId };
}
