/**
 * The project tree's list as the server stores it (`@meridian/project-tree`): the one function
 * that admits records, whoever made them, and writes the tree's rows in the same transaction.
 * The rows are never the truth and never trail the list: a failure anywhere before the commit
 * leaves no record and no row.
 */

import type { SettleRecord, TreeRecord } from "@meridian/project-tree";

/**
 * A list is one project's, or one account's (`user://`). Its journal id is the owner's
 * `tree_list_id`, a column of its own, never the owner's id or a node's.
 */
export type TreeList = { kind: "project"; projectId: string } | { kind: "account"; userId: string };

/** What the server itself appends: records, and the settlements that go with them. */
export type ServerEntries = {
  records: readonly TreeRecord[];
  settlements?: readonly SettleRecord[];
};

/** What a commit added to the list: the update every other copy of it needs. */
export type CommittedTreeUpdate = {
  listId: string;
  /** The client's new items, with the verdicts the server appended after them. */
  update: Uint8Array;
  /** The journal row that holds it. */
  seq: number;
};

/** Why `admit` refused an account that cannot write the list now: not a fault of the update. */
export const NO_WRITE_ACCESS = "no write access";

export type AdmitResult =
  | { ok: true; committed: CommittedTreeUpdate | null }
  | { ok: false; reason: string };

/** What an account may do in a list's room: write, or only read. */
export type TreeListAccess = { listId: string; level: "edit" | "read" };

export interface TreeListStore {
  /**
   * The journal id of the list and what the account may do in its room, or null when the list is
   * not the account's: the project (or account) decides, never a document.
   */
  open(input: { list: TreeList; accountId: string }): Promise<TreeListAccess | null>;
  /**
   * The list's state past journal row `afterSeq` as one update, and the row it reaches: the
   * rows after it, or the whole state when `afterSeq` is 0 or behind a checkpoint. Read
   * without the list's lock, which is safe because rows are only ever added at the head.
   */
  readSince(input: {
    listId: string;
    afterSeq: number;
  }): Promise<{ seq: number; update: Uint8Array }>;
  /**
   * Admits a client's Yjs update for the connection of `accountId`: checks it, appends the
   * server's verdicts, journals it and writes the rows it changes. A refused whole update stores
   * nothing. `committed` is null when the list already held every item.
   */
  admit(input: { list: TreeList; accountId: string; update: Uint8Array }): Promise<AdmitResult>;
  /**
   * Appends records the server made, in the caller's transaction when there is one (a document
   * command's), else in one of its own. The records join the list and the rows follow with
   * them; the update reaches `onCommitted` after the outermost commit.
   */
  submit(input: { list: TreeList; entries: ServerEntries }): Promise<CommittedTreeUpdate | null>;
  /** Called after each commit that added to a list, for whoever sends it to the other clients. */
  onCommitted(listener: (committed: CommittedTreeUpdate) => void): () => void;
}
