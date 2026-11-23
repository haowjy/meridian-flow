import type { CommandId, DocumentId, DraftId, DraftItemKey, WorkId } from "../ids.js";
import type { TreeSaw } from "./review.js";

/**
 * Apply or Discard, pressed on one change, a document, a draft or every draft of a Work. One recorded command; one Undo
 * (`PressUndoRequest`) takes it back; pressing again is the Redo.
 */
export type PressVerdict = "apply" | "discard";

/**
 * What a press takes. A document of a draft is its `DraftItemKey`. A change is named by the id of any one of its members
 * (a block id, or a comment id for a comment-body change: `changedBlocks`'s `BlockChange`), the id `change=<id>` carries
 * in the address; the press takes the whole change it belongs to. There is no folder scope.
 */
export type PressScope =
  | { kind: "change"; item: DraftItemKey; change: string }
  | { kind: "document"; item: DraftItemKey }
  | { kind: "draft"; draft: DraftId }
  /**
   * The Changes tab's `Apply all`: every draft of the Work, pressed one after another in draft id order, each on Live as
   * the one before left it. Its Undo takes them back draft by draft in the reverse order.
   */
  | { kind: "work"; work: WorkId };

export type PressRequest = {
  commandId: CommandId;
  verdict: PressVerdict;
  scope: PressScope;
  /**
   * The tree cut the press was drawn from: records admitted after it stay pending, as do records it saw that the
   * server has not received yet.
   */
  saw?: TreeSaw;
  /**
   * For an Apply, the Live text the writer was shown, per document: an encoded `RoomVersion` (`encodeRoomVersion`) of
   * Live's text docs as the pressing tab showed them, or as the Changes list was read (`DraftItem.liveVersion`). It only
   * stamps the record of a removal the press applies, never a barrier: Live typing it does not count brings the block
   * back. A document, or a text doc of one, it names no version for counts as never shown, so a removal there does not
   * land.
   */
  liveVersions?: { documentId: DocumentId; version: string }[];
};

export type PressResult = {
  status: "pressed";
  commandId: CommandId;
  verdict: PressVerdict;
  scope: PressScope;
  /**
   * Every document whose rooms the press committed to, in Live or a fork: text, structure or a comment body. What its
   * Undo takes back. Empty when the scope had no change.
   */
  documents: DocumentId[];
  /** The nodes whose tree change the press made. */
  items: { node: string; tree?: true }[];
  /** A Discard's: the tree's delete records that put the documents the Work created in Trash. */
  trashed?: string[];
};

/**
 * Who wrote over a pressed change since the press, read from the commits on its text: the writer (a tab's commit, which
 * has no message), a chat (`turn:<id>`, named by its ref, `c12`), or another press. A server write with no message (a
 * restore, a copy) names no one. Empty when only its structure was written over, which names no author.
 */
export type PressOverwriter =
  | { kind: "writer" }
  | { kind: "chat"; ref: string }
  | { kind: "press" };

export type PressUndoRequest = { commandId: CommandId; pressCommandId: CommandId };

export type PressUndoResult = {
  status: "unpressed";
  commandId: CommandId;
  pressCommandId: CommandId;
  /** Every document whose rooms the Undo committed to. */
  documents: DocumentId[];
  /**
   * The changes someone wrote over since the press, which the Undo left whole, each named by the id of one of its members
   * (as `PressScope`'s `change`) and by who wrote over it. An Undo takes a change back whole or not at all (design §2).
   */
  stayed: { documentId: DocumentId; change: string; by: PressOverwriter[] }[];
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
