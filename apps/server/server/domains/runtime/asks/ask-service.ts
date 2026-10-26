/**
 * Durable ask resolution, split into claim, tool-result, and continuation owners.
 * Every resolution that continues writes one `ask_resolved` inbox row, the
 * continuation's only identity; a parent's foreground answer marks it `direct`.
 * Permission asks extend the typed tool-result plan with savepoint execution.
 * No path changes the ask-first claim and thread-lock ordering.
 */

import type { ThreadId } from "@meridian/contracts/runtime";
import type {
  AskAnswer,
  AskResolution,
  JsonValue,
  QuestionAskPayload,
  ThreadAsk,
} from "@meridian/contracts/threads";
import { testHook } from "../../../shared/test-hooks.js";
import { askToolResult, threadAsk } from "../../threads/domain/ask.js";
import type { LiveEventWriter, StoredAsk, ThreadRepositories } from "../../threads/index.js";
import { contentForBlockInput } from "../loop/block-helpers.js";
import { persistAndAppendEvents } from "../loop/persistence.js";
import type { AskResolvedBody } from "../loop/ports.js";
import type { DeliveryProducer, DeliveryTransaction } from "../loop/runtime-delivery.js";

export type AskAnswerResult =
  | { ok: true; ask: ThreadAsk }
  | { ok: false; code: "ask_not_open" | "invalid_answer"; ask?: ThreadAsk };

export type AskToolResultPlan = { kind: "from_resolution" };

export type AskToolResult = {
  output: JsonValue;
  result: JsonValue;
  isError: boolean;
};

/**
 * How the continuation reports back, and the forwarded ask whose relay this
 * answer is: the relay record commits with the answer that creates its obligation.
 */
export type AskContinuationPlan = {
  delivery: AskResolvedBody["delivery"];
  relayFor?: string;
};

export type AskResolutionPlan =
  | {
      kind: "resume";
      toolResult: AskToolResultPlan;
      continuation: AskContinuationPlan;
    }
  | {
      kind: "cancel";
      toolResult: AskToolResultPlan;
    };

type AskClaim = { kind: "claimed"; ask: StoredAsk } | { kind: "finished"; result: AskAnswerResult };

export interface AskService {
  answer(input: {
    userId: string;
    threadId: ThreadId;
    askId: string;
    submissionId: string;
    answer: AskAnswer;
  }): Promise<AskAnswerResult>;
  /**
   * Resolves exactly the ask named by a parent message; never searches for a newer
   * ask. A replay of the same submission answers ok without a second continuation.
   */
  answerFromParent(input: {
    parentThreadId: ThreadId;
    childThreadId: ThreadId;
    askId: string;
    submissionId: string;
    text: string;
    delivery: AskResolvedBody["delivery"];
    /** The parent's forwarded ask this answer relays. */
    relayFor?: string;
  }): Promise<AskAnswerResult>;
  expireDue(now?: Date, limit?: number): Promise<number>;
  cancelOpen(threadId: ThreadId, askId: string): Promise<AskAnswerResult>;
  /** Joins a thread lifecycle transaction; claims the ask before its thread lock. */
  cancelForThreadLifecycle(threadId: ThreadId): Promise<void>;
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

function resolutionPlan(
  resolution: AskResolution,
  continuation: AskContinuationPlan,
): AskResolutionPlan {
  return resolution.kind === "cancelled"
    ? { kind: "cancel", toolResult: { kind: "from_resolution" } }
    : { kind: "resume", toolResult: { kind: "from_resolution" }, continuation };
}

export function createAskService(deps: {
  repos: ThreadRepositories;
  eventWriter: LiveEventWriter;
  delivery: Pick<DeliveryProducer, "withThreadLock">;
}): AskService {
  async function claim(input: {
    askId: string;
    threadId: ThreadId;
    status: "answered" | "expired" | "cancelled";
    resolution: AskResolution;
    submissionId?: string;
    claimLive?: boolean;
  }): Promise<AskClaim> {
    const existing = await deps.repos.asks.findById(input.askId);
    if (!existing || existing.threadId !== input.threadId)
      return { kind: "finished", result: { ok: false, code: "ask_not_open" } };
    if (
      input.submissionId &&
      existing.submissionId === input.submissionId &&
      existing.status !== "open"
    )
      return { kind: "finished", result: { ok: true, ask: threadAsk(existing) } };

    const claimed = input.claimLive
      ? await deps.repos.asks.resolveLive({
          id: input.askId,
          status: "cancelled",
          resolution: input.resolution,
          resolvedAt: new Date(),
        })
      : await deps.repos.asks.resolveOpen({
          id: input.askId,
          status: input.status,
          resolution: input.resolution,
          submissionId: input.submissionId,
          resolvedAt: new Date(),
        });
    if (claimed) return { kind: "claimed", ask: claimed };

    const current = await deps.repos.asks.findById(input.askId);
    if (
      input.submissionId &&
      current?.submissionId === input.submissionId &&
      current.status !== "open"
    )
      return { kind: "finished", result: { ok: true, ask: threadAsk(current) } };
    return {
      kind: "finished",
      result: {
        ok: false,
        code: "ask_not_open",
        ...(current ? { ask: threadAsk(current) } : {}),
      },
    };
  }

  async function writeToolResult(input: {
    ask: StoredAsk;
    threadId: ThreadId;
    plan: AskResolutionPlan;
    claimLive?: boolean;
  }) {
    const turn = await deps.repos.turns.findById(input.ask.askingTurnId);
    if (
      !turn ||
      turn.threadId !== input.threadId ||
      (turn.status !== "awaiting_answer" && !(input.claimLive && turn.status === "streaming"))
    )
      throw new Error("Live ask is not attached to its active asking turn");
    const blocks = await deps.repos.blocks.listByTurn(turn.id);
    const result = await resolveToolResult(input.ask, input.plan.toolResult);
    const block = contentForBlockInput({
      turnId: turn.id,
      blockType: "tool_result",
      sequence: Math.max(-1, ...blocks.map((candidate) => candidate.sequence)) + 1,
      content: {
        toolCallId: input.ask.toolCallId,
        ...result,
      },
      status: "complete",
    });
    const completed = {
      ...turn,
      status: input.plan.kind === "resume" ? ("complete" as const) : ("cancelled" as const),
      completedAt: new Date().toISOString(),
    };
    await persistAndAppendEvents(deps, input.threadId, async () => ({
      result: undefined,
      events: [
        { type: "block.upserted" as const, block },
        {
          type: "tool.result" as const,
          toolCallId: input.ask.toolCallId,
          ...result,
        },
        input.plan.kind === "resume"
          ? { type: "turn.completed" as const, turn: completed }
          : { type: "turn.cancelled" as const, turn: completed },
        { type: "ask.updated" as const, ask: threadAsk(input.ask) },
      ],
    }));
  }

  async function resolveToolResult(
    ask: StoredAsk,
    plan: AskToolResultPlan,
  ): Promise<AskToolResult> {
    switch (plan.kind) {
      case "from_resolution": {
        const result = askToolResult(ask);
        return { output: result, result, isError: false };
      }
    }
  }

  async function continueResolution(
    producer: DeliveryTransaction,
    ask: StoredAsk,
    plan: AskContinuationPlan,
  ) {
    const draft = {
      threadId: ask.threadId,
      intent: "control" as const,
      provenance: { kind: "system" as const, source: "ask" as const },
      body: { kind: "ask_resolved" as const, askId: ask.id, delivery: plan.delivery },
      idempotencyKey: `ask-resolved:${ask.id}`,
    };
    // A direct continuation is driven by the waiting parent call; the wake sweep
    // still finds the row if that caller dies first.
    if (plan.delivery === "direct") await producer.enqueueWithoutWake(draft);
    else await producer.enqueue(draft);
    if (plan.relayFor)
      await deps.repos.asks.recordRelayOnce(plan.relayFor, {
        childAskId: ask.id,
        mode: "foreground",
        result: null,
      });
  }

  async function resolve(input: {
    askId: string;
    threadId: ThreadId;
    status: "answered" | "expired" | "cancelled";
    resolution: AskResolution;
    submissionId?: string;
    claimLive?: boolean;
    continuation?: AskContinuationPlan;
  }): Promise<AskAnswerResult> {
    return deps.repos.transaction(async () => {
      const claimed = await claim(input);
      if (claimed.kind === "finished") return claimed.result;
      const plan = resolutionPlan(
        input.resolution,
        input.continuation ?? { delivery: "background_notification" },
      );
      // The conditional ask claim precedes the thread lock for every resolver.
      return deps.delivery.withThreadLock(input.threadId, async (producer) => {
        await writeToolResult({
          ask: claimed.ask,
          threadId: input.threadId,
          plan,
          claimLive: input.claimLive,
        });
        if (plan.kind === "resume")
          await continueResolution(producer, claimed.ask, plan.continuation);
        return { ok: true, ask: threadAsk(claimed.ask) };
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
      });
      if (result.ok) await testHook("ask.answer.afterCommit");
      return result;
    },
    async answerFromParent(input) {
      const child = await deps.repos.threads.findById(input.childThreadId);
      const stored = await deps.repos.asks.findById(input.askId);
      if (
        child?.parentThreadId !== input.parentThreadId ||
        !stored ||
        stored.threadId !== input.childThreadId ||
        stored.kind !== "question"
      ) {
        return {
          ok: false,
          code: "ask_not_open",
          ...(stored ? { ask: threadAsk(stored) } : {}),
        };
      }
      if (!input.text.trim()) return { ok: false, code: "invalid_answer", ask: threadAsk(stored) };
      const replayed = stored.status !== "open" && stored.submissionId === input.submissionId;
      const result = await resolve({
        askId: stored.id,
        threadId: input.childThreadId,
        status: "answered",
        resolution: { kind: "parent", text: input.text },
        submissionId: input.submissionId,
        continuation: {
          delivery: input.delivery,
          ...(input.relayFor ? { relayFor: input.relayFor } : {}),
        },
      });
      if (result.ok && !replayed) await testHook("ask.parentAnswer.afterCommit");
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
      });
    },
    async cancelForThreadLifecycle(threadId) {
      const asks = await deps.repos.asks.listLiveByLineage(threadId);
      for (const ask of asks) {
        const result = await resolve({
          askId: ask.id,
          threadId: ask.threadId,
          status: "cancelled",
          resolution: { kind: "cancelled" },
          claimLive: true,
        });
        if (!result.ok && result.code !== "ask_not_open")
          throw new Error(`Could not cancel live ask ${ask.id}`);
      }
    },
  };
}
