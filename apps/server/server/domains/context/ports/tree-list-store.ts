/**
 * The project tree's list as the server stores it (`@meridian/project-tree`): the one function
 * that admits records, whoever made them, and writes the tree's rows in the same transaction.
 * The rows are never the truth and never trail the list: a failure anywhere before the commit
 * leaves no record and no row.
 */

import type { ListEnd } from "@meridian/project-tree";

/**
 * A list is one project's, or one account's (`user://`). Its journal id is the owner's
 * `tree_list_id`, a column of its own, never the owner's id or a node's.
 */
export type TreeList = { kind: "project"; projectId: string } | { kind: "account"; userId: string };

/** One list's copy handed to a change or a read: the writer on it, and the list's journal id. */
export type ListWriter = ListEnd;

/**
 * What the server's own change makes, in the lists' copies under their locks: each writer makes
 * its list's records (names numbered, ranks placed against the copy's own view, settlements
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
  | { ok: false; reason: string; record?: string };

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
   * nothing, and names the record that earned the refusal when one did. `committed` is null when the list already held every item.
   */
  admit(input: { list: TreeList; accountId: string; update: Uint8Array }): Promise<AdmitResult>;
  /**
   * Makes records the server wants in one or several lists, in the caller's transaction when
   * there is one (a document command's), else in one of its own. The lists' keys are taken in
   * one order (by list id) whatever order the caller names them, so no two paths on the same
   * lists deadlock. The records join the lists and the rows follow with them; the updates reach
   * `onCommitted` after the outermost commit. `make` runs under the keys on copies at the
   * journal's head, holds no document or namespace key and does no I/O. `committed` has an entry
   * per list, in the caller's order, null where the list gained nothing.
   *
   * A move between two lists is `moveBetweenLists` over both writers: the node's claim follows it.
   */
  submit<T>(input: {
    lists: readonly TreeList[];
    make: ServerChange<T>;
  }): Promise<{ committed: readonly (CommittedTreeUpdate | null)[]; result: T }>;
  /**
   * Reads the lists' replays at the journal's head without a key: every row a commit made is
   * there, and a change in this process that has not committed is not. `view` changes nothing.
   * Hold the lists' keys through `submit` when the answer must not change before the transaction
   * ends.
   */
  read<T>(input: { lists: readonly TreeList[]; view: ServerChange<T> }): Promise<T>;
  /**
   * Takes the lists' keys in list-id order and nothing else: the list step of a command that
   * takes document keys. Every list the command will write or resync is locked here, before
   * its first document key; `submit` and `resync` then wait on nothing. Idempotent.
   */
  lock(lists: readonly TreeList[]): Promise<void>;
  /**
   * Brings the rows of the lists to their replay when something the rows read changes outside
   * the list: a Work's branch ends, or a draft gains its first text or loses its last. Call it
   * in the transaction that changed it. It takes no key: the transaction must hold the lists'
   * keys already (`lock`, `submit`), and throws when it does not, since a key taken after a
   * document key can deadlock.
   */
  resync(lists: readonly TreeList[]): Promise<void>;
  /** Called after each commit that added to a list, for whoever sends it to the other clients. */
  onCommitted(listener: (committed: CommittedTreeUpdate) => void): () => void;
  /**
   * Called with the list's id once any server process has committed a journal row to it: a room
   * that holds the list reads the rows it lacks. Only commits are announced, never a rollback.
   */
  onJournalAdvanced(listener: (listId: string) => void): () => void;
}
