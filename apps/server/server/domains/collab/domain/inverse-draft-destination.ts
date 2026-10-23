/** Resolves immutable origins to one captured live, active-draft, or gone destination. */

import type { BranchId, EditOrigin } from "@meridian/contracts";
import type * as Y from "yjs";
import type { DraftSnapshot } from "./draft-store.js";
import type { InverseDocument } from "./turn-inverse-service.js";

export type LiveInverseDestination = { kind: "live"; view: Y.Doc };
export type ActiveInverseDestination = {
  kind: "draft";
  frozen: boolean;
  branchId: BranchId;
  draftId: string;
  revision: number;
  view: Y.Doc;
  state: "active";
};
export type GoneInverseDestination = {
  kind: "draft";
  frozen: boolean;
  branchId: BranchId;
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
  frozen: boolean;
};

export function createInverseDestinationResolver(
  document: InverseDocument,
  occupancy: ReadonlyMap<BranchId, string>,
  branchAvailability: ReadonlyMap<BranchId, { frozen: boolean }>,
): Pick<InverseDocument, "destinationOf" | "destinationForBranch"> {
  const drafts = new Map<string, InverseDestination>();
  const live: LiveInverseDestination = { kind: "live", view: document.live };
  const fromDraft = (draftId: string): InverseDestination => {
    const cached = drafts.get(draftId);
    if (cached) return cached;
    const captured = document.drafts.get(draftId);
    if (!captured)
      throw new Error(
        `Inverse origin draft ${draftId} was not captured for ${document.documentId}`,
      );
    const row = captured.documentDraft;
    const destination: InverseDestination =
      row.status === "active"
        ? {
            kind: "draft",
            frozen: captured.frozen,
            branchId: row.branchId,
            draftId: row.draftId,
            revision: row.revision,
            view: captured.doc,
            state: "active",
          }
        : { kind: "draft", frozen: captured.frozen, branchId: row.branchId, state: "gone" };
    drafts.set(draftId, destination);
    return destination;
  };
  return {
    destinationOf(origin: EditOrigin) {
      return origin.kind === "live" ? live : fromDraft(origin.draftId);
    },
    destinationForBranch(branchId: BranchId) {
      const draftId = occupancy.get(branchId);
      return draftId
        ? fromDraft(draftId)
        : {
            kind: "draft",
            frozen: branchAvailability.get(branchId)?.frozen ?? true,
            branchId,
            state: "gone",
          };
    },
  };
}
