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
  agentEditResultCommand,
  modelResult,
  WriteCommandSchema,
} from "@meridian/agent-edit/integration";
import { ASK_USER_TOOL_INPUT_SCHEMA } from "@meridian/contracts/components";
import {
  INVALID_WORK_STATUS,
  normalizeWorkStatus,
  WORK_STATUS_MAX_LENGTH,
} from "@meridian/contracts/works";
import { z } from "zod";
import { searchDocumentText, writeDocumentText } from "./document-text.js";
import { writeHistoryPreview } from "./history-previews.js";
import { modelToolSchema } from "./model-tool-schema.js";
import type { ToolExecutionError, ToolRegistration } from "./types.js";

const WorkSelectorSchema = z.object({ work: z.string().min(1).describe("Work slug.") });

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
      name: z.string().min(1),
      goal: z.string().optional(),
    })
    .strict()
    .describe("Create a Work."),
  WorkSelectorSchema.extend({
    command: z.literal("update"),
    name: z.string().optional(),
    goal: z.string().optional(),
    status: z
      .string()
      .nullable()
      .superRefine((value, context) => {
        if (normalizeWorkStatus(value) === INVALID_WORK_STATUS) {
          context.addIssue({
            code: "custom",
            message: `Work status must be one to three words and ${WORK_STATUS_MAX_LENGTH} characters or fewer`,
          });
        }
      })
      .optional()
      .describe(
        "Where the Work stands in one to three words, e.g. Drafting, Blocked, Done. Set it when you start in a Work without one and keep it current; null clears it.",
      ),
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
      target: z.string().min(1).nullable().optional().describe("Work slug; omit for No Work."),
    })
    .strict()
    .describe("Move this conversation to another Work."),
]);

export type WorkCommand = z.infer<typeof WorkCommandSchema>;
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
export const CORE_TOOL_NAMES = ["write", "work", "ls", "search", "ask_user"] as const;

export type CoreToolName = (typeof CORE_TOOL_NAMES)[number];
type ServerToolHandler = Extract<ToolRegistration["execution"], { type: "server" }>["handler"];

/**
 * Concrete handlers for every core tool. The mapped type makes adding a new
 * core tool an exhaustive wiring change instead of silently publishing a stub.
 */
export type CoreToolHandlers = { [Name in CoreToolName]: ServerToolHandler };

function writeToolInputSchema(): Record<string, unknown> {
  return packageSchemaToModelSchema(modelToolSchema(WriteCommandSchema));
}

function workToolInputSchema(): Record<string, unknown> {
  return packageSchemaToModelSchema(modelToolSchema(WorkCommandSchema));
}

function formatWriteExecutionError(error: ToolExecutionError) {
  return modelResult({
    command: agentEditResultCommand(error.arguments),
    status: error.kind === "arguments_parse" ? "invalid_write" : "internal_error",
    payload: { message: error.message },
  });
}

function packageSchemaToModelSchema(schema: unknown): Record<string, unknown> {
  const transformed = renameSchemaProperty(schema, "file", "path") as Record<string, unknown>;
  stripSchemaProperty(transformed, "documentId");
  stripSchemaProperty(transformed, "tool_use_id");
  return transformed;
}

function renameSchemaProperty(schema: unknown, from: string, to: string): unknown {
  if (Array.isArray(schema)) return schema.map((item) => renameSchemaProperty(item, from, to));
  if (!schema || typeof schema !== "object") return schema;
  const record = schema as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    record[key] = renameSchemaProperty(value, from, to);
  }
  const properties = record.properties;
  if (properties && typeof properties === "object" && from in properties) {
    const propertyRecord = properties as Record<string, unknown>;
    propertyRecord[to] = propertyRecord[from];
    delete propertyRecord[from];
  }
  const required = record.required;
  if (Array.isArray(required)) {
    record.required = required.map((value) => (value === from ? to : value));
  }
  return record;
}

function stripSchemaProperty(schema: unknown, property: string): void {
  if (Array.isArray(schema)) {
    for (const item of schema) stripSchemaProperty(item, property);
    return;
  }
  if (!schema || typeof schema !== "object") return;
  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  if (properties && typeof properties === "object") {
    delete (properties as Record<string, unknown>)[property];
  }
  const required = record.required;
  if (Array.isArray(required)) {
    record.required = required.filter((value) => value !== property);
  }
  for (const value of Object.values(record)) stripSchemaProperty(value, property);
}

export function createCoreToolRegistrations(handlers: CoreToolHandlers): ToolRegistration[] {
  return [
    {
      source: "core",
      definition: {
        type: "function",
        name: "write",
        description:
          "Read and edit documents. Block hashes in results are targeting tokens for in, after and before; never show them to the user.",
        inputSchema: writeToolInputSchema(),
      },
      execution: { type: "server", handler: handlers.write },
      documentText: writeDocumentText,
      historyPreview: writeHistoryPreview,
      sequential: true,
      timeoutMs: 30_000,
      formatExecutionError: formatWriteExecutionError,
    },
    {
      source: "core",
      definition: {
        type: "function",
        name: "work",
        description: "Manage the project's Works and which Work this conversation is in.",
        inputSchema: workToolInputSchema(),
      },
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
        inputSchema: ASK_USER_TOOL_INPUT_SCHEMA,
      },
      execution: { type: "server", handler: handlers.ask_user },
      capability: "interrupt",
    },
  ];
}
