import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { useOptionalAccountEpochSignal } from "@/client/account/account-context";
import { renameThread } from "@/client/api/threads-api";

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
