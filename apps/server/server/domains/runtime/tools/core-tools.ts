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
export const CORE_TOOL_NAMES = ["write", "list", "search", "ask_user"] as const;

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
        name: "write",
        description:
          "Document edit tool. Use command=view to sync and read block-hashed content; create to create a new document (use overwrite=true to overwrite an existing document); insert to add content; replace to replace or delete content within a document; undo and redo to reverse or reapply this thread's document writes.",
        // Keep this JSON Schema in sync with packages/agent-edit/src/tool/types.ts
        // (WriteCommand). The chat layer uses `path` for context URIs; the
        // server handler resolves it to the package `file`/document id.
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              enum: ["create", "view", "insert", "replace", "undo", "redo"],
              description: "Command to run: create, view, insert, replace, undo, or redo.",
            },
            path: {
              type: "string",
              description:
                "Context URI or bare manuscript path for the document. May include a #fragment for view/section targeting.",
            },
            content: {
              type: "string",
              description:
                "Markdown content. Optional initial content for create; required for insert and replace; empty string deletes in replace.",
            },
            find: {
              type: "string",
              description: "Exact text to find for find-based insert/replace. Not a regex.",
            },
            overwrite: {
              type: "boolean",
              description:
                "For create only: overwrite the document if it already exists instead of erroring.",
            },
            in: {
              type: "string",
              description:
                "View range, replace target, or find scope (block hash, hash range, or #section).",
            },
            around: {
              type: "string",
              description: "Fuzzy scope around a known block hash for view/find operations.",
            },
            after: {
              type: "string",
              description: "Insert block content after this block hash.",
            },
            before: {
              type: "string",
              description: "Insert block content before this block hash.",
            },
            all: {
              type: "boolean",
              description: "Apply to all matches for find, or undo/redo all available turns.",
            },
            to: {
              type: "string",
              description:
                "Undo/redo selector: a single write handle (for example w3), or the inclusive range end when from is also set.",
            },
            from: {
              type: "string",
              description:
                "Undo/redo selector: inclusive range start write handle (for example w2). Requires to.",
            },
            last: {
              type: "integer",
              minimum: 1,
              description: "Number of recent turns to undo or redo.",
            },
            format: {
              type: "string",
              enum: ["auto", "full", "outline"],
              description: "View output format. Defaults to auto.",
            },
          },
          required: ["command", "path"],
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
          'List files and directories under a path or URI. Use this to inspect project files, knowledge base folders, work memory, or user files before viewing specific documents with write(command="view").',
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
          'Search project context files for a query. Use this to find relevant knowledge-base, work-memory, or user files before viewing them with write(command="view").',
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
