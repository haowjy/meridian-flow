/**
 * The answer command both clients run: the attempt shows at once, the frame goes out, and the
 * reply settles it. Clients adapt the ports and never re-implement the settlement.
 */
import type { AskAnswer } from "@meridian/contracts/threads";
import type { ThreadTransport } from "../socket/thread-transport";
import { beginAskAnswer, type ChatAsks, failAskAnswer, markAskAnswer, receiveAsks } from "./asks";

export type AnswerAskPorts = {
  transport: Pick<ThreadTransport, "answerAsk">;
  /** Apply a change to the chat's asks; it runs synchronously against the current value. */
  update(change: (asks: ChatAsks) => ChatAsks): void;
  /** Read the chat again and apply the read; rejects when the read fails. */
  refresh(): Promise<void>;
  newSubmissionId(): string;
};

export type AnswerAskResult =
  | { kind: "answered" | "not_open" | "failed" }
  /** The server refused the answer; `questionIndex` names the question at fault, when one is. */
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
    // Another tab, the parent or the deadline won. The reply names the resolution when it can;
    // otherwise the attempt holds the ask closed here until a read says how it ended.
    const winner = reply.ask;
    if (winner) {
      ports.update((asks) => receiveAsks(asks, [winner]));
      void ports.refresh().catch(() => undefined);
    } else await settleAsk(ports, askId);
    return { kind: "not_open" };
  }
  ports.update((asks) => failAskAnswer(asks, askId, submissionId));
  if (reply.type === "ask.answer.error" && reply.code === "invalid_answer")
    return { kind: "invalid_answer", questionIndex: reply.questionIndex };
  return { kind: "failed" };
}

/**
 * Read the chat until it says how the ask ended. The attempt stays `settling` meanwhile; a failed
 * read, or one that still shows it open, leaves it `unsettled` for the writer to read again.
 */
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
