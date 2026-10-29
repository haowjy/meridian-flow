/**
 * Durable ask creation and resolution, split into claim, tool-result, and continuation owners.
 * A resolution that continues sets the ask's continuation `pending` and writes one
 * `ask_resolved` inbox row, the wake hint that admission follows. Permission asks extend the
 * typed tool-result plan with savepoint execution. Every path locks its ask row before the
 * thread lock.
 */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  AskAnswer,
  AskResolution,
  JsonValue,
  QuestionAskPayload,
  ThreadAsk,
} from "@meridian/contracts/threads";
import { testHook } from "../../../shared/test-hooks.js";
import { askToolResult, threadAsk } from "../../threads/domain/ask.js";
import type {
  ClaimedAsk,
  LiveEventWriter,
  StoredAsk,
  ThreadRepositories,
} from "../../threads/index.js";
import { contentForBlockInput } from "../loop/block-helpers.js";
import { persistAndAppendEvents } from "../loop/persistence.js";
import type { DeliveryProducer, DeliveryTransaction } from "../loop/runtime-delivery.js";

export type AskAnswerResult =
  | { ok: true; ask: ThreadAsk }
  | { ok: false; code: "ask_not_open" | "invalid_answer"; ask?: ThreadAsk };

/** What a tool call asks the writer for. */
export type AskRequest = { kind: "question"; payload: QuestionAskPayload };

/** `deferred`: the call's execution settles on the ask, and its answer writes the result. */
export type AskRequestOutcome =
  | { kind: "deferred"; askId: string }
  | { kind: "refused"; refusal: JsonValue };

export type AskToolResultPlan = { kind: "from_resolution" };

export type AskToolResult = {
  output: JsonValue;
  result: JsonValue;
  isError: boolean;
};

export type AskResolutionPlan =
  | {
      kind: "resume";
      toolResult: AskToolResultPlan;
    }
  | {
      kind: "cancel";
      toolResult: AskToolResultPlan;
    };

type AskClaim = { kind: "claimed"; ask: StoredAsk } | { kind: "finished"; result: AskAnswerResult };

export interface AskService {
  /** The one way a tool call opens an ask. */
  request(input: {
    threadId: ThreadId;
    askingTurnId: TurnId;
    executionId: string;
    toolCallId: string;
    request: AskRequest;
  }): Promise<AskRequestOutcome>;
  answer(input: {
    userId: string;
    threadId: ThreadId;
    askId: string;
    submissionId: string;
    answer: AskAnswer;
  }): Promise<AskAnswerResult>;
  expireDue(now?: Date, limit?: number): Promise<number>;
  /**
   * Records an ask a lineage cancellation claimed: a live one's cancelled tool result, or
   * an `ask.updated` for an owed continuation it withdrew. Call under the ask's thread lock.
   */
  recordCancelled(claimed: ClaimedAsk): Promise<void>;
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

function resolutionPlan(resolution: AskResolution): AskResolutionPlan {
  return resolution.kind === "cancelled"
    ? { kind: "cancel", toolResult: { kind: "from_resolution" } }
    : { kind: "resume", toolResult: { kind: "from_resolution" } };
}

export function createAskService(deps: {
  repos: ThreadRepositories;
  eventWriter: LiveEventWriter;
  delivery: Pick<DeliveryProducer, "withThreadLock">;
}): AskService {
  async function claim(input: {
    askId: string;
    threadId: ThreadId;
    status: "answered" | "expired";
    resolution: AskResolution;
    submissionId?: string;
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

    const claimed = await deps.repos.asks.resolveOpen({
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

  async function continueResolution(producer: DeliveryTransaction, ask: StoredAsk) {
    await producer.enqueue({
      threadId: ask.threadId,
      intent: "control",
      provenance: { kind: "system", source: "ask" },
      body: { kind: "ask_resolved", askId: ask.id },
      idempotencyKey: `ask-resolved:${ask.id}`,
    });
  }

  async function resolve(input: {
    askId: string;
    threadId: ThreadId;
    status: "answered" | "expired";
    resolution: AskResolution;
    submissionId?: string;
  }): Promise<AskAnswerResult> {
    const plan = resolutionPlan(input.resolution);
    return deps.repos.transaction(() =>
      // The thread lock takes its held ask rows, this one included, before its own lock.
      deps.delivery.withThreadLock(input.threadId, async (producer) => {
        const claimed = await claim(input);
        if (claimed.kind === "finished") return claimed.result;
        await writeToolResult({ ask: claimed.ask, threadId: input.threadId, plan });
        if (plan.kind === "resume") await continueResolution(producer, claimed.ask);
        return { ok: true, ask: threadAsk(claimed.ask) };
      }),
    );
  }

  return {
    async request(input) {
      const ask = await deps.repos.asks.create({
        threadId: input.threadId,
        askingTurnId: input.askingTurnId,
        executionId: input.executionId,
        toolCallId: input.toolCallId,
        kind: input.request.kind,
        payload: input.request.payload,
        deadlineAt: null,
        status: "pending",
        resolution: null,
        submissionId: null,
      });
      await testHook("ask.pending");
      return { kind: "deferred", askId: ask.id };
    },
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
    async recordCancelled({ ask, wasLive }) {
      if (wasLive) {
        await writeToolResult({
          ask,
          threadId: ask.threadId,
          plan: { kind: "cancel", toolResult: { kind: "from_resolution" } },
          claimLive: true,
        });
        return;
      }
      await persistAndAppendEvents(deps, ask.threadId, async () => ({
        result: undefined,
        events: [{ type: "ask.updated" as const, ask: threadAsk(ask) }],
      }));
    },
  };
}
