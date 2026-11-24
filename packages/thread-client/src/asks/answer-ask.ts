import type { AskAnswer } from "@meridian/contracts/threads";
import type { ThreadTransport } from "../socket/thread-transport";
import {
  beginAskAnswer,
  type ChatAsks,
  clearAskAnswer,
  failAskAnswer,
  markAskAnswer,
  receiveAsks,
} from "./asks";

export type AnswerAskPorts = {
  transport: Pick<ThreadTransport, "answerAsk">;
  update(change: (asks: ChatAsks) => ChatAsks): void;
  refresh(): Promise<void>;
  newSubmissionId(): string;
};

export type AnswerAskResult =
  | { kind: "answered" | "not_open" | "failed" }
  | { kind: "invalid_answer"; questionIndex?: number };

export async function answerAsk(
  ports: AnswerAskPorts,
  threadId: string,
  askId: string,
  answer: AskAnswer,
): Promise<AnswerAskResult> {
  let submissionId = "";
  ports.update((asks) => {
    const begun = beginAskAnswer(asks, askId, answer, ports.newSubmissionId);
    submissionId = begun.attempt.submissionId;
    return begun.asks;
  });
  const reply = await ports.transport.answerAsk({ threadId, askId, submissionId, answer });
  if (reply.type === "ask.answer.ok") {
    ports.update((asks) => receiveAsks(asks, [reply.ask]));
    return { kind: "answered" };
  }
  if (reply.type === "ask.answer.error" && reply.code === "ask_not_open") {
    const winner = reply.ask;
    if (winner) {
      ports.update((asks) => receiveAsks(asks, [winner]));
      void ports.refresh().catch(() => undefined);
    } else await settleAsk(ports, askId);
    return { kind: "not_open" };
  }
  if (reply.type === "ask.answer.error" && reply.code === "invalid_answer") {
    ports.update((asks) => clearAskAnswer(asks, askId, submissionId));
    return { kind: "invalid_answer", questionIndex: reply.questionIndex };
  }
  ports.update((asks) => failAskAnswer(asks, askId, submissionId));
  return { kind: "failed" };
}

export async function settleAsk(
  ports: Pick<AnswerAskPorts, "update" | "refresh">,
  askId: string,
): Promise<void> {
  ports.update((asks) => markAskAnswer(asks, askId, "settling"));
  try {
    await ports.refresh();
  } catch {
    // Left for the check below: the attempt is still settling.
  }
  ports.update((asks) =>
    asks.attempts.get(askId)?.state === "settling" ? markAskAnswer(asks, askId, "unsettled") : asks,
  );
}
