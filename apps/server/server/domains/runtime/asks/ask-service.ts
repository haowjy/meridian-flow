/**
 * Durable ask creation and resolution, split into claim, tool-result, and continuation owners.
 * A resolution that continues sets the ask's continuation `pending` and writes one
 * `ask_resolved` inbox row, the wake hint that admission follows. A permission ask's tool
 * result is the approved action's result, or `{allowed: false}` on Deny; the executor owns its
 * savepoint and refusal translation. Every path locks its ask row before the thread lock.
 */

import type { ProjectId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  AskAnswer,
  AskResolution,
  JsonObject,
  JsonValue,
  PermissionAskPayload,
  PermissionWorkCommand,
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
import type { PermissionGrantStore } from "../loop/permissions/permission-grants.js";
import { persistAndAppendEvents } from "../loop/persistence.js";
import type { DeliveryProducer, DeliveryTransaction } from "../loop/runtime-delivery.js";

export type AskAnswerResult =
  | { ok: true; ask: ThreadAsk }
  | { ok: false; code: "ask_not_open" | "invalid_answer"; ask?: ThreadAsk };

/** What a tool call asks the writer for: an answer to a question, or permission to run an action. */
export type AskRequest =
  | { kind: "question"; payload: QuestionAskPayload }
  | { kind: "permission"; payload: PermissionAskPayload; command: PermissionWorkCommand };

/** `deferred`: the call's execution settles on the ask, and its answer writes the result. */
export type AskRequestOutcome =
  | { kind: "deferred"; askId: string }
  | { kind: "refused"; refusal: JsonValue };

/** `permission`: Allow runs the stored command, and Deny reports `{allowed: false}`. */
export type AskToolResultPlan = { kind: "from_resolution" } | { kind: "permission" };

export type AskToolResult = {
  output: JsonValue;
  result: JsonValue;
  isError: boolean;
  metadata?: JsonObject;
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

/** The resolution a writer's answer gives this ask, or null when it doesn't fit the ask. */
function answerResolution(ask: StoredAsk, answer: AskAnswer): AskResolution | null {
  if (ask.kind === "permission")
    return answer.kind === "allow" || answer.kind === "allow_always" || answer.kind === "deny"
      ? { kind: answer.kind }
      : null;
  const payload = ask.payload as QuestionAskPayload;
  if (answer.kind === "option")
    return payload.options.some((option) => option.label === answer.label)
      ? { kind: "option", label: answer.label }
      : null;
  if (answer.kind === "text")
    return answer.text.trim() ? { kind: "text", text: answer.text } : null;
  if (answer.kind === "skip") return { kind: "skipped" };
  return null;
}

function resolutionPlan(ask: StoredAsk, resolution: AskResolution): AskResolutionPlan {
  if (resolution.kind === "cancelled")
    return { kind: "cancel", toolResult: { kind: "from_resolution" } };
  return {
    kind: "resume",
    toolResult: { kind: ask.kind === "permission" ? "permission" : "from_resolution" },
  };
}

/** Runs what the writer allowed. */
export interface PermissionExecutor {
  grants: Pick<PermissionGrantStore, "grant">;
  /**
   * Takes the thread locks the command's stop will take first, with the asking thread's, in a
   * stop's order, before the answer takes any other lock. Runs whether or not the answer wins
   * the claim.
   */
  lockAhead(input: { threadId: ThreadId; command: PermissionWorkCommand }): Promise<void>;
  /**
   * Runs the stored command as the thread's writer, inside the answer's transaction; a
   * domain refusal rolls back the command's own writes and becomes an error result.
   */
  execute(input: { threadId: ThreadId; command: PermissionWorkCommand }): Promise<AskToolResult>;
}

/** For compositions that run no model tools, so no permission request can open. */
export const refusingPermissionExecutor: PermissionExecutor = {
  async lockAhead() {
    throw new Error("This composition runs no permission requests");
  },
  grants: {
    async grant() {
      throw new Error("This composition runs no permission requests");
    },
  },
  async execute() {
    throw new Error("This composition runs no permission requests");
  },
};

const DENIED: AskToolResult = {
  output: { allowed: false },
  result: { allowed: false },
  isError: false,
};

export function createAskService(deps: {
  repos: ThreadRepositories;
  eventWriter: LiveEventWriter;
  delivery: Pick<DeliveryProducer, "withThreadLock">;
  permission: PermissionExecutor;
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

    if (await deps.repos.threads.findById(input.threadId)) {
      const claimed = await deps.repos.asks.resolveOpen({
        id: input.askId,
        status: input.status,
        resolution: input.resolution,
        submissionId: input.submissionId,
        resolvedAt: new Date(),
      });
      if (claimed) return { kind: "claimed", ask: claimed };
    } else {
      // The chat's delete skipped this row because this answer held it: finish that cancellation.
      const cancelled = await deps.repos.asks.resolveLive({
        id: input.askId,
        status: "cancelled",
        resolution: { kind: "cancelled" },
        resolvedAt: new Date(),
      });
      if (cancelled)
        await writeToolResult({
          ask: cancelled,
          threadId: input.threadId,
          plan: { kind: "cancel", toolResult: { kind: "from_resolution" } },
          claimLive: true,
        });
    }

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
      case "permission": {
        const decision = ask.resolution?.kind;
        if (decision === "deny") return DENIED;
        if (decision !== "allow" && decision !== "allow_always")
          throw new Error(`Permission ask ${ask.id} resolved as ${decision}`);
        const command = ask.permissionCommand;
        if (!command) throw new Error(`Permission ask ${ask.id} has no command`);
        const result = await deps.permission.execute({ threadId: ask.threadId, command });
        // The writer's standing choice holds even when this action was refused.
        if (decision === "allow_always")
          await deps.permission.grants.grant(
            command.projectId as ProjectId,
            `work.${command.command.command}`,
          );
        return result;
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

  /**
   * An allowed action can end the asking chat's own lineage (deleting its Work), which
   * cancels this continuation; a hint written after that would wake a deleted chat.
   */
  async function stillOwed(ask: StoredAsk, plan: AskResolutionPlan): Promise<boolean> {
    if (plan.toolResult.kind !== "permission") return true;
    return (await deps.repos.asks.findById(ask.id))?.continuation === "pending";
  }

  /**
   * An allowed action that stops threads (a Work delete) takes their lineage owners' locks
   * before the asking thread's, or it deadlocks with a concurrent stop of the same threads.
   * The asking thread locks in the same pass, so its own lock below is a re-entry.
   */
  async function lockAhead(input: {
    askId: string;
    threadId: ThreadId;
    resolution: AskResolution;
  }) {
    if (input.resolution.kind !== "allow" && input.resolution.kind !== "allow_always") return;
    const ask = await deps.repos.asks.findById(input.askId);
    if (ask?.permissionCommand && ask.threadId === input.threadId)
      await deps.permission.lockAhead({ threadId: input.threadId, command: ask.permissionCommand });
  }

  async function resolve(input: {
    askId: string;
    threadId: ThreadId;
    status: "answered" | "expired";
    resolution: AskResolution;
    submissionId?: string;
  }): Promise<AskAnswerResult> {
    return deps.repos.transaction(async () => {
      await lockAhead(input);
      // The thread lock takes its held ask rows, this one included, before its own lock.
      return deps.delivery.withThreadLock(input.threadId, async (producer) => {
        const claimed = await claim(input);
        if (claimed.kind === "finished") return claimed.result;
        const plan = resolutionPlan(claimed.ask, input.resolution);
        await writeToolResult({ ask: claimed.ask, threadId: input.threadId, plan });
        if (plan.kind === "resume" && (await stillOwed(claimed.ask, plan)))
          await continueResolution(producer, claimed.ask);
        return { ok: true, ask: threadAsk(claimed.ask) };
      });
    });
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
        permissionCommand: input.request.kind === "permission" ? input.request.command : null,
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
      const resolution = answerResolution(stored, input.answer);
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
