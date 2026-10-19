import type * as Y from "yjs";
import type { z } from "zod";
import type { ActorSession } from "../ports/actor-session-store.js";
import { DocumentNotFoundError } from "../ports/document-coordinator.js";
import { ReadCommandSchema, WriteCommandSchema } from "./command-schema.js";
import { createCommitDetection } from "./commit-detection.js";
import { createDocumentEditCommands } from "./document-edits.js";
import { createDocumentRenderer } from "./document-renderer.js";
import type { InternalWriteResult } from "./internal-result.js";
import { isInternalWriteResult } from "./internal-result.js";
import type { AgentEditResultCommand } from "./model-result.js";
import { settledReceipt } from "./receipt.js";
import { createResponseCommitter, type ResponseCommitter } from "./response-committer.js";
import { status, toOutcome } from "./response-format.js";
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
  /** Buffer-only selection. Public finalizers take the typed provider/scope pair. */
  commitResponse(
    editScopeId: string,
    options?: import("./response-committer.js").ResponseCommitOptions,
  ): Promise<ResponseCommitSuccessResult>;
  prepareResponse: ResponseCommitter["prepareResponse"];
  rollbackResponse(
    editScopeId: string,
    options?: Pick<import("./response-committer.js").ResponseCommitOptions, "deferFinalization">,
  ): Promise<ResponseRollbackResult>;
  hasResponseDocument: ResponseCommitter["hasResponseDocument"];
  /**
   * A host's read of the document a call would see: the room copy with the reply's
   * surviving staged entries. The caller disposes it.
   */
  readRoom(
    docId: string,
    scope: { threadId: string; responseId?: string },
  ): Promise<{ doc: Y.Doc; room: string | null; dispose(): void }>;
  responseDocuments: ResponseCommitter["responseDocuments"];
  /** Move one response document's staged writes (one peer's, when named) to rejected receipts. */
  refuseStaged(
    responseId: string,
    documentId: string,
    reason: import("../ports/document-coordinator.js").StagedWriteRejectionReason,
    peerDraftId?: string,
  ): void;
  retirePeer(input: {
    documentId: string;
    threadId: string;
    peerDraftId: string;
    reason: import("../ports/document-coordinator.js").DiscardedWriteReason;
  }): void;
  /** Drop one thread's staged writes to a document: a save fence denied them. */
  dropStaged(docId: string, threadId: string): void;
}

export function createWriteTool(options: CreateWriteToolOptions): WriteTool {
  const localSessions = new Map<string, ActorSession>();
  const idempotencyCache = createWriteIdempotencyCache(options);
  const autoTurnIdNonce = createAutoTurnIdNonce();
  const autoTurnCounter = { value: 0 };
  const renderer = createDocumentRenderer({ model: options.model, codec: options.codec });
  const journal = options.journal;
  const detection = createCommitDetection({
    links: options.links,
    journal: options.journal,
    coordinator: options.coordinator,
    model: options.model,
  });
  const lifecyclePort = options.lifecycle;
  const responseCommitter = createResponseCommitter({
    detection,
    coordinator: options.coordinator,
    model: options.model,
    codec: options.codec,
    links: options.links,
    ensureDocument: lifecyclePort ? (docId) => lifecyclePort.ensureDocument(docId) : undefined,
    onLifecycleError: options.onResponseLifecycleError,
    onClaimDiscarded: options.onResponseClaimDiscarded,
    onTransition: options.onResponseCommitterTransition,
    closedResponseTombstoneCap: options.closedResponseTombstoneCap,
    onObservationFailed: options.onObservationFailed,
  });
  const commands = createWriteCommands({
    options: {
      model: options.model,
      codec: options.codec,
      coordinator: options.coordinator,
      lifecycle: options.lifecycle,
      links: options.links,
      semanticProvenance: options.semanticProvenance,
      onLinkSpliceFallback: options.onLinkSpliceFallback,
      onObservationFailed: options.onObservationFailed,
    },
    autoTurnCounter,
    autoTurnIdNonce,
    renderer,
    journal,
    responseCommitter,
  });
  const documentEdits = createDocumentEditCommands({ options, committer: responseCommitter });
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
    const session: ActorSession = { id, threadId };
    localSessions.set(id, session);
    return session;
  }

  return {
    read,
    write,
    commitResponse: responseCommitter.commitResponse,
    prepareResponse: responseCommitter.prepareResponse,
    rollbackResponse: responseCommitter.rollbackResponse,
    hasResponseDocument: responseCommitter.hasResponseDocument,
    async readRoom(docId, { threadId, responseId }) {
      const room = await responseCommitter.openRoom({
        docId,
        threadId,
        commandName: "read",
        ...(responseId ? { responseId } : {}),
      });
      if (isInternalWriteResult(room)) throw new DocumentNotFoundError(docId);
      return room;
    },
    responseDocuments: responseCommitter.responseDocuments,
    refuseStaged: responseCommitter.refuseStaged,
    retirePeer(input) {
      if (!input.documentId || !input.threadId || !input.peerDraftId)
        throw new Error("Retirement requires a document, thread and peer");
      responseCommitter.retirePeer(input);
    },
    dropStaged(docId, threadId) {
      if (!docId || !threadId) throw new Error("dropStaged names one document and one thread");
      responseCommitter.dropStaged(docId, threadId);
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
