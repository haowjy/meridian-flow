/**
 * Core-tool wiring: binds runtime core tool registrations to concrete handlers
 * backed by Meridian context, collab, and thread services.
 */
import type { ResponseStagedCreateOutcome, WriteCommand } from "@meridian/agent-edit";
import { checkpointResolvedPropsFromAnswer } from "@meridian/contracts/components";
import {
  checkpointRequestFromAskUser,
  type MeridianError,
  meridianErrorFromStructuredToolOutput,
  meridianErrorFromTool,
  parseAskUserToolInput,
} from "@meridian/contracts/interrupt";
import type { JsonValue } from "@meridian/contracts/threads";
import type { AgentEditAccess, DocumentProjectionRefresher } from "../domains/collab/index.js";
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
  documentSync: AgentEditAccess & DocumentProjectionRefresher;
  responseWrites: Pick<AgentEditResponseWriteLifecycle, "trackStagedCreate">;
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
  created?: boolean;
};

export type StagedCreateCleanup = {
  responseId: string;
  port: ContextPort;
  path: string;
  documentId: string;
};

export interface AgentEditResponseWriteLifecycle {
  trackStagedCreate(input: StagedCreateCleanup): void;
  commitResponse(
    responseId: string,
    ctx: Pick<ToolHandlerContext, "threadId" | "turnId">,
  ): Promise<void>;
  rollbackResponse(responseId: string): Promise<void>;
}

const MUTATING_WRITE_COMMANDS = new Set<WriteCommand["command"]>([
  "create",
  "insert",
  "replace",
  "undo",
  "redo",
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
  if (typeof command !== "string" || !isWriteCommandName(command)) {
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
    command,
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

function isWriteCommandName(command: string): command is WriteCommand["command"] {
  switch (command) {
    case "create":
    case "view":
    case "insert":
    case "replace":
    case "undo":
    case "redo":
      return true;
    default:
      return false;
  }
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
  options: { deferTrackedDocumentSync?: boolean } = {},
): Promise<ResolvedDocumentAddress | ToolErrorOutput> {
  const { basePath, fragment } = splitFragment(input.path);
  if (input.command === "create") {
    if (fragment) return toolError({ message: "create does not accept a #fragment in path" });
    const ensured = await port.ensureTrackedDocument(
      basePath,
      options.deferTrackedDocumentSync ? { deferDocumentSync: true } : undefined,
    );
    if (!ensured.ok) return toolError(ensured.error);
    return {
      documentId: ensured.value.documentId,
      file: fileForDocument(ensured.value.documentId, fragment),
      created: ensured.value.created,
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

function contextErrorMessage(error: ContextError): string {
  if ("message" in error && typeof error.message === "string") return error.message;
  return `${error.code}: ${error.uri}`;
}

async function deleteCreatedTrackedDocument(input: {
  port: ContextPort;
  path: string;
  documentId: string;
}): Promise<void> {
  const ref = await input.port.stat(input.path);
  if (!ref.ok) {
    if (ref.error.code === "not_found") return;
    throw new Error(contextErrorMessage(ref.error));
  }
  if (ref.value.kind !== "tracked" || ref.value.documentId !== input.documentId) return;

  const deleted = await input.port.delete(input.path);
  if (!deleted.ok && deleted.error.code !== "not_found") {
    throw new Error(contextErrorMessage(deleted.error));
  }
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

async function refreshProjectionAfterCommittedWrite(
  deps: Pick<ToolWiringDeps, "documentSync" | "eventSink">,
  documentId: string,
  ctx: Pick<ToolHandlerContext, "threadId" | "turnId">,
): Promise<void> {
  try {
    await deps.documentSync.refreshDocumentProjection({
      documentId,
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
        documentId,
        ...unknownToEventPayload(error),
      },
    });
  }
}

export function createAgentEditResponseWriteLifecycle(
  deps: Pick<ToolWiringDeps, "documentSync" | "eventSink">,
): AgentEditResponseWriteLifecycle {
  const stagedCreates = new Map<string, StagedCreateCleanup[]>();

  async function cleanupDiscardedStagedCreates(
    responseId: string,
    discardedDocumentIds: ResponseStagedCreateOutcome["discarded"],
  ): Promise<void> {
    const records = stagedCreates.get(responseId) ?? [];
    const discarded = new Set(discardedDocumentIds);
    for (const record of records) {
      if (!discarded.has(record.documentId)) continue;
      await deleteCreatedTrackedDocument(record);
    }
  }

  return {
    trackStagedCreate(input: StagedCreateCleanup): void {
      const records = stagedCreates.get(input.responseId) ?? [];
      if (
        !records.some(
          (record) => record.path === input.path && record.documentId === input.documentId,
        )
      ) {
        records.push(input);
      }
      stagedCreates.set(input.responseId, records);
    },

    async commitResponse(
      responseId: string,
      ctx: Pick<ToolHandlerContext, "threadId" | "turnId">,
    ): Promise<void> {
      const result = await deps.documentSync.agentEdit().commitResponse(responseId);
      await Promise.all(
        result.documents.map((document) =>
          refreshProjectionAfterCommittedWrite(deps, document.documentId, {
            threadId: ctx.threadId,
            turnId: ctx.turnId,
          }),
        ),
      );
      await cleanupDiscardedStagedCreates(responseId, result.stagedCreates.discarded);
      stagedCreates.delete(responseId);
    },

    async rollbackResponse(responseId: string): Promise<void> {
      const result = await deps.documentSync.agentEdit().rollbackResponse(responseId);
      try {
        await cleanupDiscardedStagedCreates(responseId, result.stagedCreates.discarded);
      } finally {
        stagedCreates.delete(responseId);
      }
    },
  };
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

      const address = await resolveDocumentAddress(portOrError, parsed, {
        deferTrackedDocumentSync: parsed.command === "create" && ctx.responseId !== undefined,
      });
      if (isToolError(address)) return address;

      const outcome = await deps.documentSync
        .agentEdit()
        .write(buildAgentWriteCommand(parsed, address.file, ctx.toolCallId), {
          sessionId: ctx.threadId,
          threadId: ctx.threadId,
          turnId: ctx.turnId,
          responseId: ctx.responseId,
          tool_use_id: ctx.toolCallId,
        });
      const stagedCreate =
        parsed.command === "create" && ctx.responseId !== undefined && address.created === true;
      if (outcome.isError) {
        if (stagedCreate) {
          try {
            await deleteCreatedTrackedDocument({
              port: portOrError,
              path: parsed.path,
              documentId: address.documentId,
            });
          } catch (error) {
            return toolError({
              message: `Failed to discard staged create for ${parsed.path}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            });
          }
        }
        return toolError({ message: outcome.text });
      }
      if (stagedCreate) {
        const responseId = ctx.responseId;
        if (responseId === undefined) return toolError({ message: "Missing staged response id" });
        deps.responseWrites.trackStagedCreate({
          responseId,
          port: portOrError,
          path: parsed.path,
          documentId: address.documentId,
        });
      }

      recordTouchInBackground(deps, address.documentId, ctx);
      const stagedWrite =
        ctx.responseId !== undefined &&
        (parsed.command === "create" ||
          parsed.command === "insert" ||
          parsed.command === "replace");
      if (MUTATING_WRITE_COMMANDS.has(parsed.command) && !stagedWrite) {
        await refreshProjectionAfterCommittedWrite(deps, address.documentId, ctx);
      }
      return outcome.text;
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
