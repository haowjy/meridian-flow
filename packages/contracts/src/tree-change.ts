/**
 * A move or delete in a document's edit history (`document_edits.tree_change`): the exact state
 * transition it made in its destination, so an inverse restores the prior state rather than
 * coordinates. A tree entry has no Yjs parts; `seq` places it on the same axis as text parts.
 */
import type { BranchId } from "./ids.js";

/** A document's placement: its folder (or, at a source's root, that source), name and extension. */
export type TreePlacement = {
  folderId: string | null;
  rootSourceId: string | null;
  name: string;
  extension: string;
};

/** A removal as the row held it right after: its time and the `location_version` it wrote. */
export type TreeRemoval = { time: string; locationVersion: string };

/** Live has one state per document: living at a placement, or removed by one removal. */
export type LiveTreeState =
  | { living: true; at: TreePlacement }
  | { living: false; removal: TreeRemoval };

/**
 * A branch's facts about a document (its `branch_tree_changes` row), not its effective
 * placement, so "no move, follows live" and "moved to where live happens to be" differ.
 */
export type BranchTreeFacts = {
  row: boolean;
  created: boolean;
  moved: TreePlacement | null;
  deleted: boolean;
};

export type TreeChangeDestination = { kind: "live" } | { kind: "draft"; branchId: BranchId };

export type TreeChangeTarget = { editId: string; direction: "invert" | "reapply" };

/** A live transition joins two live states; a branch one, two sets of the branch's facts. */
export type LiveTreeTransition = {
  destination: { kind: "live" };
  before: LiveTreeState;
  after: LiveTreeState;
};
export type BranchTreeTransition = {
  destination: { kind: "draft"; branchId: BranchId };
  before: BranchTreeFacts;
  after: BranchTreeFacts;
};
export type TreeTransition = LiveTreeTransition | BranchTreeTransition;

/** `restore` reverses a delete. */
export type TreeChangeOp = "move" | "delete" | "restore";

type TreeEntryFields = {
  /** The path the model or writer saw it at, for messages. */
  shownAt: string | null;
  /** `nextval` of `document_edit_parts`' id sequence: one chronology with text parts. */
  seq: number;
};

/** A row that changed where a document is, or whether it is. */
export type TreeTransitionChange = TreeTransition &
  TreeEntryFields & {
    op: TreeChangeOp;
    /** Where a model's move left it, for the turn's receipt line; the move's own row sets it. */
    landedAt?: string;
    /** What an undo, redo, revert or rollback reverses. */
    targets: TreeChangeTarget[];
  };

/**
 * A row that mutates nothing: it names the drafted entries a writer's Apply or Discard, or a
 * cleanup, ended.
 */
export type TreeSettlement = TreeEntryFields & {
  op: "settle";
  destination: TreeChangeDestination;
  targets: [];
  settles: { editIds: string[]; as: "applied" | "discarded" };
};

export type TreeChange = TreeTransitionChange | TreeSettlement;

/** Narrows a transition by its destination: the one place a live or branch shape is told apart. */
export function isLiveTransition<T extends TreeTransition>(
  transition: T,
): transition is Extract<T, LiveTreeTransition> {
  return transition.destination.kind === "live";
}
