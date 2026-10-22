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

/** Live has one state per document: living at a placement, or removed by one removal. */
export type LiveTreeState =
  | { living: true; at: TreePlacement }
  /** The removal as the row held it right after: its time and the `location_version` it wrote. */
  | { living: false; removal: { time: string; locationVersion: string } };

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

/**
 * `restore` reverses a delete; `settle` mutates nothing (its `before` and `after` are equal) and
 * exists to name the entries a writer's Apply, Discard or cleanup ended.
 */
export type TreeChangeOp = "move" | "delete" | "restore" | "settle";

export type TreeChange = {
  op: TreeChangeOp;
  destination: TreeChangeDestination;
  /** `LiveTreeState` for a live destination, `BranchTreeFacts` for a draft one. */
  before: LiveTreeState | BranchTreeFacts;
  after: LiveTreeState | BranchTreeFacts;
  /** The path the model or writer saw it at, for messages. */
  shownAt: string | null;
  /** `nextval` of `document_edit_parts`' id sequence: one chronology with text parts. */
  seq: number;
  /** What an undo, redo, revert or rollback reverses. */
  targets: TreeChangeTarget[];
  /** The drafted entries a writer's Apply or Discard, or a cleanup, ended. */
  settles?: { editIds: string[]; as: "applied" | "discarded" };
};
