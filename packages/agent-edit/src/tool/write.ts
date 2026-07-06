// Dispatches the LLM write(command=...) surface onto codec, resolver, apply, journal, and undo ports.
import * as Y from "yjs";

import { snapshotBlocks, truncateSerializedBlock } from "../apply/echo.js";
import { applyEdits } from "../apply/tiers.js";
import type { ApplyEchoHunk, ConcurrentEditInfo, ConcurrentUpdateOrigin } from "../apply/types.js";
import type { AgentEditCodec } from "../codec-adapter.js";
import type { DocumentAddress } from "../document-address.js";
import { parseDocumentAddress } from "../document-address.js";
import { toDocHandle } from "../handles.js";
import type { ActorSession, ActorSessionStore } from "../ports/actor-session-store.js";
import type { DocumentCoordinator } from "../ports/document-coordinator.js";
import type { DocumentLifecycle } from "../ports/document-lifecycle.js";
import type { AgentEditModel } from "../ports/model.js";
import type { SyncStateStore } from "../ports/sync-state-store.js";
import type { UpdateMeta } from "../ports/types.js";
import type { ReversalStore, UpdateJournal } from "../ports/update-journal.js";
import { parseWriteHandle, writeHandle } from "../ports/update-journal.js";
import { resolveWrite } from "../resolver/resolve.js";
import type { UndoAvailability } from "../undo/availability.js";
import type { ReversalSelection } from "../undo/reversal-plan.js";
import { createThreadOriginRegistry } from "../undo/thread-origin-registry.js";
import { WriteCommandSchema } from "./command-schema.js";
import { withLiveDocument } from "./coordinator.js";
import { createDocumentRenderer } from "./document-renderer.js";
import type { WriteResultBlock } from "./internal-result.js";
import { type InternalWriteResult, isInternalWriteResult } from "./internal-result.js";
import { createMutationCommit } from "./mutation-commit.js";
import { formatConcurrent, result, status, toOutcome } from "./response-format.js";
import { createResponseStaging } from "./response-staging.js";
import { createRuntimeStore } from "./runtime-store.js";
import type {
  ReadCommand,
  RedoCommand,
  RedoResult,
  ResponseCommitResult,
  ResponseRollbackResult,
  TurnRedoResult,
  TurnUndoResult,
  UndoCommand,
  UndoResult,
  WriteCommand,
  WriteContext,
  WriteErrorStatus,
  WriteFunction,
  WriteOutcome,
} from "./types.js";
import { createWriteReversal, type UndoNotificationPort } from "./write-reversal.js";

export interface CreateWriteToolOptions {
  journal: UpdateJournal & ReversalStore;
  coordinator: DocumentCoordinator;
  lifecycle?: DocumentLifecycle;
  codec: AgentEditCodec;
  model: AgentEditModel;
  actorSessionStore?: ActorSessionStore;
  syncStateStore?: SyncStateStore;
  idempotency?: {
    maxEntries?: number;
  };
  /** Server-local fallback identity when no ActorSession/ActorSessionStore is supplied. */
  defaultSessionId?: string;
  defaultThreadId?: string;
  /**
   * Stable Yjs client id used for cold undo/redo reconstruction. Defaults to
   * agent-edit's arbitrary standalone fallback when the host does not inject one.
   */
  undoClientId?: number;
  /**
   * Host-owned factory for forward-authoring runtime docs. Lets the host keep
   * their clientID outside any reserved band. Defaults to a plain gc:false
   * Y.Doc for standalone use.
   */
  createRuntimeDoc?: () => Y.Doc;
  /** Host-owned notification sink for user-triggered undo/redo context. */
  undoNotificationPort?: UndoNotificationPort;
  /** Host-owned policy for internal journal/undo invariant drift; defaults to fail-fast. */
  onInvariantViolation?: (message: string) => void;
}

export interface ReverseInput {
  docId: string;
  threadId: string;
  direction: "undo" | "redo";
  selection: ReversalSelection;
  actor: { type: "user"; userId: string } | { type: "agent" };
  /** Ask agent-edit to compare full Yjs document updates before/after reversal. */
  requireEffect?: boolean;
}

export type VerifiedReverseEffect = "changed" | "unchanged" | "not_checked";
export type VerifiedReverseResult = WriteOutcome & {
  reversalEffect?: VerifiedReverseEffect;
};

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
  /** Host-compatible aliases. */
  undoTurn(docId: string, threadId: string): Promise<TurnUndoResult>;
  redoTurn(docId: string, threadId: string): Promise<TurnRedoResult>;
  invalidateThread(docId: string, threadId: string): void;
}

interface ApplySuccessResponseInput {
  writeId?: string;
  echo: ApplyEchoHunk[];
  concurrentEdits?: ConcurrentEditInfo;
  deletedBlocks?: readonly string[];
}

const DEFAULT_IDEMPOTENCY_ENTRIES = 500;
// Fixed fallback Yjs clientID for deterministic standalone cold reconstruction
// when the host does not inject one. Not tied to any host reserved-band scheme;
// Meridian injects its own AGENT_EDIT_UNDO_CLIENT_ID at the composition root.
const DEFAULT_UNDO_CLIENT_ID = 999;
let nextAutoTurnIdNonce = 0;

export function createWriteTool(options: CreateWriteToolOptions): WriteTool {
  const threadOrigins = createThreadOriginRegistry();
  const lifecycle = options.lifecycle;
  const undoClientId = options.undoClientId ?? DEFAULT_UNDO_CLIENT_ID;
  const localSessions = new Map<string, ActorSession>();
  const idempotency = new Map<string, WriteOutcome>();
  const maxIdempotencyEntries = options.idempotency?.maxEntries ?? DEFAULT_IDEMPOTENCY_ENTRIES;
  // Fallback turn ids are durable, so their counter must not live on an
  // evictable runtime document.
  const autoTurnIdNonce = createAutoTurnIdNonce();
  let autoTurnCounter = 0;
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
    syncStateStore: options.syncStateStore,
  });
  const { markSynced, requireSynced, runtimeFor } = runtimeStore;
  const responseStaging = createResponseStaging({
    runtimeStore,
    mutationCommit,
    model: options.model,
    ensureDocument: lifecycle ? (docId) => lifecycle.ensureDocument(docId) : undefined,
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
  });

  const write: WriteFunction = async (command, context = {}) => {
    const parsed = WriteCommandSchema.safeParse(command);
    const commandName = parsed.success ? parsed.data.command : fallbackCommandName(command);
    if (!parsed.success) {
      return toOutcome(commandName, status("invalid_write", writeSchemaError(parsed.error)));
    }

    const validCommand = parsed.data;
    const session = await resolveSession(context);
    const toolUseId = validCommand.tool_use_id ?? context.tool_use_id;
    const cacheKey = toolUseId ? `${session.id}\u0000${toolUseId}` : undefined;
    if (cacheKey) {
      const cached = idempotency.get(cacheKey);
      if (cached !== undefined) return cached;
    }

    const result = await dispatch(validCommand, session, context).catch((cause: unknown) =>
      internalError(cause),
    );
    const outcome = toOutcome(validCommand.command, result);
    if (cacheKey) remember(cacheKey, outcome);
    return outcome;
  };

  return {
    write,
    recover: (docId) => options.coordinator.recover(docId),
    commitResponse: responseStaging.commitResponse,
    rollbackResponse: responseStaging.rollbackResponse,
    bufferedUpdatesForDoc: responseStaging.bufferedUpdatesForDoc,
    stagedCreatedDocumentIds: responseStaging.stagedCreatedDocumentIds,
    getAvailability: writeReversal.getAvailability,
    undo: (docId, threadId) => runTurnReversalEndpoint(docId, threadId, "undo"),
    redo: (docId, threadId) => runTurnReversalEndpoint(docId, threadId, "redo"),
    reverse,
    undoTurn: (docId, threadId) => runTurnReversalEndpoint(docId, threadId, "undo"),
    redoTurn: (docId, threadId) => runTurnReversalEndpoint(docId, threadId, "redo"),
    invalidateThread,
  };

  async function dispatch(
    command: WriteCommand,
    session: ActorSession,
    context: WriteContext,
  ): Promise<InternalWriteResult> {
    switch (command.command) {
      case "read":
        // Query command. Not pure: read rebuilds runtime and replays staged updates.
        return read(command, session, context);
      case "create":
        return create(command, session, context);
      case "insert":
      case "replace":
        // Mutating commands lower to ResolvedEdit before applying.
        return mutate(command, session, context);
      case "undo":
      case "redo":
        return undoOrRedo(command, session, command.command, context);
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

  async function read(
    command: ReadCommand,
    session: ActorSession,
    context: WriteContext,
  ): Promise<InternalWriteResult> {
    const address = parseFileAddress(command);
    if (!address.ok) return status("invalid_write", address.message);
    const runtime = runtimeFor(session, address.documentId);

    const restored = await runtimeStore.restoreRuntimeFromLive(
      session,
      address.documentId,
      runtime,
      command.command,
      { filePath: address.filePath },
    );
    if (isInternalWriteResult(restored)) return restored;
    if (context.responseId) {
      for (const update of responseStaging.bufferedUpdatesForDoc(
        context.responseId,
        address.documentId,
      )) {
        Y.applyUpdate(runtime.doc, update, { type: "system" });
      }
    }
    markSynced(session, address.documentId, runtime);

    const selection = renderer.selectReadBlocks(toDocHandle(runtime.doc), command, address);
    if (!selection.ok) return errorResponse(selection.code, selection.message, address.filePath);
    if (command.format === "outline") {
      return success(
        renderer.renderOutline(toDocHandle(runtime.doc), selection.blocks, address.filePath),
      );
    }
    return success(renderer.renderBlocks(toDocHandle(runtime.doc), selection.blocks));
  }

  async function create(
    command: Extract<WriteCommand, { command: "create" }>,
    session: ActorSession,
    context: WriteContext,
  ): Promise<InternalWriteResult> {
    const address = parseFileAddress(command);
    if (!address.ok) return status("invalid_write", address.message);
    if (address.fragment) {
      return status("invalid_write", "create does not accept a #fragment in file.");
    }
    if (!options.lifecycle) {
      return status("invalid_write", "document creation is not supported by this deployment");
    }

    const runtime = runtimeFor(session, address.documentId);
    const overwriting = command.overwrite === true;
    const parsed = renderer.parseForCommand(command.content ?? "");
    if (!parsed.ok) return status("invalid_write", parsed.message);

    const stagedCreate = context.responseId !== undefined;
    if (!stagedCreate) await options.lifecycle.ensureDocument(address.documentId);
    const liveCheck = await withLiveDocument(
      options.coordinator,
      address.documentId,
      command.command,
      address.filePath,
      (liveDoc) =>
        options.model.getBlocks(toDocHandle(liveDoc)).length > 0 && !overwriting
          ? status(
              "invalid_write",
              `File already exists: ${address.filePath}. Use overwrite=true to overwrite.`,
            )
          : null,
    );
    const missingLiveForStagedCreate =
      stagedCreate && isInternalWriteResult(liveCheck) && liveCheck.status === "document_not_found";
    // Response-staged creates may intentionally defer live document creation
    // until commit so rollback leaves no empty Y.Doc behind.
    if (isInternalWriteResult(liveCheck) && !missingLiveForStagedCreate) return liveCheck;

    // Reconstruct the authoritative current view so existence and the overwrite
    // delete-set come from canonical plus staged updates, never a stale replica.
    if (!missingLiveForStagedCreate) {
      const restored = await runtimeStore.restoreRuntimeFromLive(
        session,
        address.documentId,
        runtime,
        command.command,
        { filePath: address.filePath },
      );
      if (isInternalWriteResult(restored)) return restored;
    }
    if (missingLiveForStagedCreate) {
      runtime.doc = options.createRuntimeDoc?.() ?? new Y.Doc({ gc: false });
    }
    if (context.responseId) {
      for (const update of responseStaging.bufferedUpdatesForDoc(
        context.responseId,
        address.documentId,
      )) {
        Y.applyUpdate(runtime.doc, update, { type: "system" });
      }
    }
    const existingBlocks = options.model.getBlocks(toDocHandle(runtime.doc));
    if (existingBlocks.length > 0 && !overwriting) {
      return status(
        "invalid_write",
        `File already exists: ${address.filePath}. Use overwrite=true to overwrite.`,
      );
    }
    const turnId = nextTurnId(session, address.documentId, context);
    const writeIdentity = await nextWriteIdentity(address.documentId, session, context);
    const beforeVector = Y.encodeStateVector(runtime.doc);
    const origin = threadOrigins.getThreadOrigin(address.documentId, session.threadId);
    runtime.doc.transact(() => {
      if (overwriting) {
        options.model.replaceAllBlocks(toDocHandle(runtime.doc), parsed.parsed);
      } else {
        options.model.insertBlocks(toDocHandle(runtime.doc), null, parsed.parsed);
      }
    }, origin);
    const update = Y.encodeStateAsUpdate(runtime.doc, beforeVector);
    const meta = agentMeta(turnId);

    if (context.responseId) {
      if (context.createdDocument === undefined) {
        return status(
          "invalid_write",
          "Staged create requires host-resolved createdDocument ownership metadata.",
        );
      }
      responseStaging.stageUpdate({
        responseId: context.responseId,
        docId: address.documentId,
        session,
        runtime,
        commandName: command.command,
        update,
        meta,
        liveOrigin: agentUpdateOrigin(turnId),
        turnId,
        writeId: writeIdentity.handle,
        writeOrdinal: writeIdentity.ordinal,
        durableWriteId: writeIdentity.durableId,
        ensureDocumentBeforeCommit: true,
        createdDocumentBeforeCommit: context.createdDocument,
        ...(overwriting ? { updateKind: "replaceAll" } : {}),
      });
      markSynced(session, address.documentId, runtime);
      return formatApplySuccess({
        writeId: writeIdentity.handle,
        echo: [{ mode: "truncated", blocks: truncateCreateEcho(runtime.doc) }],
      });
    }

    const committed = await mutationCommit.commitImmediate({
      docId: address.documentId,
      commandName: command.command,
      updates: [
        {
          update,
          meta,
          mutation: {
            threadId: session.threadId,
            turnId,
            writeId: writeIdentity.durableId,
            wId: writeIdentity.ordinal,
            ...(overwriting ? { updateKind: "replaceAll" } : {}),
          },
        },
      ],
      afterOwnVector: Y.encodeStateVector(runtime.doc),
      liveOrigin: agentUpdateOrigin(turnId),
    });
    if (!committed.ok) return committed.response;

    runtimeStore.attachRuntime(session, address.documentId, runtime);
    return formatApplySuccess({
      writeId: writeIdentity.handle,
      echo: [{ mode: "truncated", blocks: truncateCreateEcho(runtime.doc) }],
    });
  }

  async function mutate(
    command: Extract<WriteCommand, { command: "insert" | "replace" }>,
    session: ActorSession,
    context: WriteContext,
  ): Promise<InternalWriteResult> {
    const address = parseFileAddress(command);
    if (!address.ok) return status("invalid_write", address.message);
    const runtime = runtimeFor(session, address.documentId);
    let synced = await requireSynced(
      session,
      address.documentId,
      command.command,
      address.filePath,
      runtime,
      { rejectOnStale: isUnconfirmedDestructiveReplace(command, address) },
    );
    if (!synced.ok) return synced.response;
    if (context.interactionBaselineSnapshot) {
      const merged = await runtimeStore.syncLocalFromLive(
        session,
        address.documentId,
        runtime,
        command.command,
      );
      if (!merged.ok) return merged.response;
      const committedSnapshot = responseAwareBaselineSnapshot(
        context.interactionBaselineSnapshot,
        context.responseId
          ? responseStaging.bufferedUpdatesForDoc(context.responseId, address.documentId)
          : [],
      );
      runtimeStore.setCommittedSnapshot(session, address.documentId, committedSnapshot);
      synced = { ok: true, stateVector: Y.encodeStateVector(runtime.doc) };
    }

    const resolved = resolveWrite(
      { doc: toDocHandle(runtime.doc), model: options.model, codec: options.codec },
      { ...command, documentAddress: address },
    );
    if (!resolved.ok) {
      return errorResponse(resolved.error.code, resolved.error.message, address.filePath);
    }

    const before = snapshotBlocks(toDocHandle(runtime.doc), options.model, options.codec);
    const beforeVector = Y.encodeStateVector(runtime.doc);
    const turnId = nextTurnId(session, address.documentId, context);
    const origin = threadOrigins.getThreadOrigin(address.documentId, session.threadId);
    const applied = applyEdits(
      toDocHandle(runtime.doc),
      options.model,
      options.codec,
      resolved.edits,
      origin,
      {
        ownActorTurnId: turnId,
        syncStateVector: synced.stateVector,
      },
    );
    if (!applied.ok)
      return errorResponse(applied.error.code, applied.error.message, address.filePath);

    const afterOwnVector = Y.encodeStateVector(runtime.doc);
    const ownUpdate = Y.encodeStateAsUpdate(runtime.doc, beforeVector);
    const meta = agentMeta(turnId);

    if (context.responseId) {
      const writeIdentity = await nextWriteIdentity(address.documentId, session, context);
      const concurrent = context.interactionBaselineSnapshot
        ? await mutationCommit.detectConcurrentEdits({
            docId: address.documentId,
            runtime,
            agentUpdate: ownUpdate,
            committedSnapshot: responseAwareBaselineSnapshot(
              context.interactionBaselineSnapshot,
              responseStaging.bufferedUpdatesForDoc(context.responseId, address.documentId),
            ),
            ownTurnId: turnId,
          })
        : undefined;
      responseStaging.stageUpdate({
        responseId: context.responseId,
        docId: address.documentId,
        session,
        runtime,
        commandName: command.command,
        update: ownUpdate,
        meta,
        liveOrigin: agentUpdateOrigin(turnId),
        turnId,
        writeId: writeIdentity.handle,
        writeOrdinal: writeIdentity.ordinal,
        durableWriteId: writeIdentity.durableId,
        createdDocumentBeforeCommit: false,
      });
      const summary = mutationCommit.summarizeMutationEcho(
        {
          runtime,
          before,
          touchedHashes: new Set(applied.changedBlocks ?? []),
          deletedHashes: new Set(applied.deletedBlocks ?? []),
        },
        concurrent,
      );
      markSynced(session, address.documentId, runtime);
      return formatApplySuccess({
        writeId: writeIdentity.handle,
        echo: summary.echo,
        concurrentEdits: summary.concurrentEdits,
        deletedBlocks: applied.deletedBlocks,
      });
    }

    const writeIdentity = await nextWriteIdentity(address.documentId, session, context);
    const syncedMutation = await mutationCommit.syncAfterLocalMutation({
      docId: address.documentId,
      commandName: command.command,
      runtime,
      update: ownUpdate,
      meta,
      mutation: {
        threadId: session.threadId,
        turnId,
        writeId: writeIdentity.durableId,
        wId: writeIdentity.ordinal,
      },
      afterOwnVector,
      liveOrigin: agentUpdateOrigin(turnId),
      before,
      touchedHashes: new Set(applied.changedBlocks ?? []),
      deletedHashes: new Set(applied.deletedBlocks ?? []),
      ownTurnId: turnId,
      committedSnapshot: runtimeStore.getCommittedSnapshot(session, address.documentId),
    });
    if (!syncedMutation.ok) return syncedMutation.response;

    runtimeStore.attachRuntime(session, address.documentId, runtime);
    return formatApplySuccess({
      writeId: writeIdentity.handle,
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
    const address = parseFileAddress(command);
    if (!address.ok) return status("invalid_write", address.message);
    if (context.responseId && responseStaging.hasBufferedWrites(context.responseId)) {
      // Undo/redo read and write committed journal state; flush staged response
      // writes first so reversal order matches the model's tool-call order.
      await responseStaging.commitResponse(context.responseId);
    }
    const selection = commandSelection(command);
    if (!selection.ok) return status("invalid_write", selection.message);

    return writeReversal.run({
      docId: address.documentId,
      session,
      commandName: command.command,
      direction,
      selection: selection.selection,
    });
  }

  function reverse(input: ReverseInput): Promise<UndoResult | RedoResult | VerifiedReverseResult> {
    return runHostedReversal(input);
  }

  function runTurnReversalEndpoint(
    docId: string,
    threadId: string,
    direction: "undo",
  ): Promise<TurnUndoResult>;
  function runTurnReversalEndpoint(
    docId: string,
    threadId: string,
    direction: "redo",
  ): Promise<TurnRedoResult>;
  function runTurnReversalEndpoint(
    docId: string,
    threadId: string,
    direction: "undo" | "redo",
  ): Promise<TurnUndoResult | TurnRedoResult> {
    return runHostedReversal({
      docId,
      threadId,
      direction,
      selection: { kind: "latest" },
      actor: { type: "agent" },
    }) as Promise<TurnUndoResult | TurnRedoResult>;
  }

  async function runHostedReversal(
    input: ReverseInput,
  ): Promise<UndoResult | RedoResult | VerifiedReverseResult> {
    responseStaging.dropForThread(input.docId, input.threadId);
    const liveBefore = input.requireEffect ? await encodedLiveDocument(input.docId) : null;
    const session = localSession(`turn-reversal:${input.threadId}`, input.threadId);
    const outcome =
      input.direction === "undo"
        ? await writeReversal
            .runWriteReversal({
              docId: input.docId,
              session,
              direction: "undo",
              selection: input.selection,
              actor: input.actor,
            })
            .catch((cause: unknown) => toOutcome("undo", internalError(cause)) as UndoResult)
        : await writeReversal
            .runWriteReversal({
              docId: input.docId,
              session,
              direction: "redo",
              selection: input.selection,
              actor: input.actor,
            })
            .catch((cause: unknown) => toOutcome("redo", internalError(cause)) as RedoResult);
    if (outcome.status !== "document_not_found")
      responseStaging.dropForThread(input.docId, input.threadId);
    if (!input.requireEffect) return outcome;
    const liveAfter = await encodedLiveDocument(input.docId);
    return {
      ...outcome,
      reversalEffect:
        liveBefore && liveAfter && !equalBytes(liveBefore, liveAfter) ? "changed" : "unchanged",
    } as VerifiedReverseResult;
  }

  async function encodedLiveDocument(docId: string): Promise<Uint8Array | null> {
    try {
      return await options.coordinator.withDocument(docId, async (doc) =>
        Y.encodeStateAsUpdate(doc),
      );
    } catch {
      return null;
    }
  }

  function invalidateThread(docId: string, threadId: string): void {
    responseStaging.dropForThread(docId, threadId);
    runtimeStore.evictThreadRuntimes(docId, threadId, { markLiveDocStale: true });
    threadOrigins.evictThread(docId, threadId);
  }

  async function nextWriteIdentity(
    docId: string,
    session: ActorSession,
    context: WriteContext,
  ): Promise<{ durableId: string; ordinal: number; handle: string }> {
    const ordinal = await reversalStore.reserveWriteOrdinal(docId, session.threadId);
    const durableId =
      context.tool_use_id ??
      globalThis.crypto?.randomUUID?.() ??
      `${session.threadId}:${docId}:write-${ordinal}`;
    return { durableId, ordinal, handle: writeHandle(ordinal) };
  }

  function nextTurnId(session: ActorSession, docId: string, context: WriteContext): string {
    if (context.turnId) return context.turnId;
    autoTurnCounter += 1;
    return `${session.threadId}:${docId}:turn-${autoTurnIdNonce}-${autoTurnCounter.toString(36)}`;
  }

  /** Create echo: model just wrote the content — return hash|truncated-preview per block. */
  function truncateCreateEcho(doc: Y.Doc): string[] {
    return renderer.renderBlockLines(toDocHandle(doc)).map(truncateSerializedBlock);
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

function responseAwareBaselineSnapshot(
  baseline: Uint8Array,
  bufferedUpdates: readonly Uint8Array[],
): Uint8Array {
  if (bufferedUpdates.length === 0) return baseline;
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, baseline, { type: "system" });
    for (const update of bufferedUpdates) Y.applyUpdate(doc, update, { type: "system" });
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function createAutoTurnIdNonce(): string {
  nextAutoTurnIdNonce += 1;
  const instanceId = nextAutoTurnIdNonce.toString(36);
  const randomId =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${instanceId}-${randomId}`;
}

function parseFileAddress(
  command: Pick<WriteCommand, "file" | "documentId">,
): ({ ok: true } & DocumentAddress) | { ok: false; message: string } {
  return parseDocumentAddress(command.file, command.documentId);
}

function formatApplySuccess(input: ApplySuccessResponseInput): InternalWriteResult {
  const metaLines = ["status: success"];
  if (input.writeId) metaLines.push(`write id: ${input.writeId}`);
  if (input.deletedBlocks && input.deletedBlocks.length > 0) {
    metaLines.push(`deleted: ${input.deletedBlocks.join(", ")}`);
  }
  if (input.concurrentEdits) metaLines.push(...formatConcurrent(input.concurrentEdits));

  const echoLines = input.echo.flatMap((hunk) => hunk.blocks).filter((line) => line.length > 0);

  const content: WriteResultBlock[] = [{ type: "text", text: metaLines.join("\n") }];
  if (echoLines.length > 0) content.push({ type: "text", text: echoLines.join("\n") });

  return {
    status: "success",
    text: content.map((block) => block.text).join("\n\n"),
    content,
    ...(input.writeId ? { writeId: input.writeId } : {}),
  };
}

function errorResponse(
  code: WriteErrorStatus,
  message: string,
  filePath: string,
): InternalWriteResult {
  const needsRead = code === "not_found" && !message.includes('write(command="read"');
  return status(
    code,
    needsRead ? `${message}. Run write(command="read", file="${filePath}") to re-sync.` : message,
  );
}

function success(text: string): InternalWriteResult {
  return result("success", text);
}

function internalError(_cause: unknown): InternalWriteResult {
  return status("internal_error", "Retry — transient edit system failure.");
}

function commandSelection(
  command: UndoCommand | RedoCommand,
): { ok: true; selection: ReversalSelection } | { ok: false; message: string } {
  const selectors = [
    command.to !== undefined || command.from !== undefined,
    command.last !== undefined,
    command.all === true,
  ].filter(Boolean).length;
  if (selectors > 1)
    return { ok: false, message: "Use only one undo/redo selector: to/from, last, or all." };
  if (command.all === true) return { ok: true, selection: { kind: "all" } };
  if (command.last !== undefined) {
    if (!Number.isInteger(command.last) || command.last < 1) {
      return { ok: false, message: "last must be a positive integer" };
    }
    return { ok: true, selection: { kind: "last", count: command.last } };
  }
  if (command.from !== undefined || command.to !== undefined) {
    if (command.to === undefined) return { ok: false, message: "from requires to" };
    if (!isWriteHandle(command.to))
      return { ok: false, message: "to must be a write handle like w3" };
    if (command.from === undefined)
      return { ok: true, selection: { kind: "single", to: command.to } };
    if (!isWriteHandle(command.from))
      return { ok: false, message: "from must be a write handle like w2" };
    if (Number(command.from.slice(1)) > Number(command.to.slice(1))) {
      return { ok: false, message: "from must be before or equal to to" };
    }
    return { ok: true, selection: { kind: "range", from: command.from, to: command.to } };
  }
  return { ok: true, selection: { kind: "latest" } };
}

function isWriteHandle(value: string): boolean {
  return parseWriteHandle(value) !== undefined;
}

function agentMeta(turnId: string): UpdateMeta {
  return { origin: `agent:${turnId}`, actorTurnId: turnId, seq: 0 };
}

function agentUpdateOrigin(turnId: string): ConcurrentUpdateOrigin & { type: "agent" } {
  return { type: "agent", actorTurnId: turnId };
}

function fallbackCommandName(command: unknown): WriteCommand["command"] {
  if (typeof command === "object" && command !== null && "command" in command) {
    const value = (command as { command?: unknown }).command;
    switch (value) {
      case "create":
      case "read":
      case "insert":
      case "replace":
      case "undo":
      case "redo":
        return value;
    }
  }
  return "read";
}

function writeSchemaError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
}

function isUnconfirmedDestructiveReplace(
  command: Extract<WriteCommand, { command: "insert" | "replace" }>,
  address: DocumentAddress,
): boolean {
  // A stale scope address (hash, index, range, or section) can resolve to a different
  // block after concurrent edits; with no `find` to confirm content, the target can't be verified.
  return (
    command.command === "replace" &&
    command.find === undefined &&
    (command.in !== undefined || address.fragment !== undefined)
  );
}
