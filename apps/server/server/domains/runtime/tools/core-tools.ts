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
import { z } from "zod";
import type { ToolExecutionError, ToolRegistration } from "./types.js";

const WorkStatusSchema = z.enum(["active", "archived"]);
const WorkSelectorSchema = z.object({ work: z.string().min(1) });

export const WorkCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("list"), status: WorkStatusSchema.optional() }).strict(),
  WorkSelectorSchema.extend({ command: z.literal("show") }).strict(),
  z
    .object({
      command: z.literal("create"),
      name: z.string().min(1),
      goal: z.string().optional(),
      description: z.string().optional(),
    })
    .strict(),
  WorkSelectorSchema.extend({
    command: z.literal("update"),
    name: z.string().min(1).optional(),
    goal: z.string().optional(),
    description: z.string().optional(),
    status: WorkStatusSchema.optional(),
  }).strict(),
  WorkSelectorSchema.extend({ command: z.literal("delete") }).strict(),
  WorkSelectorSchema.extend({ command: z.literal("switch") }).strict(),
]);

export type WorkCommand = z.infer<typeof WorkCommandSchema>;
export type WorkCommandCategory = "read" | "mutate" | "binding";

export function workCommandCategory(command: WorkCommand): WorkCommandCategory {
  if (command.command === "list" || command.command === "show") return "read";
  if (command.command === "switch") return "binding";
  return "mutate";
}

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
  return packageSchemaToModelSchema(z.toJSONSchema(WriteCommandSchema));
}

function workToolInputSchema(): Record<string, unknown> {
  return packageSchemaToModelSchema(z.toJSONSchema(WorkCommandSchema));
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
  // All gateway adapters forward this object as the provider JSON Schema:
  // OpenAI Responses and OpenAI-compatible chat accept arbitrary schema records,
  // while Anthropic's SDK type requires an object root and allows composition
  // keywords. Keep the discriminated oneOf branches strict; do not seal the
  // union wrapper itself, because that makes every branch unsatisfiable.
  transformed.type = "object";
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
          "Document edit tool. Results use the meridian.agent-edit.v1 JSON envelope; each block record separates hash from exact body and says whether body is full or a prefix. Use read for block-addressed content. Use diff to inspect the folded net effect of this turn's writes; it is provisional until the trail settles. To replace an entire existing document, use create with overwrite=true. insert adds content; before/after take block hashes, not text. replace edits content; find replaces only the exact matched span, never following blocks. delete removes the block or block range selected by in. in accepts one block hash or 1-based block number, or an inclusive [start, end] range of hashes or block numbers. Block hashes are internal targeting tokens: use them in tool arguments, but do not quote or label writer-facing prose with hashes unless the writer explicitly asks for edit-protocol details. undo and redo reverse or reapply this thread's document writes.",
        inputSchema: writeToolInputSchema(),
      },
      execution: { type: "server", handler: handlers.write },
      sequential: true,
      timeoutMs: 30_000,
      formatExecutionError: formatWriteExecutionError,
    },
    {
      source: "core",
      definition: {
        type: "function",
        name: "work",
        description: "Inspect or change the project Work and this conversation's Work binding.",
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
        description:
          'List files and directories under a path or URI. Use bare ls() to inspect mounted roots before viewing specific documents with write(command="read").',
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "Optional directory path or URI to list. Omit for the mount table. Supported schemes include scratch:// for work-item scratch files.",
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
      execution: { type: "server", handler: handlers.ls },
      timeoutMs: 30_000,
    },
    {
      source: "core",
      definition: {
        type: "function",
        name: "search",
        description:
          'Literal-text search across visible context files. Use this to find relevant manuscript, knowledge-base, scratch, upload, or user files before viewing them with write(command="read").',
        inputSchema: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "Literal text pattern to search for.",
            },
            scope: {
              type: "string",
              description:
                "Optional URI prefix scope. Use kb:// to search the knowledge base, or a subtree like kb://protocols to search one folder. When omitted, searches all visible context schemes.",
            },
          },
          required: ["pattern"],
          additionalProperties: false,
        },
      },
      execution: { type: "server", handler: handlers.search },
      timeoutMs: 30_000,
    },
    {
      source: "core",
      definition: {
        type: "function",
        name: "ask_user",
        description:
          "Pause execution and present a question to the user. Execution suspends until the user responds or the interrupt times out. The user's answer is returned as the tool result.",
        inputSchema: ASK_USER_TOOL_INPUT_SCHEMA,
      },
      execution: { type: "server", handler: handlers.ask_user },
      capability: "interrupt",
    },
  ];
}
