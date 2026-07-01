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
import { WriteCommandSchema } from "@meridian/agent-edit";
import { ASK_USER_TOOL_INPUT_SCHEMA } from "@meridian/contracts/components";
import { z } from "zod";
import type { ToolRegistration } from "./types.js";

/** Canonical list of runnable core tool names. */
export const CORE_TOOL_NAMES = ["write", "list", "search", "ask_user"] as const;

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
          "Document edit tool. Use command=read to sync and read block-hashed content; create to create a new document (use overwrite=true to overwrite an existing document); insert to add content; replace to replace or delete content within a document; undo and redo to reverse or reapply this thread's document writes.",
        inputSchema: writeToolInputSchema(),
      },
      execution: { type: "server", handler: handlers.write },
      sequential: true,
      timeoutMs: 30_000,
    },
    {
      source: "core",
      definition: {
        type: "function",
        name: "list",
        description:
          'List files and directories under a path or URI. Use this to inspect project files, knowledge base folders, work memory, or user files before viewing specific documents with write(command="read").',
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "Directory path or URI to list. Supported schemes include work:// for project workspace documents.",
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      execution: { type: "server", handler: handlers.list },
      timeoutMs: 30_000,
    },
    {
      source: "core",
      definition: {
        type: "function",
        name: "search",
        description:
          'Search project context files for a query. Use this to find relevant knowledge-base, work-memory, or user files before viewing them with write(command="read").',
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Full-text query to search for.",
            },
            uri: {
              type: "string",
              description:
                "Optional URI scope. Use kb:// to search the knowledge base, or a subtree like kb://protocols to search one folder. When omitted, searches all searchable context schemes.",
            },
          },
          required: ["query"],
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
