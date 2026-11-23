import type { CommandId, DocumentId, DraftId, WorkId } from "../ids.js";
import type { TreeSaw } from "./review.js";

/**
 * Apply or Discard, pressed on one change, a document, a draft or every draft of a Work. One recorded command; one Undo
 * (`PressUndoRequest`) takes it back; pressing again is the Redo.
 */
export type PressVerdict = "apply" | "discard";

/**
 * What a press takes. A change is named by any one of its blocks: the press takes the whole change it belongs to
 * (`changedBlocks`'s group). There is no folder scope.
 */
export type PressScope =
  | { kind: "change"; draft: DraftId; documentId: DocumentId; blockId: string }
  | { kind: "document"; draft: DraftId; documentId: DocumentId }
  | { kind: "draft"; draft: DraftId }
  /** The Changes tab's `Apply all`: every draft of the Work. */
  | { kind: "work"; work: WorkId };

export type PressRequest = {
  commandId: CommandId;
  verdict: PressVerdict;
  scope: PressScope;
  /** The tree cut the press was drawn from: records admitted after it stay pending. */
  saw?: TreeSaw;
};

export type PressResult = {
  status: "pressed";
  commandId: CommandId;
  verdict: PressVerdict;
  scope: PressScope;
  /** The documents whose text the press changed, in Live or in a fork: what its Undo takes back. Empty when the scope had no change. */
  documents: DocumentId[];
  /** The nodes whose tree change the press made. */
  items: { node: string; tree?: true }[];
  /** A Discard's: the tree's delete records that put the documents the Work created in Trash. */
  trashed?: string[];
};

export type PressUndoRequest = { commandId: CommandId; pressCommandId: CommandId };

export type PressUndoResult = {
  status: "unpressed";
  commandId: CommandId;
  pressCommandId: CommandId;
  /** The documents whose text came back. */
  documents: DocumentId[];
  /** The nodes whose tree change came back. */
  tree: string[];
};

/**
 * The press today's server and client speak: the tree half over documents and folders of one draft. 2b and 2c move
 * onto `PressRequest` and delete these.
 */
export type TreePressRequest = {
  commandId: CommandId;
  /** The draft pressed on. */
  draft: DraftId;
  verdict: PressVerdict;
  /** Documents and folders (a folder takes what is under it), or everything the Work has pending. */
  items: { node: string }[] | "all";
  saw?: TreeSaw;
};

export type TreePressResult = {
  status: "pressed";
  commandId: CommandId;
  draft: DraftId;
  verdict: PressVerdict;
  items: { node: string; tree?: true }[];
  trashed?: string[];
};

export type TreePressUndoResult = {
  status: "unpressed";
  commandId: CommandId;
  pressCommandId: CommandId;
  tree: string[];
};
