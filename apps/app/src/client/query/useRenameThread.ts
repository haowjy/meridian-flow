/**
 * useRenameThread — direct TanStack P1 command for the thread title.
 *
 * The request lifecycle runs through `useMutation` (serialized per thread with
 * `scope`); the optimistic projection, revision fence, and classified failure
 * live in `thread-rename-command`'s QueryClient-scoped record. Success is only
 * announced by the caller after the server confirms the write.
 *
 * The account epoch is stamped onto the mutation context and forwarded to
 * `fetch`, so a result that arrives after an A→B→A replacement cannot confirm,
 * announce, or write into the new account lifetime.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import { renameThread } from "@/client/api/threads-api";
import { useOptionalAccountEpochSignal } from "@/features/project/context/account-feature-context";

import { projectQueryKeys } from "./project-query-keys";
import {
  abandonThreadRename,
  beginThreadRename,
  classifyThreadRenameFailure,
  confirmThreadRename,
  discardThreadRename,
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

type RenameMutationContext = ThreadRenameMutationContext & { accountSignal: AbortSignal | null };

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
  const accountSignal = useOptionalAccountEpochSignal();
  const confirmedRef = useRef(onConfirmed);
  confirmedRef.current = onConfirmed;

  // Account replacement drops the whole record and its optimistic projection.
  useEffect(() => {
    if (!accountSignal) return;
    const onAbort = () => discardThreadRename(client, projectId, threadId);
    accountSignal.addEventListener("abort", onAbort);
    return () => accountSignal.removeEventListener("abort", onAbort);
  }, [accountSignal, client, projectId, threadId]);

  const mutation = useMutation({
    mutationKey: ["thread-rename", threadId],
    scope: { id: `thread-rename:${threadId}` },
    mutationFn: ({ title }: { title: string }) =>
      renameThread(threadId, { title }, { signal: accountSignal ?? undefined }),
    onMutate: ({ title }): RenameMutationContext => ({
      ...beginThreadRename(client, projectId, threadId, title),
      accountSignal,
    }),
    onSuccess: (response, _variables, context: RenameMutationContext) => {
      if (context.accountSignal?.aborted) return;
      if (confirmThreadRename(client, context, response.title)) {
        confirmedRef.current?.(response.title);
      }
    },
    onError: (error, _variables, context?: RenameMutationContext) => {
      if (!context || context.accountSignal?.aborted) return;
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
