import type { AskAnswer, DraftAnswers } from "@meridian/contracts/threads";
import {
  type AnswerAskPorts,
  type AnswerAskResult,
  answerAsk,
  settleAsk,
} from "@meridian/thread-client";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { useThreadActions } from "@/client/stores";

export type AskCommands = {
  answer(askId: string, answer: AskAnswer): Promise<AnswerAskResult>;
  settle(askId: string): void;
  presence(askId: string, answers?: DraftAnswers): boolean;
  onConnected(listener: () => void): () => void;
};

export function useAnswerAsk(threadId: string): AskCommands {
  const transport = useThreadTransport();
  const queryClient = useQueryClient();
  const { updateAsks } = useThreadActions();
  return useMemo(() => {
    const ports: AnswerAskPorts = {
      transport,
      update: (change) => updateAsks(threadId, change),
      refresh: () =>
        queryClient.refetchQueries(
          { queryKey: threadQueryKeys.snapshot(threadId), exact: true },
          { throwOnError: true },
        ),
      newSubmissionId: () => globalThis.crypto.randomUUID(),
    };
    return {
      answer: (askId, answer) => answerAsk(ports, threadId, askId, answer),
      settle: (askId) => void settleAsk(ports, askId),
      presence: (askId, answers) => transport.sendAskPresence({ threadId, askId, answers }),
      onConnected: (listener) =>
        transport.onConnectionState((state) => {
          if (state.kind === "connected") listener();
        }),
    };
  }, [queryClient, threadId, transport, updateAsks]);
}
