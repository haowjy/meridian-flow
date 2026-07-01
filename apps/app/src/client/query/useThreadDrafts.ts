/**
 * useThreadDrafts — reviewable AI draft list for one thread.
 *
 * Keeps the UI stack-ready by exposing drafts grouped by document even though
 * the backend currently returns at most one active draft per document.
 */
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { listThreadDrafts } from "@/client/api/drafts-api";
import { useIsThreadPendingCreation } from "@/client/stores";

import { type ListQueryStatus, unwrapListQuery } from "./list-query";
import { threadQueryKeys } from "./thread-query-keys";

export type ThreadDraftGroup = {
  documentId: string;
  documentName: string | null;
  drafts: ThreadDraftListItem[];
};

export function groupDraftsByDocument(drafts: ThreadDraftListItem[]): ThreadDraftGroup[] {
  const groups = new Map<string, ThreadDraftListItem[]>();
  for (const draft of drafts) {
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
    // Active drafts first so group.drafts[0] always picks the actionable
    // draft over terminal (applied/discarded) ones still within the
    // retention window.
    drafts: groupDrafts.sort((a, b) => {
      if (a.status === "active" && b.status !== "active") return -1;
      if (a.status !== "active" && b.status === "active") return 1;
      return 0;
    }),
  }));
}

export type ThreadDraftsStatus = ListQueryStatus<ThreadDraftListItem> & {
  drafts: ThreadDraftListItem[] | null;
  groups: ThreadDraftGroup[] | null;
};

export function useThreadDrafts(
  threadId: string | null,
  options?: { enabled?: boolean },
): ThreadDraftsStatus {
  const callerEnabled = options?.enabled ?? true;
  const isPendingCreation = useIsThreadPendingCreation(threadId);
  const enabled = callerEnabled && Boolean(threadId) && !isPendingCreation;
  const result = unwrapListQuery(
    useQuery({
      queryKey: threadQueryKeys.drafts(threadId ?? ""),
      queryFn: async () => {
        const response = await listThreadDrafts(threadId as string);
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
