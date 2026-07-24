/**
 * Core-tool wiring: binds runtime core tool registrations to concrete handlers
 * backed by Meridian context, collab, and thread services.
 */

import type {
  ConcurrentEditInfo,
  ResponseCommitWriteReceipt,
  ResponseStagedCreateOutcome,
  WriteCommand,
} from "@meridian/agent-edit";
import {
  type DocumentAddress,
  formatDocumentFile,
  splitDocumentFile,
  WriteCommandSchema,
} from "@meridian/agent-edit";
import { interruptResolvedPropsFromAnswer } from "@meridian/contracts/components";
import {
  askRequestFromAskUser,
  type MeridianError,
  meridianErrorFromStructuredToolOutput,
  meridianErrorFromTool,
  parseAskUserToolInput,
} from "@meridian/contracts/interrupt";
import type { JsonValue } from "@meridian/contracts/threads";
import type {
  AgentEditAccess,
  DocumentProjectionRefresher,
  ResponseWriteFinalizer,
} from "../domains/collab/index.js";
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
  createCoreToolRegistrations,
  type InterruptToolHandlerContext,
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
  documentSync: AgentEditAccess & DocumentProjectionRefresher & ResponseWriteFinalizer;
  responseWrites: Pick<AgentEditResponseWriteLifecycle, "trackStagedCreate">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary" | "listByThread">;
  documentTouches?: TurnDocumentTouchRepository;
  eventSink: EventSink;
}

type ToolErrorOutput = { isError: true; output: MeridianError };
type ModelWriteCommand = {
  [Command in WriteCommand as Command["command"]]: Omit<Command, "file" | "documentId"> & {
    path: string;
  };
}[WriteCommand["command"]];

type ResolvedDocumentAddress = DocumentAddress & { created?: boolean };

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
    beforeTransactionCommit?: (result: ResponseWriteLifecycleCommitResult) => Promise<void>,
  ): Promise<ResponseWriteLifecycleCommitResult>;
  rollbackResponse(
    responseId: string,
    ctx: Pick<ToolHandlerContext, "threadId" | "turnId">,
  ): Promise<void>;
}

export type ResponseWriteLifecycleCommitResult =
  | {
      status: "committed";
      receipts: Array<{ documentId: string; receipt: ResponseCommitWriteReceipt }>;
      concurrentEdits: { documentId: string; concurrentEdits: ConcurrentEditInfo }[];
    }
  | { status: "draft_closed"; responseId: string; mode: "draft" };

const PROJECTION_REFRESH_COMMANDS = new Set<WriteCommand["command"]>([
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
  responseId?: string,
): Promise<ContextPort | ToolErrorOutput> {
  const resolution = await resolveThreadContext(
    { threads: deps.threads, threadWorks: deps.threadWorks },
    threadId,
  );
  if (!resolution) return toolError({ message: `Thread not found: ${threadId}` });
  return contextPortForThread(deps.contextPorts, resolution, { responseId });
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

function parseWriteToolInput(input: unknown): ModelWriteCommand | ToolErrorOutput {
  const record = asRecord(input);
  if (!record) return toolError({ message: "write input must be an object" });

  const { path, ...packageInput } = record;
  if (typeof path !== "string" || path.length === 0) {
    return toolError({ message: "path is required" });
  }

  const parsed = WriteCommandSchema.safeParse({ ...packageInput, file: path });
  if (!parsed.success) return toolError({ message: writeSchemaError(parsed.error) });

  const { file: _file, documentId: _documentId, tool_use_id: _toolUseId, ...command } = parsed.data;
  return { ...command, path } as ModelWriteCommand;
}

function writeSchemaError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map((part) => (part === "file" ? "path" : part)).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

function isToolError(value: unknown): value is ToolErrorOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    "isError" in value &&
    (value as { isError?: boolean }).isError === true
  );
}

async function resolveDocumentAddress(
  port: ContextPort,
  input: ModelWriteCommand,
  options: { deferTrackedDocumentSync?: boolean } = {},
): Promise<ResolvedDocumentAddress | ToolErrorOutput> {
  const { filePath: basePath, fragment } = splitDocumentFile(input.path);
  if (input.command === "create") {
    if (fragment) return toolError({ message: "create does not accept a #fragment in path" });
    const ensured = await port.ensureTrackedDocument(
      basePath,
      options.deferTrackedDocumentSync ? { deferDocumentSync: true } : undefined,
    );
    if (!ensured.ok) return toolError(ensured.error);
    return {
      documentId: ensured.value.documentId,
      filePath: basePath,
      ...(fragment === undefined ? {} : { fragment }),
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
    filePath: basePath,
    ...(fragment === undefined ? {} : { fragment }),
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
  input: ModelWriteCommand,
  address: ResolvedDocumentAddress,
  toolUseId: string | undefined,
): WriteCommand {
  const { path: _path, ...command } = input;
  return {
    ...command,
    documentId: address.documentId,
    file: formatDocumentFile(address),
    tool_use_id: toolUseId,
  } as WriteCommand;
}

async function refreshProjectionAfterToolWrite(
  deps: Pick<ToolWiringDeps, "documentSync">,
  documentId: string,
  ctx: Pick<ToolHandlerContext, "threadId">,
): Promise<void> {
  await deps.documentSync.refreshDocumentProjection({
    documentId,
    threadId: ctx.threadId,
  });
}

export function createAgentEditResponseWriteLifecycle(
  deps: Pick<ToolWiringDeps, "documentSync">,
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
      beforeTransactionCommit?: (result: ResponseWriteLifecycleCommitResult) => Promise<void>,
    ): Promise<ResponseWriteLifecycleCommitResult> {
      const mapResult = (
        result: Awaited<ReturnType<typeof deps.documentSync.finalizeResponseCommit>>,
      ): ResponseWriteLifecycleCommitResult => {
        if (result.status === "draft_closed") {
          return { status: result.status, responseId: result.responseId, mode: result.mode };
        }
        return {
          status: "committed",
          receipts: result.documents.flatMap((document) =>
            document.receipts.map((receipt) => ({ documentId: document.documentId, receipt })),
          ),
          concurrentEdits: result.documents.flatMap((document) =>
            document.concurrentEdits
              ? [{ documentId: document.documentId, concurrentEdits: document.concurrentEdits }]
              : [],
          ),
        };
      };
      const result = await deps.documentSync.finalizeResponseCommit(
        responseId,
        ctx,
        async (commitResult) => beforeTransactionCommit?.(mapResult(commitResult)),
      );
      await cleanupDiscardedStagedCreates(responseId, result.stagedCreates.discarded);
      stagedCreates.delete(responseId);
      return mapResult(result);
    },

    async rollbackResponse(
      responseId: string,
      ctx: Pick<ToolHandlerContext, "threadId" | "turnId">,
    ): Promise<void> {
      const result = await deps.documentSync.finalizeResponseRollback(responseId, ctx);
      try {
        await cleanupDiscardedStagedCreates(responseId, result.stagedCreates.discarded);
      } finally {
        stagedCreates.delete(responseId);
      }
    },
  };
}

async function askUserHandler(input: unknown, ctx: InterruptToolHandlerContext) {
  const parsed = parseAskUserToolInput(input);
  if (!parsed.ok) return toolError({ message: parsed.message });

  const args = parsed.value;
  const timeoutMs = args.timeoutMs ?? ctx.interruptTimeoutMs;
  const request = askRequestFromAskUser(args, crypto.randomUUID());

  const response = await ctx.interrupt(request, timeoutMs);
  const resolvedProps = interruptResolvedPropsFromAnswer(response);
  await ctx.updateComponentBlock(request.interruptId, resolvedProps);
  return { value: resolvedProps.resolvedValue, provenance: response.provenance };
}

export function createWiredCoreToolRegistrations(deps: ToolWiringDeps): ToolRegistration[] {
  return createCoreToolRegistrations({
    write: async (input: unknown, ctx: ToolHandlerContext) => {
      const parsed = parseWriteToolInput(input);
      if (isToolError(parsed)) return parsed;

      const portOrError = await resolveContextPort(deps, ctx.threadId, ctx.responseId);
      if ("isError" in portOrError) return portOrError;

      const address = await resolveDocumentAddress(portOrError, parsed, {
        deferTrackedDocumentSync: parsed.command === "create" && ctx.responseId !== undefined,
      });
      if (isToolError(address)) return address;

      const outcome = await deps.documentSync
        .agentEdit()
        .write(buildAgentWriteCommand(parsed, address, ctx.toolCallId), {
          sessionId: ctx.threadId,
          threadId: ctx.threadId,
          turnId: ctx.turnId,
          responseId: ctx.responseId,
          tool_use_id: ctx.toolCallId,
          createdDocument: address.created === true,
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
      if (PROJECTION_REFRESH_COMMANDS.has(parsed.command) && !stagedWrite) {
        await refreshProjectionAfterToolWrite(deps, address.documentId, ctx);
      }
      return {
        output: outcome.content ?? outcome.text,
        ...(stagedWrite
          ? {
              metadata: {
                documentId: address.documentId,
                stagedWrite: true,
                ...(outcome.writeId ? { writeId: outcome.writeId } : {}),
                ...(outcome.settlementId ? { settlementId: outcome.settlementId } : {}),
              },
            }
          : {}),
      };
    },
    ls: async (input: unknown, ctx: ToolHandlerContext) => {
      const { path } = (input ?? {}) as { path?: string };
      const portOrError = await resolveContextPort(deps, ctx.threadId, ctx.responseId);
      if ("isError" in portOrError) return portOrError;
      const result = await portOrError.list(path);
      if (!result.ok) return toolError(result.error);
      return result.value;
    },
    grep: async (input: unknown, ctx: ToolHandlerContext) => {
      const { pattern, scope } = input as { pattern?: string; scope?: string };
      if (!pattern) return toolError({ message: "pattern is required" });
      const portOrError = await resolveContextPort(deps, ctx.threadId, ctx.responseId);
      if ("isError" in portOrError) return portOrError;
      const result = await portOrError.search(pattern, scope);
      if (!result.ok) return toolError(result.error);
      return result.value;
    },
    ask_user: askUserHandler,
  });
}
