/**
 * useRenameThread — direct TanStack P1 command for the thread title.
 *
 * The request lifecycle runs through `useMutation` (serialized per thread with
 * `scope`); the optimistic projection, revision fence, and classified failure
 * live in `thread-rename-command`'s QueryClient-scoped record. The returned
 * `rename` rejects only when the server refused it, so a `TitleEditSlot` can
 * reopen the field. Success is only announced by the caller after the server
 * confirms the write.
 *
 * The account epoch is stamped onto the mutation context and forwarded to
 * `fetch`, so a result that arrives after an A→B→A replacement cannot confirm,
 * announce, or write into the new account lifetime.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import { renameThread } from "@/client/api/threads-api";
import { useOptionalAccountEpochSignal } from "@/features/project/context/account-feature-context";

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
} from "./thread-rename-command";

type RenameMutationContext = ThreadRenameMutationContext & { accountSignal: AbortSignal | null };

export function useRenameThread(
  projectId: string,
  threadId: string,
  onConfirmed?: (title: string) => void,
): (title: string) => Promise<void> {
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

  // Rejects only for a definitive refusal of this intent, after the title has
  // been reverted; an unknown outcome keeps the title and reconciles quietly.
  return useCallback(
    async (title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      try {
        await mutation.mutateAsync({ title: trimmed });
      } catch (error) {
        const failure = readThreadRenameRecord(client, projectId, threadId).failure;
        if (failure?.kind === "rejected" && failure.error === error) throw error;
      }
    },
    [client, mutation.mutateAsync, projectId, threadId],
  );
}
