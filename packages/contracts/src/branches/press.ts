import type { Settlement } from "../commands/index.js";
import type { CommandId } from "../ids.js";
import type { TreeSaw } from "./review.js";

/**
 * Suggestion mode (`FLOW_SUGGESTIONS`): Apply or Discard pressed on documents, folders or a whole
 * Work. One recorded command over both halves: the Work's pending tree records and its
 * suggestions in each document's text. One Undo (`PressUndoRequest`) takes back both; pressing
 * again is the Redo.
 */
export type PressVerdict = "apply" | "discard";

export type PressRequest = {
  commandId: CommandId;
  /** The Work: its draft owner key, `work:<id>` or `lineage:<rootThreadId>`. */
  owner: string;
  verdict: PressVerdict;
  /** Documents and folders (a folder takes what is under it), or everything the Work has pending. */
  items: { node: string }[] | "all";
  /** The tree cut the press was drawn from: records admitted after it stay pending. */
  saw?: TreeSaw;
  /**
   * For each document open in the pressing tab, its Yjs state vector (base64): the server answers
   * "not yet" (503) until it holds them, so a keystroke typed just before the press is in it.
   */
  seen?: { documentId: string; vector: string }[];
};

export type PressResult = {
  status: "pressed";
  commandId: CommandId;
  /** The Work pressed on, as its owner key. */
  owner: string;
  verdict: PressVerdict;
  /** The nodes the press changed, with the halves that changed: what its Undo takes back. */
  items: { node: string; tree?: true; text?: true }[];
  /** A Discard on a closed owner (an archived or deleted Work, a chat in Trash) changes nothing. */
  settled?: Settlement[];
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
