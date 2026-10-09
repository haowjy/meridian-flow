/**
 * useWorkDrafts — reviewable AI draft list for one Work, and the Work's AI
 * write mode, whose change re-reads those drafts.
 *
 * Projects one catalog-labelled file per active document draft, in stable order.
 */
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import type { UpdateWorkWriteModeRequest } from "@meridian/contracts/protocol";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { listWorkDrafts } from "@/client/api/drafts-api";
import { updateWorkWriteMode } from "@/client/api/projects-api";
import { readDraftsAfterCommands } from "./draft-command-record";
import { type ListQueryStatus, unwrapListQuery } from "./list-query";
import { projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";
import { useContextCatalogView } from "./useContextCatalog";
import { projectWorkDraftFiles, type ReviewFileTarget } from "./work-draft-files";
import { repairWorksSnapshot } from "./works-projection-acquisition";

export type ThreadDraftsStatus = ListQueryStatus<ThreadDraftListItem> & {
  /** Raw query rows for generation evidence and command fences. */
  drafts: ThreadDraftListItem[] | null;
  files: ReviewFileTarget[] | null;
  fileForDocument: (documentId: string | null | undefined) => ReviewFileTarget | null;
};

/** The one Work draft-list query, shared by every reader so the list is fetched once. */
export function workDraftsQueryOptions(projectId: string, workId: string) {
  return {
    queryKey: projectQueryKeys.workDrafts(projectId, workId),
    queryFn: () =>
      readDraftsAfterCommands({ projectId, workId }, () =>
        listWorkDrafts(projectId, workId).then((response) => response.drafts),
      ),
    staleTime: 15_000,
  };
}

export function useWorkDrafts(
  projectId: string | null,
  workId: string | null,
  options?: { enabled?: boolean },
): ThreadDraftsStatus {
  const callerEnabled = options?.enabled ?? true;
  const enabled = callerEnabled && Boolean(projectId) && Boolean(workId);
  const result = unwrapListQuery(
    useQuery({
      ...workDraftsQueryOptions(projectId ?? "", workId ?? ""),
      enabled,
    }),
  );

  const { catalog } = useContextCatalogView(projectId ?? "", "manuscript", {
    enabled: enabled && Boolean(result.data?.length),
    workId: null,
  });
  const files = useMemo(
    () => (enabled && result.data ? projectWorkDraftFiles(result.data, catalog) : null),
    [enabled, result.data, catalog],
  );
  const byDocument = useMemo(() => new Map(files?.map((file) => [file.documentId, file])), [files]);
  const fileForDocument = useCallback(
    (documentId: string | null | undefined) =>
      documentId ? (byDocument.get(documentId) ?? null) : null,
    [byDocument],
  );

  if (!enabled) {
    return {
      ...result,
      data: null,
      status: "disabled",
      drafts: null,
      files: null,
      fileForDocument,
    };
  }

  return {
    ...result,
    drafts: result.data,
    files,
    fileForDocument,
  };
}

export function useUpdateWorkWriteMode(projectId: string, workId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateWorkWriteModeRequest) => {
      if (!workId) throw new Error("Cannot update write mode before a work is loaded");
      return updateWorkWriteMode(projectId, workId, input);
    },
    onSuccess: async (result) => {
      if (!workId) return;
      invalidateWorkPushQueries(queryClient, projectId, workId);
      if (result.status !== "updated") return;
      await repairWorksSnapshot(queryClient, projectId);
    },
  });
}

function invalidateWorkPushQueries(
  queryClient: QueryClient,
  projectId: string,
  workId: string,
): void {
  void queryClient.invalidateQueries({ queryKey: projectQueryKeys.workDrafts(projectId, workId) });
  void queryClient.invalidateQueries({ queryKey: projectQueryKeys.threads(projectId) });
  void queryClient.invalidateQueries({ queryKey: threadQueryKeys.all });
  void queryClient.invalidateQueries({
    queryKey: ["projects", projectId, "works", workId, "documents"],
  });
}
