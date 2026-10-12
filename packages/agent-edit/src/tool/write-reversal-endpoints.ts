// Hosted undo/redo/reverse endpoints and thread invalidation for the write tool.
import type { LinkView } from "@meridian/contracts";
import * as Y from "yjs";

import type { ActorSession } from "../ports/actor-session-store.js";
import type { DocumentCoordinator } from "../ports/document-coordinator.js";
import type { ReversalActor } from "../ports/types.js";
import type { ReversalSelection } from "../undo/reversal-plan.js";
import type { ThreadOriginRegistry } from "../undo/thread-origin-registry.js";
import { bytesEqual } from "../yjs-update.js";
import type { ResponseCommitter } from "./response-committer.js";
import { toOutcome } from "./response-format.js";
import type { RuntimeStore } from "./runtime-store.js";
import type {
  InteractionContext,
  RedoResult,
  TurnRedoResult,
  TurnUndoResult,
  UndoResult,
  WriteOutcome,
} from "./types.js";
import { writeError } from "./write-helpers.js";
import type { WriteReversal } from "./write-reversal.js";

export interface ReverseInput {
  docId: string;
  threadId: string;
  direction: "undo" | "redo";
  selection: ReversalSelection;
  actor: ReversalActor;
  requireEffect?: boolean;
  interactionContext?: InteractionContext;
  /** The view of the destination whose history this reverses (`WriteContext.linkView`). */
  linkView?: LinkView;
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
  };

  function runTurnReversalEndpoint(
    docId: string,
    threadId: string,
    direction: "undo",
    linkView?: LinkView,
  ): Promise<TurnUndoResult>;
  function runTurnReversalEndpoint(
    docId: string,
    threadId: string,
    direction: "redo",
    linkView?: LinkView,
  ): Promise<TurnRedoResult>;
  function runTurnReversalEndpoint(
    docId: string,
    threadId: string,
    direction: "undo" | "redo",
    linkView?: LinkView,
  ): Promise<TurnUndoResult | TurnRedoResult> {
    return runHostedReversal({
      docId,
      threadId,
      direction,
      selection: { kind: "latest" },
      actor: { type: "agent" },
      ...(linkView ? { linkView } : {}),
    }) as Promise<TurnUndoResult | TurnRedoResult>;
  }

  function reverse(input: ReverseInput): Promise<UndoResult | RedoResult | VerifiedReverseResult> {
    return runHostedReversal(input);
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
              linkView: input.linkView,
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
              linkView: input.linkView,
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
    const session: ActorSession = { id, threadId, documents: new Set() };
    localSessions.set(id, session);
    return session;
  }
}
