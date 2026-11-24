import type { LinkShowing, ObservationFrontier } from "@meridian/agent-edit/integration";
import type { ModelEvidence } from "../../domains/collab/index.js";
import type { ResultEvidence, ShownLinkShowing } from "../../shared/model-evidence.js";

export function evidenceOf(
  documentId: string,
  outcome: { showing?: LinkShowing; frontier?: ObservationFrontier },
): ResultEvidence {
  return {
    shown: showingOf(documentId, outcome),
    ...(outcome.frontier ? { frontier: outcome.frontier } : {}),
  };
}

export function showingOf(
  documentId: string,
  shown: { showing?: LinkShowing },
): ShownLinkShowing[] {
  return shown.showing ? [{ documentId, ...shown.showing }] : [];
}

export function threadShownLinks(
  deps: { shownLinks: Pick<ModelEvidence, "forDocument"> },
  threadId: string,
) {
  return (documentId: string) => deps.shownLinks.forDocument(threadId, documentId);
}
