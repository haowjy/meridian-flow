// Dispatches the LLM write(command=...) surface onto codec, resolver, apply, journal, and undo ports.
import * as Y from "yjs";

import { snapshotBlocks } from "../apply/echo.js";
import { applyEdits } from "../apply/tiers.js";
import type {
  ApplyEchoHunk,
  ApplyResult,
  ConcurrentEditInfo,
  ConcurrentUpdateOrigin,
} from "../apply/types.js";
import type { Codec } from "../codec/types.js";
import type { DocumentAddress } from "../document-address.js";
import { parseDocumentAddress } from "../document-address.js";
import type { ActorSession, ActorSessionStore } from "../ports/actor-session-store.js";
import type { DocumentCoordinator } from "../ports/document-coordinator.js";
import type { DocumentLifecycle } from "../ports/document-lifecycle.js";
import type { AgentEditModel } from "../ports/model.js";
import type { UpdateMeta } from "../ports/types.js";
import type { ReversalStore, UpdateJournal } from "../ports/update-journal.js";
import { parseWriteHandle, writeHandle } from "../ports/update-journal.js";
import { resolveWrite } from "../resolver/resolve.js";
import type { UndoAvailability } from "../undo/availability.js";
import { createThreadOriginRegistry } from "../undo/thread-origin-registry.js";
import { withLiveDocument } from "./coordinator.js";
import { createDocumentRenderer } from "./document-renderer.js";
import { type InternalWriteResult, isInternalWriteResult } from "./internal-result.js";
import { createMutationCommit } from "./mutation-commit.js";
import { formatConcurrent, result, status, toOutcome } from "./response-format.js";
import { createResponseStaging } from "./response-staging.js";
import { createRuntimeStore } from "./runtime-store.js";
import type {
  RedoCommand,
  RedoResult,
  ResponseCommitResult,
  ResponseRollbackResult,
  TurnRedoResult,
  TurnUndoResult,
  UndoCommand,
  UndoResult,
  ViewCommand,
  WriteCommand,
  WriteContext,
  WriteErrorStatus,
  WriteFunction,
  WriteOutcome,
} from "./types.js";
import { createWriteReversal } from "./write-reversal.js";

export interface CreateWriteToolOptions {
  journal: UpdateJournal;
  reversalStore?: ReversalStore;
  coordinator: DocumentCoordinator;
  lifecycle?: DocumentLifecycle;
  codec: Codec;
  model: AgentEditModel;
  actorSessionStore?: ActorSessionStore;
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
  /** Host-owned policy for internal journal/undo invariant drift; defaults to fail-fast. */
  onInvariantViolation?: (message: string) => void;
}

export interface WriteTool {
  write: WriteFunction;
  recover(docId: string): Promise<void>;
  commitResponse(responseId: string): Promise<ResponseCommitResult>;
  rollbackResponse(responseId: string): Promise<ResponseRollbackResult>;
  getAvailability(docId: string, threadId: string): Promise<UndoAvailability>;
  undo(docId: string, threadId: string): Promise<UndoResult>;
  redo(docId: string, threadId: string): Promise<RedoResult>;
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
  const reversalStore = options.reversalStore ?? (options.journal as UpdateJournal & ReversalStore);
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
  const { markSynced, requireSynced, runtimeFor } = runtimeStore;
  const responseStaging = createResponseStaging({
    runtimeStore,
    mutationCommit,
    ensureDocument: lifecycle ? (docId) => lifecycle.ensureDocument(docId) : undefined,
  });
  const writeReversal = createWriteReversal({
    reversalStore,
    runtimeStore,
    mutationCommit,
    model: options.model,
    codec: options.codec,
    undoClientId,
    onInvariantViolation: options.onInvariantViolation,
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
    recover: (docId) => options.coordinator.recover(docId),
    commitResponse: responseStaging.commitResponse,
    rollbackResponse: responseStaging.rollbackResponse,
    getAvailability: writeReversal.getAvailability,
    undo: (docId, threadId) => runTurnReversalEndpoint(docId, threadId, "undo"),
    redo: (docId, threadId) => runTurnReversalEndpoint(docId, threadId, "redo"),
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
    const address = parseFileAddress(command);
    if (!address.ok) return status("invalid_write", address.message);
    if (address.fragment) {
      return status("invalid_write", "create does not accept a #fragment in file.");
    }
    if (!options.lifecycle) {
      return status("invalid_write", "document creation is not supported by this deployment");
    }

    const runtime = runtimeFor(session, address.documentId);
    if (options.model.getBlocks(runtime.doc).length > 0) {
      return status("invalid_write", `File already exists: ${address.filePath}`);
    }
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
        options.model.getBlocks(liveDoc).length > 0
          ? status("invalid_write", `File already exists: ${address.filePath}`)
          : null,
    );
    const missingLiveForStagedCreate =
      stagedCreate && isInternalWriteResult(liveCheck) && liveCheck.status === "document_not_found";
    // Response-staged creates may intentionally defer live document creation
    // until commit so rollback leaves no empty Y.Doc behind.
    if (isInternalWriteResult(liveCheck) && !missingLiveForStagedCreate) return liveCheck;

    const turnId = nextTurnId(session, address.documentId, context);
    const writeIdentity = await nextWriteIdentity(address.documentId, session, context);
    const before = snapshotBlocks(runtime.doc, options.model, options.codec);
    const beforeVector = Y.encodeStateVector(runtime.doc);
    const origin = threadOrigins.getThreadOrigin(address.documentId, session.threadId);
    runtime.doc.transact(() => {
      options.model.insertBlocks(runtime.doc, null, parsed.parsed);
    }, origin);
    const update = Y.encodeStateAsUpdate(runtime.doc, beforeVector);
    const meta = agentMeta(turnId);
    const after = snapshotBlocks(runtime.doc, options.model, options.codec);

    if (context.responseId) {
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
        before,
        touchedHashes: new Set(after.map((block) => block.hash)),
        deletedHashes: new Set(),
        structuralChange: true,
      });
      markSynced(session, address.documentId, runtime);
      return formatApplySuccess({
        writeId: writeIdentity.handle,
        echo: [{ mode: "truncated", blocks: renderer.renderBlockLines(runtime.doc) }],
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
          },
        },
      ],
      afterOwnVector: Y.encodeStateVector(runtime.doc),
      liveOrigin: agentUpdateOrigin(turnId),
    });
    if (!committed.ok) return committed.response;

    markSynced(session, address.documentId, runtime);
    return formatApplySuccess({
      writeId: writeIdentity.handle,
      echo: [{ mode: "truncated", blocks: renderer.renderBlockLines(runtime.doc) }],
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
    const synced = requireSynced(session, address.documentId, address.filePath);
    if (!synced.ok) return synced.response;

    const resolved = resolveWrite(
      { doc: runtime.doc, model: options.model, codec: options.codec },
      { ...command, documentAddress: address },
    );
    if (!resolved.ok) {
      return errorResponse(resolved.error.code, resolved.error.message, address.filePath);
    }

    const before = snapshotBlocks(runtime.doc, options.model, options.codec);
    const beforeVector = Y.encodeStateVector(runtime.doc);
    const turnId = nextTurnId(session, address.documentId, context);
    const writeIdentity = await nextWriteIdentity(address.documentId, session, context);
    const origin = threadOrigins.getThreadOrigin(address.documentId, session.threadId);
    const applied = applyEdits(runtime.doc, options.model, options.codec, resolved.edits, origin, {
      ownActorTurnId: turnId,
      syncStateVector: synced.stateVector,
    });
    if (!applied.ok)
      return errorResponse(applied.error.code, applied.error.message, address.filePath);

    const afterOwnVector = Y.encodeStateVector(runtime.doc);
    const ownUpdate = Y.encodeStateAsUpdate(runtime.doc, beforeVector);
    const meta = agentMeta(turnId);

    if (context.responseId) {
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
        before,
        touchedHashes: new Set(applied.changedBlocks ?? []),
        deletedHashes: new Set(applied.deletedBlocks ?? []),
        structuralChange: hasStructuralChange(applied),
      });
      const summary = mutationCommit.summarizeMutationEcho({
        runtime,
        before,
        touchedHashes: new Set(applied.changedBlocks ?? []),
        deletedHashes: new Set(applied.deletedBlocks ?? []),
        structuralChange: hasStructuralChange(applied),
      });
      markSynced(session, address.documentId, runtime);
      return formatApplySuccess({
        writeId: writeIdentity.handle,
        echo: summary.echo,
        deletedBlocks: applied.deletedBlocks,
      });
    }

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
      structuralChange: hasStructuralChange(applied),
      ownTurnId: turnId,
    });
    if (!syncedMutation.ok) return syncedMutation.response;

    markSynced(session, address.documentId, runtime);
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
  async function runTurnReversalEndpoint(
    docId: string,
    threadId: string,
    direction: "undo" | "redo",
  ): Promise<TurnUndoResult | TurnRedoResult> {
    responseStaging.dropForThread(docId, threadId);
    const session = localSession(`turn-reversal:${threadId}`, threadId);
    const outcome =
      direction === "undo"
        ? await writeReversal
            .runWriteReversal({ docId, session, direction: "undo" })
            .catch((cause: unknown) => toOutcome("undo", internalError(cause)) as TurnUndoResult)
        : await writeReversal
            .runWriteReversal({ docId, session, direction: "redo" })
            .catch((cause: unknown) => toOutcome("redo", internalError(cause)) as TurnRedoResult);
    if (outcome.status !== "document_not_found") responseStaging.dropForThread(docId, threadId);
    return outcome;
  }

  function invalidateThread(docId: string, threadId: string): void {
    responseStaging.dropForThread(docId, threadId);
    runtimeStore.evictThreadRuntimes(docId, threadId, { needsRecovery: true });
    threadOrigins.evictThread(docId, threadId);
  }

  async function nextWriteIdentity(
    docId: string,
    session: ActorSession,
    context: WriteContext,
  ): Promise<{ durableId: string; ordinal: number; handle: string }> {
    const ordinal = await requireJournalMethod(
      reversalStore.reserveWriteOrdinal,
      "reserveWriteOrdinal",
    ).call(reversalStore, docId, session.threadId);
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

  function remember(cacheKey: string, outcome: WriteOutcome): void {
    idempotency.set(cacheKey, outcome);
    while (idempotency.size > maxIdempotencyEntries) {
      const oldest = idempotency.keys().next().value;
      if (oldest === undefined) break;
      idempotency.delete(oldest);
    }
  }
}

function requireJournalMethod<T extends (...args: never[]) => unknown>(
  method: T | undefined,
  name: string,
): T {
  if (!method) throw new Error(`ReversalStore.${name} is required for write-level undo`);
  return method;
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
  const lines = ["status: success"];
  if (input.writeId) lines.push(`write id: ${input.writeId}`);
  if (input.deletedBlocks && input.deletedBlocks.length > 0) {
    lines.push("", `deleted: ${input.deletedBlocks.join(", ")}`);
  }
  const echoLines = input.echo.flatMap((hunk) => hunk.blocks).filter((line) => line.length > 0);
  if (echoLines.length > 0) lines.push("", ...echoLines);
  if (input.concurrentEdits) lines.push("", ...formatConcurrent(input.concurrentEdits));
  return {
    ...result("success", lines.join("\n")),
    ...(input.writeId ? { writeId: input.writeId } : {}),
  };
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

function success(text: string): InternalWriteResult {
  return result("success", text);
}

function internalError(cause: unknown): InternalWriteResult {
  const reason = cause instanceof Error && cause.message ? ` ${cause.message}` : "";
  return status("internal_error", `Retry — transient edit system failure.${reason}`);
}

type ReversalSelection =
  | { kind: "latest" }
  | { kind: "single"; to: string }
  | { kind: "range"; from: string; to: string }
  | { kind: "last"; count: number }
  | { kind: "all" };

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

function hasStructuralChange(result: Extract<ApplyResult, { ok: true }>): boolean {
  return result.appliedEdits?.some((edit) => edit.kind !== "text") ?? false;
}

function agentMeta(turnId: string): UpdateMeta {
  return { origin: `agent:${turnId}`, actorTurnId: turnId, seq: 0 };
}

function agentUpdateOrigin(turnId: string): ConcurrentUpdateOrigin & { type: "agent" } {
  return { type: "agent", actorTurnId: turnId };
}
