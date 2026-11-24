import { z } from "zod";
import { aiWriteModeSchema } from "../works/ai-write-mode.js";

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

export const MAX_ASK_QUESTIONS = 4;

export const questionAskPayloadSchema = z.strictObject({
  questions: z.array(askQuestionSchema).min(1).max(MAX_ASK_QUESTIONS),
});

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

// keep: permissionWorkCommand is server-only and must never be serialized through threadAsk()
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

export const questionAnswerSchema = z.discriminatedUnion("kind", [
  optionAnswerSchema,
  textAnswerSchema,
  skippedAnswerSchema,
]);

export const resolvedQuestionAnswerSchema = z.discriminatedUnion("kind", [
  ...questionAnswerSchema.options,
  z.strictObject({ kind: z.literal("timeout"), label: z.string().nullable() }),
  z.strictObject({ kind: z.literal("unsent"), text: z.string() }),
]);

export const draftAnswersSchema = z.array(questionAnswerSchema.nullable()).max(MAX_ASK_QUESTIONS);

const timeoutResolutionSchema = z.strictObject({
  kind: z.literal("timeout"),
  answers: z.array(resolvedQuestionAnswerSchema).min(1).max(MAX_ASK_QUESTIONS),
});

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

export type AskContinuationState = "pending" | "done" | "cancelled";
export type ThreadAsk = z.infer<typeof threadAskSchema>;

export type AskAnswer = z.infer<typeof askAnswerSchema>;
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;
export type ResolvedQuestionAnswer = z.infer<typeof resolvedQuestionAnswerSchema>;
export type DraftAnswers = z.infer<typeof draftAnswersSchema>;
