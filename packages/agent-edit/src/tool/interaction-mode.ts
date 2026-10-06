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
 * Per-attempt interaction context for a write: stamps the durable attempt ID
 * without changing interaction mode. A live write without its own journal
 * floor takes the runtime's, the head it last read the live document at.
 */
export function interactionContextForAttempt(
  context: InteractionContext | undefined,
  attemptId: string,
  runtimeJournalSeq: number | undefined,
): InteractionContext {
  if (context?.mode === "threadPeer") return { ...context, attemptId };
  const liveJournalSeq = context?.liveJournalSeq ?? runtimeJournalSeq;
  return {
    ...context,
    mode: "live",
    attemptId,
    ...(liveJournalSeq === undefined ? {} : { liveJournalSeq }),
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
