import type { Database } from "@meridian/database";
import {
  admit,
  type Connection,
  isListRoot,
  recordsOf,
  type TreeRecord,
  TreeWriter,
} from "@meridian/project-tree";
import { sql } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import {
  currentDrizzleDb,
  type DrizzleDb,
  type DrizzleTransactionParticipant,
  deferUntilDrizzleRollback,
  enlistDrizzleTransactionParticipant,
  isInDrizzleTransaction,
  runAfterDrizzleCommit,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { testHook } from "../../../shared/test-hooks.js";
import { lockSeamWorks } from "../../../shared/work-lifecycle-lock.js";
import type { CollabJournal } from "../../collab/adapters/drizzle-journal.js";
import {
  type CommittedTreeUpdate,
  type ListWriter,
  NO_WRITE_ACCESS,
  type TreeList,
  type TreeListStore,
} from "../ports/tree-list-store.js";
import { listIdOf, readConnection } from "./tree-list-facts.js";
import { arriveNodes, claimNodeIds, NodeIdRefusedError, syncRows } from "./tree-list-rows.js";

/**
 * This process's copy of one list, brought to the journal's head under the list's lock and
 * changed in place by what the transaction admits. `pending` is the root transaction (its
 * `Ownership.token`, the same in every savepoint under it) that changed it and has not
 * committed: a copy found in any other transaction's hands is behind the journal or ahead of
 * it, so it is thrown away and reloaded. A rollback drops the copies the transaction held.
 */
type Copy = { doc: Y.Doc; writer: TreeWriter; seq: number; pending: object | null };

/**
 * What a root transaction holds in this store: its identity, and the lists whose keys it has
 * taken. A savepoint's state is a fork; one that rolls back leaves its keys out of the parent's.
 */
type Ownership = { token: object; keys: Set<string> };

const ownership: DrizzleTransactionParticipant<Ownership> = {
  key: {},
  create: () => ({ token: {}, keys: new Set() }),
  fork: (parent) => ({ token: parent.token, keys: new Set(parent.keys) }),
  merge(parent, child) {
    parent.token = child.token;
    for (const id of child.keys) parent.keys.add(id);
    return parent;
  },
};

/** A list in a transaction that holds its key, with its copy at the journal's head. */
type Held = { list: TreeList; listId: string; copy: Copy };

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

const isCreate = (record: TreeRecord): record is Extract<TreeRecord, { type: "create" }> =>
  record.type === "create";

/** Runs `make` inside one Yjs transaction on every list's doc, so each emits one update. */
function inOneTransaction<T>(
  lists: readonly ListWriter[],
  at: number,
  make: (lists: readonly ListWriter[]) => T,
): T {
  const each = lists[at];
  if (!each) return make(lists);
  let result: T | undefined;
  each.writer.transact(() => {
    result = inOneTransaction(lists, at + 1, make);
  });
  return result as T;
}

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

  async function copyAtHead(tx: DrizzleDb, listId: string, owner: object): Promise<Copy> {
    let copy = copies.get(listId);
    if (copy && copy.pending !== null && copy.pending !== owner) copy = undefined;
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
        copy.seq = Math.max(copy.seq, head);
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
   * A copy at the journal's head for a read that holds no key. A copy this process has
   * changed and not committed, or a copy of an uncommitted transaction's, is not read: the
   * list is loaded afresh, and the shared copy is left to its writer.
   */
  async function viewCopy(tx: DrizzleDb, listId: string): Promise<Copy> {
    const shared = copies.get(listId);
    const owner = isInDrizzleTransaction()
      ? enlistDrizzleTransactionParticipant(ownership).token
      : null;
    if (shared && (shared.pending === null || shared.pending === owner))
      return copyAtHead(tx, listId, owner ?? {});
    const doc = new Y.Doc({ gc: false });
    const snapshot = await journal.read(listId);
    applyHistory(doc, [
      ...(snapshot.checkpoint ? [snapshot.checkpoint] : []),
      ...snapshot.updates.map((row) => row.update),
    ]);
    return { doc, writer: new TreeWriter(doc, "server"), seq: 0, pending: null };
  }

  /**
   * Takes the lists' keys in list-id order, after the Work locks (the lock order in
   * `collab/.context/CONTEXT.md`), and returns their ids in the caller's order. `held` says the
   * transaction took them already: a path that takes document keys does it first, and a key
   * taken here after one could deadlock, so a missing key throws instead of waiting.
   */
  async function keysOf(
    tx: DrizzleDb,
    lists: readonly TreeList[],
    mode: "take" | "held",
  ): Promise<{ ids: string[]; owner: Ownership }> {
    const owner = enlistDrizzleTransactionParticipant(ownership);
    // Work rows and lifecycle locks come before any advisory key; the journal's append then
    // takes no lock it lacks.
    if (mode === "take") await lockSeamWorks(tx, []);
    const ids: string[] = [];
    for (const list of lists) {
      const listId = await listIdOf(tx, list);
      if (listId === null) throw new Error("The list's project or account is gone");
      ids.push(listId);
    }
    for (const listId of [...new Set(ids)].sort()) {
      if (mode === "held") {
        if (!owner.keys.has(listId))
          throw new Error(`The list ${listId} is resynced without its key: lock it first`);
        continue;
      }
      await lockDocumentMutation(tx as Database, listId);
      owner.keys.add(listId);
    }
    return { ids, owner };
  }

  /**
   * One transaction on one or several lists: the Work locks, then the lists' keys in list-id
   * order whatever order `lists` names, then each copy at the journal's head. A failure
   * discards the copies, which `body` may have changed in place; so does a rollback of the
   * transaction, or of a savepoint it is nested in, after the body returned.
   */
  function withLists<T>(
    lists: readonly TreeList[],
    body: (tx: DrizzleDb, held: readonly Held[], owner: object) => Promise<T>,
    mode: "take" | "held" = "take",
  ): Promise<T> {
    return runInDrizzleTransaction(db, async () => {
      const tx = currentDrizzleDb(db);
      const { ids, owner } = await keysOf(tx, lists, mode);
      const held: Held[] = [];
      for (const [at, list] of lists.entries()) {
        const listId = ids[at] as string;
        held.push({ list, listId, copy: await copyAtHead(tx, listId, owner.token) });
      }
      const drop = () => {
        for (const { listId, copy } of held) if (copies.get(listId) === copy) copies.delete(listId);
      };
      deferUntilDrizzleRollback(drop);
      try {
        await testHook("treeList.afterLock");
        return await body(tx, held, owner.token);
      } catch (cause) {
        drop();
        throw cause;
      }
    });
  }

  /**
   * Journals what the copy gained since `before` (the copy has changed), writes the rows, and
   * queues the hand-off. `created` are the creates whose documents get their `documents` rows;
   * `claimed` are the creates whose node ids this list claims; `arrived`
   * the nodes that came from another list in the same change, whose claims move instead.
   */
  async function commitChange(
    tx: DrizzleDb,
    list: TreeList,
    copy: Copy,
    listId: string,
    before: Uint8Array,
    created: readonly TreeRecord[],
    claimed: readonly TreeRecord[],
    arrived: ReadonlySet<string> = new Set(),
  ): Promise<CommittedTreeUpdate | null> {
    await claimNodeIds(tx, listId, claimed);
    await arriveNodes(tx, list, listId, arrived);
    const update = Y.encodeStateAsUpdate(copy.doc, before);
    // The system path: a person's path would read the whole list under the lock to record an
    // edit, and a list's receipt is the record itself.
    const seq = await journal.append(listId, update, { origin: "system", seq: 0 });
    copy.seq = seq;
    // Delivered at the commit, to every instance: a room on another process catches up from it.
    await tx.execute(sql`select pg_notify(${CHANNEL}, ${listId})`);
    await testHook("treeList.afterAppend");
    // An arrived node has its `documents` row already: only the creates of new nodes make one.
    await syncRows(
      tx,
      list,
      listId,
      copy.doc,
      created.filter((record) => !arrived.has(record.node)),
    );
    await testHook("treeList.afterRows");
    const committed = { listId, update, seq };
    const owner = copy.pending;
    runAfterDrizzleCommit(async () => {
      if (copy.pending === owner) copy.pending = null;
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
      let created: readonly Extract<TreeRecord, { type: "create" }>[] = [];
      try {
        return await withLists([list], async (tx, [held], owner) => {
          const { copy, listId } = held as Held;
          const connection: Connection | null = await readConnection(tx, list, accountId);
          if (!connection) return { ok: false as const, reason: NO_WRITE_ACCESS };
          const before = Y.encodeStateVector(copy.doc);
          const verdict = admit(copy.writer, update, connection);
          if (!verdict.ok) return verdict;
          if (sameBytes(Y.encodeStateVector(copy.doc), before))
            return { ok: true as const, committed: null };
          copy.pending = owner;
          const refused = new Set(verdict.refused.map((entry) => entry.id));
          const kept = verdict.kept.map((entry) => entry.record);
          const added = [...verdict.records.filter((record) => !refused.has(record.id)), ...kept];
          created = verdict.records.filter(isCreate);
          // Every create the update holds claims its id, a refused one too (its kept create has
          // the same node): an id in use refuses the whole update.
          return {
            ok: true as const,
            committed: await commitChange(
              tx,
              list,
              copy,
              listId,
              before,
              added,
              verdict.records.filter(isCreate),
            ),
          };
        });
      } catch (cause) {
        // The transaction is rolled back: the update, its claims and its rows are not stored.
        if (cause instanceof NodeIdRefusedError) {
          const record = created.find((create) => create.node === cause.nodeId)?.id;
          return { ok: false as const, reason: cause.message, ...(record ? { record } : {}) };
        }
        throw cause;
      }
    },

    submit: ({ lists, make }) =>
      withLists(lists, async (tx, held, owner) => {
        const marks = held.map(({ copy }) => ({
          before: Y.encodeStateVector(copy.doc),
          ops: recordsOf(copy.doc).length,
        }));
        const writers = held.map(({ copy, listId }) => ({ writer: copy.writer, list: listId }));
        const result = inOneTransaction(writers, 0, make);
        // What each copy gained is the tail of its records, so no caller lists what it made.
        const gained = held.map((each, at) => {
          const mark = marks[at] as (typeof marks)[number];
          const all = recordsOf(each.copy.doc).toArray();
          return {
            held: each,
            before: mark.before,
            added: all.slice(mark.ops),
            earlier: all.slice(0, mark.ops),
          };
        });
        // Settlements gain nothing in the records: the state is what says a copy changed.
        const changes = gained.filter(
          ({ held: each, before }) => !sameBytes(Y.encodeStateVector(each.copy.doc), before),
        );
        // Marked in this tick, before the first await: a read in this process then reloads
        // instead of seeing a copy ahead of the journal.
        for (const { held: each } of changes) each.copy.pending = owner;
        // A node that leaves a list for another in this change is claimed by the other list
        // when its create is written; the list it leaves writes first, so its row is gone.
        const leaving = new Set(
          changes.flatMap(({ added }) =>
            added.flatMap((record) =>
              record.type === "move" && isListRoot(record.parent) ? [record.node] : [],
            ),
          ),
        );
        const arrivedIn = (added: readonly TreeRecord[]) =>
          new Set(
            added
              .filter(isCreate)
              .flatMap((record) => (leaving.has(record.node) ? [record.node] : [])),
          );
        const order = [...changes].sort(
          (a, b) => Number(arrivedIn(a.added).size > 0) - Number(arrivedIn(b.added).size > 0),
        );
        const done = new Map<Held, CommittedTreeUpdate>();
        for (const { held: each, before, added, earlier } of order) {
          const arrived = arrivedIn(added);
          // A node's id is claimed by its first create: a copy of a create (Apply's live copy of
          // a drafted one, a restored Discard's) names a node the list holds already.
          const known = new Set(earlier.filter(isCreate).map((record) => record.node));
          const claimed = added.filter(isCreate).filter((record) => {
            const first = !known.has(record.node) && !arrived.has(record.node);
            known.add(record.node);
            return first;
          });
          const committed = await commitChange(
            tx,
            each.list,
            each.copy,
            each.listId,
            before,
            claimed,
            claimed,
            arrived,
          );
          if (committed) done.set(each, committed);
        }
        return { committed: held.map((each) => done.get(each) ?? null), result };
      }),

    read: async ({ lists, view }) => {
      const tx = currentDrizzleDb(db);
      const writers: ListWriter[] = [];
      for (const list of lists) {
        const listId = await listIdOf(tx, list);
        if (listId === null) throw new Error("The list's project or account is gone");
        writers.push({ writer: (await viewCopy(tx, listId)).writer, list: listId });
      }
      return view(writers);
    },

    lock: async (lists) => {
      await runInDrizzleTransaction(db, async () => {
        await keysOf(currentDrizzleDb(db), lists, "take");
      });
    },

    resync: (lists) =>
      withLists(
        lists,
        async (tx, held) => {
          for (const { list, listId, copy } of held) await syncRows(tx, list, listId, copy.doc, []);
        },
        "held",
      ),

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
