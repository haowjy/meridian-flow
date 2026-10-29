/** Durable ask serialization and model-result rendering. */

import type {
  JsonObject,
  QuestionAskPayload,
  ResolvedQuestionAnswer,
  ThreadAsk,
} from "@meridian/contracts/threads";
import type { StoredAsk } from "../ports/ask-repository.js";

export function threadAsk(ask: StoredAsk): ThreadAsk {
  return {
    id: ask.id,
    threadId: ask.threadId,
    turnId: ask.askingTurnId,
    toolCallId: ask.toolCallId,
    kind: ask.kind,
    payload: ask.payload,
    deadlineAt: ask.deadlineAt?.toISOString() ?? null,
    draftAnswers: ask.draftAnswers,
    status: ask.status,
    resolution: ask.resolution,
    createdAt: ask.createdAt.toISOString(),
    resolvedAt: ask.resolvedAt?.toISOString() ?? null,
  } as ThreadAsk;
}

/** One entry per question, in order, with the question's text so the model needn't line answers up by position. */
function questionResult(question: string, answer: ResolvedQuestionAnswer): JsonObject {
  switch (answer.kind) {
    case "option":
      return { question, answer: answer.label };
    case "text":
      return { question, answer: answer.text, free_text: true };
    case "skipped":
      return { question, answer: null, skipped: true };
    case "timeout":
      return { question, answer: answer.label, timed_out: true };
  }
}

export function askToolResult(ask: Pick<StoredAsk, "payload" | "resolution">): JsonObject {
  const resolution = ask.resolution;
  if (!resolution) throw new Error("Resolved ask has no resolution");
  switch (resolution.kind) {
    case "answers":
    case "timeout": {
      const { questions } = ask.payload as QuestionAskPayload;
      return {
        answers: resolution.answers.map((answer, index) =>
          questionResult((questions[index] as { question: string }).question, answer),
        ),
      };
    }
    case "cancelled":
      return { cancelled: true };
    case "allow":
    case "allow_always":
    case "deny":
      throw new Error("Permission ask results are owned by the permission lifecycle");
  }
}
