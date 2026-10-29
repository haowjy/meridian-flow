/**
 * Durable ask creation and resolution, split into claim, tool-result, and continuation owners.
 * A resolution that continues sets the ask's continuation `pending` and writes one
 * `ask_resolved` inbox row, the wake hint that admission follows. A permission ask's tool
 * result is the approved action's result, or `{allowed: false}` on Deny; the executor owns its
 * savepoint and refusal translation. Every path locks its ask row before the thread lock.
 */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  AskAnswer,
  AskResolution,
  DraftAnswers,
  JsonObject,
  JsonValue,
  PermissionAskPayload,
  PermissionWorkCommand,
  QuestionAnswer,
  QuestionAskPayload,
  ResolvedQuestionAnswer,
  ThreadAsk,
} from "@meridian/contracts/threads";
import { permissionWorkCommandSchema } from "@meridian/contracts/threads";
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
import { askDeadline } from "./ask-deadline.js";

export type AskAnswerResult =
  | { ok: true; ask: ThreadAsk }
  | {
      ok: false;
      code: "ask_not_open" | "invalid_answer";
      ask?: ThreadAsk;
      /** The first question whose answer didn't fit, when one entry is at fault. */
      questionIndex?: number;
    };

/** What a tool call asks the writer for: an answer to a question, or permission to run an action. */
export type AskRequest =
  | { kind: "question"; payload: QuestionAskPayload }
  | { kind: "permission"; payload: PermissionAskPayload; command: PermissionWorkCommand };

/** `deferred`: the call's execution settles on the ask, and its answer writes the result. */
export type AskRequestOutcome =
  | { kind: "deferred"; askId: string }
  | { kind: "refused"; refusal: JsonValue };

export type AskToolResult = {
  output: JsonValue;
  result: JsonValue;
  isError: boolean;
  metadata?: JsonObject;
};

/** `resume` continues the asking run with the answer's tool result; `cancel` ends its turn. */
export type AskResolutionPlan = { kind: "resume" } | { kind: "cancel" };

export type PresenceRefusal = "not_owner" | "not_open_question" | "draft_misfit";

/** A presence moves the published deadline only when it moves this far; smaller moves stay in the row. */
const PRESENCE_PUBLISH_MS = 30_000;

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
  /**
   * The writer is interacting with an open question ask: stores the answers they hold and
   * moves its deadline out. Publishes the ask only when the stored answers changed or the
   * deadline moved by `PRESENCE_PUBLISH_MS`. Refused (nothing changes, the reason returned)
   * for a thread the user doesn't own, a closed or permission ask, or draft answers that don't
   * fit the questions.
   */
  presence(input: {
    userId: string;
    threadId: ThreadId;
    askId: string;
    answers: DraftAnswers;
    now?: Date;
  }): Promise<PresenceRefusal | null>;
  /**
   * Resolves every open question ask past its deadline: what the writer had answered stands,
   * and each other question takes its Recommended option.
   */
  expireDue(now?: Date, limit?: number): Promise<number>;
  /**
   * Records an ask a lineage cancellation claimed: a live one's cancelled tool result, or
   * an `ask.updated` for an owed continuation it withdrew. Call under the ask's thread lock.
   */
  recordCancelled(claimed: ClaimedAsk): Promise<void>;
}

type AskQuestion = QuestionAskPayload["questions"][number];

function fitsQuestion(question: AskQuestion, answer: QuestionAnswer): boolean {
  if (answer.kind === "option") return question.options.some((o) => o.label === answer.label);
  if (answer.kind === "text") return answer.text.trim() !== "";
  return true;
}

/** The index of the first answer that doesn't fit its question, or -1. Null entries are unanswered. */
function firstMisfit(questions: readonly AskQuestion[], answers: DraftAnswers): number {
  return answers.findIndex((answer, i) => {
    const question = questions[i];
    return !question || (answer !== null && !fitsQuestion(question, answer));
  });
}

/** Why a writer's answer doesn't fit this ask (the question it misses, when one), or null when it fits. */
function answerMisfit(ask: StoredAsk, answer: AskAnswer): { questionIndex?: number } | null {
  if (ask.kind === "permission") return answer.kind === "answers" ? {} : null;
  if (answer.kind !== "answers") return {};
  const { questions } = ask.payload as QuestionAskPayload;
  if (answer.answers.length !== questions.length) return {};
  const misfit = firstMisfit(questions, answer.answers);
  return misfit >= 0 ? { questionIndex: misfit } : null;
}

/** The timeout's resolution: the writer's held answers stand, every other question takes its Recommended option. */
function timeoutResolution(ask: StoredAsk): AskResolution {
  const { questions } = ask.payload as QuestionAskPayload;
  const answers = questions.map(
    (question, i): ResolvedQuestionAnswer =>
      ask.draftAnswers?.[i] ?? { kind: "timeout", label: question.recommended ?? null },
  );
  return { kind: "timeout", answers };
}

function resolutionPlan(resolution: AskResolution | null): AskResolutionPlan {
  if (!resolution) throw new Error("A claimed ask has a resolution");
  return { kind: resolution.kind === "cancelled" ? "cancel" : "resume" };
}

/** Runs what the writer allowed. */
export interface PermissionExecutor {
  /**
   * Runs the stored command inside the answer's transaction; a domain refusal rolls back the
   * command's own writes and becomes an error result. `always` also stores the project's
   * grant for the action, even when the action was refused: the writer's standing choice.
   */
  execute(input: {
    threadId: ThreadId;
    command: PermissionWorkCommand;
    always: boolean;
  }): Promise<AskToolResult>;
}

/** For compositions that run no model tools, so no permission request can open. */
export const refusingPermissionExecutor: PermissionExecutor = {
  async execute() {
    throw new Error("This composition runs no permission requests");
  },
};

const DENIED: AskToolResult = {
  output: { allowed: false },
  result: { allowed: false },
  isError: false,
};

const UNREADABLE_COMMAND: AskToolResult = {
  output: { allowed: false, error: "This request was stored by another version and cannot run." },
  result: { allowed: false, error: "This request was stored by another version and cannot run." },
  isError: true,
};

interface ResolveInput {
  askId: string;
  threadId: ThreadId;
  status: "answered" | "expired";
  /** Built from the row as the thread lock holds it, so a draft stored since a listing counts. */
  resolution: (current: StoredAsk) => AskResolution;
  submissionId?: string;
  dueBy?: Date;
}

export function createAskService(deps: {
  repos: ThreadRepositories;
  eventWriter: LiveEventWriter;
  delivery: Pick<DeliveryProducer, "withThreadLock">;
  permission: PermissionExecutor;
}): AskService {
  async function claim(input: ResolveInput): Promise<AskClaim> {
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
        resolution: input.resolution(existing),
        submissionId: input.submissionId,
        resolvedAt: new Date(),
        dueBy: input.dueBy,
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
          plan: { kind: "cancel" },
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
    const result = await resolveToolResult(input.ask);
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

  /** A question's answer, or a cancelled ask, as the tool result; an answered permission ask runs. */
  async function resolveToolResult(ask: StoredAsk): Promise<AskToolResult> {
    const decision = ask.resolution?.kind;
    if (ask.kind === "question" || decision === "cancelled") {
      const result = askToolResult(ask);
      return { output: result, result, isError: false };
    }
    if (decision === "deny") return DENIED;
    if (decision !== "allow" && decision !== "allow_always")
      throw new Error(`Permission ask ${ask.id} resolved as ${decision}`);
    if (!ask.permissionCommand) throw new Error(`Permission ask ${ask.id} has no command`);
    // Tolerant on read, strict here: a command stored by another release may not parse, and that
    // ask resolves as a recorded refusal instead of breaking the thread's reads.
    const parsed = permissionWorkCommandSchema.safeParse(ask.permissionCommand);
    if (!parsed.success) return UNREADABLE_COMMAND;
    return deps.permission.execute({
      threadId: ask.threadId,
      command: parsed.data,
      always: decision === "allow_always",
    });
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

  async function resolve(input: ResolveInput): Promise<AskAnswerResult> {
    return deps.repos.transaction(() =>
      // The thread lock takes its held ask rows, this one included, before its own lock.
      deps.delivery.withThreadLock(input.threadId, async (producer) => {
        const claimed = await claim(input);
        if (claimed.kind === "finished") return claimed.result;
        const plan = resolutionPlan(claimed.ask.resolution);
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
      const misfit = answerMisfit(stored, input.answer);
      if (misfit)
        return {
          ok: false,
          code: "invalid_answer",
          ask: threadAsk(stored),
          ...(misfit.questionIndex === undefined ? {} : { questionIndex: misfit.questionIndex }),
        };
      const result = await resolve({
        askId: input.askId,
        threadId: input.threadId,
        status: "answered",
        resolution: () => input.answer,
        submissionId: input.submissionId,
      });
      if (result.ok) await testHook("ask.answer.afterCommit");
      return result;
    },
    async presence(input) {
      const thread = await deps.repos.threads.findById(input.threadId);
      if (!thread || thread.userId !== input.userId) return "not_owner";
      const now = input.now ?? new Date();
      // The thread lock serializes this with a resolution; a timeout whose deadline this moves
      // then loses on its `dueBy` check.
      return deps.repos.transaction(() =>
        deps.delivery.withThreadLock(input.threadId, async (): Promise<PresenceRefusal | null> => {
          const stored = await deps.repos.asks.findById(input.askId);
          if (
            stored?.threadId !== input.threadId ||
            stored.status !== "open" ||
            stored.kind !== "question" ||
            !stored.openedAt
          )
            return "not_open_question";
          const { questions } = stored.payload as QuestionAskPayload;
          if (input.answers.length > questions.length || firstMisfit(questions, input.answers) >= 0)
            return "draft_misfit";
          const deadline = askDeadline(now, stored.openedAt);
          const updated = await deps.repos.asks.recordPresence({
            id: stored.id,
            deadline,
            draftAnswers: input.answers,
          });
          if (!updated) return "not_open_question";
          const moved = (updated.deadlineAt?.getTime() ?? 0) - (stored.deadlineAt?.getTime() ?? 0);
          const draftChanged =
            JSON.stringify(updated.draftAnswers) !== JSON.stringify(stored.draftAnswers);
          if (!draftChanged && moved < PRESENCE_PUBLISH_MS) return null;
          await persistAndAppendEvents(deps, input.threadId, async () => ({
            result: undefined,
            events: [{ type: "ask.updated" as const, ask: threadAsk(updated) }],
          }));
          return null;
        }),
      );
    },
    async expireDue(now = new Date(), limit = 100) {
      const due = await deps.repos.asks.listOpenDueBy(now, limit);
      let expired = 0;
      for (const ask of due) {
        if (ask.kind !== "question") continue;
        const result = await resolve({
          askId: ask.id,
          threadId: ask.threadId,
          status: "expired",
          resolution: timeoutResolution,
          dueBy: now,
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
          plan: { kind: "cancel" },
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
