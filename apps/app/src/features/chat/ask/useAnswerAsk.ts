/** Binds the shared answer and settle commands to this chat's store, its snapshot read and the socket. */
import type { AskAnswer } from "@meridian/contracts/threads";
import { type AnswerAskPorts, answerAsk, settleAsk } from "@meridian/thread-client";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { useThreadActions } from "@/client/stores";

export type AskCommands = {
  answer(askId: string, answer: AskAnswer): void;
  /** Read the chat again after an answer could not learn how the ask ended. */
  settle(askId: string): void;
};

export function useAnswerAsk(threadId: string): AskCommands {
  const transport = useThreadTransport();
  const queryClient = useQueryClient();
  const { updateAsks } = useThreadActions();
  return useMemo(() => {
    const ports: AnswerAskPorts = {
      transport,
      update: (change) => updateAsks(threadId, change),
      // The snapshot query's read applies through the chat's sync before this resolves.
      refresh: () =>
        queryClient.refetchQueries(
          { queryKey: threadQueryKeys.snapshot(threadId), exact: true },
          { throwOnError: true },
        ),
      newSubmissionId: () => globalThis.crypto.randomUUID(),
    };
    return {
      answer: (askId, answer) => void answerAsk(ports, threadId, askId, answer),
      settle: (askId) => void settleAsk(ports, askId),
    };
  }, [queryClient, threadId, transport, updateAsks]);
}
