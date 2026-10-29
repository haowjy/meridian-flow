/** Durable question and permission-request contracts shared by thread clients and the server. */
import { z } from "zod";
import { aiWriteModeSchema } from "../works/ai-write-mode.js";

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

const permissionAskFields = {
  agent: z.string().min(1).nullable(),
  changes: z.strictObject({
    name: z.string().optional(),
    goal: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    mode: aiWriteModeSchema.optional(),
  }),
};

/**
 * What the writer is asked to allow, as facts the client renders in its own locale: who
 * asks (null: the default agent), the action, the Work it targets as named when asked
 * (`handle: null` is No Work), and the values it sets. Create and write_mode target no
 * Work. `changes` holds only the fields the action sets; a null goal or status clears it.
 */
export const permissionAskPayloadSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...permissionAskFields,
    action: permissionActionSchema.extract(["work.create", "work.write_mode"]),
    work: z.null(),
  }),
  z.strictObject({
    ...permissionAskFields,
    action: permissionActionSchema.extract([
      "work.update",
      "work.archive",
      "work.unarchive",
      "work.switch",
    ]),
    work: z.strictObject({ handle: z.string().nullable(), name: z.string() }),
  }),
]);

const workIdSchema = z.string().uuid();

/**
 * The resolved command an Allow runs, stored on the ask and never sent to a client. Rows
 * are parsed with this on read: Allow executes them.
 */
export const permissionWorkCommandSchema = z.strictObject({
  tool: z.literal("work"),
  projectId: z.string().uuid(),
  command: z.discriminatedUnion("command", [
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
  ]),
});

export const askContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("question"), payload: questionAskPayloadSchema }),
  z.object({ kind: z.literal("permission"), payload: permissionAskPayloadSchema }),
]);

export const answeredAskResolutionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("option"), label: z.string().min(1) }),
  z.strictObject({ kind: z.literal("text"), text: z.string().min(1) }),
  z.strictObject({ kind: z.literal("skipped") }),
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

export const askAnswerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("option"), label: z.string().min(1) }),
  z.strictObject({ kind: z.literal("text"), text: z.string().min(1) }),
  z.strictObject({ kind: z.literal("skip") }),
  z.strictObject({ kind: z.literal("allow") }),
  z.strictObject({ kind: z.literal("allow_always") }),
  z.strictObject({ kind: z.literal("deny") }),
]);
export type AskAnswer = z.infer<typeof askAnswerSchema>;
