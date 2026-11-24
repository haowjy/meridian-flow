import { t } from "@lingui/core/macro";
import { type StopStatus, stopStatus } from "@meridian/thread-client";
import { useCallback, useLayoutEffect, useRef } from "react";
import { announce, useRunState } from "@/client/stores";
import type { ChatHandBack } from "./useHandBack";

export type ChatStop = {
  status: StopStatus;
  stop: () => void;
};

export function useChatStop(input: { threadId: string; handBack: ChatHandBack }): ChatStop {
  const { threadId, handBack } = input;
  const { operation, stopFacts } = handBack;
  const view = useRunState(threadId);
  const latest = useRef(view);

  const status = stopStatus(view, stopFacts);
  const pressed = useRef(status);
  useLayoutEffect(() => {
    latest.current = view;
    pressed.current = status;
  }, [status, view]);

  const stop = useCallback(() => {
    if (pressed.current === "pending" || pressed.current === "stopping") return;
    announce(t`Stopping`);
    void operation.press({ kind: "stop", view: latest.current });
  }, [operation]);

  return { status, stop };
}
