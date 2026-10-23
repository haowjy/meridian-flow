/** Resolves immutable draft origins to one captured destination for an inverse attempt. */

import type { BranchId, EditOrigin } from "@meridian/contracts";
import type * as Y from "yjs";
import type { DraftSnapshot } from "./draft-store.js";
import type { StoredTreeEntry, TransitionEntry } from "./tree-inverse.js";
import type { InverseDocument } from "./turn-inverse-service.js";

export type LiveInverseDestination = { kind: "live"; view: Y.Doc };
export type ActiveInverseDestination = {
  kind: "draft";
  branchId: BranchId;
  draftId: string;
  revision: number;
  view: Y.Doc;
  state: "active";
};
export type RestorableInverseDestination = {
  kind: "draft";
  branchId: BranchId;
  source: { draftId: string; revision: number };
  view: Y.Doc;
  state: "restorable";
};
export type GoneInverseDestination = {
  kind: "draft";
  branchId: BranchId;
  state: "gone";
};
export type InverseDestination =
  | LiveInverseDestination
  | ActiveInverseDestination
  | RestorableInverseDestination
  | GoneInverseDestination;

export type CapturedDraft = {
  documentDraft: DraftSnapshot;
  doc: Y.Doc;
  name: string;
  frozen: boolean;
};

function terminal(document: InverseDocument, originDraftId: string): CapturedDraft | undefined {
  const origin = document.drafts.get(originDraftId);
  if (!origin) return undefined;
  const visited = new Set<string>();
  let current = origin;
  while (current.documentDraft.successorDraftId) {
    if (visited.has(current.documentDraft.draftId))
      throw new Error(`Draft continuation cycle at ${current.documentDraft.draftId}`);
    visited.add(current.documentDraft.draftId);
    const successor = document.drafts.get(current.documentDraft.successorDraftId);
    if (
      !successor ||
      successor.documentDraft.documentId !== origin.documentDraft.documentId ||
      successor.documentDraft.branchId !== origin.documentDraft.branchId
    )
      throw new Error(`Draft ${current.documentDraft.draftId} has an invalid continuation`);
    current = successor;
  }
  return current;
}

function retiredByCreateUndo(document: InverseDocument, draftId: string): boolean {
  return document.tree.some(
    (row) => row.tree.op !== "settle" && row.tree.retiredDraftId === draftId,
  );
}

function fromDraft(document: InverseDocument, draftId: string): InverseDestination {
  const origin = document.drafts.get(draftId);
  if (!origin)
    throw new Error(`Inverse origin draft ${draftId} was not captured for ${document.documentId}`);
  const current = terminal(document, draftId);
  if (!current) throw new Error(`Inverse origin draft ${draftId} vanished from its capture`);
  const row = current.documentDraft;
  if (row.status === "active")
    return {
      kind: "draft",
      branchId: row.branchId,
      draftId: row.draftId,
      revision: row.revision,
      view: current.doc,
      state: "active",
    };
  if (!document.occupancy(row.branchId) && retiredByCreateUndo(document, row.draftId))
    return {
      kind: "draft",
      branchId: row.branchId,
      source: { draftId: row.draftId, revision: row.revision },
      view: current.doc,
      state: "restorable",
    };
  return { kind: "draft", branchId: row.branchId, state: "gone" };
}

export function createInverseDestinationResolver(
  document: InverseDocument,
  occupancy: ReadonlyMap<BranchId, string>,
): Pick<InverseDocument, "destinationOf" | "destinationForCreate" | "occupancy"> {
  const origins = new Map<string, InverseDestination>();
  const creates = new Map<string, InverseDestination>();
  const live: LiveInverseDestination = { kind: "live", view: document.live };
  const destinationOf = (origin: EditOrigin): InverseDestination => {
    if (origin.kind === "live") return live;
    let destination = origins.get(origin.draftId);
    if (!destination) {
      destination = fromDraft(document, origin.draftId);
      origins.set(origin.draftId, destination);
    }
    return destination;
  };
  const destinationForCreate = (create: TransitionEntry): InverseDestination => {
    const cached = creates.get(create.editId);
    if (cached) return cached;
    if (create.tree.destination.kind === "live") {
      creates.set(create.editId, live);
      return live;
    }
    const retired = [...document.tree]
      .reverse()
      .find(
        (row: StoredTreeEntry) =>
          row.tree.op !== "settle" &&
          row.tree.retiredDraftId &&
          row.tree.targets.some((target) => target.editId === create.editId),
      );
    const retiredDraftId = retired?.tree.op !== "settle" ? retired?.tree.retiredDraftId : undefined;
    const destination = retiredDraftId
      ? fromDraft(document, retiredDraftId)
      : ({
          kind: "draft",
          branchId: create.tree.destination.branchId,
          state: "gone",
        } as const);
    creates.set(create.editId, destination);
    return destination;
  };
  return {
    destinationOf,
    destinationForCreate,
    occupancy: (branchId) => occupancy.get(branchId) ?? null,
  };
}
