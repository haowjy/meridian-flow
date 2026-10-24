/** Shared restore command for the Trash list and read-only Trash view. */
import { t } from "@lingui/core/macro";
import type { DocumentTrashEntry, ListDocumentTrashResponse } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { restoreContextDocuments } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { announce } from "@/client/stores";

export type TrashRestoreOutcome =
  | { kind: "living"; landedAt?: string }
  | { kind: "superseded" | "ancestor_taken" | "refused" };

export async function restoreTrashedDocument(
  queryClient: QueryClient,
  projectId: string,
  entry: Pick<DocumentTrashEntry, "documentId" | "removal">,
): Promise<TrashRestoreOutcome> {
  const { documents } = await restoreContextDocuments(projectId, {
    documents: [{ documentId: entry.documentId, removal: entry.removal }],
  });
  const result = documents[0];
  if (!result) throw new Error("Restore returned no result");
  if (result.outcome === "restored" || result.outcome === "already_living") {
    queryClient.setQueryData<ListDocumentTrashResponse>(
      projectQueryKeys.documentTrash(projectId),
      (current) =>
        current
          ? {
              documents: current.documents.filter(
                ({ documentId }) => documentId !== entry.documentId,
              ),
            }
          : current,
    );
    queryClient.removeQueries({
      queryKey: projectQueryKeys.trashedDocument(projectId, entry.documentId),
      exact: true,
    });
    if (result.outcome === "restored" && result.landedAt)
      announce(t`Restored at ${result.landedAt}.`);
    return {
      kind: "living",
      ...(result.outcome === "restored" && result.landedAt ? { landedAt: result.landedAt } : {}),
    };
  }
  if (result.outcome === "superseded") {
    await queryClient.invalidateQueries({ queryKey: projectQueryKeys.documentTrash(projectId) });
    return { kind: "superseded" };
  }
  return { kind: result.outcome };
}
