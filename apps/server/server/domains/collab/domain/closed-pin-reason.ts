/** Why a reply's pinned peer lost its write: the one rule the save fence and peer pulls share. */
import type { RetiredWriteReason } from "@meridian/agent-edit/integration";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import type { DraftSnapshot } from "./draft-store.js";

type PinnedDraft = Pick<DraftSnapshot, "status" | "closedCause"> | null | undefined;

export type ClosedPin = {
  branchActive: boolean;
  upstream: PinnedDraft;
  peer: PinnedDraft;
  removal: DocumentRemovalRecord | undefined;
};

/**
 * The branch closed, else the upstream draft is closed or gone, else the peer is; undefined while
 * all three stand. A closed draft is the removal's, not a writer's discard, when its document
 * has a removal record or either draft closed `document_removed`: that cause outlives a Work
 * Restore, so the record may be gone (`removed: null`).
 */
export function closedPinReason(pin: ClosedPin): RetiredWriteReason | undefined {
  if (!pin.branchActive) return "discarded_draft";
  const closed = (draft: PinnedDraft) => !draft || draft.status === "closed";
  const reason = closed(pin.upstream)
    ? "discarded_document"
    : closed(pin.peer)
      ? "discarded_edit"
      : undefined;
  if (!reason) return undefined;
  const byRemoval =
    pin.upstream?.closedCause === "document_removed" ||
    pin.peer?.closedCause === "document_removed";
  return pin.removal || byRemoval ? { removed: pin.removal ?? null } : reason;
}
