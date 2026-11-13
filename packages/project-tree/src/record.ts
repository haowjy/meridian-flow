import type * as Y from "yjs";

export type NodeKind = "folder" | "document" | "file";
/** The Work's branch id for a drafted record. */
export type DraftId = string;
/** `user:<id>`, or `agent:<chat>/<turn>`. A client may only claim its own account. */
export type Actor = string;
/** A file's place in the tree carries a pointer to its bytes, never the bytes. */
export type BlobRef = { storageKey: string; mime: string; size: number };

/**
 * The top of a source (manuscript, knowledge base, Unfiled, a Work's Scratch, a chat's uploads).
 * Sources come from their own lifecycles, not from records: replay treats each as a folder that
 * exists, and no record may name one as its node.
 */
export function sourceRoot(sourceId: string): string {
  return `source:${sourceId}`;
}
export function isSourceRoot(id: string): boolean {
  return id.startsWith("source:");
}
export function sourceIdOf(root: string): string {
  return root.slice("source:".length);
}

/**
 * The parent of a `move` out of this list into another (a project's list and the account's
 * `user://` list). Only the server writes one, as half of a move between two lists.
 */
export function listRoot(listId: string): string {
  return `list:${listId}`;
}
export function isListRoot(id: string): boolean {
  return id.startsWith("list:");
}

/** A record or settlement id. A uuid, so two writers on one copy never repeat one. */
export function newId(): string {
  return crypto.randomUUID();
}

type RecordBase = {
  id: string;
  node: string;
  actor: Actor;
  /** Null for live; the Work's branch id for a drafted record. */
  draft: DraftId | null;
  /**
   * On a record that stands for an earlier one (an Apply's live copy, a restored Discard's
   * pending copy): the id of the root original, flattened, so a copy of a copy names the same
   * one. An Undo or Trash entry that names the original finds the copy through it. Server only.
   */
  carries?: string;
  /** On a live copy made by Apply: who applied it. `actor` stays who drafted it. */
  appliedBy?: Actor;
  /** On a live copy made by Apply: the Work it came from. */
  fromDraft?: DraftId;
  /** On an opposite record: the record it takes back. */
  undoes?: string;
  /** On a pending copy made by restoring a Discard: that Discard's command. Server only. */
  restores?: string;
  /** On a pending copy made by restoring a Discard: who restored it. `actor` stays who drafted it. Server only. */
  restoredBy?: Actor;
};

export type CreateRecord = RecordBase & {
  type: "create";
  kind: NodeKind;
  name: string;
  /** A folder's id, or a source root. */
  parent: string;
  /** The source it was made in: where it shows if its folder never existed in a view (rule 6). */
  source: string;
  rank: string;
  /** A document states its type at creation, which decides the editor that opens it. A file has none: its type is in the blob. */
  filetype?: string;
  /** The name was given, not chosen ("Untitled"); it ends at the node's first rename by a person. */
  provisional?: true;
  /** Other names it answers to in links; an import's frontmatter. Server only. */
  aliases?: string[];
  /** It has imported properties to show, which load by id. Server only. */
  hasProperties?: true;
  blob?: BlobRef;
  /** On a create the server appended for a node whose client create it refused: that create. */
  replaces?: string;
};
export type MoveRecord = RecordBase & {
  type: "move";
  parent: string;
  rank: string;
  /** Where the author saw it, for the Undo. */
  from: { parent: string; rank: string };
};
export type RenameRecord = RecordBase & {
  type: "rename";
  name: string;
  fromName: string;
  /** Set when the new name's extension changes the type (notes.md to notes.txt). */
  filetype?: string;
};
/** `cascade` is the nodes its author saw inside; only those that are still inside go with it. */
export type DeleteRecord = RecordBase & { type: "delete"; cascade: string[] };
export type RestoreRecord = RecordBase & { type: "restore" };
/** Trash emptied: the node is gone for good. Only the server writes one. */
export type PurgeRecord = RecordBase & { type: "purge" };

export type TreeRecord =
  | CreateRecord
  | MoveRecord
  | RenameRecord
  | DeleteRecord
  | RestoreRecord
  | PurgeRecord;

type WithoutBase<T> = Omit<T, keyof RecordBase | "node"> & { node: string };
export type TreeRecordInput =
  | WithoutBase<CreateRecord>
  | WithoutBase<MoveRecord>
  | WithoutBase<RenameRecord>
  | WithoutBase<DeleteRecord>
  | WithoutBase<RestoreRecord>
  | WithoutBase<PurgeRecord>;

export type Settlement = "applied" | "discarded" | "undone" | "superseded" | "refused";

/**
 * A settlement is a record too, appended and never changed. A record's state is its last
 * settlement in list order, so the list holds no deletions and a state vector names a point in
 * it exactly. `pending` puts a drafted record back, as an Undo of an Apply does. A Discard is
 * final: restoring one appends new pending copies, never a `pending` settlement.
 */
export type SettleRecord = {
  id: string;
  actor: Actor;
  targets: string[];
  to: Settlement | "pending";
  /** On a refusal at admission: why, for the client to show on the thing the writer did. */
  reason?: string;
  /** The command (a uuid) that made it: Undo of an Apply and the restore of a Discard select by it. */
  command?: string;
};

export function recordsOf(doc: Y.Doc): Y.Array<TreeRecord> {
  return doc.getArray<TreeRecord>("ops");
}

export function settleLogOf(doc: Y.Doc): Y.Array<SettleRecord> {
  return doc.getArray<SettleRecord>("settle");
}
