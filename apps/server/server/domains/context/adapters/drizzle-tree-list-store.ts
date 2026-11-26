import type { Database } from "@meridian/database";
import { documentSnapshots, drafts, type StoredFrontiers } from "@meridian/database/schema";
import {
  type DocVersion,
  decodeDocVersion,
  docCovers,
  docVersion,
  encodeDocVersion,
  freshServerPeerId,
  withVector,
} from "@meridian/document-model";
import { admit, listOf, readRecords, type TreeRecord, TreeWriter } from "@meridian/project-tree";
import { and, eq, inArray, sql } from "drizzle-orm";
import { LoroDoc } from "loro-crdt";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { holdsFrontiers, writeSnapshots } from "../../../shared/document-snapshots.js";
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
 * This process's copy of one list, brought to the stored snapshot under the list's lock and
 * changed in place by what the transaction admits. `pending` is the root transaction (its
 * `Ownership.token`, the same in every savepoint under it) that changed it and has not
 * committed: a copy found in any other transaction's hands is behind the stored list or ahead of
 * it, so it is set aside and the list loaded again. A rollback sets aside the copies the
 * transaction held. A copy set aside is freed when nothing holds it: no transaction that took it
 * under the list's key has ended and no read is between its awaits.
 */
type Copy = { doc: LoroDoc; writer: TreeWriter; pending: object | null; retired: boolean };

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

type Held = { list: TreeList; listId: string; copy: Copy };

const roomKeyOf = (listId: string) => `tree:${listId}`;
const LIST_DOC = "s";

const CHANNEL = "tree_list_advanced";

const isCreate = (record: TreeRecord): record is Extract<TreeRecord, { type: "create" }> =>
  record.type === "create";

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

const unchanged = (doc: LoroDoc, before: DocVersion) => docCovers(before, docVersion(doc));

function copyOf(snapshot: Uint8Array | null): Copy {
  const doc = new LoroDoc();
  doc.setPeerId(freshServerPeerId());
  if (snapshot) doc.import(snapshot);
  return { doc, writer: new TreeWriter(doc, "server"), pending: null, retired: false };
}

export type PgTreeListStore = TreeListStore & {
  listen(): Promise<{ unlisten: () => Promise<void> }>;
};

export function createDrizzleTreeListStore(deps: {
  db: Database;
  recountAfterCommit?: (owners: OwnerLocks) => void;
  liveChangedUnder?: (draftIds: readonly string[]) => void;
  fileAccessChanges?: Pick<FileAccessChanges, "publish">;
}): PgTreeListStore {
  const { db } = deps;
  const copies = new Map<string, Copy>();
  const holders = new Map<Copy, number>();
  const listeners = new Set<(committed: CommittedTreeUpdate) => void>();
  const advancedListeners = new Set<(listId: string) => void>();

  const hold = (copy: Copy) => holders.set(copy, (holders.get(copy) ?? 0) + 1);
  const release = (copy: Copy) => {
    const left = (holders.get(copy) ?? 1) - 1;
    if (left > 0) holders.set(copy, left);
    else holders.delete(copy);
    if (left <= 0 && copy.retired) copy.doc.free();
  };
  const retire = (listId: string, copy: Copy) => {
    if (copies.get(listId) === copy) copies.delete(listId);
    copy.retired = true;
  };

  async function storedRow(tx: DrizzleDb, listId: string, snapshot: boolean) {
    const [row] = await tx
      .select({
        frontiers: documentSnapshots.frontiers,
        ...(snapshot ? { snapshot: documentSnapshots.snapshot } : {}),
      })
      .from(documentSnapshots)
      .where(
        and(
          eq(documentSnapshots.roomKey, roomKeyOf(listId)),
          eq(documentSnapshots.docKey, LIST_DOC),
        ),
      );
    return row as { frontiers: StoredFrontiers; snapshot?: Uint8Array } | undefined;
  }

  async function storedSnapshot(tx: DrizzleDb, listId: string): Promise<Uint8Array | null> {
    return (await storedRow(tx, listId, true))?.snapshot ?? null;
  }

  async function copyAtHead(tx: DrizzleDb, listId: string, owner: object): Promise<Copy> {
    let copy = copies.get(listId);
    if (copy && copy.pending !== null && copy.pending !== owner) {
      retire(listId, copy);
      copy = undefined;
    }
    if (copy) {
      const row = await storedRow(tx, listId, false);
      if (row && !holdsFrontiers(copy.doc, row.frontiers)) {
        const snapshot = await storedSnapshot(tx, listId);
        if (snapshot) copy.doc.import(snapshot);
      }
      return copy;
    }
    copy = copyOf(await storedSnapshot(tx, listId));
    copies.set(listId, copy);
    return copy;
  }

  async function viewCopy(tx: DrizzleDb, listId: string): Promise<Copy> {
    const shared = copies.get(listId);
    const owner = isInDrizzleTransaction()
      ? enlistDrizzleTransactionParticipant(ownership).token
      : null;
    if (shared && (shared.pending === null || shared.pending === owner))
      return copyAtHead(tx, listId, owner ?? {});
    const copy = copyOf(await storedSnapshot(tx, listId));
    copy.retired = true;
    return copy;
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
   * order whatever order `lists` names, then each copy at the stored list. A failure discards the
   * copies, which `body` may have changed in place; so does a rollback of the transaction, or of
   * a savepoint it is nested in, after the body returned.
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
        const copy = await copyAtHead(tx, listId, owner.token);
        hold(copy);
        runAfterDrizzleCommit(() => release(copy));
        deferUntilDrizzleRollback(() => {
          retire(listId, copy);
          release(copy);
        });
        held.push({ list, listId, copy });
      }
      const drop = () => {
        for (const { listId, copy } of held) retire(listId, copy);
      };
      try {
        await testHook("treeList.afterLock");
        return await body(tx, held, owner.token);
      } catch (cause) {
        drop();
        throw cause;
      }
    });
  }

  async function commitChange(
    tx: DrizzleDb,
    list: TreeList,
    copy: Copy,
    listId: string,
    before: DocVersion,
    created: readonly TreeRecord[],
    claimed: readonly TreeRecord[],
  ): Promise<CommittedTreeUpdate> {
    await claimNodeIds(tx, listId, claimed);
    const update = withVector(before, (from) => copy.doc.export({ mode: "update", from }));
    await writeSnapshots(tx, [{ roomKey: roomKeyOf(listId), docKey: LIST_DOC, doc: copy.doc }]);
    await tx.execute(sql`select pg_notify(${CHANNEL}, ${listId})`);
    await testHook("treeList.afterAppend");
    const { changedDrafts, liveChangedUnder, reassigned } = await syncRows(
      tx,
      list,
      listId,
      copy.doc,
      created,
    );
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
    const committed = { listId, update };
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

    readSince: async ({ listId, version }) => {
      const copy = copyOf(await storedSnapshot(db as DrizzleDb, listId));
      try {
        return {
          update:
            version.length > 0
              ? withVector(decodeDocVersion(version), (from) =>
                  copy.doc.export({ mode: "update", from }),
                )
              : copy.doc.export({ mode: "update" }),
          version: encodeDocVersion(docVersion(copy.doc)),
        };
      } finally {
        copy.doc.free();
      }
    },

    admit: ({ list, accountId, update }) =>
      withLists([list], async (tx, [held], owner) => {
        const { copy, listId } = held as Held;
        const connection = await readConnection(tx, list, accountId);
        if (!connection) throw new Error("The account cannot write this list");
        const before = docVersion(copy.doc);
        const admitted = admit(copy.writer, update, connection);
        if (unchanged(copy.doc, before)) return { committed: null };
        copy.pending = owner;
        const dropped = new Set(admitted.dropped);
        const live = admitted.records.filter((record) => !dropped.has(record.id));
        const failed = await claimNodeIdsEach(tx, listId, live);
        const made = live.filter((record) => record.type !== "create" || !failed.has(record.node));
        return { committed: await commitChange(tx, list, copy, listId, before, made, []) };
      }),

    submit: ({ lists, make }) =>
      withLists(lists, async (tx, held, owner) => {
        const marks = held.map(({ copy }) => ({
          before: docVersion(copy.doc),
          ops: listOf(copy.doc).recordCount(),
        }));
        const writers = held.map(({ copy, listId }) => ({ writer: copy.writer, list: listId }));
        const result = inOneTransaction(writers, 0, make);
        const gained = held.map((each, at) => {
          const mark = marks[at] as (typeof marks)[number];
          const all = listOf(each.copy.doc).records();
          return {
            held: each,
            before: mark.before,
            added: readRecords(all.slice(mark.ops)),
            earlier: readRecords(all.slice(0, mark.ops)),
          };
        });
        const changes = gained.filter(
          ({ held: each, before }) => !unchanged(each.copy.doc, before),
        );
        for (const { held: each } of changes) each.copy.pending = owner;
        const done = new Map<Held, CommittedTreeUpdate>();
        for (const { held: each, before, added, earlier } of changes) {
          const known = new Set(earlier.filter(isCreate).map((record) => record.node));
          const claimed = added.filter(isCreate).filter((record) => {
            const first = !known.has(record.node);
            known.add(record.node);
            return first;
          });
          done.set(
            each,
            await commitChange(tx, each.list, each.copy, each.listId, before, claimed, claimed),
          );
        }
        return { committed: held.map((each) => done.get(each) ?? null), result };
      }),

    read: async ({ lists, view }) => {
      const tx = currentDrizzleDb(db);
      const held: Copy[] = [];
      try {
        const writers: ListWriter[] = [];
        for (const list of lists) {
          const listId = await listIdOf(tx, list);
          if (listId === null) throw new Error("The list's project or account is gone");
          const copy = await viewCopy(tx, listId);
          hold(copy);
          held.push(copy);
          writers.push({ writer: copy.writer, list: listId });
        }
        return view(writers);
      } finally {
        for (const copy of held) release(copy);
      }
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

    onListAdvanced(listener) {
      advancedListeners.add(listener);
      return () => advancedListeners.delete(listener);
    },

    listen: () =>
      db.listen(CHANNEL, (listId) => {
        for (const listener of advancedListeners) listener(listId);
      }),
  };
}
