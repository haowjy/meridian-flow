import type { CommandId, DocumentId, DraftId, DraftItemKey, TurnId, WorkId } from "../ids.js";
import type { TreeSaw } from "./review.js";

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

/**
 * What a press does, and to what. Apply or Discard on one change, a document, a draft or every draft of a Work; or a
 * Draft chat turn card's `Restore before` on a turn in one draft: the turn's writes into the draft's text (its fork of a
 * document, or the Live room of a document only the draft holds) go back by the one Undo rule, newest first, each whole
 * or left whole when someone wrote over it since, and the nodes the turn created in the draft go to Trash (design §2). Live's manuscript is
 * untouched, so text an Apply already put there stays. A turn that wrote in several drafts is one press per draft,
 * each in that draft's lane. One recorded command; one Undo (`PressUndoRequest`) takes it back; pressing again is the
 * Redo.
 */
export type PressAction =
  | { verdict: "apply" | "discard"; scope: PressScope }
  | { verdict: "restore"; scope: { kind: "turn"; turn: TurnId; draft: DraftId } };

export type PressVerdict = PressAction["verdict"];

export type PressRequest = PressAction & {
  commandId: CommandId;
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

export type PressResult = PressAction & {
  status: "pressed";
  commandId: CommandId;
  /**
   * Every document whose rooms the press committed to, in Live or a fork: text, structure or a comment body. What its
   * Undo takes back. Empty when the scope had no change.
   */
  documents: DocumentId[];
  /** The nodes whose tree change the press made. */
  items: { node: string; tree?: true }[];
  /** A Discard's or a Restore before's: the tree's delete records that put the documents it took out in Trash. */
  trashed?: string[];
};

/**
 * Who wrote over a pressed change since the press, read from who the commits on its text are by: the writer (a tab's
 * commit, which names no author, its Undo included), a chat (a turn, named by its ref, `c12`), or another press (its
 * Undo included). A server write by no one (a restore, a copy) names no one. Empty when only its structure was written over, which names no author.
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
