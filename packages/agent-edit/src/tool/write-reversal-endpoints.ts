// Hosted undo/redo/reverse endpoints and thread invalidation for the write tool.
import * as Y from "yjs";

import type { ActorSession } from "../ports/actor-session-store.js";
import type { DocumentCoordinator } from "../ports/document-coordinator.js";
import { parseWriteHandle } from "../ports/update-journal.js";
import type { ReversalSelection } from "../undo/reversal-plan.js";
import type { ThreadOriginRegistry } from "../undo/thread-origin-registry.js";
import { bytesEqual } from "../yjs-update.js";
import type { ResponseCommitter } from "./response-committer.js";
import { status, toOutcome } from "./response-format.js";
import type { RuntimeStore } from "./runtime-store.js";
import type {
  InteractionContext,
  RedoCommand,
  RedoResult,
  TurnRedoResult,
  TurnUndoResult,
  UndoCommand,
  UndoResult,
  WriteContext,
  WriteOutcome,
} from "./types.js";
import { parseFileAddress, writeError } from "./write-helpers.js";
import type { WriteReversal } from "./write-reversal.js";

export interface ReverseInput {
  docId: string;
  threadId: string;
  direction: "undo" | "redo";
  selection: ReversalSelection;
  actor: { type: "user"; userId: string } | { type: "agent" };
  requireEffect?: boolean;
  interactionContext?: InteractionContext;
}

export type VerifiedReverseEffect = "changed" | "unchanged" | "not_checked";
export type VerifiedReverseResult = WriteOutcome & {
  reversalEffect?: VerifiedReverseEffect;
};

export function createWriteReversalEndpoints(deps: {
  coordinator: DocumentCoordinator;
  localSessions: Map<string, ActorSession>;
  responseCommitter: ResponseCommitter;
  writeReversal: WriteReversal;
  runtimeStore: RuntimeStore;
  threadOrigins: ThreadOriginRegistry;
}) {
  const {
    coordinator,
    localSessions,
    responseCommitter,
    writeReversal,
    runtimeStore,
    threadOrigins,
  } = deps;

  return {
    runTurnReversalEndpoint,
    reverse,
    invalidateThread,
    undoOrRedo,
  };

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

  function reverse(input: ReverseInput): Promise<UndoResult | RedoResult | VerifiedReverseResult> {
    return runHostedReversal(input);
  }

  async function undoOrRedo(
    command: UndoCommand | RedoCommand,
    session: ActorSession,
    direction: "undo" | "redo",
    context: WriteContext,
  ) {
    const address = parseFileAddress(command);
    if (!address.ok) return status("invalid_write", address.message);
    if (runtimeStore.isReadFenced(session.id, address.documentId)) {
      return readRequiredRejection(address.filePath);
    }
    if (context.responseId && responseCommitter.hasBufferedWrites(context.responseId)) {
      const committed = await responseCommitter.commitResponse(context.responseId);
      if (committed.status === "rejected") {
        const documentIds = committed.rejections.map((rejection) => rejection.documentId);
        runtimeStore.setReadRequiredFence(session.id, documentIds);
        return stagedCommitRejection(committed.rejections);
      }
    }
    const selection = commandSelection(command);
    if (!selection.ok) return status("invalid_write", selection.message);

    return writeReversal.run({
      docId: address.documentId,
      session,
      commandName: command.command,
      direction,
      selection: selection.selection,
      interactionContext: context.interactionContext,
    });
  }

  async function runHostedReversal(
    input: ReverseInput,
  ): Promise<UndoResult | RedoResult | VerifiedReverseResult> {
    const session = localSession(input.threadId, input.threadId);
    if (input.actor.type === "agent" && runtimeStore.isReadFenced(session.id, input.docId)) {
      return toOutcome(input.direction, readRequiredRejection(input.docId)) as
        | UndoResult
        | RedoResult;
    }
    responseCommitter.dropForThread(input.docId, input.threadId);
    const liveBefore = input.requireEffect ? await encodedLiveDocument(input.docId) : null;
    const outcome =
      input.direction === "undo"
        ? await writeReversal
            .runWriteReversal({
              docId: input.docId,
              session,
              direction: "undo",
              selection: input.selection,
              actor: input.actor,
              interactionContext: input.interactionContext,
            })
            .catch((cause: unknown) => toOutcome("undo", writeError(cause)) as UndoResult)
        : await writeReversal
            .runWriteReversal({
              docId: input.docId,
              session,
              direction: "redo",
              selection: input.selection,
              actor: input.actor,
              interactionContext: input.interactionContext,
            })
            .catch((cause: unknown) => toOutcome("redo", writeError(cause)) as RedoResult);
    if (outcome.status !== "document_not_found")
      responseCommitter.dropForThread(input.docId, input.threadId);
    if (!input.requireEffect) return outcome;
    const liveAfter = await encodedLiveDocument(input.docId);
    return {
      ...outcome,
      reversalEffect:
        liveBefore && liveAfter && !bytesEqual(liveBefore, liveAfter) ? "changed" : "unchanged",
    } as VerifiedReverseResult;
  }

  async function invalidateThread(docId: string, threadId: string): Promise<void> {
    responseCommitter.dropForThread(docId, threadId);
    await runtimeStore.evictThreadRuntimes(docId, threadId, {
      markLiveDocStale: true,
    });
    threadOrigins.evictThread(docId, threadId);
  }

  async function encodedLiveDocument(docId: string): Promise<Uint8Array | null> {
    try {
      return await coordinator.withDocument(docId, async (doc) => Y.encodeStateAsUpdate(doc));
    } catch {
      return null;
    }
  }

  function localSession(id: string, threadId: string): ActorSession {
    const existing = localSessions.get(id);
    if (existing) return existing;
    const session: ActorSession = { id, threadId, documents: new Map() };
    localSessions.set(id, session);
    return session;
  }
}

function readRequiredRejection(file: string) {
  return status(
    "rejected_response_requires_reread",
    `This document must be read after a rejected response before it can be changed. Run write(command="read", file="${file}") and retry.`,
  );
}

function stagedCommitRejection(
  rejections: readonly import("./types.js").ResponseCommitDocumentRejection[],
) {
  const affectedWriteIds = [
    ...new Set(rejections.flatMap((rejection) => rejection.affectedWriteIds)),
  ];
  return status(
    "destructive_write_rejected",
    `The buffered response was rejected before undo/redo. Superseded tool calls: ${affectedWriteIds.join(", ") || "none reported"}. Read the affected documents and retry.`,
  );
}

export function commandSelection(
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
