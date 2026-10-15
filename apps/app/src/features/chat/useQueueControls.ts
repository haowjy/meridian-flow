/**
 * useQueueControls — the queue's x and Cancel queue: take queued messages back into this tab's
 * composer. Both press the chat's hand-back operation (`useHandBack`) with the ids the writer saw
 * drawn as queued, frozen at the press; there is one queue per chat, so any tab's press takes
 * any queued message. A lost race (`answered`, `gone`) shows nothing.
 */
import { t } from "@lingui/core/macro";
import { waitingWriterMessages } from "@meridian/thread-client";
import { useCallback, useRef } from "react";
import { announce, announceError, useRunState } from "@/client/stores";
import type { ChatHandBack } from "./useHandBack";

export type QueueControls = {
  /** The x: move one queued message to the message box. */
  remove: (turnId: string) => void;
  /** Cancel queue: move every queued message, in send order. */
  cancelQueue: () => void;
};

export function useQueueControls(input: { threadId: string; handBack: ChatHandBack }) {
  const { threadId, handBack } = input;
  const { operation, settle } = handBack;
  const view = useRunState(threadId);
  const latest = useRef(view);
  latest.current = view;

  const press = useCallback(
    (ids: readonly string[]) => {
      if (ids.length === 0) return;
      void settle(operation.press({ kind: "queue", ids })).then((outcome) => {
        if (outcome.kind === "confirmed") {
          if (outcome.result.handedBack.length > 0) announce(t`Moved to the message box`);
        } else announceError(t`Couldn't move your queued message to the message box.`);
      });
    },
    [operation, settle],
  );

  const remove = useCallback((turnId: string) => press([turnId]), [press]);
  const cancelQueue = useCallback(
    () => press(waitingWriterMessages(latest.current).map((item) => item.id)),
    [press],
  );
  return { remove, cancelQueue } satisfies QueueControls;
}
