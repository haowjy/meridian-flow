// Hosted undo/redo/reverse endpoints and thread invalidation for the write tool.
import * as Y from "yjs";

import type { ActorSession } from "../ports/actor-session-store.js";
import type { ReversalSelection } from "../undo/reversal-plan.js";
import { bytesEqual } from "../yjs-update.js";
import { status, toOutcome } from "./response-format.js";
import type {
  RedoCommand,
  RedoResult,
  TurnRedoResult,
  TurnUndoResult,
  UndoCommand,
  UndoResult,
  WriteContext,
  WriteOutcome,
} from "./types.js";
import type { WriteToolInternals } from "./write-deps.js";
import { commandSelection, parseFileAddress, writeError } from "./write-helpers.js";

export interface ReverseInput {
  docId: string;
  threadId: string;
  direction: "undo" | "redo";
  selection: ReversalSelection;
  actor: { type: "user"; userId: string } | { type: "agent" };
  requireEffect?: boolean;
}

export type VerifiedReverseEffect = "changed" | "unchanged" | "not_checked";
export type VerifiedReverseResult = WriteOutcome & {
  reversalEffect?: VerifiedReverseEffect;
};

export function createWriteReversalEndpoints(deps: WriteToolInternals) {
  const { options, localSessions, responseCommitter, writeReversal, runtimeStore, threadOrigins } =
    deps;

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
    if (context.responseId && responseCommitter.hasBufferedWrites(context.responseId)) {
      await responseCommitter.commitResponse(context.responseId);
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

  async function runHostedReversal(
    input: ReverseInput,
  ): Promise<UndoResult | RedoResult | VerifiedReverseResult> {
    responseCommitter.dropForThread(input.docId, input.threadId);
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
            .catch((cause: unknown) => toOutcome("undo", writeError(cause)) as UndoResult)
        : await writeReversal
            .runWriteReversal({
              docId: input.docId,
              session,
              direction: "redo",
              selection: input.selection,
              actor: input.actor,
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
      return await options.coordinator.withDocument(docId, async (doc) =>
        Y.encodeStateAsUpdate(doc),
      );
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
