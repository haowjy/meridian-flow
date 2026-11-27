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
  ToolContentPart,
} from "@meridian/contracts/threads";
import { permissionWorkCommandSchema } from "@meridian/contracts/threads";
import type { PromptCacheDescriptor } from "@meridian-flow/runtime/gateway";
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
import { jsonContent } from "../tools/tool-content.js";
import { askDeadline, askHardLimitSeconds } from "./ask-deadline.js";

export type AskAnswerResult =
  | { ok: true; ask: ThreadAsk }
  | {
      ok: false;
      code: "ask_not_open" | "invalid_answer";
      ask?: ThreadAsk;
      questionIndex?: number;
    };

export type AskRequest =
  | { kind: "question"; payload: QuestionAskPayload }
  | { kind: "permission"; payload: PermissionAskPayload; command: PermissionWorkCommand };

export type AskRequestOutcome =
  | { kind: "deferred"; askId: string }
  | { kind: "refused"; refusal: JsonValue };

export type AskToolResult = {
  content: ToolContentPart[];
  result: JsonValue;
  isError: boolean;
  metadata?: JsonObject;
};

export type AskResolutionPlan = { kind: "resume" } | { kind: "cancel" };

export type PresenceRefusal = "not_owner" | "not_open_question" | "draft_misfit";

const PRESENCE_PUBLISH_MS = 30_000;

type AskClaim = { kind: "claimed"; ask: StoredAsk } | { kind: "finished"; result: AskAnswerResult };

export interface AskService {
  request(input: {
    threadId: ThreadId;
    askingTurnId: TurnId;
    executionId: string;
    toolCallId: string;
    request: AskRequest;
    promptCache: PromptCacheDescriptor | null;
  }): Promise<AskRequestOutcome>;
  answer(input: {
    userId: string;
    threadId: ThreadId;
    askId: string;
    submissionId: string;
    answer: AskAnswer;
  }): Promise<AskAnswerResult>;
  presence(input: {
    userId: string;
    threadId: ThreadId;
    askId: string;
    answers?: DraftAnswers;
    now?: Date;
  }): Promise<PresenceRefusal | null>;
  expireDue(now?: Date, limit?: number): Promise<number>;
  recordCancelled(claimed: ClaimedAsk): Promise<void>;
}

type AskQuestion = QuestionAskPayload["questions"][number];

function fitsQuestion(question: AskQuestion, answer: QuestionAnswer): boolean {
  if (answer.kind === "option") return question.options.some((o) => o.label === answer.label);
  if (answer.kind === "text") return answer.text.trim() !== "";
  return true;
}

function firstMisfit(questions: readonly AskQuestion[], answers: DraftAnswers): number {
  return answers.findIndex((answer, i) => {
    const question = questions[i];
    return !question || (answer !== null && !fitsQuestion(question, answer));
  });
}

function answerMisfit(ask: StoredAsk, answer: AskAnswer): { questionIndex?: number } | null {
  if (ask.kind === "permission") return answer.kind === "answers" ? {} : null;
  if (answer.kind !== "answers") return {};
  const { questions } = ask.payload as QuestionAskPayload;
  if (answer.answers.length !== questions.length) return {};
  const misfit = firstMisfit(questions, answer.answers);
  return misfit >= 0 ? { questionIndex: misfit } : null;
}

function timeoutResolution(ask: StoredAsk): AskResolution {
  const { questions } = ask.payload as QuestionAskPayload;
  const answers = questions.map((question, i): ResolvedQuestionAnswer => {
    const held = ask.draftAnswers?.[i];
    if (held?.kind === "text") return { kind: "unsent", text: held.text };
    return held ?? { kind: "timeout", label: question.recommended ?? null };
  });
  return { kind: "timeout", answers };
}

function resolutionPlan(resolution: AskResolution | null): AskResolutionPlan {
  if (!resolution) throw new Error("A claimed ask has a resolution");
  return { kind: resolution.kind === "cancelled" ? "cancel" : "resume" };
}

export interface PermissionExecutor {
  execute(input: {
    threadId: ThreadId;
    command: PermissionWorkCommand;
    always: boolean;
  }): Promise<AskToolResult>;
}

export const refusingPermissionExecutor: PermissionExecutor = {
  async execute() {
    throw new Error("This composition runs no permission requests");
  },
};

const DENIED: AskToolResult = {
  content: jsonContent({ allowed: false }),
  result: { allowed: false },
  isError: false,
};

const UNREADABLE_COMMAND: AskToolResult = {
  content: jsonContent({
    allowed: false,
    error: "This request was stored by another version and cannot run.",
  }),
  result: { allowed: false, error: "This request was stored by another version and cannot run." },
  isError: true,
};

interface ResolveInput {
  askId: string;
  threadId: ThreadId;
  status: "answered" | "expired";
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

  async function resolveToolResult(ask: StoredAsk): Promise<AskToolResult> {
    const decision = ask.resolution?.kind;
    if (ask.kind === "question" || decision === "cancelled") {
      const result = askToolResult(ask);
      return { content: jsonContent(result), result, isError: false };
    }
    if (decision === "deny") return DENIED;
    if (decision !== "allow" && decision !== "allow_always")
      throw new Error(`Permission ask ${ask.id} resolved as ${decision}`);
    if (!ask.permissionCommand) throw new Error(`Permission ask ${ask.id} has no command`);
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
        hardLimitSeconds: askHardLimitSeconds(input.promptCache),
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
          if (
            input.answers &&
            (input.answers.length > questions.length || firstMisfit(questions, input.answers) >= 0)
          )
            return "draft_misfit";
          const deadline = askDeadline(now, stored.openedAt, stored.hardLimitSeconds);
          const updated = await deps.repos.asks.recordPresence({
            id: stored.id,
            deadline,
            draftAnswers: input.answers,
          });
          if (!updated) return "not_open_question";
          const bucket = (at: Date | null) =>
            Math.floor((at?.getTime() ?? 0) / PRESENCE_PUBLISH_MS);
          if (!input.answers && bucket(updated.deadlineAt) === bucket(stored.deadlineAt))
            return null;
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
