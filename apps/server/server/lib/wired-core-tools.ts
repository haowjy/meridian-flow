/**
 * Core-tool wiring: binds runtime core tool registrations to concrete handlers
 * backed by Meridian context, collab, and thread services.
 */
import type { WriteCommand, WriteResult } from "@meridian/agent-edit";
import { checkpointResolvedPropsFromAnswer } from "@meridian/contracts/components";
import {
  checkpointRequestFromAskUser,
  type MeridianError,
  meridianErrorFromStructuredToolOutput,
  meridianErrorFromTool,
  parseAskUserToolInput,
} from "@meridian/contracts/interrupt";
import type { JsonValue } from "@meridian/contracts/threads";
import type { CollabDomain } from "../domains/collab/index.js";
import {
  contextPortForThread,
  resolveThreadContext,
} from "../domains/context/context-port-resolution.js";
import { MANUSCRIPT_URI } from "../domains/context/manuscript-uri.js";
import type { ContextError, ContextPort } from "../domains/context/ports/context-port.js";
import type { UnifiedContextPortFactory } from "../domains/context/unified-context-port-factory.js";
import {
  type EventSink,
  emitEvent,
  unknownToEventPayload,
} from "../domains/observability/index.js";
import {
  type CheckpointToolHandlerContext,
  createCoreToolRegistrations,
  type ToolHandlerContext,
  type ToolRegistration,
} from "../domains/runtime/index.js";
import type {
  ThreadRepository,
  ThreadWorksRepository,
  TurnDocumentTouchRepository,
} from "../domains/threads/index.js";

export const UNIFIED_MANUSCRIPT_URI = MANUSCRIPT_URI;

export interface ToolWiringDeps {
  threads: ThreadRepository;
  contextPorts: UnifiedContextPortFactory;
  documentSync: Pick<CollabDomain, "agentEdit" | "refreshDocumentProjection">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary" | "listByThread">;
  documentTouches?: TurnDocumentTouchRepository;
  eventSink: EventSink;
}

type ToolErrorOutput = { isError: true; output: MeridianError };
type WriteToolInput = {
  command: WriteCommand["command"];
  path: string;
  content?: string;
  find?: string;
  in?: string;
  around?: string;
  after?: string;
  before?: string;
  all?: boolean;
  last?: number;
  format?: "auto" | "full" | "outline";
};

type ResolvedDocumentAddress = {
  documentId: string;
  file: string;
};

const WRITE_COMMANDS = new Set<WriteCommand["command"]>([
  "create",
  "view",
  "insert",
  "replace",
  "undo",
  "redo",
]);
const MUTATING_WRITE_COMMANDS = new Set<WriteCommand["command"]>([
  "create",
  "insert",
  "replace",
  "undo",
  "redo",
]);
const STATUS_ENVELOPED_WRITE_COMMANDS = MUTATING_WRITE_COMMANDS;
const WRITE_ERROR_STATUSES = new Set([
  "not_found",
  "ambiguous_match",
  "invalid_write",
  "document_not_found",
  "partial_failure",
  "internal_error",
]);

function toolError(error: ContextError | { message: string }): ToolErrorOutput {
  if ("code" in error && typeof error.code === "string") {
    return { isError: true, output: meridianErrorFromStructuredToolOutput(error as JsonValue) };
  }
  return { isError: true, output: meridianErrorFromTool(error.message) };
}

async function resolveContextPort(
  deps: ToolWiringDeps,
  threadId: string,
): Promise<ContextPort | ToolErrorOutput> {
  const resolution = await resolveThreadContext(
    { threads: deps.threads, threadWorks: deps.threadWorks },
    threadId,
  );
  if (!resolution) return toolError({ message: `Thread not found: ${threadId}` });
  return contextPortForThread(deps.contextPorts, resolution);
}

function recordTouchInBackground(
  deps: ToolWiringDeps,
  documentId: string | undefined,
  ctx: ToolHandlerContext,
): void {
  if (!deps.documentTouches || !documentId) return;
  const eventSink = deps.eventSink;
  void deps.documentTouches.recordTouch(ctx.turnId, documentId).catch((error) => {
    emitEvent(eventSink, {
      level: "warn",
      source: "lib.wired-core-tools",
      name: "document_touch.failed",
      correlation: {
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        runId: ctx.turnId,
      },
      payload: {
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        documentId,
        ...unknownToEventPayload(error),
      },
    });
  });
}

function asRecord(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function optionalString(
  input: Record<string, unknown>,
  key: keyof WriteToolInput,
): string | ToolErrorOutput | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") return toolError({ message: `${String(key)} must be a string` });
  return value;
}

function optionalBoolean(
  input: Record<string, unknown>,
  key: keyof WriteToolInput,
): boolean | ToolErrorOutput | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") return toolError({ message: `${String(key)} must be a boolean` });
  return value;
}

function optionalPositiveInteger(
  input: Record<string, unknown>,
  key: keyof WriteToolInput,
): number | ToolErrorOutput | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return toolError({ message: `${String(key)} must be a positive integer` });
  }
  return value;
}

function parseWriteToolInput(input: unknown): WriteToolInput | ToolErrorOutput {
  const record = asRecord(input);
  if (!record) return toolError({ message: "write input must be an object" });

  const { command, path } = record;
  if (typeof command !== "string" || !WRITE_COMMANDS.has(command as WriteCommand["command"])) {
    return toolError({ message: "command is required" });
  }
  if (typeof path !== "string" || path.length === 0) {
    return toolError({ message: "path is required" });
  }

  const content = optionalString(record, "content");
  if (isToolError(content)) return content;
  const find = optionalString(record, "find");
  if (isToolError(find)) return find;
  const inScope = optionalString(record, "in");
  if (isToolError(inScope)) return inScope;
  const around = optionalString(record, "around");
  if (isToolError(around)) return around;
  const after = optionalString(record, "after");
  if (isToolError(after)) return after;
  const before = optionalString(record, "before");
  if (isToolError(before)) return before;
  const all = optionalBoolean(record, "all");
  if (isToolError(all)) return all;
  const last = optionalPositiveInteger(record, "last");
  if (isToolError(last)) return last;
  const format = optionalString(record, "format");
  if (isToolError(format)) return format;
  if (format !== undefined && !["auto", "full", "outline"].includes(format)) {
    return toolError({ message: "format must be auto, full, or outline" });
  }

  if ((command === "insert" || command === "replace") && content === undefined) {
    return toolError({ message: "content is required" });
  }

  return {
    command: command as WriteCommand["command"],
    path,
    content,
    find,
    in: inScope,
    around,
    after,
    before,
    all,
    last,
    format: format as WriteToolInput["format"],
  };
}

function isToolError(value: unknown): value is ToolErrorOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    "isError" in value &&
    (value as { isError?: boolean }).isError === true
  );
}

function splitFragment(path: string): { basePath: string; fragment?: string } {
  const marker = path.indexOf("#");
  if (marker === -1) return { basePath: path };
  return { basePath: path.slice(0, marker), fragment: path.slice(marker + 1) };
}

function fileForDocument(documentId: string, fragment?: string): string {
  return fragment ? `${documentId}#${fragment}` : documentId;
}

async function resolveDocumentAddress(
  port: ContextPort,
  input: WriteToolInput,
): Promise<ResolvedDocumentAddress | ToolErrorOutput> {
  const { basePath, fragment } = splitFragment(input.path);
  if (input.command === "create") {
    if (fragment) return toolError({ message: "create does not accept a #fragment in path" });
    const ensured = await port.ensureTrackedDocument(basePath);
    if (!ensured.ok) return toolError(ensured.error);
    return {
      documentId: ensured.value.documentId,
      file: fileForDocument(ensured.value.documentId, fragment),
    };
  }

  const ref = await port.stat(basePath);
  if (!ref.ok) return toolError(ref.error);
  if (ref.value.kind !== "tracked") {
    return toolError({ message: `Cannot ${input.command} binary file: ${input.path}` });
  }
  if (!ref.value.documentId) {
    return toolError({ message: `Document id missing for ${input.path}` });
  }
  return {
    documentId: ref.value.documentId,
    file: fileForDocument(ref.value.documentId, fragment),
  };
}

function buildAgentWriteCommand(
  input: WriteToolInput,
  file: string,
  toolUseId: string | undefined,
): WriteCommand {
  switch (input.command) {
    case "create":
      return { command: "create", file, content: input.content, tool_use_id: toolUseId };
    case "view":
      return {
        command: "view",
        file,
        in: input.in,
        around: input.around,
        format: input.format,
        tool_use_id: toolUseId,
      };
    case "insert":
      return {
        command: "insert",
        file,
        content: input.content ?? "",
        find: input.find,
        in: input.in,
        around: input.around,
        after: input.after,
        before: input.before,
        all: input.all,
        tool_use_id: toolUseId,
      };
    case "replace":
      return {
        command: "replace",
        file,
        content: input.content ?? "",
        find: input.find,
        in: input.in,
        around: input.around,
        all: input.all,
        tool_use_id: toolUseId,
      };
    case "undo":
      return { command: "undo", file, last: input.last, all: input.all, tool_use_id: toolUseId };
    case "redo":
      return { command: "redo", file, last: input.last, all: input.all, tool_use_id: toolUseId };
  }
}

function writeStatus(result: WriteResult): string | null {
  return result.match(/^status:\s*([a-z_]+)/)?.[1] ?? null;
}

function isAgentWriteError(command: WriteCommand["command"], result: WriteResult): boolean {
  // agent-edit currently returns WriteResult as plain text. Until it exposes a
  // structured success/error channel, only status-sniff commands whose success
  // shape is always status-enveloped; view success is raw document content.
  if (!STATUS_ENVELOPED_WRITE_COMMANDS.has(command)) return false;
  const status = writeStatus(result);
  return status !== null && WRITE_ERROR_STATUSES.has(status);
}

async function refreshProjectionAfterCommittedWrite(
  deps: ToolWiringDeps,
  address: ResolvedDocumentAddress,
  ctx: ToolHandlerContext,
): Promise<void> {
  try {
    await deps.documentSync.refreshDocumentProjection({
      documentId: address.documentId,
      threadId: ctx.threadId,
    });
  } catch (error) {
    emitEvent(deps.eventSink, {
      level: "error",
      source: "lib.wired-core-tools",
      name: "document_projection_refresh.unhandled_failure",
      correlation: {
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        runId: ctx.turnId,
      },
      payload: {
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        documentId: address.documentId,
        ...unknownToEventPayload(error),
      },
    });
  }
}

async function askUserHandler(input: unknown, ctx: CheckpointToolHandlerContext) {
  const parsed = parseAskUserToolInput(input);
  if (!parsed.ok) return toolError({ message: parsed.message });

  const args = parsed.value;
  const timeoutMs = args.timeoutMs ?? ctx.checkpointTimeoutMs;
  const request = checkpointRequestFromAskUser(args, crypto.randomUUID());

  const response = await ctx.checkpoint(request, timeoutMs);
  const resolvedProps = checkpointResolvedPropsFromAnswer(response);
  await ctx.updateComponentBlock(request.checkpointId, resolvedProps);
  return { value: resolvedProps.resolvedValue, provenance: response.provenance };
}

export function createWiredCoreToolRegistrations(deps: ToolWiringDeps): ToolRegistration[] {
  return createCoreToolRegistrations({
    write: async (input: unknown, ctx: ToolHandlerContext) => {
      const parsed = parseWriteToolInput(input);
      if (isToolError(parsed)) return parsed;

      const portOrError = await resolveContextPort(deps, ctx.threadId);
      if ("isError" in portOrError) return portOrError;

      const address = await resolveDocumentAddress(portOrError, parsed);
      if (isToolError(address)) return address;

      const result = await deps.documentSync
        .agentEdit()
        .write(buildAgentWriteCommand(parsed, address.file, ctx.toolCallId), {
          sessionId: ctx.threadId,
          threadId: ctx.threadId,
          turnId: ctx.turnId,
          tool_use_id: ctx.toolCallId,
        });
      if (isAgentWriteError(parsed.command, result)) return toolError({ message: result });

      recordTouchInBackground(deps, address.documentId, ctx);
      if (MUTATING_WRITE_COMMANDS.has(parsed.command)) {
        await refreshProjectionAfterCommittedWrite(deps, address, ctx);
      }
      return result;
    },
    list: async (input: unknown, ctx: ToolHandlerContext) => {
      const { path } = input as { path?: string };
      if (!path) return toolError({ message: "path is required" });
      const portOrError = await resolveContextPort(deps, ctx.threadId);
      if ("isError" in portOrError) return portOrError;
      const result = await portOrError.list(path);
      if (!result.ok) return toolError(result.error);
      return result.value;
    },
    search: async (input: unknown, ctx: ToolHandlerContext) => {
      const { query, uri } = input as { query?: string; uri?: string };
      if (!query) return toolError({ message: "query is required" });
      const portOrError = await resolveContextPort(deps, ctx.threadId);
      if ("isError" in portOrError) return portOrError;
      const result = await portOrError.search(query, uri);
      if (!result.ok) return toolError(result.error);
      return result.value;
    },
    ask_user: askUserHandler,
  });
}
