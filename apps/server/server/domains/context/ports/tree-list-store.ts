import type { TreeWriter } from "@meridian/project-tree";

/**
 * A list is one project's, or one account's (`user://`). Its id is the owner's `tree_list_id`, a
 * column of its own, never the owner's id or a node's; its snapshot row is `tree:<list id>`.
 */
export type TreeList = { kind: "project"; projectId: string } | { kind: "account"; userId: string };

export type ListWriter = { writer: TreeWriter; list: string };

/**
 * What the server's own change makes, in the lists' copies under their locks: each writer makes
 * its list's records (ranks placed against the copy's own view, settlements
 * appended), in the order of the `lists` the caller named, and `make` returns whatever the
 * caller reads back from the replay (the names a node ended at, what a delete took). The store
 * derives the new nodes from what the copies gained. `make` is synchronous: a copy is never
 * half-changed across an await.
 */
export type ServerChange<T> = (lists: readonly ListWriter[]) => T;

/**
 * Thrown by a `make` that decides, after reading the copy, that it cannot go ahead (a name
 * taken, a stale address). Nothing it made is stored and the copies are reloaded; the store
 * rethrows it for the caller to answer. `reason` is the caller's own to type.
 */
export class TreeRefusal<R = unknown> extends Error {
  constructor(readonly reason: R) {
    super("The tree change was refused");
  }
}

export type CommittedTreeUpdate = {
  listId: string;
  /** The Loro update of the client's new records, with the stamps the server appended after them. */
  update: Uint8Array;
};

/** What `admit` stored; null when the list already held every item. */
export type AdmitResult = { committed: CommittedTreeUpdate | null };

export interface TreeListStore {
  /**
   * The id of the list, or null when the list is not the account's: the project (or
   * account) decides, never a document.
   */
  open(input: { list: TreeList; accountId: string }): Promise<{ listId: string } | null>;
  /**
   * The stored list past `version` (an encoded Loro version vector; empty for none) as one
   * update, and the stored list's version. Read without the list's lock: every commit stores the
   * whole list.
   */
  readSince(input: {
    listId: string;
    version: Uint8Array;
  }): Promise<{ update: Uint8Array; version: Uint8Array }>;
  /**
   * Admits a client's Loro update for the connection of `accountId`, as sent: the stamp `dropped`
   * on each create raced into a closed Work, then the stored list and the rows it changes. Throws
   * Loro's import error for bytes that are no Loro update; nothing is stored. A create whose node
   * id is another's has no row.
   */
  admit(input: { list: TreeList; accountId: string; update: Uint8Array }): Promise<AdmitResult>;
  /**
   * Makes records the server wants in one or several lists, in the caller's transaction when
   * there is one (a document command's), else in one of its own. The lists' keys are taken in
   * one order (by list id) whatever order the caller names them, so no two paths on the same
   * lists deadlock. The records join the lists and the rows follow with them; the updates reach
   * `onCommitted` after the outermost commit. `make` runs under the keys on copies at the
   * stored list, holds no document or namespace key and does no I/O. `committed` has an entry
   * per list, in the caller's order, null where the list gained nothing.
   */
  submit<T>(input: {
    lists: readonly TreeList[];
    make: ServerChange<T>;
  }): Promise<{ committed: readonly (CommittedTreeUpdate | null)[]; result: T }>;
  /**
   * Reads the lists' replays as stored, without a key: every row a commit made is
   * there, and a change in this process that has not committed is not. `view` changes nothing.
   * Hold the lists' keys through `submit` when the answer must not change before the transaction
   * ends.
   */
  read<T>(input: { lists: readonly TreeList[]; view: ServerChange<T> }): Promise<T>;
  /**
   * Takes the lists' keys in list-id order, plus the seam Works' locks those lists need: the list
   * step of a command that takes document keys. Every list the command will write or resync is
   * locked here, before its first document key; `submit` and `resync` then wait on nothing. The
   * keys are transaction locks, so call it inside the command's transaction. Idempotent.
   */
  lock(lists: readonly TreeList[]): Promise<void>;
  /**
   * Brings the rows of the lists to their replay when something the rows read changes outside
   * the list: a Work's draft ends, or a draft gains its first text or loses its last. Call it
   * in the transaction that changed it. It takes no key: the transaction must hold the lists'
   * keys already (`lock`, `submit`), and throws when it does not, since a key taken after a
   * document key can deadlock.
   */
  resync(lists: readonly TreeList[]): Promise<void>;
  /** Called after each commit that added to a list, for whoever sends it to the other clients. */
  onCommitted(listener: (committed: CommittedTreeUpdate) => void): () => void;
  /**
   * Called with the list's id once any server process has committed a change to it: a room that
   * holds the list reads what it lacks. Only commits are announced, never a rollback.
   */
  onListAdvanced(listener: (listId: string) => void): () => void;
}
