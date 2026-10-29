/** Durable question and permission-request contracts shared by thread clients and the server. */
import { z } from "zod";
import { aiWriteModeSchema } from "../works/ai-write-mode.js";

/** The AG-UI CUSTOM event name carrying an `ask.updated` frame; its value is the whole `ThreadAsk`. */
export const ASK_UPDATED_EVENT = "meridian.ask" as const;

const askOptionSchema = z.strictObject({
  label: z.string().min(1),
  description: z.string().min(1).optional(),
});

const askQuestionSchema = z
  .strictObject({
    question: z.string().min(1),
    options: z.array(askOptionSchema).min(2).max(4),
    recommended: z.string().min(1).optional(),
  })
  .superRefine((item, ctx) => {
    if (
      item.recommended !== undefined &&
      !item.options.some((option) => option.label === item.recommended)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["recommended"],
        message: "Recommended option must match an option label",
      });
    }
  });

/** The most questions one `ask_user` call carries. */
export const MAX_ASK_QUESTIONS = 4;

/** What a question ask holds, and what the model passes to `ask_user`: 1–4 questions. */
export const questionAskPayloadSchema = z.strictObject({
  questions: z.array(askQuestionSchema).min(1).max(MAX_ASK_QUESTIONS),
});

/**
 * The actions a permission request can hold: each changing `work` command but delete. A
 * deleted Work restores for 30 days from its receipt, so delete never asks.
 */
export const permissionActionSchema = z.enum([
  "work.create",
  "work.update",
  "work.archive",
  "work.unarchive",
  "work.switch",
  "work.write_mode",
]);

const agentSchema = z.string().min(1).nullable();
const permissionWorkSchema = z.strictObject({ handle: z.string().nullable(), name: z.string() });

/**
 * What the writer is asked to allow, as facts the client renders in its own locale: who
 * asks (null: the default agent), the action, the Work it targets as named when asked
 * (`handle: null` is No Work), and the values it sets. Create and write_mode target no
 * Work. An update's `changes` holds only the fields it sets; a null goal or status clears it.
 */
export const permissionAskPayloadSchema = z.discriminatedUnion("action", [
  z.strictObject({
    agent: agentSchema,
    action: z.literal("work.create"),
    work: z.null(),
    changes: z.strictObject({ name: z.string(), goal: z.string().nullable().optional() }),
  }),
  z.strictObject({
    agent: agentSchema,
    action: z.literal("work.write_mode"),
    work: z.null(),
    changes: z.strictObject({ mode: aiWriteModeSchema }),
  }),
  z.strictObject({
    agent: agentSchema,
    action: z.literal("work.update"),
    work: permissionWorkSchema,
    changes: z.strictObject({
      name: z.string().optional(),
      goal: z.string().nullable().optional(),
      status: z.string().nullable().optional(),
    }),
  }),
  z.strictObject({
    agent: agentSchema,
    action: permissionActionSchema.extract(["work.archive", "work.unarchive", "work.switch"]),
    work: permissionWorkSchema,
    changes: z.strictObject({}),
  }),
]);

const workIdSchema = z.string().uuid();

/**
 * The resolved command an Allow runs, its target pinned by id, stored on the ask and never
 * sent to a client. The project is the asking chat's. Rows are parsed with this on read:
 * Allow executes them.
 */
export const permissionWorkCommandSchema = z.discriminatedUnion("command", [
  z.strictObject({
    command: z.literal("create"),
    name: z.string(),
    goal: z.string().nullable().optional(),
  }),
  z.strictObject({
    command: z.literal("update"),
    workId: workIdSchema,
    name: z.string().optional(),
    goal: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
  }),
  z.strictObject({ command: z.literal("archive"), workId: workIdSchema }),
  z.strictObject({ command: z.literal("unarchive"), workId: workIdSchema }),
  z.strictObject({ command: z.literal("switch"), workId: workIdSchema }),
  z.strictObject({ command: z.literal("write_mode"), mode: aiWriteModeSchema }),
]);

export const askContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("question"), payload: questionAskPayloadSchema }),
  z.object({ kind: z.literal("permission"), payload: permissionAskPayloadSchema }),
]);

const optionAnswerSchema = z.strictObject({ kind: z.literal("option"), label: z.string().min(1) });
const textAnswerSchema = z.strictObject({ kind: z.literal("text"), text: z.string().min(1) });
const skippedAnswerSchema = z.strictObject({ kind: z.literal("skipped") });

/** The writer's answer to one question. */
export const questionAnswerSchema = z.discriminatedUnion("kind", [
  optionAnswerSchema,
  textAnswerSchema,
  skippedAnswerSchema,
]);

/** One question's outcome in a resolved ask: the writer's answer, or the timeout's pick. */
export const resolvedQuestionAnswerSchema = z.discriminatedUnion("kind", [
  ...questionAnswerSchema.options,
  z.strictObject({ kind: z.literal("timeout"), label: z.string().nullable() }),
]);

/**
 * Answers the writer had chosen so far, by question index (null: not answered yet). The
 * server keeps them with the ask so a timeout resolves from them.
 */
export const draftAnswersSchema = z.array(questionAnswerSchema.nullable()).max(MAX_ASK_QUESTIONS);

const timeoutResolutionSchema = z.strictObject({
  kind: z.literal("timeout"),
  answers: z.array(resolvedQuestionAnswerSchema).min(1).max(MAX_ASK_QUESTIONS),
});

/**
 * What the writer answers a question ask with (one entry per question, in order) or a
 * permission ask (one decision); stored as the resolution unchanged.
 */
export const askAnswerSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("answers"),
    answers: z.array(questionAnswerSchema).min(1).max(MAX_ASK_QUESTIONS),
  }),
  z.strictObject({ kind: z.literal("allow") }),
  z.strictObject({ kind: z.literal("allow_always") }),
  z.strictObject({ kind: z.literal("deny") }),
]);

export const askResolutionSchema = z.union([
  askAnswerSchema,
  timeoutResolutionSchema,
  z.strictObject({ kind: z.literal("cancelled") }),
]);

export const askLifecycleSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), resolution: z.null(), resolvedAt: z.null() }),
  z.object({ status: z.literal("open"), resolution: z.null(), resolvedAt: z.null() }),
  z.object({
    status: z.literal("answered"),
    resolution: askAnswerSchema,
    resolvedAt: z.string().datetime(),
  }),
  z.object({
    status: z.literal("expired"),
    resolution: timeoutResolutionSchema,
    resolvedAt: z.string().datetime(),
  }),
  z.object({
    status: z.literal("cancelled"),
    resolution: z.strictObject({ kind: z.literal("cancelled") }),
    resolvedAt: z.string().datetime(),
  }),
]);

const threadAskIdentitySchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  toolCallId: z.string().min(1),
  deadlineAt: z.string().datetime().nullable(),
  /** The answers the owner's client last reported holding; a timeout keeps them. Owner-only data. */
  draftAnswers: draftAnswersSchema.nullable().optional(),
  createdAt: z.string().datetime(),
});

export const threadAskSchema = z.intersection(
  z.intersection(threadAskIdentitySchema, askContentSchema),
  askLifecycleSchema,
);

export type QuestionAskPayload = z.infer<typeof questionAskPayloadSchema>;
export type PermissionAction = z.infer<typeof permissionActionSchema>;
export type PermissionAskPayload = z.infer<typeof permissionAskPayloadSchema>;
export type PermissionWorkCommand = z.infer<typeof permissionWorkCommandSchema>;
export type AskPayload = QuestionAskPayload | PermissionAskPayload;
export type AskKind = z.infer<typeof askContentSchema>["kind"];
export type AskResolution = z.infer<typeof askResolutionSchema>;
export type AskStatus = z.infer<typeof askLifecycleSchema>["status"];

/**
 * Where a resolved ask's continuation stands; null while the ask is live. `pending` is owed
 * until a run admits it (`done`) or a cancellation takes it (`cancelled`).
 */
export type AskContinuationState = "pending" | "done" | "cancelled";
export type ThreadAsk = z.infer<typeof threadAskSchema>;

export type AskAnswer = z.infer<typeof askAnswerSchema>;
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;
export type ResolvedQuestionAnswer = z.infer<typeof resolvedQuestionAnswerSchema>;
export type DraftAnswers = z.infer<typeof draftAnswersSchema>;
