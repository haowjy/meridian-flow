/**
 * The project tree's list as the server stores it (`@meridian/project-tree`): the one function
 * that admits records, whoever made them, and writes the tree's rows in the same transaction.
 * The rows are never the truth and never trail the list: a failure anywhere before the commit
 * leaves no record and no row.
 */

import type { SettleRecord, TreeRecord } from "@meridian/project-tree";

/** A list is one project's, or one account's (`user://`). Its id is the owner's id. */
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

export type AdmitResult =
  | { ok: true; committed: CommittedTreeUpdate | null }
  | { ok: false; reason: string };

export interface TreeListStore {
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
