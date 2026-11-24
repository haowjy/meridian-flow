import { t } from "@lingui/core/macro";
import { waitingWriterMessages } from "@meridian/thread-client";
import { useCallback, useRef } from "react";
import { announce, useRunState, useThreadAsks } from "@/client/stores";
import type { ChatHandBack } from "./useHandBack";

export type QueueControls = {
  remove: (turnId: string) => void;
  cancelQueue: () => void;
};

export function useQueueControls(input: { threadId: string; handBack: ChatHandBack }) {
  const { threadId, handBack } = input;
  const { operation } = handBack;
  const view = useRunState(threadId);
  const asks = useThreadAsks(threadId);
  const latest = useRef({ view, asks });
  latest.current = { view, asks };

  const press = useCallback(
    (ids: readonly string[]) => {
      if (ids.length === 0) return;
      void operation.press({ kind: "queue", ids }).then((outcome) => {
        if (outcome.kind === "confirmed" && outcome.result.handedBack.length > 0)
          announce(t`Moved to the message box`);
      });
    },
    [operation],
  );

  const remove = useCallback((turnId: string) => press([turnId]), [press]);
  const cancelQueue = useCallback(
    () =>
      press(
        waitingWriterMessages(latest.current.view, latest.current.asks.byId.values()).map(
          (item) => item.id,
        ),
      ),
    [press],
  );
  return { remove, cancelQueue } satisfies QueueControls;
}
