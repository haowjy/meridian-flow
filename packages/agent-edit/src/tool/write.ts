// Dispatches the LLM write(command=...) surface onto codec, resolver, apply, journal, and undo ports.
import * as Y from "yjs";

import { diffSnapshots, snapshotBlocks } from "../apply/echo.js";
import { applyEdits } from "../apply/tiers.js";
import type {
  ApplyEchoHunk,
  ApplyResult,
  ConcurrentEditInfo,
  ConcurrentUpdateOrigin,
} from "../apply/types.js";
import type { Codec } from "../codec/types.js";
import type { YProsemirrorDocumentModel } from "../model/y-prosemirror.js";
import type { ActorSession, ActorSessionStore } from "../ports/actor-session-store.js";
import type { DocumentCoordinator } from "../ports/document-coordinator.js";
import type { DocumentLifecycle } from "../ports/document-lifecycle.js";
import type { MutationStore } from "../ports/mutation-store.js";
import type { ReversalRecord, UpdateMeta } from "../ports/types.js";
import type { UpdateJournal } from "../ports/update-journal.js";
import { resolveWrite } from "../resolver/resolve.js";
import {
  latestRedoableTarget,
  latestUndoableTurn,
  resolveUndoAvailability,
  type UndoAvailability,
} from "../undo/availability.js";
import { createUndoManagerRegistry, type UndoManagerRegistry } from "../undo/manager-registry.js";
import { reconstructRedoUpdate, reconstructUndoUpdate } from "../undo/reconstruction.js";
import { withLiveDocument } from "./coordinator.js";
import { createDocumentRenderer } from "./document-renderer.js";
import { type InternalWriteResult, isInternalWriteResult } from "./internal-result.js";
import { createMutationCommit, type SyncedMutationSummary } from "./mutation-commit.js";
import { createResponseStaging } from "./response-staging.js";
import { createRuntimeStore, type RuntimeDocumentState } from "./runtime-store.js";
import type {
  RedoCommand,
  ResponseCommitResult,
  ResponseRollbackResult,
  TurnRedoResult,
  TurnUndoResult,
  UndoCommand,
  UndoRedoOutcome,
  ViewCommand,
  WriteCommand,
  WriteCommandName,
  WriteContext,
  WriteErrorStatus,
  WriteFunction,
  WriteOutcome,
  WriteStatus,
} from "./types.js";

export interface CreateWriteToolOptions {
  journal: UpdateJournal;
  mutationStore: MutationStore;
  coordinator: DocumentCoordinator;
  lifecycle?: DocumentLifecycle;
  codec: Codec;
  model: YProsemirrorDocumentModel;
  undoRegistry?: UndoManagerRegistry;
  actorSessionStore?: ActorSessionStore;
  retention?: {
    reversalWindowMs?: number;
  };
  idempotency?: {
    maxEntries?: number;
  };
  /** Server-local fallback identity when no ActorSession/ActorSessionStore is supplied. */
  defaultSessionId?: string;
  defaultThreadId?: string;
  /** Fresh Yjs client id used for cold undo/redo reconstruction. */
  undoClientId?: number;
}

export interface WriteTool {
  write: WriteFunction;
  registry: UndoManagerRegistry;
  recover(docId: string): Promise<void>;
  commitResponse(responseId: string): Promise<ResponseCommitResult>;
  rollbackResponse(responseId: string): Promise<ResponseRollbackResult>;
  getAvailability(docId: string, threadId: string): Promise<UndoAvailability>;
  undoTurn(docId: string, threadId: string): Promise<TurnUndoResult>;
  redoTurn(docId: string, threadId: string): Promise<TurnRedoResult>;
  invalidateThread(docId: string, threadId: string): void;
}

interface FileAddress {
  filePath: string;
  fragment?: string;
}

interface ApplySuccessResponseInput {
  echo: ApplyEchoHunk[];
  concurrentEdits?: ConcurrentEditInfo;
  deletedBlocks?: readonly string[];
}

type ReversalResult =
  | {
      ok: true;
      status: UndoRedoOutcome;
      sync?: SyncedMutationSummary;
    }
  | { ok: false; response: InternalWriteResult };

const DEFAULT_IDEMPOTENCY_ENTRIES = 500;
export function createWriteTool(options: CreateWriteToolOptions): WriteTool {
  const registry = options.undoRegistry ?? createUndoManagerRegistry();
  const lifecycle = options.lifecycle;
  const localSessions = new Map<string, ActorSession>();
  const idempotency = new Map<string, WriteOutcome>();
  const maxIdempotencyEntries = options.idempotency?.maxEntries ?? DEFAULT_IDEMPOTENCY_ENTRIES;
  const renderer = createDocumentRenderer({ model: options.model, codec: options.codec });
  const mutationCommit = createMutationCommit({
    journal: options.journal,
    registry,
    coordinator: options.coordinator,
    model: options.model,
    codec: options.codec,
  });
  const runtimeStore = createRuntimeStore({
    coordinator: options.coordinator,
    journal: options.journal,
    registry,
    model: options.model,
    codec: options.codec,
  });
  const { markSynced, requireSynced, restoreRuntimeFromLive, runtimeFor, syncLocalFromLive } =
    runtimeStore;
  const responseStaging = createResponseStaging({
    journal: options.journal,
    registry,
    runtimeStore,
    mutationCommit,
    ensureDocument: lifecycle ? (docId) => lifecycle.ensureDocument(docId) : undefined,
  });

  const write: WriteFunction = async (command, context = {}) => {
    const session = await resolveSession(context);
    const toolUseId = command.tool_use_id ?? context.tool_use_id;
    const cacheKey = toolUseId ? `${session.id}\u0000${toolUseId}` : undefined;
    if (cacheKey) {
      const cached = idempotency.get(cacheKey);
      if (cached !== undefined) return cached;
    }

    const result = await dispatch(command, session, context).catch((cause: unknown) =>
      internalError(cause),
    );
    const outcome = toOutcome(command.command, result);
    if (cacheKey) remember(cacheKey, outcome);
    return outcome;
  };

  return {
    write,
    registry,
    recover: (docId) => options.coordinator.recover(docId),
    commitResponse: responseStaging.commitResponse,
    rollbackResponse: responseStaging.rollbackResponse,
    getAvailability,
    undoTurn: (docId, threadId) => runTurnReversal(docId, threadId, "undo"),
    redoTurn: (docId, threadId) => runTurnReversal(docId, threadId, "redo"),
    invalidateThread,
  };

  async function dispatch(
    command: WriteCommand,
    session: ActorSession,
    context: WriteContext,
  ): Promise<InternalWriteResult> {
    switch (command.command) {
      case "view":
        return view(command, session, context);
      case "create":
        return create(command, session, context);
      case "insert":
      case "replace":
        return mutate(command, session, context);
      case "undo":
        return undoOrRedo(command, session, "undo", context);
      case "redo":
        return undoOrRedo(command, session, "redo", context);
    }
  }

  async function resolveSession(context: WriteContext): Promise<ActorSession> {
    if (context.session) return context.session;
    if (context.externalId && options.actorSessionStore) {
      return options.actorSessionStore.resolve(context.externalId);
    }

    const id = context.sessionId ?? options.defaultSessionId ?? "default-session";
    const threadId = context.threadId ?? options.defaultThreadId ?? id;
    return localSession(id, threadId);
  }

  function localSession(id: string, threadId: string): ActorSession {
    const existing = localSessions.get(id);
    if (existing) return existing;
    const session: ActorSession = { id, threadId, documents: new Map() };
    localSessions.set(id, session);
    return session;
  }

  async function view(
    command: ViewCommand,
    session: ActorSession,
    context: WriteContext,
  ): Promise<InternalWriteResult> {
    const address = parseFileAddress(command.file);
    if (!address.ok) return status("invalid_write", address.message);
    const runtime = runtimeFor(session, address.filePath);

    if (
      !context.responseId ||
      !responseStaging.hasBufferedWritesForDoc(context.responseId, address.filePath)
    ) {
      const synced = await syncLocalFromLive(session, address.filePath, runtime, command.command);
      if (!synced.ok) return synced.response;
    }

    const selection = renderer.selectViewBlocks(runtime.doc, command, address);
    if (!selection.ok) return errorResponse(selection.code, selection.message, address.filePath);
    if (command.format === "outline") {
      return success(renderer.renderOutline(runtime.doc, selection.blocks, address.filePath));
    }
    return success(renderer.renderBlocks(runtime.doc, selection.blocks));
  }

  async function create(
    command: Extract<WriteCommand, { command: "create" }>,
    session: ActorSession,
    context: WriteContext,
  ): Promise<InternalWriteResult> {
    const address = parseFileAddress(command.file);
    if (!address.ok) return status("invalid_write", address.message);
    if (address.fragment) {
      return status("invalid_write", "create does not accept a #fragment in file.");
    }
    if (!options.lifecycle) {
      return status("invalid_write", "document creation is not supported by this deployment");
    }

    const runtime = runtimeFor(session, address.filePath);
    if (options.model.getBlocks(runtime.doc).length > 0) {
      return status("invalid_write", `File already exists: ${address.filePath}`);
    }
    const parsed = renderer.parseForCommand(command.content ?? "");
    if (!parsed.ok) return status("invalid_write", parsed.message);

    const stagedCreate = context.responseId !== undefined;
    if (!stagedCreate) await options.lifecycle.ensureDocument(address.filePath);
    const liveCheck = await withLiveDocument(
      options.coordinator,
      address.filePath,
      command.command,
      (liveDoc) =>
        options.model.getBlocks(liveDoc).length > 0
          ? status("invalid_write", `File already exists: ${address.filePath}`)
          : null,
    );
    const missingLiveForStagedCreate =
      stagedCreate && isInternalWriteResult(liveCheck) && liveCheck.status === "document_not_found";
    // Response-staged creates may intentionally defer live document creation
    // until commit so rollback leaves no empty Y.Doc behind.
    if (isInternalWriteResult(liveCheck) && !missingLiveForStagedCreate) return liveCheck;

    const turnId = nextTurnId(session, address.filePath, runtime, context);
    const beforeVector = Y.encodeStateVector(runtime.doc);
    const origin = registry.beginTurn(
      address.filePath,
      session.threadId,
      runtime.doc,
      turnId,
    ).origin;
    try {
      runtime.doc.transact(() => {
        options.model.insertBlocks(runtime.doc, null, parsed.parsed);
      }, origin);
    } finally {
      registry.endTurn(address.filePath, session.threadId, turnId);
    }
    const update = Y.encodeStateAsUpdate(runtime.doc, beforeVector);
    const meta = agentMeta(turnId);

    if (context.responseId) {
      responseStaging.stageUpdate({
        responseId: context.responseId,
        docId: address.filePath,
        session,
        runtime,
        commandName: command.command,
        update,
        meta,
        liveOrigin: agentUpdateOrigin(turnId),
        turnId,
        ensureDocumentBeforeCommit: true,
      });
      runtime.undoStack.push(turnId);
      runtime.redoStack = [];
      markSynced(session, address.filePath, runtime);
      return formatApplySuccess({
        echo: [{ mode: "truncated", blocks: renderer.renderBlockLines(runtime.doc) }],
      });
    }

    const committed = await mutationCommit.commitUpdatesToJournalAndLive({
      docId: address.filePath,
      commandName: command.command,
      updates: [{ update, meta, mutation: { threadId: session.threadId, turnId } }],
      afterOwnVector: Y.encodeStateVector(runtime.doc),
      liveOrigin: agentUpdateOrigin(turnId),
    });
    if (!committed.ok) return committed.response;

    runtime.undoStack.push(turnId);
    runtime.redoStack = [];
    markSynced(session, address.filePath, runtime);
    return formatApplySuccess({
      echo: [{ mode: "truncated", blocks: renderer.renderBlockLines(runtime.doc) }],
    });
  }

  async function mutate(
    command: Extract<WriteCommand, { command: "insert" | "replace" }>,
    session: ActorSession,
    context: WriteContext,
  ): Promise<InternalWriteResult> {
    const address = parseFileAddress(command.file);
    if (!address.ok) return status("invalid_write", address.message);
    const runtime = runtimeFor(session, address.filePath);
    const synced = requireSynced(session, address.filePath);
    if (!synced.ok) return synced.response;

    const resolved = resolveWrite(
      { doc: runtime.doc, model: options.model, codec: options.codec },
      { ...command, documentId: address.filePath, file: command.file },
    );
    if (!resolved.ok) {
      return errorResponse(resolved.error.code, resolved.error.message, address.filePath);
    }

    const before = snapshotBlocks(runtime.doc, options.model, options.codec);
    const beforeVector = Y.encodeStateVector(runtime.doc);
    const turnId = nextTurnId(session, address.filePath, runtime, context);
    const origin = registry.beginTurn(
      address.filePath,
      session.threadId,
      runtime.doc,
      turnId,
    ).origin;
    let applied: ApplyResult;
    try {
      applied = applyEdits(runtime.doc, options.model, options.codec, resolved.edits, origin, {
        ownActorTurnId: turnId,
        syncStateVector: synced.stateVector,
      });
    } finally {
      registry.endTurn(address.filePath, session.threadId, turnId);
    }
    if (!applied.ok)
      return errorResponse(applied.error.code, applied.error.message, address.filePath);

    const afterOwnVector = Y.encodeStateVector(runtime.doc);
    const ownUpdate = Y.encodeStateAsUpdate(runtime.doc, beforeVector);
    const meta = agentMeta(turnId);

    if (context.responseId) {
      responseStaging.stageUpdate({
        responseId: context.responseId,
        docId: address.filePath,
        session,
        runtime,
        commandName: command.command,
        update: ownUpdate,
        meta,
        liveOrigin: agentUpdateOrigin(turnId),
        turnId,
      });
      const summary = mutationCommit.summarizeMutationEcho({
        runtime,
        before,
        touchedHashes: new Set(applied.changedBlocks ?? []),
        deletedHashes: new Set(applied.deletedBlocks ?? []),
        structuralChange: hasStructuralChange(applied),
      });
      runtime.undoStack.push(turnId);
      runtime.redoStack = [];
      markSynced(session, address.filePath, runtime);
      return formatApplySuccess({
        echo: summary.echo,
        deletedBlocks: applied.deletedBlocks,
      });
    }

    const syncedMutation = await mutationCommit.syncAfterLocalMutation({
      docId: address.filePath,
      commandName: command.command,
      runtime,
      update: ownUpdate,
      meta,
      mutation: { threadId: session.threadId, turnId },
      afterOwnVector,
      liveOrigin: agentUpdateOrigin(turnId),
      before,
      touchedHashes: new Set(applied.changedBlocks ?? []),
      deletedHashes: new Set(applied.deletedBlocks ?? []),
      structuralChange: hasStructuralChange(applied),
      ownTurnId: turnId,
    });
    if (!syncedMutation.ok) return syncedMutation.response;

    runtime.undoStack.push(turnId);
    runtime.redoStack = [];
    markSynced(session, address.filePath, runtime);
    return formatApplySuccess({
      echo: syncedMutation.summary.echo,
      concurrentEdits: syncedMutation.summary.concurrentEdits,
      deletedBlocks: applied.deletedBlocks,
    });
  }

  async function undoOrRedo(
    command: UndoCommand | RedoCommand,
    session: ActorSession,
    direction: "undo" | "redo",
    context: WriteContext,
  ): Promise<InternalWriteResult> {
    const address = parseFileAddress(command.file);
    if (!address.ok) return status("invalid_write", address.message);
    if (context.responseId && responseStaging.hasBufferedWrites(context.responseId)) {
      // Undo/redo read and write committed journal state; flush staged response
      // writes first so reversal order matches the model's tool-call order.
      await responseStaging.commitResponse(context.responseId);
    }
    const runtime = runtimeFor(session, address.filePath);
    const synced = requireSynced(session, address.filePath);
    if (!synced.ok) return synced.response;
    const count = commandCount(command);
    if (!count.ok) return status("invalid_write", count.message);

    return runUndoOrRedo({
      docId: address.filePath,
      session,
      runtime,
      commandName: command.command,
      direction,
      count,
    });
  }

  function runTurnReversal(
    docId: string,
    threadId: string,
    direction: "undo",
  ): Promise<TurnUndoResult>;
  function runTurnReversal(
    docId: string,
    threadId: string,
    direction: "redo",
  ): Promise<TurnRedoResult>;
  async function runTurnReversal(
    docId: string,
    threadId: string,
    direction: "undo" | "redo",
  ): Promise<TurnUndoResult | TurnRedoResult> {
    invalidateThread(docId, threadId);
    const session = localSession(`turn-reversal:${threadId}`, threadId);
    const runtime = runtimeFor(session, docId);
    const synced = await syncLocalFromLive(session, docId, runtime, direction);
    const result = !synced.ok
      ? synced.response
      : await runUndoOrRedo({
          docId,
          session,
          runtime,
          commandName: direction,
          direction,
          count: { all: false, count: 1 },
        });
    if (result.status !== "document_not_found") invalidateThread(docId, threadId);
    return toOutcome(direction, result) as TurnUndoResult | TurnRedoResult;
  }

  async function getAvailability(docId: string, threadId: string): Promise<UndoAvailability> {
    const availability = await resolveUndoAvailability({
      journal: options.journal,
      mutationStore: options.mutationStore,
      docId,
      threadId,
    });
    return {
      undo: availability.undo,
      redo: availability.redo,
      ...(availability.undoTurnId ? { undoTurnId: availability.undoTurnId } : {}),
      ...(availability.redoTurnId ? { redoTurnId: availability.redoTurnId } : {}),
    };
  }

  async function runUndoOrRedo(input: {
    docId: string;
    session: ActorSession;
    runtime: RuntimeDocumentState;
    commandName: WriteCommand["command"];
    direction: "undo" | "redo";
    count: { all: boolean; count: number };
  }): Promise<InternalWriteResult> {
    let applied = 0;
    let lastOutcome: UndoRedoOutcome | null = null;
    const echo: ApplyEchoHunk[] = [];
    const concurrentEdits: ConcurrentEditInfo[] = [];
    let sawReconcile = false;
    const limit = input.count.all ? Number.POSITIVE_INFINITY : input.count.count;

    while (applied < limit) {
      const result =
        input.direction === "undo"
          ? await undoOne(input.docId, input.session, input.runtime, input.commandName)
          : await redoOne(input.docId, input.session, input.runtime, input.commandName);
      if (!result.ok) return result.response;
      if (result.status === "nothing_to_undo" || result.status === "nothing_to_redo") {
        if (applied === 0) return status(result.status);
        lastOutcome = input.count.all ? (sawReconcile ? "reconciled" : "reversed") : "partial";
        break;
      }
      if (result.status === "expired") {
        if (applied === 0) return status("expired");
        lastOutcome = "partial";
        break;
      }
      if (result.status !== "reversed" && result.status !== "reconciled") {
        lastOutcome = result.status;
        break;
      }
      if (result.status === "reconciled") sawReconcile = true;
      if (result.sync) {
        echo.push(...result.sync.echo);
        if (result.sync.concurrentEdits) concurrentEdits.push(result.sync.concurrentEdits);
      }
      applied += 1;
      markSynced(input.session, input.docId, input.runtime);
    }

    const outcome = lastOutcome ?? (sawReconcile ? "reconciled" : "reversed");
    const lines = [`status: ${outcome}`];
    if (applied > 0) lines.push("", `${input.direction}: ${applied} edit(s)`);
    const echoLines = echo.flatMap((hunk) => hunk.blocks).filter((line) => line.length > 0);
    if (echoLines.length > 0) lines.push("", ...echoLines);
    for (const concurrent of concurrentEdits) lines.push("", ...formatConcurrent(concurrent));
    return result(outcome, lines.join("\n"));
  }

  async function undoOne(
    docId: string,
    session: ActorSession,
    runtime: RuntimeDocumentState,
    commandName: WriteCommand["command"],
  ): Promise<ReversalResult> {
    const availableTurnId = await latestUndoableTurn({
      journal: options.journal,
      mutationStore: options.mutationStore,
      docId,
      threadId: session.threadId,
    });
    if (!availableTurnId) return { ok: true, status: "nothing_to_undo" };

    const before = snapshotBlocks(runtime.doc, options.model, options.codec);
    const beforeVector = Y.encodeStateVector(runtime.doc);
    const hot = registry.undoLatest(docId, session.threadId, {
      scope: "turn",
      turnId: availableTurnId,
      mutationClientId: options.undoClientId,
    });
    let turnId: string | undefined;
    let update: Uint8Array | undefined;

    if (hot.ok) {
      turnId = hot.turnId;
      update = Y.encodeStateAsUpdate(runtime.doc, beforeVector);
    } else if (hot.status !== "no_manager" && hot.status !== "no_undo") {
      registry.evictThread(docId, session.threadId);
      update = undefined;
      turnId = undefined;
    }

    if (!turnId || !update) {
      try {
        const cold = await reconstructUndoUpdate(options.journal, docId, availableTurnId, {
          undoClientId: options.undoClientId,
        });
        turnId = availableTurnId;
        update = cold.undoUpdate;
        Y.applyUpdate(runtime.doc, update, { type: "system" });
      } catch (_cause) {
        return { ok: true, status: "nothing_to_undo" };
      }
    }

    if (turnId !== availableTurnId) {
      registry.evictThread(docId, session.threadId);
      return { ok: true, status: "partial" };
    }
    const afterOwnVector = Y.encodeStateVector(runtime.doc);
    const ownDiff = diffSnapshots(
      before,
      snapshotBlocks(runtime.doc, options.model, options.codec),
    );

    const record: ReversalRecord = {
      documentId: docId,
      turnId,
      threadId: session.threadId,
      status: "reversed",
      undoUpdateSeq: 0,
      reversedAt: new Date(),
      ...(options.retention?.reversalWindowMs
        ? { expiresAt: new Date(Date.now() + options.retention.reversalWindowMs) }
        : {}),
    };
    await options.journal.persistReversal(docId, update, record);
    const sync = await mutationCommit.syncAfterLocalMutation({
      docId,
      commandName,
      runtime,
      update,
      afterOwnVector,
      liveOrigin: { type: "system" },
      before,
      touchedHashes: new Set([...ownDiff.changed, ...ownDiff.inserted]),
      deletedHashes: ownDiff.deleted,
      structuralChange: ownDiff.deleted.size > 0 || ownDiff.inserted.size > 0,
    });
    if (!sync.ok) return { ok: false, response: sync.response };
    popIfTop(runtime.undoStack, turnId);
    runtime.redoStack.push({ turnId, undoUpdateSeq: record.undoUpdateSeq || undefined });
    return {
      ok: true,
      status: sync.summary.reconciled ? "reconciled" : "reversed",
      sync: sync.summary,
    };
  }

  async function redoOne(
    docId: string,
    session: ActorSession,
    runtime: RuntimeDocumentState,
    commandName: WriteCommand["command"],
  ): Promise<ReversalResult> {
    const redoTarget = await latestRedoableTarget({
      journal: options.journal,
      mutationStore: options.mutationStore,
      docId,
      threadId: session.threadId,
    });
    if (!redoTarget) return { ok: true, status: "nothing_to_redo" };

    const before = snapshotBlocks(runtime.doc, options.model, options.codec);
    let update: Uint8Array | undefined;
    let locallyApplied = false;
    const hotRedoTurn = registry.getState(docId, session.threadId)?.redoStack.at(-1)?.turnId;
    if (hotRedoTurn === redoTarget.turnId) {
      const beforeVector = Y.encodeStateVector(runtime.doc);
      const hot = registry.redoLatest(docId, session.threadId, {
        mutationClientId: options.undoClientId,
      });
      if (hot.ok) {
        update = Y.encodeStateAsUpdate(runtime.doc, beforeVector);
        locallyApplied = true;
      }
    }

    if (!update) {
      const cold = await reconstructRedoUpdate(
        options.journal,
        docId,
        redoTarget.turnId,
        redoTarget.undoUpdateSeq,
        { undoClientId: options.undoClientId },
      ).catch(() => null);
      if (!cold?.ok) {
        popIfTop(runtime.redoStack, redoTarget.turnId);
        registry.evictThread(docId, session.threadId);
        return { ok: true, status: "nothing_to_redo" };
      }
      update = cold.redoUpdate;
    }

    let consumed: { consumed: boolean; seq?: number };
    try {
      consumed = await options.journal.persistRedo(
        docId,
        update,
        {
          threadId: session.threadId,
          turnId: redoTarget.turnId,
          undoUpdateSeq: redoTarget.undoUpdateSeq,
        },
        { origin: "system", seq: 0 },
      );
    } catch (cause) {
      if (locallyApplied) await restoreRuntimeFromLive(session, docId, runtime, commandName);
      registry.evictThread(docId, session.threadId);
      throw cause;
    }
    if (!consumed.consumed) {
      popIfTop(runtime.redoStack, redoTarget.turnId);
      registry.evictThread(docId, session.threadId);
      if (locallyApplied) {
        const restored = await restoreRuntimeFromLive(session, docId, runtime, commandName);
        if (isInternalWriteResult(restored)) return { ok: false, response: restored };
      }
      return { ok: true, status: "nothing_to_redo" };
    }

    const turnId = redoTarget.turnId;
    if (!locallyApplied) Y.applyUpdate(runtime.doc, update, { type: "system" });
    const afterOwnVector = Y.encodeStateVector(runtime.doc);
    const ownDiff = diffSnapshots(
      before,
      snapshotBlocks(runtime.doc, options.model, options.codec),
    );

    const sync = await mutationCommit.syncAfterLocalMutation({
      docId,
      commandName,
      runtime,
      update,
      afterOwnVector,
      liveOrigin: { type: "system" },
      before,
      touchedHashes: new Set([...ownDiff.changed, ...ownDiff.inserted]),
      deletedHashes: ownDiff.deleted,
      structuralChange: ownDiff.deleted.size > 0 || ownDiff.inserted.size > 0,
    });
    if (!sync.ok) return { ok: false, response: sync.response };
    popIfTop(runtime.redoStack, turnId);
    if (!locallyApplied) registry.evictThread(docId, session.threadId);
    runtime.undoStack.push(turnId);
    return {
      ok: true,
      status: sync.summary.reconciled ? "reconciled" : "reversed",
      sync: sync.summary,
    };
  }

  function invalidateThread(docId: string, threadId: string): void {
    responseStaging.dropForThread(docId, threadId);
    runtimeStore.evictThreadRuntimes(docId, threadId, { needsRecovery: true });
    registry.evictThread(docId, threadId);
  }

  function nextTurnId(
    session: ActorSession,
    docId: string,
    runtime: RuntimeDocumentState,
    context: WriteContext,
  ): string {
    if (context.turnId) return context.turnId;
    runtime.turnCounter += 1;
    return `${session.threadId}:${docId}:turn-${runtime.turnCounter}`;
  }

  function remember(cacheKey: string, outcome: WriteOutcome): void {
    idempotency.set(cacheKey, outcome);
    while (idempotency.size > maxIdempotencyEntries) {
      const oldest = idempotency.keys().next().value;
      if (oldest === undefined) break;
      idempotency.delete(oldest);
    }
  }
}

function parseFileAddress(
  file: string,
): ({ ok: true } & FileAddress) | { ok: false; message: string } {
  const [filePath, fragment] = file.split("#", 2);
  if (!filePath) return { ok: false, message: "file is required" };
  return fragment === undefined ? { ok: true, filePath } : { ok: true, filePath, fragment };
}

function formatApplySuccess(input: ApplySuccessResponseInput): InternalWriteResult {
  const lines = ["status: success"];
  if (input.deletedBlocks && input.deletedBlocks.length > 0) {
    lines.push("", `deleted: ${input.deletedBlocks.join(", ")}`);
  }
  const echoLines = input.echo.flatMap((hunk) => hunk.blocks).filter((line) => line.length > 0);
  if (echoLines.length > 0) lines.push("", ...echoLines);
  if (input.concurrentEdits) lines.push("", ...formatConcurrent(input.concurrentEdits));
  return result("success", lines.join("\n"));
}

function formatConcurrent(info: ConcurrentEditInfo): string[] {
  const lines = ["concurrent edits:"];
  if (info.human.length > 0) lines.push(`  human: ${info.human.join(", ")}`);
  if (info.agent.length > 0) lines.push(`  agent: ${info.agent.join(", ")}`);
  if (info.reviewCommand) lines.push(info.reviewCommand);
  return lines;
}

function errorResponse(
  code: WriteErrorStatus,
  message: string,
  filePath: string,
): InternalWriteResult {
  const needsView = code === "not_found" && !message.includes('write(command="view"');
  return status(
    code,
    needsView ? `${message}. Run write(command="view", file="${filePath}") to re-sync.` : message,
  );
}

function status(code: WriteStatus, message?: string): InternalWriteResult {
  return result(code, message ? `status: ${code}\n\n${message}` : `status: ${code}`);
}

function success(text: string): InternalWriteResult {
  return result("success", text);
}

function result(status: WriteStatus, text: string): InternalWriteResult {
  return { status, text };
}

function internalError(cause: unknown): InternalWriteResult {
  const reason = cause instanceof Error && cause.message ? ` ${cause.message}` : "";
  return status("internal_error", `Retry — transient edit system failure.${reason}`);
}

function toOutcome(command: WriteCommandName, result: InternalWriteResult): WriteOutcome {
  return {
    command,
    status: result.status,
    isError: isWriteErrorStatus(result.status),
    text: result.text,
  };
}

function isWriteErrorStatus(status: WriteStatus): status is WriteErrorStatus {
  return (
    status === "not_found" ||
    status === "ambiguous_match" ||
    status === "invalid_write" ||
    status === "document_not_found" ||
    status === "partial_failure" ||
    status === "internal_error"
  );
}

function commandCount(
  command: UndoCommand | RedoCommand,
): { ok: true; all: boolean; count: number } | { ok: false; message: string } {
  if (command.all === true) return { ok: true, all: true, count: Number.POSITIVE_INFINITY };
  const count = command.last ?? 1;
  if (!Number.isInteger(count) || count < 1) {
    return { ok: false, message: "last must be a positive integer" };
  }
  return { ok: true, all: false, count };
}

function hasStructuralChange(result: Extract<ApplyResult, { ok: true }>): boolean {
  return result.appliedEdits?.some((edit) => edit.kind !== "text") ?? false;
}

function agentMeta(turnId: string): UpdateMeta {
  return { origin: `agent:${turnId}`, actorTurnId: turnId, seq: 0 };
}

function agentUpdateOrigin(turnId: string): ConcurrentUpdateOrigin & { type: "agent" } {
  return { type: "agent", actorTurnId: turnId };
}

function popIfTop(stack: string[], value: string): void;
function popIfTop(stack: Array<{ turnId: string; undoUpdateSeq?: number }>, value: string): void;
function popIfTop(
  stack: string[] | Array<{ turnId: string; undoUpdateSeq?: number }>,
  value: string,
): void {
  const last = stack.at(-1);
  if (typeof last === "string") {
    while (stack.at(-1) === value) stack.pop();
    return;
  }
  let item = stack.at(-1);
  while (item && typeof item !== "string" && item.turnId === value) {
    stack.pop();
    item = stack.at(-1);
  }
}
