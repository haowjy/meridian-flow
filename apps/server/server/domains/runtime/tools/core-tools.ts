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
  type AgentEditResultV1,
  agentEditResultCommand,
  DOCUMENT_NAMES_DESCRIPTION,
  DocumentVersionSchema,
  modelResult,
  ReadToolInputSchema,
  renderAgentEditResult,
  WriteToolInputSchema,
} from "@meridian/agent-edit/integration";
import { type AskToolInput, askToolInputSchema } from "@meridian/contracts/components";
import {
  aiWriteModeSchema,
  INVALID_WORK_NAME,
  INVALID_WORK_STATUS,
  normalizeWorkGoal,
  normalizeWorkName,
  normalizeWorkStatus,
  WORK_STATUS_MAX_LENGTH,
} from "@meridian/contracts/works";
import { z } from "zod";
import { readDocumentText, searchDocumentText, writeDocumentText } from "./document-text.js";
import { documentHistorySummary, workHistorySummary } from "./history-summaries.js";
import { isInvalidArgumentsResult, renderInvalidArguments } from "./invalid-arguments.js";
import { renderLsResult } from "./ls-result.js";
import { modelToolSchema } from "./model-tool-schema.js";
import { renderSearchResult } from "./search-result.js";
import type { RequestToolHandlerContext, ToolExecutionError, ToolRegistration } from "./types.js";
import { renderWorkResult } from "./work-result.js";

/** A Work handle as the model writes it: trimmed, and `@w3` means Work `w3`. A name is answered by the handler. */
const WorkRefSchema = z
  .string()
  .min(1)
  .transform((raw, context) => {
    const trimmed = raw.trim();
    const handle = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
    if (!handle) {
      context.addIssue({ code: "custom", message: 'Expected a Work handle, e.g. "w3".' });
      return z.NEVER;
    }
    return handle;
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

const WorkVerboseSchema = z
  .boolean()
  .describe("Add dates. Leave it off unless you need them.")
  .optional();

const WorkSelectorSchema = z.object({
  work: WorkRefSchema.describe('Work handle, e.g. "w3".'),
});

export const WorkCommandSchema = z.discriminatedUnion("command", [
  z
    .object({
      command: z.literal("list"),
      archived: z.boolean().optional(),
      verbose: WorkVerboseSchema,
    })
    .strict()
    .describe("List Works: active, or archived when archived is true."),
  WorkSelectorSchema.extend({ command: z.literal("show"), verbose: WorkVerboseSchema })
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
    .describe(
      "Archive a Work. Its scratch://, drafts and goal become read-only; its chats continue.",
    ),
  WorkSelectorSchema.extend({ command: z.literal("unarchive") })
    .strict()
    .describe("Unarchive a Work so it can be changed again."),
  WorkSelectorSchema.extend({ command: z.literal("delete") })
    .strict()
    .describe("Delete a Work with its chats and files; restorable for 30 days."),
  z
    .object({
      command: z.literal("switch"),
      work: WorkRefSchema.nullable()
        .optional()
        .describe('Work handle, e.g. "w3"; omit or null for No Work.'),
    })
    .strict()
    .describe("Move this conversation to another Work."),
  z
    .object({
      command: z.literal("write_mode"),
      mode: aiWriteModeSchema.describe("The AI write mode for this chat."),
    })
    .strict()
    .describe(
      "Change this chat's AI write mode. The current reply finishes in its starting mode; the change applies from the next reply.",
    ),
]);

export type WorkCommand = z.output<typeof WorkCommandSchema>;

const LsToolInputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe("Folder path or context URI; omit to list the roots.")
      .optional(),
    verbose: z
      .boolean()
      .describe(
        "Add each file's size and when it was last edited. Leave it off unless you need them.",
      )
      .optional(),
    version: DocumentVersionSchema.optional(),
  })
  .strict();
export type LsToolInput = z.output<typeof LsToolInputSchema>;

const SearchToolInputSchema = z
  .object({
    pattern: z.string().min(1).describe("Literal text, not a regex."),
    scope: z
      .string()
      .min(1)
      .describe("URI prefix to search under, e.g. kb:// or kb://protocols.")
      .optional(),
    verbose: z
      .boolean()
      .describe("Show each matching block in full. Leave it off unless you need it.")
      .optional(),
    version: DocumentVersionSchema.optional(),
  })
  .strict();
export type SearchToolInput = z.output<typeof SearchToolInputSchema>;

export const AskToolInputSchema = askToolInputSchema;

/** Canonical list of runnable core tool names. */
export const CORE_TOOL_NAMES = ["read", "write", "work", "ls", "search", "ask_user"] as const;

export type CoreToolName = (typeof CORE_TOOL_NAMES)[number];
type ServerToolHandler = Extract<ToolRegistration["execution"], { type: "server" }>["handler"];

/**
 * Concrete handlers for every core tool the composition root binds. The mapped type
 * makes adding a new core tool an exhaustive wiring change instead of silently
 * publishing a stub. `ask_user` needs nothing from the root: it only makes a request.
 */
export type CoreToolHandlers = {
  [Name in Exclude<CoreToolName, "ask_user">]: ServerToolHandler;
};

async function askUser(input: unknown, ctx: RequestToolHandlerContext) {
  const outcome = await ctx.request({ kind: "question", payload: input as AskToolInput });
  return outcome.kind === "refused" ? { isError: true, output: outcome.refusal } : outcome;
}

/**
 * The document tools' handlers and error formatter return agent-edit results,
 * except a `skills://` read, whose text is already the model's (D52).
 */
/** A handler's own `invalid_arguments` refusal (a `skills://` read, D60) reads like the executor's. */
function renderDocumentResult(tool: "read" | "write") {
  return (result: unknown): string => {
    if (typeof result === "string") return result;
    if (isInvalidArgumentsResult(result)) return renderInvalidArguments(tool, result.issues);
    return renderAgentEditResult(result as AgentEditResultV1);
  };
}

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
          DOCUMENT_NAMES_DESCRIPTION +
          "\n" +
          "Read a document, or part of it. Results show a block hash before each block; use hashes to target `read` and `write`. `format: edits` lists your edits newest first with undo, redo or revert availability. `before` pages older edits. Never show hashes or handles to the user.",
        inputSchema: modelToolSchema(ReadToolInputSchema),
      },
      input: ReadToolInputSchema,
      execution: { type: "server", handler: handlers.read },
      documentText: readDocumentText,
      historySummary: documentHistorySummary,
      historyKind: "routine",
      // Reads run in call order with writes, so a read after a write sees it.
      sequential: true,
      timeoutMs: 30_000,
      formatExecutionError: documentExecutionError(() => "read"),
      renderResult: renderDocumentResult("read"),
    },
    {
      source: "core",
      definition: {
        type: "function",
        name: "write",
        description:
          DOCUMENT_NAMES_DESCRIPTION +
          "\n" +
          "Change documents. In draft mode your changes to a document go to its draft, except `scratch://`, which is always edited directly.",
        inputSchema: modelToolSchema(WriteToolInputSchema),
      },
      input: WriteToolInputSchema,
      execution: { type: "server", handler: handlers.write },
      documentText: writeDocumentText,
      historySummary: documentHistorySummary,
      sequential: true,
      timeoutMs: 30_000,
      formatExecutionError: documentExecutionError((error) =>
        agentEditResultCommand(error.arguments),
      ),
      renderResult: renderDocumentResult("write"),
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
      // A command the policy asks about becomes a permission request.
      capability: "request",
      historySummary: workHistorySummary,
      historyKind: (input) =>
        input.command === "list" || input.command === "show" ? "routine" : "receipt",
      sequential: true,
      timeoutMs: 30_000,
      renderResult: renderWorkResult,
    },
    {
      source: "core",
      definition: {
        type: "function",
        name: "ls",
        description: `${DOCUMENT_NAMES_DESCRIPTION}\nList files and folders.`,
        inputSchema: modelToolSchema(LsToolInputSchema),
      },
      input: LsToolInputSchema,
      execution: { type: "server", handler: handlers.ls },
      historyKind: "routine",
      timeoutMs: 30_000,
      renderResult: renderLsResult,
    },
    {
      source: "core",
      definition: {
        type: "function",
        name: "search",
        description: `${DOCUMENT_NAMES_DESCRIPTION}\nSearch document text across all context files.`,
        inputSchema: modelToolSchema(SearchToolInputSchema),
      },
      input: SearchToolInputSchema,
      execution: { type: "server", handler: handlers.search },
      documentText: searchDocumentText,
      historyKind: "routine",
      timeoutMs: 30_000,
      renderResult: renderSearchResult,
    },
    {
      source: "core",
      definition: {
        type: "function",
        name: "ask_user",
        description:
          "Ask only when the answer changes what you do and you can't make a reasonable choice. Otherwise choose, say what you chose, and continue. Give 2–4 options; the writer can also answer in their own words. Mark one recommended if you have a preference: it's used if no one answers within a few minutes. Asking ends your turn, and the answer arrives as this tool's result.",
        inputSchema: modelToolSchema(AskToolInputSchema),
      },
      input: AskToolInputSchema,
      execution: { type: "server", handler: askUser },
      capability: "request",
    },
  ];
}
