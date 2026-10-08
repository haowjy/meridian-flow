/**
 * One command record per delete, shared by its receipt and tool row. Pending
 * and the current refusal are shared; detail stays on the initiating surface.
 * A new attempt or confirmed restoration retires the previous outcome.
 */
import type { ListTurnLiveLineageResponse } from "@meridian/contracts/protocol";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { type RestoreDeleteOutcome, restoreAgentDelete } from "@/client/api/restore-delete-api";
import { useOptionalAccountEpochSignal } from "@/features/project/context/account-feature-context";
import { threadQueryKeys } from "./thread-query-keys";

export type RestoreDeleteInput = { turnId: string; documentId: string; wId: number };
export type RestoreDeleteFailure = RestoreDeleteOutcome | { status: "request_failed" };
type Surface = "tool" | "receipt";
type RestoreRecord =
  | { phase: "pending" }
  | { phase: "failed"; surface: Surface; outcome: RestoreDeleteFailure };

export function useRestoreDeleteMutation(
  threadId: string,
  input: RestoreDeleteInput | null,
  surface: Surface,
  active: boolean,
) {
  const queryClient = useQueryClient();
  const accountSignal = useOptionalAccountEpochSignal();
  const recordKey = useMemo(
    () => ["restore-delete-command", threadId, input?.turnId, input?.documentId, input?.wId],
    [threadId, input?.turnId, input?.documentId, input?.wId],
  );
  const { data: record } = useQuery<RestoreRecord | null>({
    queryKey: recordKey,
    queryFn: () => queryClient.getQueryData<RestoreRecord>(recordKey) ?? null,
    initialData: null,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const setRecord = (value: RestoreRecord | null) => queryClient.setQueryData(recordKey, value);
  useEffect(() => {
    if (!active && record?.phase === "failed") queryClient.setQueryData(recordKey, null);
  }, [active, record, queryClient, recordKey]);

  const mutation = useMutation<RestoreDeleteOutcome, Error, RestoreDeleteInput>({
    mutationFn: (input) => restoreAgentDelete(threadId, input),
    onSuccess: async (outcome, restored) => {
      if (accountSignal?.aborted) return;
      if (outcome.status !== "restored" && outcome.status !== "already_restored") {
        setRecord({ phase: "failed", surface, outcome });
        return;
      }
      const queryKey = threadQueryKeys.liveLineage(threadId, restored.turnId);
      await queryClient.cancelQueries({ queryKey });
      if (accountSignal?.aborted) return;
      queryClient.setQueryData<ListTurnLiveLineageResponse>(
        queryKey,
        (lineage) =>
          lineage && {
            ...lineage,
            namespaceChanges: lineage.namespaceChanges.map((change) =>
              change.kind === "delete" &&
              change.documentId === restored.documentId &&
              change.wId === restored.wId
                ? { ...change, status: "reversed" }
                : change,
            ),
          },
      );
      setRecord(null);
    },
    onError: () => {
      if (!accountSignal?.aborted)
        setRecord({ phase: "failed", surface, outcome: { status: "request_failed" } });
    },
    onSettled: () => {
      if (!accountSignal?.aborted)
        void queryClient.invalidateQueries({ queryKey: threadQueryKeys.liveLineageRoot(threadId) });
    },
  });
  return {
    isPending: record?.phase === "pending",
    outcome: active && record?.phase === "failed" ? record.outcome : undefined,
    showNote: record?.phase === "failed" && record.surface === surface,
    mutate: () => {
      if (
        !input ||
        accountSignal?.aborted ||
        queryClient.getQueryData<RestoreRecord>(recordKey)?.phase === "pending"
      )
        return;
      scopeRestoreCommands(queryClient, accountSignal);
      setRecord({ phase: "pending" });
      mutation.mutate(input);
    },
  };
}

const accountsSeen = new WeakMap<QueryClient, WeakSet<AbortSignal>>();

/** Command lifetime outlives its surfaces: account cleanup must do so too. */
function scopeRestoreCommands(client: QueryClient, accountSignal: AbortSignal | null): void {
  if (!accountSignal) return;
  let seen = accountsSeen.get(client);
  if (!seen) {
    seen = new WeakSet();
    accountsSeen.set(client, seen);
  }
  if (seen.has(accountSignal)) return;
  seen.add(accountSignal);
  accountSignal.addEventListener(
    "abort",
    () => {
      client.removeQueries({ queryKey: ["restore-delete-command"] });
    },
    { once: true },
  );
}
