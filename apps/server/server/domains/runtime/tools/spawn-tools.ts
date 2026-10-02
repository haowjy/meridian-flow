/**
 * Spawn primitive tools: spawn (create a child), thread_message (put a message
 * into a thread), and return_result (child-side). Handlers are thin —
 * ChildRunCoordinator owns lifecycle. Each registration's zod input is parsed by
 * the executor before its handler runs.
 */
import { type InvocationPatch, invocationPatchSchema } from "@meridian/contracts/agents";
import {
  type ReturnResultCapture,
  returnResultCaptureSchema,
  type SpawnResult,
} from "@meridian/contracts/spawn";
import { z } from "zod";
import { spawnHistoryPreview, threadHistoryPreview } from "./history-previews.js";
import { modelToolSchema } from "./model-tool-schema.js";
import { toolFailureResult } from "./tool-executor.js";
import type {
  ReturnResultToolHandlerContext,
  SpawnToolHandlerContext,
  ThreadMessageToolHandlerContext,
  ThreadReportToolHandlerContext,
  ToolRegistration,
} from "./types.js";

const SPAWN_DESCRIPTION =
  "Run a subagent in its own thread. Prefer a named subagent from your roster; use the generic one sparingly. After starting background work, end your turn without claiming its result; its completion wakes you. Don't message a child just to wait.";
const SPAWN_DESCRIPTION_EMPTY_ROSTER =
  "Run a subagent in its own thread. You have no named subagents; spawn only when the user asks. After starting background work, end your turn without claiming its result; its completion wakes you. Don't message a child just to wait.";

const { "disallowed-tools": disallowedTools, ...invocationPatchShape } =
  invocationPatchSchema.shape;

/**
 * Today's invocation patch with its one public spelling change: the model
 * writes `disallowed_tools`, the configuration keeps `disallowed-tools`.
 */
const SpawnOverridesSchema = z
  .object({ ...invocationPatchShape, disallowed_tools: disallowedTools })
  .strict()
  .transform(
    ({ disallowed_tools, ...patch }): InvocationPatch => ({
      ...patch,
      ...(disallowed_tools !== undefined ? { "disallowed-tools": disallowed_tools } : {}),
    }),
  );

export const SpawnInputSchema = z
  .object({
    agent: z.string().min(1).describe("Roster name; omit for the generic subagent.").optional(),
    from: z
      .string()
      .min(1)
      .describe(
        'Conversation ref, or "current", that the child can read with thread_history; its history is not copied in.',
      )
      .optional(),
    prompt: z.string().min(1).describe("The child's task."),
    description: z
      .string()
      .min(1)
      .describe(
        'The name the user sees in chat, 2 to 5 words naming the task, e.g. "Chapter 12 continuity check". Distinct across parallel subagents; not a sentence, agent name or pN handle.',
      )
      .optional(),
    mode: z
      .enum(["foreground", "background"])
      .default("foreground")
      .describe("foreground (default) waits for the child's report; background returns at once."),
    append_system_prompt: z
      .string()
      .describe("Extra system-prompt text for this run only.")
      .optional(),
    overrides: SpawnOverridesSchema.describe(
      "Change this run's model, effort, tools, disallowed_tools, subagents or skills; omitted keys keep the child's own. Change model or effort only when the task needs it.",
    ).optional(),
  })
  .strict();
export type SpawnToolArgs = z.output<typeof SpawnInputSchema>;

/** Roster-aware spawn description; the caller's binding supplies whether it has named targets. */
export function spawnToolDescription(hasNamedTargets: boolean): string {
  return hasNamedTargets ? SPAWN_DESCRIPTION : SPAWN_DESCRIPTION_EMPTY_ROSTER;
}

/**
 * The canonical capture schema with model-facing copy. Tool arguments arrive
 * as parsed JSON, so `payload` is published as any value: the canonical
 * recursive JSON-value schema would add a self-referencing `$defs` entry.
 */
export const ReturnResultInputSchema = returnResultCaptureSchema.extend({
  summary: returnResultCaptureSchema.shape.summary.describe("Terminal summary for the parent."),
  payload: z.unknown().describe("Package-defined structured result.").optional(),
  artifacts: returnResultCaptureSchema.shape.artifacts.describe(
    "Meridian document URIs produced by this child.",
  ),
});

const THREAD_MESSAGE_DESCRIPTION = "Send a message to a thread.";

export const ThreadMessageInputSchema = z
  .object({
    ref: z
      .string()
      .min(1)
      .refine((ref) => ref !== "current", { message: "Name the thread to message, e.g. p12" })
      .describe('Thread ref such as p3 or c1. Not "current".'),
    message: z.string().min(1),
    mode: z
      .enum(["foreground", "background"])
      .default("background")
      .describe(
        "background (default) queues it and returns; foreground waits for a subagent in your subtree and returns its report.",
      ),
  })
  .strict();
export type ThreadMessageArgs = z.output<typeof ThreadMessageInputSchema>;
export type ThreadMessageMode = ThreadMessageArgs["mode"];

export const ThreadReportInputSchema = z
  .object({
    ref: z.string().min(1).describe('Subagent ref such as p3, or "current".'),
  })
  .strict();
export type ThreadReportArgs = z.output<typeof ThreadReportInputSchema>;

export function createSpawnToolRegistrations(): ToolRegistration[] {
  return [
    {
      source: "spawn",
      definition: {
        type: "function",
        name: "thread_report",
        description: "Read a subagent's latest finished report. Does not wait for a running one.",
        inputSchema: modelToolSchema(ThreadReportInputSchema),
      },
      input: ThreadReportInputSchema,
      execution: {
        type: "server",
        handler: async (input: unknown, ctx: ThreadReportToolHandlerContext) => {
          const result = await ctx.threadReport(input as ThreadReportArgs);
          return "ok" in result ? toolFailureResult(result) : result;
        },
      },
      sequential: true,
      capability: "thread_report",
      historyPreview: threadHistoryPreview,
      advertise: true,
    },
    {
      source: "spawn",
      definition: {
        type: "function",
        name: "spawn",
        description: SPAWN_DESCRIPTION,
        inputSchema: modelToolSchema(SpawnInputSchema),
      },
      input: SpawnInputSchema,
      execution: {
        type: "server",
        handler: async (input: unknown, ctx: SpawnToolHandlerContext) =>
          ctx.spawn(input as SpawnToolArgs),
      },
      sequential: true,
      capability: "spawn",
      historyPreview: spawnHistoryPreview,
      advertise: true,
    },
    {
      source: "spawn",
      definition: {
        type: "function",
        name: "thread_message",
        description: THREAD_MESSAGE_DESCRIPTION,
        inputSchema: modelToolSchema(ThreadMessageInputSchema),
      },
      input: ThreadMessageInputSchema,
      execution: {
        type: "server",
        handler: async (input: unknown, ctx: ThreadMessageToolHandlerContext) => {
          return ctx.threadMessage(input as ThreadMessageArgs);
        },
      },
      sequential: true,
      capability: "thread_message",
      historyPreview: threadHistoryPreview,
      advertise: true,
    },
    {
      source: "spawn",
      definition: {
        type: "function",
        name: "return_result",
        description: "Record the report and end this turn. The child chat stays open.",
        inputSchema: modelToolSchema(ReturnResultInputSchema),
      },
      input: ReturnResultInputSchema,
      execution: {
        type: "server",
        handler: async (input: unknown, ctx: ReturnResultToolHandlerContext) =>
          ctx.returnResult(input as ReturnResultCapture),
      },
      capability: "return_result",
      advertise: false,
    },
  ];
}

export type { SpawnResult };
