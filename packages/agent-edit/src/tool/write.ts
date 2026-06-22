// Dispatches the LLM write(command=...) surface onto codec, resolver, apply, journal, and undo ports.
import * as Y from "yjs";

import {
  applyConcurrentUpdates,
  type BlockSnapshot,
  type ConcurrentDetectionResult,
  computeEcho,
  diffSnapshots,
  snapshotBlocks,
} from "../apply/echo.js";
import { applyEdits } from "../apply/tiers.js";
import type {
  ApplyEchoHunk,
  ApplyResult,
  ConcurrentEditInfo,
  ConcurrentUpdateOrigin,
} from "../apply/types.js";
import type { Codec, ParsedContent } from "../codec/types.js";
import type { YProsemirrorDocumentModel } from "../model/y-prosemirror.js";
import type { ActorSession, ActorSessionStore } from "../ports/actor-session-store.js";
import {
  type DocumentCoordinator,
  isDocumentNotFoundError,
} from "../ports/document-coordinator.js";
import type { DocumentLifecycle } from "../ports/document-lifecycle.js";
import type { ReversalRecord, UpdateMeta } from "../ports/types.js";
import type { UpdateJournal } from "../ports/update-journal.js";
import { resolveWrite } from "../resolver/resolve.js";
import { isHeading, resolveScope, resolveSearchScope } from "../resolver/scope.js";
import { createUndoManagerRegistry, type UndoManagerRegistry } from "../undo/manager-registry.js";
import {
  groupUpdatesByTurn,
  reconstructRedoUpdate,
  reconstructUndoUpdate,
} from "../undo/reconstruction.js";
import { rehydrateRedoStack } from "./redo-rehydration.js";
import type {
  RedoCommand,
  UndoCommand,
  UndoRedoOutcome,
  ViewCommand,
  WriteCommand,
  WriteContext,
  WriteFunction,
  WriteResult,
} from "./types.js";

export interface CreateWriteToolOptions {
  journal: UpdateJournal;
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
}

interface RuntimeDocumentState {
  doc: Y.Doc;
  turnCounter: number;
  undoStack: string[];
  redoStack: Array<{ turnId: string; undoUpdateSeq?: number }>;
  redoStackRehydrated: boolean;
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

interface SyncedMutationSummary {
  echo: ApplyEchoHunk[];
  concurrentEdits?: ConcurrentEditInfo;
  reconciled: boolean;
}

interface LocalMutationSyncInput {
  docId: string;
  commandName: WriteCommand["command"];
  runtime: RuntimeDocumentState;
  update: Uint8Array;
  afterOwnVector: Uint8Array;
  liveOrigin: ConcurrentUpdateOrigin;
  before: readonly BlockSnapshot[];
  touchedHashes: ReadonlySet<string>;
  deletedHashes: ReadonlySet<string>;
  structuralChange: boolean;
  ownTurnId?: string;
}

type ReversalResult =
  | {
      ok: true;
      status: UndoRedoOutcome;
      turnId: string;
      sync?: SyncedMutationSummary;
    }
  | { ok: false; response: WriteResult };

const DEFAULT_IDEMPOTENCY_ENTRIES = 500;
const EMPTY_UPDATE_LENGTH = 2;

export function createWriteTool(options: CreateWriteToolOptions): WriteTool {
  const registry = options.undoRegistry ?? createUndoManagerRegistry();
  const runtimeDocs = new Map<string, RuntimeDocumentState>();
  const localSessions = new Map<string, ActorSession>();
  const idempotency = new Map<string, WriteResult>();
  const maxIdempotencyEntries = options.idempotency?.maxEntries ?? DEFAULT_IDEMPOTENCY_ENTRIES;

  const write: WriteFunction = async (command, context = {}) => {
    const session = await resolveSession(context);
    const cacheKey = command.tool_use_id ? `${session.id}\u0000${command.tool_use_id}` : undefined;
    if (cacheKey) {
      const cached = idempotency.get(cacheKey);
      if (cached !== undefined) return cached;
    }

    const response = await dispatch(command, session, context).catch((cause: unknown) =>
      internalError(cause),
    );
    if (cacheKey) remember(cacheKey, response);
    return response;
  };

  return {
    write,
    registry,
    recover: (docId) => options.coordinator.recover(docId),
  };

  async function dispatch(
    command: WriteCommand,
    session: ActorSession,
    context: WriteContext,
  ): Promise<WriteResult> {
    switch (command.command) {
      case "view":
        return view(command, session);
      case "create":
        return create(command, session, context);
      case "insert":
      case "replace":
        return mutate(command, session, context);
      case "undo":
        return undoOrRedo(command, session, "undo");
      case "redo":
        return undoOrRedo(command, session, "redo");
    }
  }

  async function resolveSession(context: WriteContext): Promise<ActorSession> {
    if (context.session) return context.session;
    if (context.externalId && options.actorSessionStore) {
      return options.actorSessionStore.resolve(context.externalId);
    }

    const id = context.sessionId ?? options.defaultSessionId ?? "default-session";
    const threadId = context.threadId ?? options.defaultThreadId ?? id;
    const existing = localSessions.get(id);
    if (existing) return existing;
    const session: ActorSession = { id, threadId, documents: new Map() };
    localSessions.set(id, session);
    return session;
  }

  async function view(command: ViewCommand, session: ActorSession): Promise<WriteResult> {
    const address = parseFileAddress(command.file);
    if (!address.ok) return status("invalid_write", address.message);
    const runtime = runtimeFor(session, address.filePath);

    const synced = await syncLocalFromLive(session, address.filePath, runtime, command.command);
    if (!synced.ok) return synced.response;

    const selection = selectViewBlocks(runtime.doc, command, address);
    if (!selection.ok) return errorResponse(selection.code, selection.message, address.filePath);
    if (command.format === "outline") {
      return renderOutline(runtime.doc, selection.blocks, address.filePath);
    }
    return renderBlocks(runtime.doc, selection.blocks);
  }

  async function create(
    command: Extract<WriteCommand, { command: "create" }>,
    session: ActorSession,
    context: WriteContext,
  ): Promise<WriteResult> {
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
    const parsed = parseForCommand(command.content ?? "");
    if (!parsed.ok) return status("invalid_write", parsed.message);

    await options.lifecycle.ensureDocument(address.filePath);
    const liveCheck = await withLive(address.filePath, command.command, (liveDoc) =>
      options.model.getBlocks(liveDoc).length > 0
        ? status("invalid_write", `File already exists: ${address.filePath}`)
        : null,
    );
    if (typeof liveCheck === "string") return liveCheck;

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
    await options.journal.append(address.filePath, update, agentMeta(turnId));

    const liveResult = await withLive(address.filePath, command.command, async (liveDoc) => {
      Y.applyUpdate(liveDoc, update, agentUpdateOrigin(turnId));
      return null;
    });
    if (typeof liveResult === "string") return liveResult;

    runtime.undoStack.push(turnId);
    runtime.redoStack = [];
    markSynced(session, address.filePath, runtime);
    return formatApplySuccess({
      echo: [{ mode: "truncated", blocks: renderBlockLines(runtime.doc) }],
    });
  }

  async function mutate(
    command: Extract<WriteCommand, { command: "insert" | "replace" }>,
    session: ActorSession,
    context: WriteContext,
  ): Promise<WriteResult> {
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
    await options.journal.append(address.filePath, ownUpdate, agentMeta(turnId));

    const syncedMutation = await syncAfterLocalMutation({
      docId: address.filePath,
      commandName: command.command,
      runtime,
      update: ownUpdate,
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
  ): Promise<WriteResult> {
    const address = parseFileAddress(command.file);
    if (!address.ok) return status("invalid_write", address.message);
    const runtime = runtimeFor(session, address.filePath);
    const synced = requireSynced(session, address.filePath);
    if (!synced.ok) return synced.response;
    const count = commandCount(command);
    if (!count.ok) return status("invalid_write", count.message);

    let applied = 0;
    let lastOutcome: UndoRedoOutcome | null = null;
    const appliedTurns: string[] = [];
    const echo: ApplyEchoHunk[] = [];
    const concurrentEdits: ConcurrentEditInfo[] = [];
    let sawReconcile = false;
    const limit = count.all ? Number.POSITIVE_INFINITY : count.count;

    while (applied < limit) {
      const result =
        direction === "undo"
          ? await undoOne(address.filePath, session, runtime, command.command)
          : await redoOne(address.filePath, session, runtime, command.command);
      if (!result.ok) return result.response;
      if (result.status === "nothing_to_undo" || result.status === "nothing_to_redo") {
        if (applied === 0) return status(result.status);
        lastOutcome = count.all ? (sawReconcile ? "reconciled" : "reversed") : "partial";
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
      appliedTurns.push(result.turnId);
      markSynced(session, address.filePath, runtime);
    }

    const outcome = lastOutcome ?? (sawReconcile ? "reconciled" : "reversed");
    const lines = [`status: ${outcome}`];
    if (appliedTurns.length > 0) lines.push("", `${direction}: ${appliedTurns.join(", ")}`);
    const echoLines = echo.flatMap((hunk) => hunk.blocks).filter((line) => line.length > 0);
    if (echoLines.length > 0) lines.push("", ...echoLines);
    for (const concurrent of concurrentEdits) lines.push("", ...formatConcurrent(concurrent));
    return lines.join("\n");
  }

  async function undoOne(
    docId: string,
    session: ActorSession,
    runtime: RuntimeDocumentState,
    commandName: WriteCommand["command"],
  ): Promise<ReversalResult> {
    const before = snapshotBlocks(runtime.doc, options.model, options.codec);
    const beforeVector = Y.encodeStateVector(runtime.doc);
    const hot = registry.undoLatest(docId, session.threadId, {
      scope: "file",
      mutationClientId: options.undoClientId,
    });
    let turnId: string | undefined;
    let update: Uint8Array | undefined;

    if (hot.ok) {
      turnId = hot.turnId;
      update = Y.encodeStateAsUpdate(runtime.doc, beforeVector);
    } else if (hot.status !== "no_manager" && hot.status !== "no_undo") {
      return {
        ok: true,
        status: "partial",
        turnId: hot.actualTurnId ?? hot.expectedTurnId ?? "unknown",
      };
    }

    if (!turnId || !update) {
      const coldTurnId =
        runtime.undoStack.at(-1) ?? (await latestJournalTurn(docId, session.threadId));
      if (!coldTurnId) return { ok: true, status: "nothing_to_undo", turnId: "" };
      try {
        const cold = await reconstructUndoUpdate(options.journal, docId, coldTurnId, {
          undoClientId: options.undoClientId,
        });
        turnId = coldTurnId;
        update = cold.undoUpdate;
        Y.applyUpdate(runtime.doc, update, { type: "system" });
      } catch (_cause) {
        return { ok: true, status: "expired", turnId: coldTurnId };
      }
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
    const sync = await syncAfterLocalMutation({
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
      turnId,
      sync: sync.summary,
    };
  }

  async function redoOne(
    docId: string,
    session: ActorSession,
    runtime: RuntimeDocumentState,
    commandName: WriteCommand["command"],
  ): Promise<ReversalResult> {
    const before = snapshotBlocks(runtime.doc, options.model, options.codec);
    const redoTarget = runtime.redoStack.at(-1);
    if (!redoTarget?.undoUpdateSeq) return { ok: true, status: "nothing_to_redo", turnId: "" };

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
        return { ok: true, status: "nothing_to_redo", turnId: redoTarget.turnId };
      }
      update = cold.redoUpdate;
    }

    let consumed: { consumed: boolean; seq?: number };
    try {
      consumed = await options.journal.persistRedo(
        docId,
        update,
        { threadId: session.threadId, turnId: redoTarget.turnId },
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
        if (typeof restored === "string") return { ok: false, response: restored };
      }
      return { ok: true, status: "nothing_to_redo", turnId: redoTarget.turnId };
    }

    const turnId = redoTarget.turnId;
    if (!locallyApplied) Y.applyUpdate(runtime.doc, update, { type: "system" });
    const afterOwnVector = Y.encodeStateVector(runtime.doc);
    const ownDiff = diffSnapshots(
      before,
      snapshotBlocks(runtime.doc, options.model, options.codec),
    );

    const sync = await syncAfterLocalMutation({
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
      turnId,
      sync: sync.summary,
    };
  }

  async function restoreRuntimeFromLive(
    session: ActorSession,
    docId: string,
    runtime: RuntimeDocumentState,
    commandName: WriteCommand["command"],
  ): Promise<WriteResult | null> {
    const response = await withLive(docId, commandName, (liveDoc) => {
      const restored = new Y.Doc({ gc: false });
      Y.applyUpdate(restored, Y.encodeStateAsUpdate(liveDoc), { type: "system" });
      runtime.doc = restored;
      return null;
    });
    if (typeof response === "string") return response;
    markSynced(session, docId, runtime);
    return null;
  }

  function runtimeFor(session: ActorSession, docId: string): RuntimeDocumentState {
    const key = runtimeKey(session, docId);
    const existing = runtimeDocs.get(key);
    if (existing) return existing;
    const runtime: RuntimeDocumentState = {
      doc: new Y.Doc({ gc: false }),
      turnCounter: 0,
      undoStack: [],
      redoStack: [],
      redoStackRehydrated: false,
    };
    runtimeDocs.set(key, runtime);
    return runtime;
  }

  async function syncLocalFromLive(
    session: ActorSession,
    docId: string,
    runtime: RuntimeDocumentState,
    commandName: WriteCommand["command"],
  ): Promise<{ ok: true } | { ok: false; response: WriteResult }> {
    const response = await withLive(docId, commandName, async (liveDoc) => {
      const update = Y.encodeStateAsUpdate(liveDoc, Y.encodeStateVector(runtime.doc));
      if (hasYjsUpdate(update)) Y.applyUpdate(runtime.doc, update, { type: "system" });
      return null;
    });
    if (typeof response === "string") return { ok: false, response };
    if (shouldRehydrateRedoStack(runtime)) {
      runtime.redoStack = await rehydrateRedoStack({
        journal: options.journal,
        docId,
        threadId: session.threadId,
      });
      runtime.redoStackRehydrated = true;
    }
    markSynced(session, docId, runtime);
    return { ok: true };
  }

  function shouldRehydrateRedoStack(runtime: RuntimeDocumentState): boolean {
    return (
      !runtime.redoStackRehydrated &&
      runtime.undoStack.length === 0 &&
      runtime.redoStack.length === 0
    );
  }

  function requireSynced(
    session: ActorSession,
    docId: string,
  ): { ok: true; stateVector: Uint8Array } | { ok: false; response: WriteResult } {
    const state = session.documents.get(docId);
    if (!state) {
      return {
        ok: false,
        response: errorResponse(
          "not_found",
          `No synced snapshot for ${docId}. Run write(command="view", file="${docId}") to re-sync.`,
          docId,
        ),
      };
    }
    return { ok: true, stateVector: state.stateVector };
  }

  async function syncAfterLocalMutation(
    input: LocalMutationSyncInput,
  ): Promise<{ ok: true; summary: SyncedMutationSummary } | { ok: false; response: WriteResult }> {
    const concurrentUpdate = await mergeUpdateAndCaptureConcurrent(input);
    if (typeof concurrentUpdate === "string") return { ok: false, response: concurrentUpdate };
    const concurrent = applyConcurrent(
      input.runtime,
      concurrentUpdate,
      input.afterOwnVector,
      input.ownTurnId,
    );
    const after = snapshotBlocks(input.runtime.doc, options.model, options.codec);
    const echo = computeEcho({
      before: input.before,
      after,
      agentTouchedHashes: input.touchedHashes,
      agentDeletedHashes: input.deletedHashes,
      structuralChange: input.structuralChange,
      concurrentTouchedHashes: concurrent.touchedHashes,
    });
    return {
      ok: true,
      summary: {
        echo,
        concurrentEdits: concurrent.info,
        reconciled: echo.some((hunk) => hunk.mode === "full"),
      },
    };
  }

  async function mergeUpdateAndCaptureConcurrent(
    input: LocalMutationSyncInput,
  ): Promise<Uint8Array | null | WriteResult> {
    let concurrentUpdate: Uint8Array | null = null;
    const response = await withLive(input.docId, input.commandName, async (liveDoc) => {
      concurrentUpdate = Y.encodeStateAsUpdate(liveDoc, input.afterOwnVector);
      Y.applyUpdate(liveDoc, input.update, input.liveOrigin);
      return null;
    });
    if (typeof response === "string") return response;
    return concurrentUpdate;
  }

  function applyConcurrent(
    runtime: RuntimeDocumentState,
    update: Uint8Array | null,
    afterOwnVector: Uint8Array,
    turnId: string | undefined,
  ): ConcurrentDetectionResult {
    if (!update || !hasYjsUpdate(update)) return { touchedHashes: new Set() };
    return applyConcurrentUpdates(
      runtime.doc,
      options.model,
      options.codec,
      [{ update, origin: { type: "human" } }],
      turnId ? agentUpdateOrigin(turnId) : undefined,
      afterOwnVector,
    );
  }

  async function withLive<T>(
    docId: string,
    commandName: WriteCommand["command"],
    fn: (doc: Y.Doc) => Promise<T | WriteResult | null> | T | WriteResult | null,
  ): Promise<T | WriteResult | null> {
    try {
      return await options.coordinator.withDocument(docId, async (doc) => fn(doc));
    } catch (cause) {
      if (isDocumentNotFoundError(cause)) return documentNotFound(commandName, docId);
      throw cause;
    }
  }

  function markSynced(session: ActorSession, docId: string, runtime: RuntimeDocumentState): void {
    session.documents.set(docId, {
      stateVector: Y.encodeStateVector(runtime.doc),
      turnCount: runtime.undoStack.length,
    });
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

  async function latestJournalTurn(docId: string, threadId: string): Promise<string | undefined> {
    const snapshot = await options.journal.read(docId);
    const prefix = `${threadId}:`;
    return groupUpdatesByTurn(snapshot.updates)
      .filter((group) => group.turnId.startsWith(prefix))
      .at(-1)?.turnId;
  }

  function remember(cacheKey: string, response: WriteResult): void {
    idempotency.set(cacheKey, response);
    while (idempotency.size > maxIdempotencyEntries) {
      const oldest = idempotency.keys().next().value;
      if (oldest === undefined) break;
      idempotency.delete(oldest);
    }
  }

  function selectViewBlocks(
    doc: Y.Doc,
    command: ViewCommand,
    address: FileAddress,
  ):
    | { ok: true; blocks: Y.XmlElement[] }
    | { ok: false; code: "not_found" | "invalid_write"; message: string } {
    const scopeContext = { doc, model: options.model };
    if (address.fragment && (command.in !== undefined || command.around !== undefined)) {
      return {
        ok: false,
        code: "invalid_write",
        message: "Use either file #fragment, in, or around for view scope, not multiple.",
      };
    }
    if (address.fragment) {
      const result = resolveScope(scopeContext, `#${address.fragment}`);
      return result.ok ? { ok: true, blocks: result.scope.blocks } : result;
    }
    if (command.around !== undefined) {
      const result = resolveSearchScope(scopeContext, undefined, command.around);
      return result.ok ? { ok: true, blocks: result.scope.blocks } : result;
    }
    if (command.in !== undefined) {
      const result = resolveScope(scopeContext, command.in);
      return result.ok ? { ok: true, blocks: result.scope.blocks } : result;
    }
    return { ok: true, blocks: options.model.getBlocks(doc) };
  }

  function renderBlocks(doc: Y.Doc, blocks: readonly Y.XmlElement[]): string {
    return renderBlockLines(doc, blocks).join("\n");
  }

  function renderBlockLines(doc: Y.Doc, blocks?: readonly Y.XmlElement[]): string[] {
    return (blocks ?? options.model.getBlocks(doc)).map((block) =>
      options.codec.serializeBlock(
        options.model.toProsemirrorBlock(doc, block),
        options.model.getBlockId(block),
      ),
    );
  }

  function renderOutline(doc: Y.Doc, blocks: readonly Y.XmlElement[], filePath: string): string {
    const lines: string[] = [];
    for (const block of blocks) {
      if (!isHeading(block)) continue;
      const hash = options.model.getBlockId(block);
      lines.push(options.codec.serializeBlock(options.model.toProsemirrorBlock(doc, block), hash));
      lines.push(`write(command="view", file="${filePath}#${hash}")`);
    }
    return lines.length > 0 ? lines.join("\n") : renderBlocks(doc, blocks);
  }

  function parseForCommand(
    content: string,
  ): { ok: true; parsed: ParsedContent } | { ok: false; message: string } {
    try {
      return { ok: true, parsed: options.codec.parse(content) };
    } catch (cause) {
      return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
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

function formatApplySuccess(input: ApplySuccessResponseInput): WriteResult {
  const lines = ["status: success"];
  if (input.deletedBlocks && input.deletedBlocks.length > 0) {
    lines.push("", `deleted: ${input.deletedBlocks.join(", ")}`);
  }
  const echoLines = input.echo.flatMap((hunk) => hunk.blocks).filter((line) => line.length > 0);
  if (echoLines.length > 0) lines.push("", ...echoLines);
  if (input.concurrentEdits) lines.push("", ...formatConcurrent(input.concurrentEdits));
  return lines.join("\n");
}

function formatConcurrent(info: ConcurrentEditInfo): string[] {
  const lines = ["concurrent edits:"];
  if (info.human.length > 0) lines.push(`  human: ${info.human.join(", ")}`);
  if (info.agent.length > 0) lines.push(`  agent: ${info.agent.join(", ")}`);
  if (info.reviewCommand) lines.push(info.reviewCommand);
  return lines;
}

function errorResponse(code: string, message: string, filePath: string): WriteResult {
  const needsView = code === "not_found" && !message.includes('write(command="view"');
  return status(
    code,
    needsView ? `${message}. Run write(command="view", file="${filePath}") to re-sync.` : message,
  );
}

function documentNotFound(commandName: WriteCommand["command"], filePath: string): WriteResult {
  if (commandName === "view") {
    return status(
      "document_not_found",
      `File not found. Check the path, or use write(command="create", file="${filePath}") to make a new one.`,
    );
  }
  return status("document_not_found", "File not found. View the project to find the right path.");
}

function status(code: string, message?: string): WriteResult {
  return message ? `status: ${code}\n\n${message}` : `status: ${code}`;
}

function internalError(cause: unknown): WriteResult {
  const reason = cause instanceof Error && cause.message ? ` ${cause.message}` : "";
  return status("internal_error", `Retry — transient edit system failure.${reason}`);
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

function hasYjsUpdate(update: Uint8Array): boolean {
  return update.length > EMPTY_UPDATE_LENGTH;
}

function agentMeta(turnId: string): UpdateMeta {
  return { origin: `agent:${turnId}`, actorTurnId: turnId, seq: 0 };
}

function agentUpdateOrigin(turnId: string): ConcurrentUpdateOrigin & { type: "agent" } {
  return { type: "agent", actorTurnId: turnId };
}

function runtimeKey(session: ActorSession, docId: string): string {
  return `${session.id}\u0000${docId}`;
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
