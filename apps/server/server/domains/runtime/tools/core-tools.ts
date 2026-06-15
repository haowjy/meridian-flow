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
import { ASK_USER_TOOL_INPUT_SCHEMA } from "@meridian/contracts/components";
import type { ToolRegistration } from "./types.js";

/** Canonical list of runnable core tool names. */
export const CORE_TOOL_NAMES = ["read", "edit", "write", "list", "search", "ask_user"] as const;

export type CoreToolName = (typeof CORE_TOOL_NAMES)[number];
type ServerToolHandler = Extract<ToolRegistration["execution"], { type: "server" }>["handler"];

/**
 * Concrete handlers for every core tool. The mapped type makes adding a new
 * core tool an exhaustive wiring change instead of silently publishing a stub.
 */
export type CoreToolHandlers = { [Name in CoreToolName]: ServerToolHandler };

export function createCoreToolRegistrations(handlers: CoreToolHandlers): ToolRegistration[] {
  return [
    {
      source: "core",
      definition: {
        type: "function",
        name: "read",
        description:
          "Read a file and return its contents with line numbers. Files larger than 1MB are truncated.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "File path or URI to read. Supported schemes include work:// for project workspace documents.",
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      execution: { type: "server", handler: handlers.read },
      timeoutMs: 30_000,
    },
    {
      source: "core",
      definition: {
        type: "function",
        name: "edit",
        description:
          "Edit a file with exact text replacements. Each edit replaces one oldText with one newText. All edits in one call are applied atomically. You must have read the file first.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path or URI to edit." },
            edits: {
              type: "array",
              description:
                "Array of edit operations. All applied atomically. Must target non-overlapping regions.",
              items: {
                type: "object",
                properties: {
                  oldText: {
                    type: "string",
                    description: "Exact text to replace. Must match current file content exactly.",
                  },
                  newText: { type: "string", description: "Replacement text." },
                },
                required: ["oldText", "newText"],
                additionalProperties: false,
              },
            },
          },
          required: ["path", "edits"],
          additionalProperties: false,
        },
      },
      execution: { type: "server", handler: handlers.edit },
      sequential: true,
      // sequential: edit is a mutation — must not interleave with reads of the same file.
      timeoutMs: 30_000,
    },
    {
      source: "core",
      definition: {
        type: "function",
        name: "write",
        description:
          "Create a new file or overwrite an existing file with the given content. Use this for creating new files. For modifying existing files, prefer the edit tool.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "File path or URI to write. Supported schemes include work:// for project workspace documents.",
            },
            content: { type: "string", description: "The full file content to write." },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
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
          "List files and directories under a path or URI. Use this to inspect project files, knowledge base folders, work memory, or user files before reading specific files.",
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
          "Search project context files for a query. Use this to find relevant knowledge-base, work-memory, or user files before reading them.",
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
          "Pause execution and present a question to the user. Execution suspends until the user responds or the checkpoint times out. The user's answer is returned as the tool result.",
        inputSchema: ASK_USER_TOOL_INPUT_SCHEMA,
      },
      execution: { type: "server", handler: handlers.ask_user },
      capability: "checkpoint",
    },
  ];
}
