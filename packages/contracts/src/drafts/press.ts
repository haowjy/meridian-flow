import type { CommandId, DraftId } from "../ids.js";
import type { TreeSaw } from "./review.js";

/**
 * Apply or Discard pressed on documents, folders or a whole draft. One recorded command over both halves: the draft's pending tree records and its
 * suggestions in each document's text. One Undo (`PressUndoRequest`) takes back both; pressing
 * again is the Redo.
 */
export type PressVerdict = "apply" | "discard";

export type PressRequest = {
  commandId: CommandId;
  /** The draft pressed on. */
  draft: DraftId;
  verdict: PressVerdict;
  /**
   * Documents and folders (a folder takes what is under it), or everything the Work has pending.
   * `half: "tree"` takes only the node's tree change (a move, rename or delete), not its text.
   */
  items: { node: string; half?: "tree" }[] | "all";
  /** The tree cut the press was drawn from: records admitted after it stay pending. */
  saw?: TreeSaw;
  /**
   * For every live room in the pressing tab with typing the server hasn't acknowledged, its Yjs
   * state vector (base64): the server answers
   * "not yet" (503) until it holds them all, so a keystroke typed just before the press is in it,
   * in a document the press names or one it finds.
   */
  seen?: { documentId: string; vector: string }[];
  /**
   * A Redo after this tab's Undo: the press it presses again. What that press put in Trash (the
   * documents the Work created) and its Undo brought back goes to Trash again.
   */
  redoes?: CommandId;
};

export type PressResult = {
  status: "pressed";
  commandId: CommandId;
  /** The draft pressed on. */
  draft: DraftId;
  verdict: PressVerdict;
  /** The nodes the press changed, with the halves that changed: what its Undo takes back. */
  items: { node: string; tree?: true; text?: true }[];
  /** A Discard's: the tree's delete records that put the documents the Work created in Trash. */
  trashed?: string[];
};

export type PressUndoRequest = { commandId: CommandId; pressCommandId: CommandId };

export type PressUndoResult = {
  status: "unpressed";
  commandId: CommandId;
  pressCommandId: CommandId;
  /** The documents whose text came back, and the nodes whose tree change came back. */
  text: string[];
  tree: string[];
};
