// Dispatches the LLM write(command=...) surface onto codec, resolver, apply, journal, and undo ports.
import * as Y from "yjs";

import {
  applyConcurrentUpdates,
  type ConcurrentDetectionResult,
  computeEcho,
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
import type { DocumentCoordinator } from "../ports/document-coordinator.js";
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

    const runtime = runtimeFor(session, address.filePath);
    if (
      session.documents.has(address.filePath) ||
      options.model.getBlocks(runtime.doc).length > 0
    ) {
      return status("invalid_write", `File already exists: ${address.filePath}`);
    }
    const liveCheck = await withLive(address.filePath, command.command, (liveDoc) =>
      options.model.getBlocks(liveDoc).length > 0
        ? status("invalid_write", `File already exists: ${address.filePath}`)
        : null,
    );
    if (typeof liveCheck === "string") return liveCheck;

    const parsed = parseForCommand(command.content ?? "");
    if (!parsed.ok) return status("invalid_write", parsed.message);

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

    const concurrentUpdate = await mergeOwnUpdateAndCaptureConcurrent(
      address.filePath,
      ownUpdate,
      afterOwnVector,
      turnId,
    );
    const concurrent = applyConcurrent(runtime, concurrentUpdate, afterOwnVector, turnId);
    const after = snapshotBlocks(runtime.doc, options.model, options.codec);
    const echo = computeEcho({
      before,
      after,
      agentTouchedHashes: new Set(applied.changedBlocks ?? []),
      agentDeletedHashes: new Set(applied.deletedBlocks ?? []),
      structuralChange: hasStructuralChange(applied),
      concurrentTouchedHashes: concurrent.touchedHashes,
    });

    runtime.undoStack.push(turnId);
    runtime.redoStack = [];
    markSynced(session, address.filePath, runtime);
    return formatApplySuccess({
      echo,
      concurrentEdits: concurrent.info,
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
    const limit = count.all ? Number.POSITIVE_INFINITY : count.count;

    while (applied < limit) {
      const result =
        direction === "undo"
          ? await undoOne(address.filePath, session, runtime)
          : await redoOne(address.filePath, session, runtime);
      if (result.status === "nothing_to_undo" || result.status === "nothing_to_redo") {
        if (applied === 0) return status(result.status);
        lastOutcome = count.all ? "reversed" : "partial";
        break;
      }
      if (result.status === "expired") {
        if (applied === 0) return status("expired");
        lastOutcome = "partial";
        break;
      }
      if (result.status !== "reversed") {
        lastOutcome = result.status;
        break;
      }
      applied += 1;
      appliedTurns.push(result.turnId);
    }

    markSynced(session, address.filePath, runtime);
    const outcome = lastOutcome ?? "reversed";
    const lines = [`status: ${outcome}`];
    if (appliedTurns.length > 0) lines.push("", `${direction}: ${appliedTurns.join(", ")}`);
    return lines.join("\n");
  }

  async function undoOne(
    docId: string,
    session: ActorSession,
    runtime: RuntimeDocumentState,
  ): Promise<{ status: UndoRedoOutcome; turnId: string }> {
    const beforeVector = Y.encodeStateVector(runtime.doc);
    const hot = registry.undoLatest(docId, session.threadId);
    let turnId: string | undefined;
    let update: Uint8Array | undefined;

    if (hot.ok) {
      turnId = hot.turnId;
      update = Y.encodeStateAsUpdate(runtime.doc, beforeVector);
    } else if (hot.status !== "no_manager" && hot.status !== "no_undo") {
      return { status: "partial", turnId: hot.actualTurnId ?? hot.expectedTurnId ?? "unknown" };
    }

    if (!turnId || !update) {
      const coldTurnId =
        runtime.undoStack.at(-1) ?? (await latestJournalTurn(docId, session.threadId));
      if (!coldTurnId) return { status: "nothing_to_undo", turnId: "" };
      try {
        const cold = await reconstructUndoUpdate(options.journal, docId, coldTurnId, {
          undoClientId: options.undoClientId,
        });
        turnId = coldTurnId;
        update = cold.undoUpdate;
        Y.applyUpdate(runtime.doc, update, { type: "system" });
      } catch (_cause) {
        return { status: "expired", turnId: coldTurnId };
      }
    }

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
    await applyUpdateToLive(docId, update, { type: "system" });
    popIfTop(runtime.undoStack, turnId);
    runtime.redoStack.push({ turnId, undoUpdateSeq: record.undoUpdateSeq || undefined });
    return { status: "reversed", turnId };
  }

  async function redoOne(
    docId: string,
    session: ActorSession,
    runtime: RuntimeDocumentState,
  ): Promise<{ status: UndoRedoOutcome; turnId: string }> {
    const beforeVector = Y.encodeStateVector(runtime.doc);
    const hot = registry.redoLatest(docId, session.threadId);
    let turnId: string | undefined;
    let update: Uint8Array | undefined;

    if (hot.ok) {
      turnId = hot.turnId;
      update = Y.encodeStateAsUpdate(runtime.doc, beforeVector);
    } else if (hot.status !== "no_manager" && hot.status !== "no_redo") {
      return { status: "partial", turnId: "unknown" };
    }

    if (!turnId || !update) {
      const redoTarget = runtime.redoStack.at(-1);
      if (!redoTarget?.undoUpdateSeq) return { status: "nothing_to_redo", turnId: "" };
      const cold = await reconstructRedoUpdate(
        options.journal,
        docId,
        redoTarget.turnId,
        redoTarget.undoUpdateSeq,
        { undoClientId: options.undoClientId },
      );
      if (!cold.ok) return { status: "nothing_to_redo", turnId: redoTarget.turnId };
      turnId = redoTarget.turnId;
      update = cold.redoUpdate;
      Y.applyUpdate(runtime.doc, update, { type: "system" });
    }

    await options.journal.append(docId, update, { origin: "system", seq: 0 });
    await applyUpdateToLive(docId, update, { type: "system" });
    popIfTop(runtime.redoStack, turnId);
    runtime.undoStack.push(turnId);
    return { status: "reversed", turnId };
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
    markSynced(session, docId, runtime);
    return { ok: true };
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

  async function mergeOwnUpdateAndCaptureConcurrent(
    docId: string,
    ownUpdate: Uint8Array,
    afterOwnVector: Uint8Array,
    turnId: string,
  ): Promise<Uint8Array | null> {
    let concurrentUpdate: Uint8Array | null = null;
    await options.coordinator.withDocument(docId, async (liveDoc) => {
      concurrentUpdate = Y.encodeStateAsUpdate(liveDoc, afterOwnVector);
      Y.applyUpdate(liveDoc, ownUpdate, agentUpdateOrigin(turnId));
    });
    return concurrentUpdate;
  }

  async function applyUpdateToLive(
    docId: string,
    update: Uint8Array,
    origin: ConcurrentUpdateOrigin,
  ): Promise<void> {
    await options.coordinator.withDocument(docId, async (liveDoc) => {
      Y.applyUpdate(liveDoc, update, origin);
    });
  }

  function applyConcurrent(
    runtime: RuntimeDocumentState,
    update: Uint8Array | null,
    afterOwnVector: Uint8Array,
    turnId: string,
  ): ConcurrentDetectionResult {
    if (!update || !hasYjsUpdate(update)) return { touchedHashes: new Set() };
    return applyConcurrentUpdates(
      runtime.doc,
      options.model,
      options.codec,
      [{ update, origin: { type: "human" } }],
      agentUpdateOrigin(turnId),
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
    } catch (_cause) {
      return documentNotFound(commandName, docId);
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
    if (last === value) stack.pop();
    return;
  }
  if (last?.turnId === value) stack.pop();
}
