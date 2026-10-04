/**
 * useWorkDrafts — reviewable AI draft list for one Work, and the Work's AI
 * write mode, whose change re-reads those drafts.
 *
 * Groups the active list by document because review launchers and navigation
 * operate at document scope.
 */
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import type { UpdateWorkWriteModeRequest } from "@meridian/contracts/protocol";
import type { Work } from "@meridian/contracts/works";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { listWorkDrafts } from "@/client/api/drafts-api";
import { updateWorkWriteMode } from "@/client/api/projects-api";
import { type ListQueryStatus, unwrapListQuery } from "./list-query";
import { projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";
import { repairWorksSnapshot } from "./works-projection-acquisition";

export type ThreadDraftGroup = {
  documentId: string;
  documentName: string | null;
  contextPath: string | null;
  drafts: ThreadDraftListItem[];
};

/** The newest active draft with reviewable content for one document. */
export function pendingReviewDraft(
  group: ThreadDraftGroup | null | undefined,
): ThreadDraftListItem | null {
  return pendingReviewDrafts(group)[0] ?? null;
}

/** Active drafts with reviewable content, newest first. */
export function pendingReviewDrafts(
  group: ThreadDraftGroup | null | undefined,
): ThreadDraftListItem[] {
  if (!group) return [];
  return group.drafts
    .filter((draft) => draft.status === "active" && draftHasReviewContent(draft))
    .sort((left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0));
}

/** Document groups that still carry an active, reviewable draft. */
export function activeWorkDraftGroups(
  groups: ThreadDraftGroup[] | null | undefined,
): ThreadDraftGroup[] {
  if (!groups?.length) return [];
  return groups
    .flatMap((group) => {
      const drafts = pendingReviewDrafts(group);
      return drafts.length > 0 ? [{ ...group, drafts }] : [];
    })
    .sort((left, right) => newestUpdatedAt(right) - newestUpdatedAt(left));
}

function newestUpdatedAt(group: ThreadDraftGroup): number {
  return Math.max(...group.drafts.map((draft) => Date.parse(draft.updatedAt) || 0));
}

function draftHasReviewContent(draft: ThreadDraftListItem): boolean {
  const hasKnownOperationCount = typeof draft.proposedOperationCount === "number";
  const hasKnownWordDelta =
    typeof draft.wordsAdded === "number" || typeof draft.wordsRemoved === "number";
  if (!hasKnownOperationCount && !hasKnownWordDelta) return true;
  return (
    (draft.proposedOperationCount ?? 0) > 0 ||
    (draft.wordsAdded ?? 0) > 0 ||
    (draft.wordsRemoved ?? 0) > 0
  );
}

export function groupDraftsByDocument(drafts: ThreadDraftListItem[]): ThreadDraftGroup[] {
  const groups = new Map<string, ThreadDraftListItem[]>();
  const seenDraftIds = new Set<string>();
  for (const draft of drafts) {
    if (seenDraftIds.has(draft.draftId)) continue;
    seenDraftIds.add(draft.draftId);
    const group = groups.get(draft.documentId);
    if (group) {
      group.push(draft);
    } else {
      groups.set(draft.documentId, [draft]);
    }
  }

  return Array.from(groups, ([documentId, groupDrafts]) => ({
    documentId,
    documentName: groupDrafts[0]?.documentName ?? null,
    contextPath: groupDrafts[0]?.contextPath ?? null,
    drafts: groupDrafts.sort(
      (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
    ),
  }));
}

export type ThreadDraftsStatus = ListQueryStatus<ThreadDraftListItem> & {
  drafts: ThreadDraftListItem[] | null;
  groups: ThreadDraftGroup[] | null;
};

export function useWorkDrafts(
  projectId: string | null,
  workId: string | null,
  options?: { enabled?: boolean },
): ThreadDraftsStatus {
  const callerEnabled = options?.enabled ?? true;
  const enabled = callerEnabled && Boolean(projectId) && Boolean(workId);
  const result = unwrapListQuery(
    useQuery({
      queryKey: projectQueryKeys.workDrafts(projectId ?? "", workId ?? ""),
      queryFn: async () => {
        const response = await listWorkDrafts(projectId as string, workId as string);
        return response.drafts;
      },
      staleTime: 15_000,
      enabled,
    }),
  );

  // Memoize on the query data identity so downstream consumers (chat
  // anchoring, memoized turn rows) only see a new groups array when the
  // underlying drafts list actually changes — otherwise the grouping would
  // allocate a fresh array on every render and bust memoization for every
  // streaming tick.
  const groups = useMemo(
    () => (result.data ? groupDraftsByDocument(result.data) : null),
    [result.data],
  );

  if (!enabled) {
    return {
      ...result,
      data: null,
      status: "disabled",
      drafts: null,
      groups: null,
    };
  }

  return {
    ...result,
    drafts: result.data,
    groups,
  };
}

export type UpdateWorkWriteModeMutationInput = Work["aiWriteMode"] | UpdateWorkWriteModeRequest;

export function useUpdateWorkWriteMode(projectId: string, workId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateWorkWriteModeMutationInput) => {
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
