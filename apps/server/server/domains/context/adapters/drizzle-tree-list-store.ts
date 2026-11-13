import type { Database } from "@meridian/database";
import { admit, type Connection, type TreeRecord, TreeWriter } from "@meridian/project-tree";
import { sql } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import {
  currentDrizzleDb,
  type DrizzleDb,
  runAfterDrizzleCommit,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { testHook } from "../../../shared/test-hooks.js";
import { lockSeamWorks } from "../../../shared/work-lifecycle-lock.js";
import type { CollabJournal } from "../../collab/adapters/drizzle-journal.js";
import {
  type CommittedTreeUpdate,
  NO_WRITE_ACCESS,
  type TreeList,
  type TreeListStore,
} from "../ports/tree-list-store.js";
import { listIdOf, readConnection } from "./tree-list-facts.js";
import { claimNodeIds, NodeIdRefusedError, syncRows } from "./tree-list-rows.js";

/**
 * This process's copy of one list, brought to the journal's head under the list's lock and
 * changed in place by what the transaction admits. `pending` is the transaction that changed it
 * and has not committed: a copy found in any other transaction's hands is behind the journal or
 * ahead of it, so it is thrown away and reloaded.
 */
type Copy = { doc: Y.Doc; writer: TreeWriter; seq: number; pending: object | null };

/**
 * The Yjs client id of every record the server makes, in every list and every process. Below
 * 1,000, which clients may not use. One id is safe because each server write is made under the
 * list's lock on a copy at the journal's head, so two copies never make an item at once.
 */
const SERVER_CLIENT_ID = 1;

/** The id a copy has while it applies journal rows: reserved too, and never used for an item. */
const CATCH_UP_CLIENT_ID = 2;

/**
 * Applies journal rows to a copy. Rows that advance the copy's own client's clock make Yjs give
 * the copy a random id of 1,000 or more (a transaction that applies an update is never local),
 * so the copy applies them under an id that has made nothing.
 */
function applyHistory(doc: Y.Doc, updates: readonly Uint8Array[]) {
  doc.clientID = CATCH_UP_CLIENT_ID;
  try {
    for (const update of updates) Y.applyUpdate(doc, update, "journal");
  } finally {
    doc.clientID = SERVER_CLIENT_ID;
  }
}

/** Every instance hears this at the commit of a journal row; the payload is the list's id. */
const CHANNEL = "tree_list_advanced";

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, at) => byte === b[at]);

export type PgTreeListStore = TreeListStore & {
  /** Starts hearing every instance's commits (this one's too) for `onJournalAdvanced`. */
  listen(): Promise<{ unlisten: () => Promise<void> }>;
};

export function createDrizzleTreeListStore(deps: {
  db: Database;
  journal: CollabJournal;
}): PgTreeListStore {
  const { db, journal } = deps;
  const copies = new Map<string, Copy>();
  const listeners = new Set<(committed: CommittedTreeUpdate) => void>();
  const advancedListeners = new Set<(listId: string) => void>();

  /** The journal's newest row, and the newest row it may have folded into a checkpoint. */
  async function journalBounds(tx: DrizzleDb, listId: string) {
    const [row] = await tx.execute<{ retired: number; head: number }>(sql`
      SELECT h.retired_through_seq::int AS retired,
        coalesce((SELECT max(u.id) FROM document_yjs_updates u
          WHERE u.document_id = h.document_id), 0)::int AS head
      FROM document_yjs_heads h WHERE h.document_id = ${listId}::uuid`);
    return { retired: row?.retired ?? 0, head: row?.head ?? 0 };
  }

  async function copyAtHead(tx: DrizzleDb, listId: string): Promise<Copy> {
    let copy = copies.get(listId);
    if (copy && copy.pending !== null && copy.pending !== tx) copy = undefined;
    const { retired, head } = await journalBounds(tx, listId);
    // Rows up to `retired` may be gone into a checkpoint: a copy behind them cannot catch up
    // from the rows that remain.
    if (copy && copy.seq < retired) copy = undefined;
    if (copy) {
      if (head > copy.seq) {
        // Caught up from the journal's new rows, not from the start.
        const rows = await journal.readUpdates(listId, copy.seq, head);
        applyHistory(
          copy.doc,
          rows.map((row) => row.update),
        );
        copy.seq = head;
      }
      return copy;
    }
    const doc = new Y.Doc({ gc: false });
    const snapshot = await journal.read(listId);
    applyHistory(doc, [
      ...(snapshot.checkpoint ? [snapshot.checkpoint] : []),
      ...snapshot.updates.map((row) => row.update),
    ]);
    copy = {
      doc,
      writer: new TreeWriter(doc, "server"),
      seq: snapshot.persistenceWatermark ?? 0,
      pending: null,
    };
    copies.set(listId, copy);
    return copy;
  }

  /**
   * One transaction on one list: the Work locks, then the list's lock, its head and the copy at
   * the journal's head. A failure discards the copy, which `body` may have changed in place.
   */
  function withList<T>(
    list: TreeList,
    body: (tx: DrizzleDb, copy: Copy, listId: string) => Promise<T>,
  ): Promise<T> {
    return runInDrizzleTransaction(db, async () => {
      const tx = currentDrizzleDb(db);
      // Work rows and lifecycle locks come before any advisory key (the lock order in
      // `collab/.context/CONTEXT.md`); the journal's append then takes no lock it lacks.
      await lockSeamWorks(tx, []);
      const listId = await listIdOf(tx, list);
      if (listId === null) throw new Error("The list's project or account is gone");
      await lockDocumentMutation(tx as Database, listId);
      const copy = await copyAtHead(tx, listId);
      try {
        await testHook("treeList.afterLock");
        return await body(tx, copy, listId);
      } catch (cause) {
        copies.delete(listId);
        throw cause;
      }
    });
  }

  /** Journals what the copy gained since `before`, writes the rows, and queues the hand-off. */
  async function commitChange(
    tx: DrizzleDb,
    list: TreeList,
    copy: Copy,
    listId: string,
    before: Uint8Array,
    added: readonly TreeRecord[],
    claimed: readonly TreeRecord[] = added,
  ): Promise<CommittedTreeUpdate | null> {
    if (sameBytes(Y.encodeStateVector(copy.doc), before)) return null;
    copy.pending = tx;
    await claimNodeIds(tx, listId, claimed);
    const update = Y.encodeStateAsUpdate(copy.doc, before);
    // The system path: a person's path would read the whole list under the lock to record an
    // edit, and a list's receipt is the record itself.
    const seq = await journal.append(listId, update, { origin: "system", seq: 0 });
    copy.seq = seq;
    // Delivered at the commit, to every instance: a room on another process catches up from it.
    await tx.execute(sql`select pg_notify(${CHANNEL}, ${listId})`);
    await testHook("treeList.afterAppend");
    await syncRows(tx, list, listId, copy.doc, added);
    await testHook("treeList.afterRows");
    const committed = { listId, update, seq };
    runAfterDrizzleCommit(async () => {
      if (copy.pending === tx) copy.pending = null;
      await testHook("treeList.afterCommit");
      for (const listener of listeners) listener(committed);
    });
    return committed;
  }

  return {
    open: async ({ list, accountId }) => {
      const listId = await listIdOf(db as DrizzleDb, list);
      if (listId === null) return null;
      const [owner] = await (db as DrizzleDb).execute<{ id: string }>(
        list.kind === "project"
          ? sql`SELECT id::text FROM projects
              WHERE id = ${list.projectId}::uuid AND user_id = ${accountId}::uuid AND deleted_at IS NULL`
          : sql`SELECT id::text FROM users WHERE id = ${list.userId}::uuid AND id = ${accountId}::uuid`,
      );
      if (!owner) return null;
      const connection = await readConnection(db as DrizzleDb, list, accountId);
      return { listId, level: connection ? "edit" : "read" };
    },

    readSince: async ({ listId, afterSeq }) => {
      const { retired, head } = await journalBounds(db as DrizzleDb, listId);
      if (afterSeq > 0 && afterSeq >= retired) {
        const rows = await journal.readUpdates(listId, afterSeq, head);
        return {
          seq: head,
          update:
            rows.length === 0
              ? Y.encodeStateAsUpdate(new Y.Doc())
              : Y.mergeUpdates(rows.map((row) => row.update)),
        };
      }
      const snapshot = await journal.read(listId);
      const updates = [
        ...(snapshot.checkpoint ? [snapshot.checkpoint] : []),
        ...snapshot.updates.map((row) => row.update),
      ];
      return {
        seq: snapshot.persistenceWatermark ?? 0,
        update: updates.length === 0 ? Y.encodeStateAsUpdate(new Y.Doc()) : Y.mergeUpdates(updates),
      };
    },

    admit: async ({ list, accountId, update }) => {
      try {
        return await withList(list, async (tx, copy, listId) => {
          const connection: Connection | null = await readConnection(tx, list, accountId);
          if (!connection) return { ok: false as const, reason: NO_WRITE_ACCESS };
          const before = Y.encodeStateVector(copy.doc);
          const verdict = admit(copy.writer, update, connection);
          if (!verdict.ok) return verdict;
          const refused = new Set(verdict.refused.map((entry) => entry.id));
          const kept = verdict.kept.map((entry) => entry.record);
          const added = [...verdict.records.filter((record) => !refused.has(record.id)), ...kept];
          // Every create the update holds claims its id, a refused one too (its kept create has
          // the same node): an id in use refuses the whole update.
          return {
            ok: true as const,
            committed: await commitChange(tx, list, copy, listId, before, added, verdict.records),
          };
        });
      } catch (cause) {
        // The transaction is rolled back: the update, its claims and its rows are not stored.
        if (cause instanceof NodeIdRefusedError)
          return { ok: false as const, reason: cause.message };
        throw cause;
      }
    },

    submit: ({ list, make }) =>
      withList(list, async (tx, copy, listId) => {
        const before = Y.encodeStateVector(copy.doc);
        let made: ReturnType<typeof make> | undefined;
        copy.writer.transact(() => {
          made = make(copy.writer);
        });
        const { records, result } = made as NonNullable<typeof made>;
        const committed = await commitChange(tx, list, copy, listId, before, records);
        return { committed, result };
      }),

    onCommitted(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    onJournalAdvanced(listener) {
      advancedListeners.add(listener);
      return () => advancedListeners.delete(listener);
    },

    listen: () =>
      db.listen(CHANNEL, (listId) => {
        for (const listener of advancedListeners) listener(listId);
      }),
  };
}
