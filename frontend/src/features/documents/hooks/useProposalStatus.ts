/**
 * useProposalStatus - Look up a proposal's live status from the collab store.
 *
 * The tool result from the backend includes `proposal_id` and `status` (at creation time).
 * This hook cross-references with the collab store to get the live status:
 * - If the proposal is still in the store's Map -> "pending" (awaiting review)
 * - If not in the Map and initial status was "accepted" -> "accepted" (auto-accepted at creation)
 * - If not in the Map and initial status was "proposed" -> "resolved" (was accepted/rejected after creation)
 *
 * Note: proposals are removed from the collab store Map when accepted or rejected,
 * so presence in the Map means the proposal is still pending review.
 */

import { useCollabStore } from "@/features/documents/stores/useCollabStore";

export type ProposalBadgeStatus =
  | "pending"
  | "accepted"
  | "resolved"
  | null;

/**
 * Look up a proposal's display status for a thread tool-result badge.
 *
 * @param proposalId - The proposal ID from the tool result (may be undefined)
 * @param initialStatus - The status at creation time from the backend ("proposed" | "accepted")
 * @param documentId - The document ID to look up in the collab store (may be undefined)
 */
export function useProposalStatus(
  proposalId: string | undefined,
  initialStatus: string | undefined,
  documentId: string | undefined,
): ProposalBadgeStatus {
  const proposalState = useCollabStore((s) =>
    documentId ? s.proposalStateByDocumentId[documentId] : undefined,
  );

  if (!proposalId) return null;

  // If auto-accepted at creation time, always show "accepted"
  if (initialStatus === "accepted") return "accepted";

  // If the document has collab state, check if proposal is still pending
  if (proposalState) {
    const isStillPending = proposalState.proposals.has(proposalId);
    return isStillPending ? "pending" : "resolved";
  }

  // No collab state for this document (not open / no WS connection).
  // Fall back to initial status from tool result.
  if (initialStatus === "proposed") return "pending";

  return null;
}
