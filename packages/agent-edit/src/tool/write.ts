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
  ResponseCommitSuccessResult,
  ResponseRollbackResult,
  TurnRedoResult,
  TurnUndoResult,
  UndoResult,
  WriteContext,
  WriteFunction,
  WriteOutcome,
} from "./types.js";
import { createWriteCommands } from "./write-commands.js";
import type { CreateWriteToolOptions } from "./write-deps.js";
import { createWriteDispatch } from "./write-dispatch.js";
import {
  createAutoTurnIdNonce,
  fallbackCommandName,
  writeError,
  writeSchemaError,
} from "./write-helpers.js";
import { createWriteIdempotencyCache, scopedToolUseId } from "./write-idempotency.js";
import { createWriteReversal } from "./write-reversal.js";
import {
  createWriteReversalEndpoints,
  type ReverseInput,
  type VerifiedReverseResult,
} from "./write-reversal-endpoints.js";

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
  commitResponse(
    responseId: string,
    options?: import("./response-committer.js").ResponseCommitOptions,
  ): Promise<ResponseCommitSuccessResult>;
  rollbackResponse(
    responseId: string,
    options?: Pick<import("./response-committer.js").ResponseCommitOptions, "deferFinalization">,
  ): Promise<ResponseRollbackResult>;
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
    observationSnapshots: options.observationSnapshots,
  });
  const runtimeStore = createRuntimeStore({
    coordinator: options.coordinator,
    createRuntimeDoc: options.createRuntimeDoc ?? (() => new Y.Doc({ gc: false })),
  });
  const lifecyclePort = options.lifecycle;
  const responseCommitter = createResponseCommitter({
    runtimeStore,
    mutationCommit,
    coordinator: options.coordinator,
    model: options.model,
    codec: options.codec,
    ensureDocument: lifecyclePort ? (docId) => lifecyclePort.ensureDocument(docId) : undefined,
    onLifecycleError: options.onResponseLifecycleError,
    onClaimDiscarded: options.onResponseClaimDiscarded,
    onTransition: options.onResponseCommitterTransition,
    closedResponseTombstoneCap: options.closedResponseTombstoneCap,
    afterPreflight: options.afterResponsePreflight,
  });
  const writeReversal = createWriteReversal({
    reversalStore,
    coordinator: options.coordinator,
    runtimeStore,
    mutationCommit,
    model: options.model,
    codec: options.codec,
    undoClientId,
    reversalNoticePort: options.reversalNoticePort,
    onInvariantViolation: options.onInvariantViolation,
    onReversalNoticeFailed: options.onReversalNoticeFailed,
  });

  const commands = createWriteCommands({
    options: {
      model: options.model,
      codec: options.codec,
      coordinator: options.coordinator,
      lifecycle: options.lifecycle,
      createRuntimeDoc: options.createRuntimeDoc,
    },
    threadOrigins,
    autoTurnCounter,
    autoTurnIdNonce,
    renderer,
    reversalStore,
    mutationCommit,
    runtimeStore,
    responseCommitter,
  });
  const reversalEndpoints = createWriteReversalEndpoints({
    coordinator: options.coordinator,
    localSessions,
    responseCommitter,
    writeReversal,
    runtimeStore,
    threadOrigins,
  });
  const dispatch = createWriteDispatch({ commands, reversal: reversalEndpoints });

  const write: WriteFunction = async (command, context = {}) => {
    const parsed = WriteCommandSchema.safeParse(command);
    const commandName = parsed.success ? parsed.data.command : fallbackCommandName(command);
    if (!parsed.success) {
      return toOutcome(commandName, status("invalid_write", writeSchemaError(parsed.error)));
    }

    const validCommand = parsed.data;
    const session = await resolveSession(context);
    const toolUseId = validCommand.tool_use_id ?? context.tool_use_id;
    const cacheKey = idempotencyCache.cacheKeyForToolUse(session, context, toolUseId);
    if (cacheKey) {
      const cached = idempotencyCache.get(cacheKey);
      if (
        cached !== undefined &&
        responseScopedStagedCacheStillValid(cached, context, session, toolUseId, responseCommitter)
      ) {
        idempotencyCache.notifyHit(session, context, toolUseId, cached);
        return cached;
      }
    }

    const result = await dispatch(validCommand, session, context).catch((cause: unknown) =>
      writeError(cause),
    );
    const outcome = toOutcome(validCommand.command, result);
    if (cacheKey && outcome.status !== "internal_error")
      idempotencyCache.remember(cacheKey, outcome);
    return outcome;
  };

  async function resolveSession(context: WriteContext): Promise<ActorSession> {
    if (context.session) return context.session;
    if (context.externalId && options.actorSessionStore) {
      return options.actorSessionStore.resolve(context.externalId);
    }
    const actorThreadId =
      context.actor?.kind === "agent" || context.actor?.kind === "human"
        ? context.actor.threadId
        : undefined;
    const id = context.sessionId ?? options.defaultSessionId ?? "default-session";
    const threadId = actorThreadId ?? context.threadId ?? options.defaultThreadId ?? id;
    const existing = localSessions.get(id);
    if (existing) return existing;
    const session: ActorSession = { id, threadId, documents: new Map() };
    localSessions.set(id, session);
    return session;
  }

  return {
    write,
    recover: (docId) => options.coordinator.recover(docId),
    commitResponse: responseCommitter.commitResponse,
    rollbackResponse: responseCommitter.rollbackResponse,
    bufferedUpdatesForDoc: responseCommitter.bufferedUpdatesForDoc,
    stagedCreatedDocumentIds: responseCommitter.stagedCreatedDocumentIds,
    getAvailability: writeReversal.getAvailability,
    undo: (docId, threadId) => reversalEndpoints.runTurnReversalEndpoint(docId, threadId, "undo"),
    redo: (docId, threadId) => reversalEndpoints.runTurnReversalEndpoint(docId, threadId, "redo"),
    reverse: reversalEndpoints.reverse,
    undoTurn: (docId, threadId) =>
      reversalEndpoints.runTurnReversalEndpoint(docId, threadId, "undo"),
    redoTurn: (docId, threadId) =>
      reversalEndpoints.runTurnReversalEndpoint(docId, threadId, "redo"),
    invalidateThread: reversalEndpoints.invalidateThread,
  };
}

function responseScopedStagedCacheStillValid(
  cached: WriteOutcome,
  context: WriteContext,
  session: ActorSession,
  toolUseId: string | undefined,
  responseCommitter: import("./response-committer.js").ResponseCommitter,
): boolean {
  if (!context.responseId || cached.status !== "success" || cached.phase !== "staged") {
    return true;
  }
  try {
    responseCommitter.assertCanStage({
      responseId: context.responseId,
      session,
      turnId: context.turnId,
      writeId: scopedToolUseId(context, toolUseId),
    });
    return true;
  } catch {
    return false;
  }
}
