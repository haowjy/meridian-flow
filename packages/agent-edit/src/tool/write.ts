import * as Y from "yjs";
import type { z } from "zod";
import type { ActorSession } from "../ports/actor-session-store.js";
import { ReadCommandSchema, WriteCommandSchema } from "./command-schema.js";
import { createDocumentEditCommands } from "./document-edits.js";
import { createDocumentRenderer } from "./document-renderer.js";
import type { InternalWriteResult } from "./internal-result.js";
import type { AgentEditResultCommand } from "./model-result.js";
import { createMutationCommit } from "./mutation-commit.js";
import { settledReceipt } from "./receipt.js";
import { createResponseCommitter, type ResponseCommitter } from "./response-committer.js";
import { status, toOutcome } from "./response-format.js";
import { createRuntimeStore } from "./runtime-store.js";
import type {
  DocumentCommandName,
  ReadFunction,
  ResponseCommitSuccessResult,
  ResponseRollbackResult,
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

export type { CreateWriteToolOptions } from "./write-deps.js";
export interface WriteTool {
  read: ReadFunction;
  write: WriteFunction;
  recover(docId: string): Promise<void>;
  /** Buffer-only selection. Public finalizers take the typed provider/scope pair. */
  commitResponse(
    editScopeId: string,
    options?: import("./response-committer.js").ResponseCommitOptions,
  ): Promise<ResponseCommitSuccessResult>;
  rollbackResponse(
    editScopeId: string,
    options?: Pick<import("./response-committer.js").ResponseCommitOptions, "deferFinalization">,
  ): Promise<ResponseRollbackResult>;
  hasResponseDocument: ResponseCommitter["hasResponseDocument"];
  prepare: ResponseCommitter["prepare"];
  responseDocuments: ResponseCommitter["responseDocuments"];
  /** Drop exactly one thread/document pair, including staged writes. */
  invalidateThreadDocument(docId: string, threadId: string): Promise<void>;
  /** Evict one thread's runtimes without revoking its response buffers. */
  evictThread(threadId: string): Promise<void>;
}

export function createWriteTool(options: CreateWriteToolOptions): WriteTool {
  const localSessions = new Map<string, ActorSession>();
  const idempotencyCache = createWriteIdempotencyCache(options);
  const autoTurnIdNonce = createAutoTurnIdNonce();
  const autoTurnCounter = { value: 0 };
  const renderer = createDocumentRenderer({ model: options.model, codec: options.codec });
  const journal = options.journal;
  const mutationCommit = createMutationCommit({
    links: options.links,
    journal: options.journal,
    coordinator: options.coordinator,
    model: options.model,
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
    links: options.links,
    ensureDocument: lifecyclePort ? (docId) => lifecyclePort.ensureDocument(docId) : undefined,
    onLifecycleError: options.onResponseLifecycleError,
    onClaimDiscarded: options.onResponseClaimDiscarded,
    onTransition: options.onResponseCommitterTransition,
    closedResponseTombstoneCap: options.closedResponseTombstoneCap,
    afterPreflight: options.afterResponsePreflight,
  });
  const commands = createWriteCommands({
    options: {
      model: options.model,
      codec: options.codec,
      coordinator: options.coordinator,
      lifecycle: options.lifecycle,
      createRuntimeDoc: options.createRuntimeDoc,
      links: options.links,
      semanticProvenance: options.semanticProvenance,
      onLinkSpliceFallback: options.onLinkSpliceFallback,
    },
    autoTurnCounter,
    autoTurnIdNonce,
    renderer,
    journal,
    mutationCommit,
    runtimeStore,
    responseCommitter,
  });
  const documentEdits = createDocumentEditCommands({
    options,
    committer: responseCommitter,
    runtimeStore,
  });
  const dispatch = createWriteDispatch({ commands, documentEdits });

  const read: ReadFunction = async (command, context = {}) => {
    const parsed = ReadCommandSchema.safeParse(command);
    if (!parsed.success) return invalidCommand("read", parsed.error);
    return execute("read", parsed.data, context, (valid, session) =>
      valid.format === "edits"
        ? documentEdits(valid, session, context)
        : commands.read(valid, session, context),
    );
  };

  const write: WriteFunction = async (command, context = {}) => {
    const parsed = WriteCommandSchema.safeParse(command);
    if (!parsed.success) return invalidCommand(fallbackCommandName(command), parsed.error);
    return execute(parsed.data.command, parsed.data, context, (valid, session) =>
      dispatch(valid, session, context),
    );
  };

  function invalidCommand(commandName: AgentEditResultCommand, error: z.ZodError): WriteOutcome {
    return toOutcome(commandName, status("invalid_write", writeSchemaError(error)));
  }

  async function execute<
    Command extends { file: string; documentId?: string; tool_use_id?: string },
  >(
    commandName: DocumentCommandName,
    validCommand: Command,
    context: WriteContext,
    run: (command: Command, session: ActorSession) => Promise<InternalWriteResult>,
  ): Promise<WriteOutcome> {
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
        return withNotices(cached, context);
      }
    }

    let result: InternalWriteResult;
    try {
      result = await run(validCommand, session);
    } catch (cause) {
      try {
        options.onUnexpectedWriteError?.({
          cause,
          command: commandName,
          ...(validCommand.documentId ? { documentId: validCommand.documentId } : {}),
          sessionId: session.id,
          threadId: session.threadId,
          ...(context.turnId ? { turnId: context.turnId } : {}),
          ...(context.responseIdentity?.editScopeId
            ? { responseId: context.responseIdentity?.editScopeId }
            : {}),
          ...(toolUseId ? { toolUseId } : {}),
        });
      } catch {
        // Host diagnostics must never change the model-facing write outcome.
      }
      result = writeError(cause);
    }
    const outcome = toOutcome(commandName, result, validCommand.file);
    if (
      commandName === "undo" ||
      commandName === "redo" ||
      commandName === "revert" ||
      ("format" in validCommand && validCommand.format === "edits")
    ) {
      const receipt = settledReceipt(
        { commandName, writeId: result.writeId ?? "", durableWriteId: result.settlementId ?? "" },
        result.revision ?? null,
        result,
      );
      outcome.result = { ...receipt.result, path: validCommand.file };
    }
    if (cacheKey && outcome.status !== "internal_error")
      idempotencyCache.remember(cacheKey, outcome);
    return withNotices(outcome, context);
  }

  function withNotices(outcome: WriteOutcome, context: WriteContext): WriteOutcome {
    const notices = context.responseIdentity?.editScopeId
      ? responseCommitter.drainNotices(context.responseIdentity?.editScopeId)
      : [];
    return notices.length
      ? {
          ...outcome,
          result: {
            ...outcome.result,
            message: [outcome.result.message, ...notices].filter(Boolean).join("\n"),
          },
        }
      : outcome;
  }

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
    const session: ActorSession = { id, threadId, documents: new Set() };
    localSessions.set(id, session);
    return session;
  }

  return {
    read,
    write,
    recover: (docId) => options.coordinator.recover(docId),
    commitResponse: responseCommitter.commitResponse,
    rollbackResponse: responseCommitter.rollbackResponse,
    hasResponseDocument: responseCommitter.hasResponseDocument,
    prepare: responseCommitter.prepare,
    responseDocuments: responseCommitter.responseDocuments,
    async invalidateThreadDocument(docId, threadId) {
      if (!docId || !threadId)
        throw new Error("invalidateThreadDocument names one document and one thread");
      responseCommitter.dropForThread(docId, threadId);
      await runtimeStore.evictThreadRuntimes(docId, threadId, { markLiveDocStale: true });
    },
    async evictThread(threadId) {
      if (!threadId) throw new Error("evictThread names one thread");
      await runtimeStore.evictThreadRuntimes(null, threadId);
    },
  };
}

function responseScopedStagedCacheStillValid(
  cached: WriteOutcome,
  context: WriteContext,
  session: ActorSession,
  toolUseId: string | undefined,
  responseCommitter: import("./response-committer.js").ResponseCommitter,
): boolean {
  if (
    !context.responseIdentity?.editScopeId ||
    cached.status !== "success" ||
    cached.phase !== "staged"
  ) {
    return true;
  }
  try {
    responseCommitter.assertCanStage({
      responseId: context.responseIdentity?.editScopeId,
      session,
      turnId: context.turnId,
      writeId: scopedToolUseId(context, toolUseId),
    });
    return true;
  } catch {
    return false;
  }
}
