/**
 * useDraftAttribution: the AI edit parts pending in a draft, for the chat-name hint. One query per draft,
 * refetched when the set of review changes moves (a chat's new write adds a change). A missing or stale
 * answer only drops a chat name.
 */
import type { DraftAttributionEdit } from "@meridian/contracts/drafts";
import { type QueryFunctionContext, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { getDraftAttribution } from "@/client/api/drafts-api";
import { projectQueryKeys } from "./project-query-keys";
import type { DraftMetaRef } from "./useDraftMeta";

const NO_EDITS: readonly DraftAttributionEdit[] = [];

export function draftAttributionQueryOptions(ref: DraftMetaRef) {
  return {
    queryKey: projectQueryKeys.workDraftAttribution(
      ref.projectId,
      ref.workId,
      ref.documentId,
      ref.itemKey,
    ),
    queryFn: ({ signal }: QueryFunctionContext) =>
      getDraftAttribution(ref.projectId, ref.workId, ref.documentId, ref.itemKey, signal),
    staleTime: 15_000,
  };
}

export function useDraftAttribution(
  draft: DraftMetaRef | null,
  { enabled, revision }: { enabled: boolean; revision: string },
): readonly DraftAttributionEdit[] {
  const ref = draft ?? { projectId: "", workId: "", documentId: "", itemKey: "" };
  const active = enabled && draft !== null;
  const { data, refetch } = useQuery({ ...draftAttributionQueryOptions(ref), enabled: active });
  const seen = useRef(revision);
  useEffect(() => {
    if (seen.current === revision) return;
    seen.current = revision;
    if (active) void refetch();
  }, [revision, active, refetch]);
  return data?.edits ?? NO_EDITS;
}
