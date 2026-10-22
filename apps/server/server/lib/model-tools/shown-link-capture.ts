/**
 * Result evidence (contract §7.2): what a tool result actually showed the
 * model, returned beside the result as host-only `evidence` (shown-link
 * candidates and the observation frontier). Dispatch records it only when it
 * persists the result, so a cancelled or timed-out call leaves none. Facts come
 * from the handlers that return rendered text, never from `readDocument`, so a
 * copy's private source read shows nothing. Also hands the thread's evidence
 * to agent-edit writes (§7.4).
 */
import type { LinkShowing, ObservationFrontier } from "@meridian/agent-edit/integration";
import type {
  ResultEvidence,
  ShownLinkShowing,
  ShownLinkStore,
} from "../../domains/runtime/index.js";

/** What a rendered agent-edit outcome showed: its links and its frontier. */
export function evidenceOf(
  documentId: string,
  outcome: { showing?: LinkShowing; frontier?: ObservationFrontier },
): ResultEvidence {
  return {
    shown: showingOf(documentId, outcome),
    ...(outcome.frontier ? { frontier: outcome.frontier } : {}),
  };
}

/**
 * The candidate for one holder, exactly as its render spelled it: facts,
 * holder URI and view all come from the binding that rendered. None without
 * facts. The caller never supplies a holder URI: one resolved before or after
 * the render could name a base the model was not shown.
 */
export function showingOf(
  documentId: string,
  shown: { showing?: LinkShowing },
): ShownLinkShowing[] {
  return shown.showing ? [{ documentId, ...shown.showing }] : [];
}

/** `WriteContext.shownLinks` for a thread's agent writes. */
export function threadShownLinks(
  deps: { shownLinks: Pick<ShownLinkStore, "forDocument"> },
  threadId: string,
) {
  return (documentId: string) => deps.shownLinks.forDocument(threadId, documentId);
}
