/** React visibility lease adapter for semantic open acknowledgements. */
import type { ThreadSnapshotResponse } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useThreadActions } from "@/client/stores";
import { threadQueryKeys } from "./thread-query-keys";
import {
  claimVisibleOpenAcknowledgement,
  createVisibilityLeaseId,
  getOpenAcknowledgementState,
  type OpenAcknowledgementOperationId,
  type OpenAcknowledgementTransfer,
  releaseVisibleOpenAcknowledgement,
  retryOpenAcknowledgement,
  subscribeOpenAcknowledgement,
} from "./visible-thread-open-acknowledgements";

export function useThreadOpenAcknowledgement({
  threadId,
  projectId,
  visible,
  transfer,
  onTransferClaimed,
}: {
  threadId: string;
  projectId: string | null;
  visible: boolean;
  transfer?: OpenAcknowledgementTransfer;
  onTransferClaimed?: (transfer: OpenAcknowledgementTransfer) => void;
}) {
  const client = useQueryClient();
  const actions = useThreadActions();
  const [leaseId] = useState(createVisibilityLeaseId);
  const [operationId, setOperationId] = useState<OpenAcknowledgementOperationId | null>(null);

  useEffect(() => {
    if (!projectId || !visible) {
      releaseVisibleOpenAcknowledgement(client, leaseId);
      setOperationId(null);
      return;
    }
    const matchingTransfer =
      transfer?.key.projectId === projectId && transfer.key.threadId === threadId
        ? transfer
        : undefined;
    const claimed = claimVisibleOpenAcknowledgement(
      client,
      { projectId, threadId },
      leaseId,
      matchingTransfer,
    );
    setOperationId(claimed);
    if (matchingTransfer && claimed === matchingTransfer.id) onTransferClaimed?.(matchingTransfer);
    return () => releaseVisibleOpenAcknowledgement(client, leaseId);
  }, [client, leaseId, onTransferClaimed, projectId, threadId, transfer, visible]);

  const state = useSyncExternalStore(
    useCallback(
      (listener) =>
        operationId ? subscribeOpenAcknowledgement(client, operationId, listener) : () => undefined,
      [client, operationId],
    ),
    useCallback(
      () => (operationId ? getOpenAcknowledgementState(client, operationId) : null),
      [client, operationId],
    ),
    () => null,
  );
  const appliedSuccess = useRef<OpenAcknowledgementOperationId | null>(null);
  useEffect(() => {
    if (state?.phase !== "succeeded" || appliedSuccess.current === state.id) return;
    appliedSuccess.current = state.id;
    actions.setThreadAttention(threadId, state.response.attention);
    client.setQueryData<ThreadSnapshotResponse>(threadQueryKeys.snapshot(threadId), (snapshot) =>
      snapshot ? { ...snapshot, attention: state.response.attention } : snapshot,
    );
  }, [actions, client, state, threadId]);

  const retry = useCallback(() => {
    if (operationId) retryOpenAcknowledgement(client, operationId);
  }, [client, operationId]);

  return {
    error: visible && state?.phase === "failed" ? state.error : null,
    pending: visible && state?.phase === "pending",
    retry,
  };
}
