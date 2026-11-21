import type { DocumentId, DraftId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { drafts } from "@meridian/database/schema";
import { admit, readRecords, recordsOf, type TreeRecord, TreeWriter } from "@meridian/project-tree";
import { inArray, sql } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { draftOwnerSql, type OwnerLocks } from "../../../shared/draft-owner.js";
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
import type { FileAccessChanges } from "../../file-policy/index.js";
import type {
  CommittedTreeUpdate,
  ListWriter,
  TreeList,
  TreeListStore,
} from "../ports/tree-list-store.js";
import { listIdOf, readConnection } from "./tree-list-facts.js";
import { claimNodeIds, claimNodeIdsEach, syncRows } from "./tree-list-rows.js";

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

/** A text document a create in a Work's version made: it needs that Work's text draft. */
export type DraftedDocument = { documentId: DocumentId; draftId: DraftId };

export function createDrizzleTreeListStore(deps: {
  db: Database;
  journal: CollabJournal;
  /**
   * Makes the Live Yjs authority of each drafted document in the admitting transaction, under
   * the list's key, so the document opens in its Work as soon as its create is admitted. Collab's (`seedWorkCreates`); a composition without collab makes rows only.
   */
  seedWorkCreates?: (created: readonly DraftedDocument[]) => Promise<void>;
  /**
   * A Work's or lineage's review count follows its draft's rows, which a tree commit may change
   * outside any Work lock: the Works boundary recounts them once the commit lands.
   */
  recountAfterCommit?: (owners: OwnerLocks) => void;
  /** Drafts with rows on nodes live changed: their owners' lists are read again after commit. */
  liveChangedUnder?: (draftIds: readonly string[]) => void;
  /** Open document sockets of a document that changed source close, to be admitted again. */
  fileAccessChanges?: Pick<FileAccessChanges, "publish">;
}): PgTreeListStore {
  const { db, journal } = deps;
  const copies = new Map<string, Copy>();
  const listeners = new Set<(committed: CommittedTreeUpdate) => void>();
  const advancedListeners = new Set<(listId: string) => void>();

  /** The journal's newest row. */
  async function journalHead(tx: DrizzleDb, listId: string): Promise<number> {
    const [row] = await tx.execute<{ head: number }>(sql`
      SELECT coalesce(max(u.id), 0)::int AS head FROM document_yjs_updates u
      WHERE u.document_id = ${listId}::uuid`);
    return row?.head ?? 0;
  }

  async function copyAtHead(tx: DrizzleDb, listId: string, owner: object): Promise<Copy> {
    let copy = copies.get(listId);
    if (copy && copy.pending !== null && copy.pending !== owner) copy = undefined;
    const head = await journalHead(tx, listId);
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
   * `claimed` are the creates whose node ids this list claims.
   */
  async function commitChange(
    tx: DrizzleDb,
    list: TreeList,
    copy: Copy,
    listId: string,
    before: Uint8Array,
    created: readonly TreeRecord[],
    claimed: readonly TreeRecord[],
  ): Promise<CommittedTreeUpdate | null> {
    await claimNodeIds(tx, listId, claimed);
    const update = Y.encodeStateAsUpdate(copy.doc, before);
    // The system path: a person's path would read the whole list under the lock to record an
    // edit, and a list's receipt is the record itself.
    const seq = await journal.append(listId, update, { origin: "system", seq: 0 });
    copy.seq = seq;
    // Delivered at the commit, to every instance: a room on another process catches up from it.
    await tx.execute(sql`select pg_notify(${CHANNEL}, ${listId})`);
    await testHook("treeList.afterAppend");
    const {
      created: made,
      changedDrafts,
      liveChangedUnder,
      reassigned,
    } = await syncRows(tx, list, listId, copy.doc, created);
    if (liveChangedUnder.length > 0) deps.liveChangedUnder?.(liveChangedUnder);
    for (const documentId of reassigned) await deps.fileAccessChanges?.publish({ documentId });
    if (changedDrafts.length > 0 && deps.recountAfterCommit) {
      const named = draftOwnerSql();
      const owners = await tx
        .select({ work: named.workId, root: named.rootThreadId })
        .from(drafts)
        .where(inArray(drafts.id, changedDrafts));
      deps.recountAfterCommit({
        workIds: owners.flatMap(({ work }) => (work ? [work] : [])),
        lineageRootIds: owners.flatMap(({ root }) => (root ? [root] : [])),
      });
    }
    await testHook("treeList.afterRows");
    const drafted = made.flatMap((record) =>
      record.kind === "document" && record.draft !== null
        ? [{ documentId: record.node as DocumentId, draftId: record.draft as DraftId }]
        : [],
    );
    if (drafted.length > 0) await deps.seedWorkCreates?.(drafted);
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
      return { listId };
    },

    readSince: async ({ listId, afterSeq }) => {
      const head = await journalHead(db as DrizzleDb, listId);
      if (afterSeq > 0) {
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

    admit: ({ list, accountId, update }) =>
      withLists([list], async (tx, [held], owner) => {
        const { copy, listId } = held as Held;
        const connection = await readConnection(tx, list, accountId);
        // The project or account is gone or no longer the account's: nothing to admit to.
        if (!connection) throw new Error("The account cannot write this list");
        const before = Y.encodeStateVector(copy.doc);
        const admitted = admit(copy.writer, update, connection);
        if (sameBytes(Y.encodeStateVector(copy.doc), before)) return { committed: null };
        copy.pending = owner;
        // A dropped record is in no view: no claim, no row change. A create whose node id is another's
        // fails its claim alone, and the rest of the update stands.
        const dropped = new Set(admitted.dropped);
        const live = admitted.records.filter((record) => !dropped.has(record.id));
        const failed = await claimNodeIdsEach(tx, listId, live);
        const made = live.filter((record) => record.type !== "create" || !failed.has(record.node));
        return { committed: await commitChange(tx, list, copy, listId, before, made, []) };
      }),

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
            added: readRecords(all.slice(mark.ops)),
            earlier: readRecords(all.slice(0, mark.ops)),
          };
        });
        // Settlements gain nothing in the records: the state is what says a copy changed.
        const changes = gained.filter(
          ({ held: each, before }) => !sameBytes(Y.encodeStateVector(each.copy.doc), before),
        );
        // Marked in this tick, before the first await: a read in this process then reloads
        // instead of seeing a copy ahead of the journal.
        for (const { held: each } of changes) each.copy.pending = owner;
        const done = new Map<Held, CommittedTreeUpdate>();
        for (const { held: each, before, added, earlier } of changes) {
          // A node's id is claimed by its first create: a copy of a create (Apply's live copy of
          // a drafted one, a restored Discard's) names a node the list holds already.
          const known = new Set(earlier.filter(isCreate).map((record) => record.node));
          const claimed = added.filter(isCreate).filter((record) => {
            const first = !known.has(record.node);
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
