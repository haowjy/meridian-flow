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
  type OpenAcknowledgementKey,
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
  const [binding, setBinding] = useState<{
    operationId: OpenAcknowledgementOperationId;
    key: OpenAcknowledgementKey;
  } | null>(null);

  useEffect(() => {
    if (!projectId || !visible) {
      releaseVisibleOpenAcknowledgement(client, leaseId);
      setBinding(null);
      return;
    }
    const key = { projectId, threadId };
    const claimed = claimVisibleOpenAcknowledgement(client, key, leaseId, transfer);
    setBinding((current) =>
      current?.operationId === claimed &&
      current.key.projectId === key.projectId &&
      current.key.threadId === key.threadId
        ? current
        : { operationId: claimed, key },
    );
    if (transfer && claimed === transfer.id) onTransferClaimed?.(transfer);
    return () => releaseVisibleOpenAcknowledgement(client, leaseId);
  }, [client, leaseId, onTransferClaimed, projectId, threadId, transfer, visible]);

  const operationId =
    visible &&
    projectId &&
    binding?.key.projectId === projectId &&
    binding.key.threadId === threadId
      ? binding.operationId
      : null;

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
    if (!operationId || state?.phase !== "succeeded" || appliedSuccess.current === state.id) return;
    appliedSuccess.current = state.id;
    actions.setThreadAttention(threadId, state.response.attention);
    client.setQueryData<ThreadSnapshotResponse>(threadQueryKeys.snapshot(threadId), (snapshot) =>
      snapshot ? { ...snapshot, attention: state.response.attention } : snapshot,
    );
  }, [actions, client, operationId, state, threadId]);

  const retry = useCallback(() => {
    if (operationId) retryOpenAcknowledgement(client, operationId);
  }, [client, operationId]);

  return {
    error: state?.phase === "failed" ? state.error : null,
    pending: state?.phase === "pending",
    retry,
  };
}
