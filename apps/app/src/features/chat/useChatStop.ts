/**
 * useChatStop — the composer's Stop: cancel the running reply and take every waiting writer
 * message back into this tab's composer. The hand-back operation (`useHandBack`) owns the
 * lifecycle and the Stop facts (a request in flight, one still owed, the execution an answer
 * cancelled) on every route into it, the card's Try again and a reload's resume included;
 * `handBackCards` decides its failure card. This hook folds those facts with the held record
 * (`stopStatus`) and presses the operation, which replays a Stop that is still owed. Other tabs
 * see the record, never Stopping.
 */
import { t } from "@lingui/core/macro";
import { type StopStatus, stopStatus } from "@meridian/thread-client";
import { useCallback, useRef } from "react";
import { announce, announceError, useRunState } from "@/client/stores";
import type { ChatHandBack } from "./useHandBack";

export type ChatStop = {
  status: StopStatus;
  /** Press Stop. While pending or stopping it does nothing; after a failure it replays. */
  stop: () => void;
};

export function useChatStop(input: { threadId: string; handBack: ChatHandBack }): ChatStop {
  const { threadId, handBack } = input;
  const { operation, stopFacts } = handBack;
  const view = useRunState(threadId);
  const latest = useRef(view);
  latest.current = view;

  const status = stopStatus(view, stopFacts);
  const pressed = useRef(status);
  pressed.current = status;

  const stop = useCallback(() => {
    // Ignored while Stopping: the request is out, or the cancel is landing.
    if (pressed.current === "pending" || pressed.current === "stopping") return;
    announce(t`Stopping`);
    void operation.press({ kind: "stop", view: latest.current }).then((outcome) => {
      if (outcome.kind !== "confirmed") announceError(t`Couldn't stop the reply.`);
    });
  }, [operation]);

  return { status, stop };
}
