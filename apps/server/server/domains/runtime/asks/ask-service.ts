/** Durable question resolution: one conditional claim, transcript result, and continuation. */

import type { ThreadId } from "@meridian/contracts/runtime";
import type {
  AskAnswer,
  AskResolution,
  QuestionAskPayload,
  ThreadAsk,
} from "@meridian/contracts/threads";
import { testHook } from "../../../shared/test-hooks.js";
import { askToolResult, threadAsk } from "../../threads/domain/ask.js";
import type { LiveEventWriter, ThreadRepositories } from "../../threads/index.js";
import { contentForBlockInput } from "../loop/block-helpers.js";
import { persistAndAppendEvents } from "../loop/persistence.js";
import type { DeliveryProducer } from "../loop/runtime-delivery.js";

export type AskAnswerResult =
  | { ok: true; ask: ThreadAsk }
  | { ok: false; code: "ask_not_open" | "invalid_answer"; ask?: ThreadAsk };

export interface AskService {
  answer(input: {
    userId: string;
    threadId: ThreadId;
    askId: string;
    submissionId: string;
    answer: AskAnswer;
  }): Promise<AskAnswerResult>;
  expireDue(now?: Date, limit?: number): Promise<number>;
  cancelOpen(threadId: ThreadId, askId: string): Promise<AskAnswerResult>;
}

function questionResolution(
  payload: Extract<ThreadAsk, { kind: "question" }>["payload"],
  answer: AskAnswer,
): AskResolution | null {
  if (answer.kind === "option")
    return payload.options.some((option) => option.label === answer.label)
      ? { kind: "option", label: answer.label }
      : null;
  if (answer.kind === "text")
    return answer.text.trim() ? { kind: "text", text: answer.text } : null;
  if (answer.kind === "skip") return { kind: "skipped" };
  return null;
}

export function createAskService(deps: {
  repos: ThreadRepositories;
  eventWriter: LiveEventWriter;
  delivery: Pick<DeliveryProducer, "withThreadLock">;
}): AskService {
  async function resolve(input: {
    askId: string;
    threadId: ThreadId;
    status: "answered" | "expired" | "cancelled";
    resolution: AskResolution;
    submissionId?: string;
    continueRun: boolean;
  }): Promise<AskAnswerResult> {
    return deps.repos.transaction(async () => {
      const existing = await deps.repos.asks.findById(input.askId);
      if (!existing || existing.threadId !== input.threadId)
        return { ok: false, code: "ask_not_open" };
      if (
        input.submissionId &&
        existing.submissionId === input.submissionId &&
        existing.status !== "open"
      )
        return { ok: true, ask: threadAsk(existing) };

      const claimed = await deps.repos.asks.resolveOpen({
        id: input.askId,
        status: input.status,
        resolution: input.resolution,
        submissionId: input.submissionId,
        resolvedAt: new Date(),
      });
      if (!claimed) {
        const current = await deps.repos.asks.findById(input.askId);
        if (
          input.submissionId &&
          current?.submissionId === input.submissionId &&
          current.status !== "open"
        )
          return { ok: true, ask: threadAsk(current) };
        return {
          ok: false,
          code: "ask_not_open",
          ...(current ? { ask: threadAsk(current) } : {}),
        };
      }
      // Claim the ask row before taking the thread lock: every resolver uses
      // this order, so answer, expiry, and cancellation cannot deadlock.
      return deps.delivery.withThreadLock(input.threadId, async (producer) => {
        const turn = await deps.repos.turns.findById(claimed.askingTurnId);
        if (!turn || turn.threadId !== input.threadId || turn.status !== "awaiting_answer")
          throw new Error("Open ask is not attached to an awaiting turn");
        const blocks = await deps.repos.blocks.listByTurn(turn.id);
        const result = askToolResult(claimed);
        const block = contentForBlockInput({
          turnId: turn.id,
          blockType: "tool_result",
          sequence: Math.max(-1, ...blocks.map((candidate) => candidate.sequence)) + 1,
          content: {
            toolCallId: claimed.toolCallId,
            output: result,
            result,
            isError: false,
          },
          status: "complete",
        });
        const completed = {
          ...turn,
          status: input.continueRun ? ("complete" as const) : ("cancelled" as const),
          completedAt: new Date().toISOString(),
        };
        await persistAndAppendEvents(deps, input.threadId, async () => ({
          result: undefined,
          events: [
            { type: "block.upserted" as const, block },
            {
              type: "tool.result" as const,
              toolCallId: claimed.toolCallId,
              output: result,
              result,
              isError: false,
            },
            input.continueRun
              ? { type: "turn.completed" as const, turn: completed }
              : { type: "turn.cancelled" as const, turn: completed },
            { type: "ask.updated" as const, ask: threadAsk(claimed) },
          ],
        }));
        if (input.continueRun)
          await producer.enqueue({
            threadId: input.threadId,
            intent: "control",
            provenance: { kind: "system", source: "ask" },
            body: { kind: "ask_resolved", askId: claimed.id },
            idempotencyKey: `ask-resolved:${claimed.id}`,
          });
        return { ok: true, ask: threadAsk(claimed) };
      });
    });
  }

  return {
    async answer(input) {
      const thread = await deps.repos.threads.findById(input.threadId);
      if (!thread || thread.userId !== input.userId) return { ok: false, code: "ask_not_open" };
      const stored = await deps.repos.asks.findById(input.askId);
      if (!stored || stored.threadId !== input.threadId) return { ok: false, code: "ask_not_open" };
      if (stored.submissionId === input.submissionId && stored.status !== "open")
        return { ok: true, ask: threadAsk(stored) };
      if (stored.kind !== "question")
        return { ok: false, code: "invalid_answer", ask: threadAsk(stored) };
      const resolution = questionResolution(stored.payload as QuestionAskPayload, input.answer);
      if (!resolution) return { ok: false, code: "invalid_answer", ask: threadAsk(stored) };
      const result = await resolve({
        askId: input.askId,
        threadId: input.threadId,
        status: "answered",
        resolution,
        submissionId: input.submissionId,
        continueRun: true,
      });
      if (result.ok) await testHook("ask.answer.afterCommit");
      return result;
    },
    async expireDue(now = new Date(), limit = 100) {
      const due = await deps.repos.asks.listOpenDueBy(now, limit);
      let expired = 0;
      for (const ask of due) {
        if (ask.kind !== "question") continue;
        const resolution: AskResolution = {
          kind: "timeout",
          label: (ask.payload as QuestionAskPayload).recommended ?? null,
        };
        const result = await resolve({
          askId: ask.id,
          threadId: ask.threadId,
          status: "expired",
          resolution,
          continueRun: true,
        });
        if (result.ok) expired += 1;
      }
      return expired;
    },
    cancelOpen(threadId, askId) {
      return resolve({
        askId,
        threadId,
        status: "cancelled",
        resolution: { kind: "cancelled" },
        continueRun: false,
      });
    },
  };
}
