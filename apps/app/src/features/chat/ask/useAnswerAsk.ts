/** Binds the shared answer command to this chat's store and the socket. */
import type { AskAnswer } from "@meridian/contracts/threads";
import { answerAsk } from "@meridian/thread-client";
import { useCallback } from "react";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import { useThreadActions } from "@/client/stores";

export function useAnswerAsk(threadId: string): (askId: string, answer: AskAnswer) => void {
  const transport = useThreadTransport();
  const { updateAsks, invalidateThreadSnapshot } = useThreadActions();
  return useCallback(
    (askId, answer) => {
      void answerAsk(
        {
          transport,
          update: (change) => updateAsks(threadId, change),
          refresh: () => invalidateThreadSnapshot(threadId),
          newSubmissionId: () => globalThis.crypto.randomUUID(),
        },
        threadId,
        askId,
        answer,
      );
    },
    [invalidateThreadSnapshot, threadId, transport, updateAsks],
  );
}
