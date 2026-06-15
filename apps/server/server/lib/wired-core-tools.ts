/**
 * Core-tool wiring: binds runtime core tool registrations to concrete handlers
 * backed by Meridian context and thread services.
 */
import { checkpointResolvedPropsFromAnswer } from "@meridian/contracts/components";
import {
  checkpointRequestFromAskUser,
  type MeridianError,
  meridianErrorFromStructuredToolOutput,
  meridianErrorFromTool,
  parseAskUserToolInput,
} from "@meridian/contracts/interrupt";
import type { JsonValue } from "@meridian/contracts/threads";
import {
  contextPortForThread,
  resolveThreadContext,
} from "../domains/context/context-port-resolution.js";
import { MANUSCRIPT_URI } from "../domains/context/manuscript-uri.js";
import type {
  ContextError,
  ContextPort,
  WriteProvenance,
} from "../domains/context/ports/context-port.js";
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
import {
  applyEditRanges,
  formatWithLineNumbers,
  resolveEditRanges,
  truncateForRead,
} from "../domains/runtime/tools/core-handlers/index.js";
import type {
  ThreadRepository,
  ThreadWorksRepository,
  TurnDocumentTouchRepository,
} from "../domains/threads/index.js";

export const UNIFIED_MANUSCRIPT_URI = MANUSCRIPT_URI;

export interface ToolWiringDeps {
  threads: ThreadRepository;
  contextPorts: UnifiedContextPortFactory;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary" | "listByThread">;
  documentTouches?: TurnDocumentTouchRepository;
  eventSink: EventSink;
}

type ToolErrorOutput = { isError: true; output: MeridianError };

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
      payload: {
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        documentId,
        ...unknownToEventPayload(error),
      },
    });
  });
}

function withTouchRecording(
  port: ContextPort,
  deps: ToolWiringDeps,
  ctx: ToolHandlerContext,
): ContextPort {
  return {
    stat: (uri) => port.stat(uri),
    async read(uri) {
      const result = await port.read(uri);
      if (result.ok) recordTouchInBackground(deps, result.value.documentId, ctx);
      return result;
    },
    async write(uri, content, options) {
      const result = await port.write(uri, content, options);
      if (result.ok) recordTouchInBackground(deps, result.value.documentId, ctx);
      return result;
    },
    list: (uri) => port.list(uri),
    mkdir: (uri, options) => port.mkdir(uri, options),
    search: (query, uri) => port.search(query, uri),
    writeBinary: (uri, options) => port.writeBinary(uri, options),
  };
}

function agentOrigin(ctx: ToolHandlerContext): WriteProvenance {
  return {
    type: "agent",
    agentSlug: ctx.agentSlug ?? "unknown",
    threadId: ctx.threadId,
    turnId: ctx.turnId,
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
    read: async (input: unknown, ctx: ToolHandlerContext) => {
      const { path } = input as { path?: string };
      if (!path) return toolError({ message: "path is required" });
      const portOrError = await resolveContextPort(deps, ctx.threadId);
      if ("isError" in portOrError) return portOrError;
      const port = withTouchRecording(portOrError, deps, ctx);
      const result = await port.read(path);
      if (!result.ok) return toolError(result.error);
      return formatWithLineNumbers(truncateForRead(result.value.content));
    },
    edit: async (input: unknown, ctx: ToolHandlerContext) => {
      const { path, edits } = input as {
        path?: string;
        edits?: Array<{ oldText: string; newText: string }>;
      };
      if (!path) return toolError({ message: "path is required" });
      if (!edits?.length) return toolError({ message: "edits is required" });
      const portOrError = await resolveContextPort(deps, ctx.threadId);
      if ("isError" in portOrError) return portOrError;
      const port = withTouchRecording(portOrError, deps, ctx);
      const readResult = await port.read(path);
      if (!readResult.ok) return toolError(readResult.error);
      const rangesOrError = resolveEditRanges(readResult.value.content, edits);
      if ("message" in rangesOrError) return toolError(rangesOrError);
      const content = applyEditRanges(readResult.value.content, rangesOrError);
      const writeResult = await port.write(path, content, { origin: agentOrigin(ctx) });
      if (!writeResult.ok) return toolError(writeResult.error);
      return { path, appliedEdits: edits.length };
    },
    write: async (input: unknown, ctx: ToolHandlerContext) => {
      const { path, content } = input as { path?: string; content?: string };
      if (!path) return toolError({ message: "path is required" });
      if (content === undefined) return toolError({ message: "content is required" });
      const portOrError = await resolveContextPort(deps, ctx.threadId);
      if ("isError" in portOrError) return portOrError;
      const port = withTouchRecording(portOrError, deps, ctx);
      const result = await port.write(path, content, { origin: agentOrigin(ctx) });
      if (!result.ok) return toolError(result.error);
      return { path, bytesWritten: Buffer.byteLength(content, "utf8") };
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
