/**
 * The answer command both clients run: the attempt shows at once, the frame goes out, and the
 * reply settles it. Clients adapt the ports and never re-implement the settlement.
 */
import type { AskAnswer } from "@meridian/contracts/threads";
import type { ThreadTransport } from "../socket/thread-transport";
import { beginAskAnswer, type ChatAsks, dropAskAnswer, failAskAnswer, receiveAsks } from "./asks";

export type AnswerAskPorts = {
  transport: Pick<ThreadTransport, "answerAsk">;
  /** Apply a change to the chat's asks; it runs synchronously against the current value. */
  update(change: (asks: ChatAsks) => ChatAsks): void;
  /** Ask for a fresh read of the chat. */
  refresh(): void;
  newSubmissionId(): string;
};

export type AnswerAskResult = "answered" | "not_open" | "failed";

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
    return "answered";
  }
  if (reply.type === "ask.answer.error" && reply.code === "ask_not_open") {
    // Another tab, the parent or the deadline won. The reply names the resolution when it can;
    // the read confirms it either way.
    const winner = reply.ask;
    ports.update((asks) => (winner ? receiveAsks(asks, [winner]) : dropAskAnswer(asks, askId)));
    ports.refresh();
    return "not_open";
  }
  ports.update((asks) => failAskAnswer(asks, askId, submissionId));
  return "failed";
}
