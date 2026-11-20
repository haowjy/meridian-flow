/** Resolves immutable origins to one captured live, active-draft, or gone destination. */

import type { BranchId, EditOrigin } from "@meridian/contracts";
import type { ClosedOwnerWhy } from "@meridian/contracts/commands";
import type * as Y from "yjs";
import type { DraftSnapshot } from "./draft-store.js";
import type { InverseDocument } from "./turn-inverse-service.js";

export type LiveInverseDestination = {
  kind: "live";
  view: Y.Doc;
  /** A live file owned by an archived or deleted Work is not writable: why, else null. */
  closed: ClosedOwnerWhy | null;
  /** Live removal does not close an active draft that survived it. */
  removed: boolean;
};
export type ActiveInverseDestination = {
  kind: "draft";
  closed: ClosedOwnerWhy | null;
  branchId: BranchId;
  draftId: string;
  revision: number;
  state: "active";
};
export type GoneInverseDestination = {
  kind: "draft";
  closed: ClosedOwnerWhy | null;
  /** Null: the draft's row is gone (its entry or its Work was purged), and with it its branch. */
  branchId: BranchId | null;
  state: "gone";
};
export type InverseDestination =
  | LiveInverseDestination
  | ActiveInverseDestination
  | GoneInverseDestination;

export type CapturedDraft = {
  documentDraft: DraftSnapshot;
  doc: Y.Doc;
  name: string;
  closed: ClosedOwnerWhy | null;
};

export function createInverseDestinationResolver(
  document: InverseDocument,
  liveAvailability: { closed: ClosedOwnerWhy | null; removed: boolean },
): Pick<InverseDocument, "destinationOf"> {
  const drafts = new Map<string, InverseDestination>();
  const live: LiveInverseDestination = { kind: "live", view: document.live, ...liveAvailability };
  const fromDraft = (draftId: string): InverseDestination => {
    const cached = drafts.get(draftId);
    if (cached) return cached;
    const captured = document.drafts.get(draftId);
    // Capture skips a draft with no row: purged with its Work, which is gone for good.
    if (!captured) {
      const purged: InverseDestination = {
        kind: "draft",
        closed: null,
        branchId: null,
        state: "gone",
      };
      drafts.set(draftId, purged);
      return purged;
    }
    const row = captured.documentDraft;
    const destination: InverseDestination = {
      kind: "draft",
      closed: captured.closed,
      branchId: row.branchId,
      draftId: row.draftId,
      revision: row.revision,
      state: "active",
    };
    drafts.set(draftId, destination);
    return destination;
  };
  return {
    destinationOf(origin: EditOrigin) {
      return origin.kind === "live" ? live : fromDraft(origin.draftId);
    },
  };
}
