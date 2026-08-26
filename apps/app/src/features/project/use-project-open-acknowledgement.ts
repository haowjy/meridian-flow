/** ProjectView ownership of Home-to-visible-Chat acknowledgement transfers. */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelOpenAcknowledgementTransfer,
  type OpenAcknowledgementTransfer,
  prepareHomeOpenAcknowledgement,
} from "@/client/query/visible-thread-open-acknowledgements";
import type { ScreenKey } from "./shell/screens";

export function useProjectOpenAcknowledgement({
  projectId,
  activeScreen,
  activeThreadId,
  onSelectThread,
}: {
  projectId: string;
  activeScreen: ScreenKey;
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [pendingOpen, setPendingOpen] = useState<{
    transfer: OpenAcknowledgementTransfer;
    navigationSettled: boolean;
  } | null>(null);
  const pendingOpenRef = useRef(pendingOpen);
  pendingOpenRef.current = pendingOpen;

  const cancelPendingOpen = useCallback(
    (transfer: OpenAcknowledgementTransfer) => {
      cancelOpenAcknowledgementTransfer(queryClient, transfer);
      if (pendingOpenRef.current?.transfer === transfer) pendingOpenRef.current = null;
      setPendingOpen((current) => (current?.transfer === transfer ? null : current));
    },
    [queryClient],
  );

  const onOpenThread = useCallback(
    (threadId: string) => {
      const previous = pendingOpenRef.current;
      if (previous) cancelPendingOpen(previous.transfer);
      const offer = prepareHomeOpenAcknowledgement(queryClient, { projectId, threadId });
      if (offer.kind === "transfer") {
        const pending = { transfer: offer.transfer, navigationSettled: false };
        pendingOpenRef.current = pending;
        setPendingOpen(pending);
      }
      void onSelectThread(threadId).then(
        () => {
          if (offer.kind !== "transfer") return;
          setPendingOpen((current) => {
            if (current?.transfer !== offer.transfer) return current;
            const settled = { transfer: offer.transfer, navigationSettled: true };
            pendingOpenRef.current = settled;
            return settled;
          });
        },
        () => {
          if (offer.kind === "transfer") cancelPendingOpen(offer.transfer);
        },
      );
    },
    [cancelPendingOpen, onSelectThread, projectId, queryClient],
  );

  const onOpenTransferClaimed = useCallback((transfer: OpenAcknowledgementTransfer) => {
    if (pendingOpenRef.current?.transfer === transfer) pendingOpenRef.current = null;
    setPendingOpen((current) => (current?.transfer === transfer ? null : current));
  }, []);

  useEffect(() => {
    if (!pendingOpen?.navigationSettled) return;
    const { transfer } = pendingOpen;
    if (
      transfer.key.projectId !== projectId ||
      transfer.key.threadId !== activeThreadId ||
      activeScreen !== "chat"
    ) {
      cancelPendingOpen(transfer);
    }
  }, [activeScreen, activeThreadId, cancelPendingOpen, pendingOpen, projectId]);

  useEffect(
    () => () => {
      const current = pendingOpenRef.current;
      if (current) cancelOpenAcknowledgementTransfer(queryClient, current.transfer);
    },
    [queryClient],
  );

  return {
    onOpenThread,
    openTransfer:
      pendingOpen?.transfer.key.projectId === projectId &&
      pendingOpen.transfer.key.threadId === activeThreadId
        ? pendingOpen.transfer
        : undefined,
    onOpenTransferClaimed,
  };
}
