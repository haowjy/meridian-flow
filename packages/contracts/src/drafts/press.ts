import type { CommandId, DraftId } from "../ids.js";
import type { TreeSaw } from "./review.js";

/**
 * Apply or Discard pressed on documents, folders or a whole draft. One recorded command over the draft's pending tree records. One Undo
 * (`PressUndoRequest`) takes it back; pressing again is the Redo.
 */
export type PressVerdict = "apply" | "discard";

export type PressRequest = {
  commandId: CommandId;
  /** The draft pressed on. */
  draft: DraftId;
  verdict: PressVerdict;
  /** Documents and folders (a folder takes what is under it), or everything the Work has pending. */
  items: { node: string }[] | "all";
  /** The tree cut the press was drawn from: records admitted after it stay pending. */
  saw?: TreeSaw;
};

export type PressResult = {
  status: "pressed";
  commandId: CommandId;
  /** The draft pressed on. */
  draft: DraftId;
  verdict: PressVerdict;
  /** The nodes the press changed: what its Undo takes back. */
  items: { node: string; tree?: true }[];
  /** A Discard's: the tree's delete records that put the documents the Work created in Trash. */
  trashed?: string[];
};

export type PressUndoRequest = { commandId: CommandId; pressCommandId: CommandId };

export type PressUndoResult = {
  status: "unpressed";
  commandId: CommandId;
  pressCommandId: CommandId;
  /** The nodes whose tree change came back. */
  tree: string[];
};
