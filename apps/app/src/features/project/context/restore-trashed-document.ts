/** The restore command behind Trash's Restore action and a drag out of Trash. */
import type { DocumentTrashEntry, ListDocumentTrashResponse } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { restoreContextDocuments } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import type { RestoreDestination } from "@/client/trash-restore/pending-restores";

export type TrashRestoreOutcome =
  | { kind: "living"; landedAt?: string }
  | { kind: "superseded" | "ancestor_taken" | "refused" | "destination_unavailable" };

/**
 * Restores `entries` in one request, each to its original path or, with a destination, into it.
 * Every entry answers on its own. Living ones leave the Trash list; a superseded one refreshes it.
 */
export async function restoreTrashedDocuments(
  queryClient: QueryClient,
  projectId: string,
  entries: readonly Pick<DocumentTrashEntry, "documentId" | "removal">[],
  destination?: RestoreDestination,
): Promise<Map<string, TrashRestoreOutcome>> {
  const { documents } = await restoreContextDocuments(projectId, {
    documents: entries.map(({ documentId, removal }) => ({ documentId, removal })),
    ...(destination ? { destination } : {}),
  });
  const outcomes = new Map<string, TrashRestoreOutcome>();
  const living: string[] = [];
  for (const result of documents) {
    if (result.outcome === "restored" || result.outcome === "already_living") {
      living.push(result.documentId);
      outcomes.set(result.documentId, {
        kind: "living",
        ...(result.outcome === "restored" && result.landedAt ? { landedAt: result.landedAt } : {}),
      });
    } else outcomes.set(result.documentId, { kind: result.outcome });
  }
  if (living.length > 0) {
    queryClient.setQueryData<ListDocumentTrashResponse>(
      projectQueryKeys.documentTrash(projectId),
      (current) =>
        current
          ? {
              documents: current.documents.filter(({ documentId }) => !living.includes(documentId)),
            }
          : current,
    );
    // Main still shows the record until it opens the document; refetching it now would 404.
    for (const documentId of living)
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.trashedDocument(projectId, documentId),
        exact: true,
        refetchType: "none",
      });
    // An address left on the document while it was trashed answers "unavailable" until re-read.
    void queryClient.invalidateQueries({ queryKey: projectQueryKeys.documentAddresses(projectId) });
  }
  if ([...outcomes.values()].some(({ kind }) => kind === "superseded"))
    await queryClient.invalidateQueries({ queryKey: projectQueryKeys.documentTrash(projectId) });
  return outcomes;
}
