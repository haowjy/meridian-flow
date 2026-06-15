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
import { HTTPError } from "nitro/h3";
import {
  contextPortForThread,
  resolveThreadContext,
} from "../domains/context/context-port-resolution.js";
import type { ContextPortFactory } from "../domains/context/index.js";
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
  REQUIRED_MANUSCRIPT_URI,
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
import { Err, Ok } from "../shared/result.js";

export const UNIFIED_MANUSCRIPT_URI = "manuscript://chapter-1.md";

export interface ToolWiringDeps {
  threads: ThreadRepository;
  contextPorts: ContextPortFactory;
  unifiedContextPorts?: UnifiedContextPortFactory;
  threadWorks?: Pick<ThreadWorksRepository, "findPrimary" | "listByThread">;
  documentTouches?: TurnDocumentTouchRepository;
  eventSink: EventSink;
}

type ToolErrorOutput = { isError: true; output: MeridianError };
type LegacyThreadContextPort = ReturnType<ContextPortFactory["forThread"]>;

function toolError(error: ContextError | { message: string }): ToolErrorOutput {
  if ("code" in error && typeof error.code === "string") {
    return { isError: true, output: meridianErrorFromStructuredToolOutput(error as JsonValue) };
  }
  return { isError: true, output: meridianErrorFromTool(error.message) };
}

function legacyErrorToContextError(uri: string, error: unknown): ContextError {
  if (HTTPError.isError(error)) {
    if (error.status === 404) return { code: "not_found", uri };
    if (error.status === 400) return { code: "invalid_uri", uri, reason: error.message };
    return { code: "io_error", uri, message: error.message };
  }
  if (error instanceof Error) return { code: "io_error", uri, message: error.message };
  return { code: "io_error", uri, message: "Unknown error" };
}

function manuscriptContextPort(legacyPort: LegacyThreadContextPort, turnId: string): ContextPort {
  return {
    stat: async (uri) => {
      try {
        const doc = await legacyPort.readDocument(uri);
        return Ok({
          kind: "tracked" as const,
          uri,
          documentId: doc.documentId,
          filetype: "markdown" as const,
          schemaType: "document" as const,
        });
      } catch (error) {
        return Err(legacyErrorToContextError(uri, error));
      }
    },
    async read(uri) {
      try {
        const doc = await legacyPort.readDocument(uri);
        return Ok({ content: doc.markdown, documentId: doc.documentId });
      } catch (error) {
        return Err(legacyErrorToContextError(uri, error));
      }
    },
    async write(uri, content) {
      try {
        const doc = await legacyPort.writeDocument({
          uri,
          markdown: content,
          origin: { type: "agent", actorTurnId: turnId },
        });
        return Ok({ documentId: doc.documentId });
      } catch (error) {
        return Err(legacyErrorToContextError(uri, error));
      }
    },
    list: async (uri) => Err({ code: "io_error", uri, message: "list is not supported" }),
    mkdir: async (uri) => Err({ code: "io_error", uri, message: "mkdir is not supported" }),
    search: async (_query, uri) =>
      Err({
        code: "io_error",
        uri: uri ?? REQUIRED_MANUSCRIPT_URI,
        message: "search is not supported",
      }),
    writeBinary: async (uri) =>
      Err({ code: "io_error", uri, message: "writeBinary is not supported" }),
  };
}

async function resolveProjectContextPort(
  deps: ToolWiringDeps,
  threadId: string,
): Promise<ContextPort | ToolErrorOutput> {
  const thread = await deps.threads.findById(threadId);
  if (!thread) return toolError({ message: `Thread not found: ${threadId}` });
  return deps.contextPorts.forProject(thread.projectId, thread.userId);
}

function usesUnifiedManuscriptPort(uri: string): boolean {
  const trimmed = uri.trim();
  if (trimmed.startsWith("manuscript://")) return true;
  if (trimmed.includes("://")) return false;
  if (/^[a-z][a-z0-9+.-]*:/.test(trimmed)) return false;
  return true;
}

async function resolveUnifiedContextPort(
  deps: ToolWiringDeps,
  threadId: string,
): Promise<ContextPort | ToolErrorOutput> {
  if (!deps.unifiedContextPorts || !deps.threadWorks) {
    return toolError({ message: "Unified context port is not configured" });
  }
  const resolution = await resolveThreadContext(
    { threads: deps.threads, threadWorks: deps.threadWorks },
    threadId,
  );
  if (!resolution) return toolError({ message: `Thread not found: ${threadId}` });
  return contextPortForThread(deps.unifiedContextPorts, resolution);
}

async function resolveContextPort(
  deps: ToolWiringDeps,
  threadId: string,
  uri: string,
  turnId: string,
): Promise<ContextPort | ToolErrorOutput> {
  if (usesUnifiedManuscriptPort(uri)) {
    return resolveUnifiedContextPort(deps, threadId);
  }

  const thread = await deps.threads.findById(threadId);
  if (!thread) return toolError({ message: `Thread not found: ${threadId}` });
  if (uri === REQUIRED_MANUSCRIPT_URI) {
    return manuscriptContextPort(
      deps.contextPorts.forThread({ threadId, userId: thread.userId }),
      turnId,
    );
  }
  return deps.contextPorts.forProject(thread.projectId, thread.userId);
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
      const portOrError = await resolveContextPort(deps, ctx.threadId, path, ctx.turnId);
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
      const portOrError = await resolveContextPort(deps, ctx.threadId, path, ctx.turnId);
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
      const portOrError = await resolveContextPort(deps, ctx.threadId, path, ctx.turnId);
      if ("isError" in portOrError) return portOrError;
      const port = withTouchRecording(portOrError, deps, ctx);
      const result = await port.write(path, content, { origin: agentOrigin(ctx) });
      if (!result.ok) return toolError(result.error);
      return { path, bytesWritten: Buffer.byteLength(content, "utf8") };
    },
    list: async (input: unknown, ctx: ToolHandlerContext) => {
      const { path } = input as { path?: string };
      if (!path) return toolError({ message: "path is required" });
      const portOrError = await resolveProjectContextPort(deps, ctx.threadId);
      if ("isError" in portOrError) return portOrError;
      const result = await portOrError.list(path);
      if (!result.ok) return toolError(result.error);
      return result.value;
    },
    search: async (input: unknown, ctx: ToolHandlerContext) => {
      const { query, uri } = input as { query?: string; uri?: string };
      if (!query) return toolError({ message: "query is required" });
      const portOrError = await resolveProjectContextPort(deps, ctx.threadId);
      if ("isError" in portOrError) return portOrError;
      const result = await portOrError.search(query, uri);
      if (!result.ok) return toolError(result.error);
      return result.value;
    },
    ask_user: askUserHandler,
  });
}
