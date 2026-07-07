// Thin facade wiring dispatch, idempotency, and response lifecycle for the write tool.
import * as Y from "yjs";
import type { ActorSession } from "../ports/actor-session-store.js";
import type { UndoAvailability } from "../undo/availability.js";
import { createThreadOriginRegistry } from "../undo/thread-origin-registry.js";
import { WriteCommandSchema } from "./command-schema.js";
import { createDocumentRenderer } from "./document-renderer.js";
import { createMutationCommit } from "./mutation-commit.js";
import { createResponseCommitter } from "./response-committer.js";
import { status, toOutcome } from "./response-format.js";
import { createRuntimeStore } from "./runtime-store.js";
import type {
  RedoResult,
  ResponseCommitResult,
  ResponseRollbackResult,
  TurnRedoResult,
  TurnUndoResult,
  UndoResult,
  WriteFunction,
} from "./types.js";
import type { CreateWriteToolOptions, WriteToolInternals } from "./write-deps.js";
import { createWriteDispatch } from "./write-dispatch.js";
import {
  createAutoTurnIdNonce,
  fallbackCommandName,
  writeError,
  writeSchemaError,
} from "./write-helpers.js";
import { createWriteIdempotencyCache } from "./write-idempotency.js";
import { createWriteReversal } from "./write-reversal.js";
import type { ReverseInput, VerifiedReverseResult } from "./write-reversal-endpoints.js";

export type { CreateWriteToolOptions } from "./write-deps.js";
export type {
  ReverseInput,
  VerifiedReverseEffect,
  VerifiedReverseResult,
} from "./write-reversal-endpoints.js";

const DEFAULT_UNDO_CLIENT_ID = 999;

export interface WriteTool {
  write: WriteFunction;
  recover(docId: string): Promise<void>;
  commitResponse(responseId: string): Promise<ResponseCommitResult>;
  rollbackResponse(responseId: string): Promise<ResponseRollbackResult>;
  bufferedUpdatesForDoc(responseId: string, docId: string): readonly Uint8Array[];
  stagedCreatedDocumentIds(responseId: string, threadId?: string): readonly string[];
  getAvailability(docId: string, threadId: string): Promise<UndoAvailability>;
  undo(docId: string, threadId: string): Promise<UndoResult>;
  redo(docId: string, threadId: string): Promise<RedoResult>;
  reverse(input: ReverseInput): Promise<UndoResult | RedoResult | VerifiedReverseResult>;
  undoTurn(docId: string, threadId: string): Promise<TurnUndoResult>;
  redoTurn(docId: string, threadId: string): Promise<TurnRedoResult>;
  invalidateThread(docId: string, threadId: string): Promise<void>;
}

export function createWriteTool(options: CreateWriteToolOptions): WriteTool {
  const threadOrigins = createThreadOriginRegistry();
  const undoClientId = options.undoClientId ?? DEFAULT_UNDO_CLIENT_ID;
  const localSessions = new Map<string, ActorSession>();
  const idempotencyCache = createWriteIdempotencyCache(options);
  const autoTurnIdNonce = createAutoTurnIdNonce();
  const autoTurnCounter = { value: 0 };
  const renderer = createDocumentRenderer({ model: options.model, codec: options.codec });
  const reversalStore = options.journal;
  const mutationCommit = createMutationCommit({
    journal: options.journal,
    coordinator: options.coordinator,
    model: options.model,
    codec: options.codec,
  });
  const runtimeStore = createRuntimeStore({
    coordinator: options.coordinator,
    createRuntimeDoc: options.createRuntimeDoc ?? (() => new Y.Doc({ gc: false })),
  });
  const lifecyclePort = options.lifecycle;
  const responseCommitter = createResponseCommitter({
    runtimeStore,
    mutationCommit,
    model: options.model,
    ensureDocument: lifecyclePort ? (docId) => lifecyclePort.ensureDocument(docId) : undefined,
    onLifecycleError: options.onResponseLifecycleError,
    onClaimDiscarded: options.onResponseClaimDiscarded,
    onTransition: options.onResponseCommitterTransition,
    closedResponseTombstoneCap: options.closedResponseTombstoneCap,
  });
  const writeReversal = createWriteReversal({
    reversalStore,
    runtimeStore,
    mutationCommit,
    model: options.model,
    codec: options.codec,
    undoClientId,
    undoNotificationPort: options.undoNotificationPort,
    onInvariantViolation: options.onInvariantViolation,
    onUndoNotificationFailed: options.onUndoNotificationFailed,
  });

  const internals: WriteToolInternals = {
    options,
    threadOrigins,
    localSessions,
    autoTurnCounter,
    autoTurnIdNonce,
    renderer,
    reversalStore,
    mutationCommit,
    runtimeStore,
    responseCommitter,
    writeReversal,
  };

  const pipeline = createWriteDispatch(internals);

  const write: WriteFunction = async (command, context = {}) => {
    const parsed = WriteCommandSchema.safeParse(command);
    const commandName = parsed.success ? parsed.data.command : fallbackCommandName(command);
    if (!parsed.success) {
      return toOutcome(commandName, status("invalid_write", writeSchemaError(parsed.error)));
    }

    const validCommand = parsed.data;
    const session = await pipeline.resolveSession(context);
    const toolUseId = validCommand.tool_use_id ?? context.tool_use_id;
    const cacheKey = idempotencyCache.cacheKeyForToolUse(session, context, toolUseId);
    if (cacheKey) {
      const cached = idempotencyCache.get(cacheKey);
      if (cached !== undefined) {
        idempotencyCache.notifyHit(session, context, toolUseId, cached);
        return cached;
      }
    }

    const result = await pipeline
      .dispatch(validCommand, session, context)
      .catch((cause: unknown) => writeError(cause));
    const outcome = toOutcome(validCommand.command, result);
    if (cacheKey && outcome.status !== "internal_error")
      idempotencyCache.remember(cacheKey, outcome);
    return outcome;
  };

  return {
    write,
    recover: (docId) => options.coordinator.recover(docId),
    commitResponse: responseCommitter.commitResponse,
    rollbackResponse: responseCommitter.rollbackResponse,
    bufferedUpdatesForDoc: responseCommitter.bufferedUpdatesForDoc,
    stagedCreatedDocumentIds: responseCommitter.stagedCreatedDocumentIds,
    getAvailability: writeReversal.getAvailability,
    undo: (docId, threadId) => pipeline.runTurnReversalEndpoint(docId, threadId, "undo"),
    redo: (docId, threadId) => pipeline.runTurnReversalEndpoint(docId, threadId, "redo"),
    reverse: pipeline.reverse,
    undoTurn: (docId, threadId) => pipeline.runTurnReversalEndpoint(docId, threadId, "undo"),
    redoTurn: (docId, threadId) => pipeline.runTurnReversalEndpoint(docId, threadId, "redo"),
    invalidateThread: pipeline.invalidateThread,
  };
}
