/** Durable question and permission-request contracts shared by thread clients and the server. */
import { z } from "zod";

/** The AG-UI CUSTOM event name carrying an `ask.updated` frame; its value is the whole `ThreadAsk`. */
export const ASK_UPDATED_EVENT = "meridian.ask" as const;

const askOptionSchema = z.strictObject({
  label: z.string().min(1),
  description: z.string().min(1).optional(),
});

export const questionAskPayloadSchema = z.strictObject({
  question: z.string().min(1),
  options: z.array(askOptionSchema).min(2).max(4),
  recommended: z.string().min(1).optional(),
  forwardedFrom: z
    .strictObject({
      threadId: z.string().min(1),
      askId: z.string().min(1),
      handle: z.string().min(1),
    })
    .optional(),
});

export const permissionAskPayloadSchema = z.strictObject({
  action: z.string().min(1),
  summary: z.string().min(1),
});

export const askContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("question"), payload: questionAskPayloadSchema }),
  z.object({ kind: z.literal("permission"), payload: permissionAskPayloadSchema }),
]);

export const answeredAskResolutionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("option"), label: z.string().min(1) }),
  z.strictObject({ kind: z.literal("text"), text: z.string().min(1) }),
  z.strictObject({ kind: z.literal("skipped") }),
  z.strictObject({ kind: z.literal("parent"), text: z.string().min(1) }),
  z.strictObject({ kind: z.literal("allow") }),
  z.strictObject({ kind: z.literal("allow_always") }),
  z.strictObject({ kind: z.literal("deny") }),
]);

export const askResolutionSchema = z.union([
  answeredAskResolutionSchema,
  z.strictObject({ kind: z.literal("timeout"), label: z.string().nullable() }),
  z.strictObject({ kind: z.literal("cancelled") }),
]);

export const askLifecycleSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), resolution: z.null(), resolvedAt: z.null() }),
  z.object({ status: z.literal("open"), resolution: z.null(), resolvedAt: z.null() }),
  z.object({
    status: z.literal("answered"),
    resolution: answeredAskResolutionSchema,
    resolvedAt: z.string().datetime(),
  }),
  z.object({
    status: z.literal("expired"),
    resolution: z.strictObject({ kind: z.literal("timeout"), label: z.string().nullable() }),
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
  createdAt: z.string().datetime(),
});

export const threadAskSchema = z
  .intersection(z.intersection(threadAskIdentitySchema, askContentSchema), askLifecycleSchema)
  .superRefine((ask, ctx) => {
    if (
      ask.kind === "question" &&
      ask.payload.recommended !== undefined &&
      !ask.payload.options.some((option) => option.label === ask.payload.recommended)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["payload", "recommended"],
        message: "Recommended option must match an option label",
      });
    }
  });

export type QuestionAskPayload = z.infer<typeof questionAskPayloadSchema>;
export type PermissionAskPayload = z.infer<typeof permissionAskPayloadSchema>;
export type AskPayload = QuestionAskPayload | PermissionAskPayload;
export type AskKind = z.infer<typeof askContentSchema>["kind"];
export type AskResolution = z.infer<typeof askResolutionSchema>;
export type AskStatus = z.infer<typeof askLifecycleSchema>["status"];

/**
 * Where a resolved ask's continuation stands; null while the ask is live. `admitted`
 * is still owed (a forwarded ask's relay); `done` and `cancelled` are final.
 */
export type AskContinuationState = "pending" | "admitted" | "done" | "cancelled";
export type ThreadAsk = z.infer<typeof threadAskSchema>;

export const askAnswerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("option"), label: z.string().min(1) }),
  z.strictObject({ kind: z.literal("text"), text: z.string().min(1) }),
  z.strictObject({ kind: z.literal("skip") }),
  z.strictObject({ kind: z.literal("allow") }),
  z.strictObject({ kind: z.literal("allow_always") }),
  z.strictObject({ kind: z.literal("deny") }),
]);
export type AskAnswer = z.infer<typeof askAnswerSchema>;
