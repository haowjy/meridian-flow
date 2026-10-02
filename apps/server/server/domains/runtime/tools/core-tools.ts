/**
 * Core tool catalogue: declares the builtin runnable tool names, model-visible
 * schemas, and per-tool execution constraints. This module is the publication
 * boundary for core runtime tools: callers must provide concrete handlers before
 * a tool registration can be constructed, so definitions cannot be advertised
 * without executable server behavior.
 *
 * The composition root supplies the handlers through
 * `createWiredCoreToolRegistrations`, keeping this runtime-domain catalogue free
 * of ContextPort or other app-layer adapter imports.
 */
import {
  type AgentEditResultCommand,
  agentEditResultCommand,
  modelResult,
  ReadToolInputSchema,
  WriteToolInputSchema,
} from "@meridian/agent-edit/integration";
import { askUserToolInputSchema } from "@meridian/contracts/components";
import {
  INVALID_WORK_NAME,
  INVALID_WORK_STATUS,
  normalizeWorkGoal,
  normalizeWorkName,
  normalizeWorkStatus,
  WORK_STATUS_MAX_LENGTH,
} from "@meridian/contracts/works";
import { z } from "zod";
import { readDocumentText, searchDocumentText, writeDocumentText } from "./document-text.js";
import { readHistoryPreview, writeHistoryPreview } from "./history-previews.js";
import { modelToolSchema } from "./model-tool-schema.js";
import type { ToolExecutionError, ToolRegistration } from "./types.js";

/** A Work slug as the model writes it: trimmed, and `@x` means Work `x`. */
const WorkRefSchema = z
  .string()
  .min(1)
  .transform((raw, context) => {
    const trimmed = raw.trim();
    const slug = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
    if (!slug) {
      context.addIssue({ code: "custom", message: 'must name a Work slug, e.g. "arc" or "@arc"' });
      return z.NEVER;
    }
    return slug;
  });

const WorkNameSchema = z
  .string()
  .min(1)
  .transform((raw, context) => {
    const name = normalizeWorkName(raw);
    if (name === INVALID_WORK_NAME) {
      context.addIssue({ code: "custom", message: "must not be blank" });
      return z.NEVER;
    }
    return name;
  });

const WorkGoalSchema = z.string().nullable().transform(normalizeWorkGoal);

const WorkStatusSchema = z
  .string()
  .nullable()
  .transform((raw, context) => {
    const status = normalizeWorkStatus(raw);
    if (status === INVALID_WORK_STATUS) {
      context.addIssue({
        code: "custom",
        message: `must be one to three words and ${WORK_STATUS_MAX_LENGTH} characters or fewer`,
      });
      return z.NEVER;
    }
    return status;
  });

const WorkSelectorSchema = z.object({
  work: WorkRefSchema.describe('Work slug, e.g. "arc" or "@arc".'),
});

export const WorkCommandSchema = z.discriminatedUnion("command", [
  z
    .object({ command: z.literal("list"), archived: z.boolean().optional() })
    .strict()
    .describe("List Works: active, or archived when archived is true."),
  WorkSelectorSchema.extend({ command: z.literal("show") })
    .strict()
    .describe("Show one Work."),
  z
    .object({
      command: z.literal("create"),
      name: WorkNameSchema,
      goal: WorkGoalSchema.describe("Omit, null or blank for no goal.").optional(),
    })
    .strict()
    .describe("Create a Work."),
  WorkSelectorSchema.extend({
    command: z.literal("update"),
    name: WorkNameSchema.optional(),
    goal: WorkGoalSchema.describe("Omit to keep; null or blank clears it.").optional(),
    status: WorkStatusSchema.describe(
      "Where the Work stands in one to three words, e.g. Drafting, Blocked, Done. Set it when you start in a Work without one and keep it current. Omit to keep; null or blank clears it.",
    ).optional(),
  })
    .strict()
    .describe("Change a Work's name, goal or status."),
  WorkSelectorSchema.extend({ command: z.literal("archive") })
    .strict()
    .describe("Archive a Work. Its files and goal become read-only; its chats continue."),
  WorkSelectorSchema.extend({ command: z.literal("unarchive") })
    .strict()
    .describe("Unarchive a Work so it can be changed again."),
  WorkSelectorSchema.extend({ command: z.literal("delete") })
    .strict()
    .describe("Delete a Work with its chats and files; restorable for 30 days."),
  z
    .object({
      command: z.literal("switch"),
      target: WorkRefSchema.nullable()
        .optional()
        .describe('Work slug, e.g. "arc" or "@arc"; omit or null for No Work.'),
    })
    .strict()
    .describe("Move this conversation to another Work."),
]);

export type WorkCommand = z.output<typeof WorkCommandSchema>;
export type WorkCommandCategory = "read" | "mutate" | "binding";

export function workCommandCategory(command: WorkCommand): WorkCommandCategory {
  if (command.command === "list" || command.command === "show") return "read";
  if (command.command === "switch") return "binding";
  return "mutate";
}

export const LsToolInputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe("Folder path or context URI; omit to list the roots.")
      .optional(),
  })
  .strict();
export type LsToolInput = z.output<typeof LsToolInputSchema>;

export const SearchToolInputSchema = z
  .object({
    pattern: z.string().min(1).describe("Literal text, not a regex."),
    scope: z
      .string()
      .min(1)
      .describe("URI prefix to search under, e.g. kb:// or kb://protocols.")
      .optional(),
  })
  .strict();
export type SearchToolInput = z.output<typeof SearchToolInputSchema>;

/** Canonical list of runnable core tool names. */
export const CORE_TOOL_NAMES = ["read", "write", "work", "ls", "search", "ask_user"] as const;

export type CoreToolName = (typeof CORE_TOOL_NAMES)[number];
type ServerToolHandler = Extract<ToolRegistration["execution"], { type: "server" }>["handler"];

/**
 * Concrete handlers for every core tool. The mapped type makes adding a new
 * core tool an exhaustive wiring change instead of silently publishing a stub.
 */
export type CoreToolHandlers = { [Name in CoreToolName]: ServerToolHandler };

/** Executor-owned failures in the document tools' own result protocol. */
function documentExecutionError(command: (error: ToolExecutionError) => AgentEditResultCommand) {
  return (error: ToolExecutionError) =>
    modelResult({
      command: command(error),
      status: error.kind === "arguments_parse" ? "invalid_write" : "internal_error",
      payload: { message: error.message },
    });
}

export function createCoreToolRegistrations(handlers: CoreToolHandlers): ToolRegistration[] {
  return [
    {
      source: "core",
      definition: {
        type: "function",
        name: "read",
        description:
          "Read a document, or part of it. `path` is a document path or context URI; a bare path means `manuscript://`. Append `#heading-slug` to target one section. Results show a block hash before each block; use hashes to target `read` and `write`, and never show them to the user.",
        inputSchema: modelToolSchema(ReadToolInputSchema),
      },
      input: ReadToolInputSchema,
      execution: { type: "server", handler: handlers.read },
      documentText: readDocumentText,
      historyPreview: readHistoryPreview,
      // Reads run in call order with writes, so a read after a write sees it.
      sequential: true,
      timeoutMs: 30_000,
      formatExecutionError: documentExecutionError(() => "read"),
    },
    {
      source: "core",
      definition: {
        type: "function",
        name: "write",
        description:
          "Change documents. `path` is the document the command creates or changes: a document path or context URI, optionally with `#heading-slug` for one section. `from` is always the source. In a draft-mode Work your changes go to the draft, except `scratch://`, which is always edited directly. `copy` copies a whole document.",
        inputSchema: modelToolSchema(WriteToolInputSchema),
      },
      input: WriteToolInputSchema,
      execution: { type: "server", handler: handlers.write },
      documentText: writeDocumentText,
      historyPreview: writeHistoryPreview,
      sequential: true,
      timeoutMs: 30_000,
      formatExecutionError: documentExecutionError((error) =>
        agentEditResultCommand(error.arguments),
      ),
    },
    {
      source: "core",
      definition: {
        type: "function",
        name: "work",
        description: "Manage the project's Works and which Work this conversation is in.",
        inputSchema: modelToolSchema(WorkCommandSchema),
      },
      input: WorkCommandSchema,
      execution: { type: "server", handler: handlers.work },
      sequential: true,
      timeoutMs: 30_000,
    },
    {
      source: "core",
      definition: {
        type: "function",
        name: "ls",
        description: "List files and folders.",
        inputSchema: modelToolSchema(LsToolInputSchema),
      },
      input: LsToolInputSchema,
      execution: { type: "server", handler: handlers.ls },
      timeoutMs: 30_000,
    },
    {
      source: "core",
      definition: {
        type: "function",
        name: "search",
        description: "Search document text across all context files.",
        inputSchema: modelToolSchema(SearchToolInputSchema),
      },
      input: SearchToolInputSchema,
      execution: { type: "server", handler: handlers.search },
      documentText: searchDocumentText,
      historyPreview: (input) => String(input.pattern ?? ""),
      timeoutMs: 30_000,
    },
    {
      source: "core",
      definition: {
        type: "function",
        name: "ask_user",
        description: "Ask the user a question and wait for the answer.",
        inputSchema: modelToolSchema(askUserToolInputSchema),
      },
      input: askUserToolInputSchema,
      execution: { type: "server", handler: handlers.ask_user },
      capability: "interrupt",
    },
  ];
}
