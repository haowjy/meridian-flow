// Hosted undo/redo/reverse endpoints and thread invalidation for the write tool.
import * as Y from "yjs";

import type { ActorSession } from "../ports/actor-session-store.js";
import type { DocumentCoordinator } from "../ports/document-coordinator.js";
import type { ReversalActor } from "../ports/types.js";
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
  actor: ReversalActor;
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
    if (context.responseId && responseCommitter.hasBufferedWrites(context.responseId)) {
      // Undo and redo reverse saved history. The host saves the reply before
      // one (a save boundary), so a write staged in it here is a host bug.
      throw new Error(
        `Invariant violation: ${direction} ran in response ${context.responseId} with staged writes; save the reply first.`,
      );
    }
    const selection = commandSelection(command, context);

    const result = await writeReversal.run({
      docId: address.documentId,
      session,
      commandName: command.command,
      direction,
      selection,
      filePath: address.filePath,
      actor: reversalActorFor(context),
      interactionContext: context.interactionContext,
    });
    return result;
  }

  function reversalActorFor(context: WriteContext): ReversalActor {
    if (context.actor?.kind === "human") return { type: "user", userId: context.actor.userId };
    const agent = context.actor?.kind === "agent" ? context.actor : undefined;
    const responseId = agent ? agent.responseId : context.responseId;
    const turnId = agent ? agent.turnId : context.turnId;
    return {
      type: "agent",
      ...(responseId ? { responseId } : {}),
      ...(turnId ? { turnId } : {}),
    };
  }

  async function runHostedReversal(
    input: ReverseInput,
  ): Promise<UndoResult | RedoResult | VerifiedReverseResult> {
    const session = localSession(input.threadId, input.threadId);
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

/**
 * Maps a parsed command to its selection; the schema already enforced the
 * selector rule. Handles the host chose replace the command's selector.
 */
export function commandSelection(
  command: UndoCommand | RedoCommand,
  context: Pick<WriteContext, "reversalHandles"> = {},
): ReversalSelection {
  if (context.reversalHandles) return { kind: "handles", ids: context.reversalHandles };
  if (command.all === true) return { kind: "all" };
  if (command.last !== undefined) return { kind: "last", count: command.last };
  if (command.to === undefined) return { kind: "latest" };
  if (command.since === undefined) return { kind: "single", to: command.to };
  return { kind: "range", since: command.since, to: command.to };
}
