/**
 * useRenameThread — direct TanStack P1 command for the thread title.
 *
 * The request lifecycle runs through `useMutation` (serialized per thread with
 * `scope`); the optimistic projection, revision fence, and classified failure
 * live in `thread-rename-command`'s QueryClient-scoped record. Success is only
 * announced by the caller after the server confirms the write.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";

import { renameThread } from "@/client/api/threads-api";

import { projectQueryKeys } from "./project-query-keys";
import {
  abandonThreadRename,
  beginThreadRename,
  classifyThreadRenameFailure,
  confirmThreadRename,
  readThreadRenameRecord,
  reconcileThreadRename,
  rejectThreadRename,
  type ThreadRenameMutationContext,
  type ThreadRenameRecord,
} from "./thread-rename-command";

export type ThreadRenameView = {
  /** A submitted rename is in flight (projected but not confirmed). */
  pending: boolean;
  /** Set only for a definitive rejection; the title has been reverted. */
  error?: Error;
  /** An unknown outcome is reconciling against the server; the title is retained. */
  reconciling: boolean;
  submit: (title: string) => void;
  retry: () => void;
};

function useThreadRenameRecord(projectId: string, threadId: string): ThreadRenameRecord {
  const client = useQueryClient();
  const { data } = useQuery({
    queryKey: projectQueryKeys.threadRename(projectId, threadId),
    queryFn: () => Promise.resolve(readThreadRenameRecord(client, projectId, threadId)),
    initialData: () => readThreadRenameRecord(client, projectId, threadId),
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return data;
}

export function useRenameThread(
  projectId: string,
  threadId: string,
  onConfirmed?: (title: string) => void,
): ThreadRenameView {
  const client = useQueryClient();
  const confirmedRef = useRef(onConfirmed);
  confirmedRef.current = onConfirmed;

  const mutation = useMutation({
    mutationKey: ["thread-rename", threadId],
    scope: { id: `thread-rename:${threadId}` },
    mutationFn: ({ title }: { title: string }) => renameThread(threadId, { title }),
    onMutate: ({ title }) => beginThreadRename(client, projectId, threadId, title),
    onSuccess: (response, _variables, context: ThreadRenameMutationContext) => {
      if (confirmThreadRename(client, context, response.title)) {
        confirmedRef.current?.(response.title);
      }
    },
    onError: (error, _variables, context?: ThreadRenameMutationContext) => {
      if (!context) return;
      const normalized = error instanceof Error ? error : new Error(String(error));
      switch (classifyThreadRenameFailure(error)) {
        case "rejected":
          rejectThreadRename(client, context, normalized);
          break;
        case "ambiguous":
          reconcileThreadRename(client, context, normalized);
          break;
        default:
          abandonThreadRename(client, context);
      }
    },
  });

  const record = useThreadRenameRecord(projectId, threadId);
  const submit = useCallback(
    (title: string) => {
      const trimmed = title.trim();
      if (trimmed) mutation.mutate({ title: trimmed });
    },
    [mutation],
  );
  const retry = useCallback(() => {
    if (record.desiredTitle) mutation.mutate({ title: record.desiredTitle });
  }, [mutation, record.desiredTitle]);

  return {
    pending: record.pendingCount > 0,
    error: record.failure?.kind === "rejected" ? record.failure.error : undefined,
    reconciling: record.failure?.kind === "ambiguous",
    submit,
    retry,
  };
}
