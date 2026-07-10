import * as Y from "yjs";
// Interaction-context merge rules and journal mutation mode for write tooling.
import type { InteractionContext } from "./types.js";

/** Journal mutation mode derived from interaction context. */
export function mutationMode(
  context: InteractionContext | undefined,
): { mode: "threadPeer"; branchGeneration: number } | { mode: "live" } {
  return context?.mode === "threadPeer"
    ? { mode: "threadPeer", branchGeneration: context.branchGeneration }
    : { mode: "live" };
}

/**
 * Per-attempt interaction context for immediate (non-staged) writes: always
 * stamps `attemptId` and folds an optional detection baseline snapshot.
 */
export function interactionContextForAttempt(
  context: InteractionContext | undefined,
  baselineSnapshot: Uint8Array | undefined,
  attemptId: string,
): InteractionContext | undefined {
  if (!context && !baselineSnapshot) return { mode: "live", attemptId };
  if (context?.mode === "threadPeer") {
    return {
      ...context,
      ...(baselineSnapshot ? { baselineSnapshot } : {}),
      attemptId,
    };
  }
  return {
    mode: "live",
    ...context,
    ...(baselineSnapshot ? { baselineSnapshot } : {}),
    attemptId,
  };
}

type ResponseDocumentInteraction = {
  interactionContext?: InteractionContext;
};

/**
 * Per-response doc buffer interaction context: once thread-peer mode is set on
 * the buffer, a later live-mode write in the same response does not downgrade it.
 */
export function responseInteractionContext(
  docBuffer: ResponseDocumentInteraction,
  inputContext: InteractionContext | undefined,
): InteractionContext | undefined {
  if (docBuffer.interactionContext?.mode === "threadPeer" && inputContext?.mode !== "threadPeer") {
    return docBuffer.interactionContext;
  }
  return inputContext ?? docBuffer.interactionContext;
}

export function responseAwareBaselineSnapshot(
  baseline: Uint8Array,
  bufferedUpdates: readonly Uint8Array[],
): Uint8Array {
  if (bufferedUpdates.length === 0) return baseline;
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, baseline, { type: "system" });
    for (const update of bufferedUpdates) {
      Y.applyUpdate(doc, update, { type: "system" });
      if (hasPendingIntegration(doc)) {
        throw new Error("Buffered response update is not integrable into the interaction baseline");
      }
    }
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

export function baselineIntegratesBuffered(
  baseline: Uint8Array,
  bufferedUpdates: readonly Uint8Array[],
): boolean {
  try {
    responseAwareBaselineSnapshot(baseline, bufferedUpdates);
    return true;
  } catch {
    return false;
  }
}

export class BaselineIntegrationError extends Error {}

function hasPendingIntegration(doc: Y.Doc): boolean {
  const store = doc.store as {
    pendingStructs?: unknown | null;
    pendingDs?: unknown | null;
  };
  return store.pendingStructs !== null || store.pendingDs !== null;
}
