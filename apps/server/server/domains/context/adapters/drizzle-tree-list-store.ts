import type { DocumentId, ProjectId, UserId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { documentYjsUpdates } from "@meridian/database/schema";
import {
  admit,
  type Connection,
  keptCreateRecords,
  recordsOf,
  settleLogOf,
  type TreeRecord,
  TreeWriter,
} from "@meridian/project-tree";
import { eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import {
  currentDrizzleDb,
  type DrizzleDb,
  runAfterDrizzleCommit,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { testHook } from "../../../shared/test-hooks.js";
import { initializeHead } from "../../collab/adapters/drizzle-document-authority-head.js";
import type { CollabJournal } from "../../collab/adapters/drizzle-journal.js";
import type { CommittedTreeUpdate, TreeList, TreeListStore } from "../ports/tree-list-store.js";
import { readConnection, usedNodeIds } from "./tree-list-facts.js";
import { syncRows } from "./tree-list-rows.js";

/**
 * This process's copy of one list, brought to the journal's head under the list's lock and
 * changed in place by what the transaction admits. `pending` is the transaction that changed it
 * and has not committed: a copy found in any other transaction's hands is behind the journal or
 * ahead of it, so it is thrown away and reloaded.
 */
type Copy = { doc: Y.Doc; writer: TreeWriter; seq: number; pending: object | null };

const listIdOf = (list: TreeList) => (list.kind === "project" ? list.projectId : list.userId);

function ownerOf(list: TreeList) {
  return list.kind === "project"
    ? { projectId: list.projectId as ProjectId }
    : { userId: list.userId as UserId };
}

/** The node ids the update's `create` records name, for the check of ids used elsewhere. */
function createdNodes(update: Uint8Array): string[] {
  let decoded: ReturnType<typeof Y.decodeUpdate>;
  try {
    decoded = Y.decodeUpdate(update);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const struct of decoded.structs) {
    if (!(struct instanceof Y.Item) || !(struct.content instanceof Y.ContentAny)) continue;
    for (const value of struct.content.getContent()) {
      const record = value as { type?: unknown; node?: unknown } | null;
      if (record?.type === "create" && typeof record.node === "string") ids.push(record.node);
    }
  }
  return ids;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, at) => byte === b[at]);

export function createDrizzleTreeListStore(deps: {
  db: Database;
  journal: CollabJournal;
}): TreeListStore {
  const { db, journal } = deps;
  const copies = new Map<string, Copy>();
  const listeners = new Set<(committed: CommittedTreeUpdate) => void>();

  async function headSeq(tx: DrizzleDb, listId: string): Promise<number> {
    const [row] = await tx
      .select({ seq: sql<number>`coalesce(max(${documentYjsUpdates.id}), 0)::int` })
      .from(documentYjsUpdates)
      .where(eq(documentYjsUpdates.documentId, listId as DocumentId));
    return row?.seq ?? 0;
  }

  async function copyAtHead(tx: DrizzleDb, listId: string): Promise<Copy> {
    let copy = copies.get(listId);
    if (copy && copy.pending !== null && copy.pending !== tx) {
      copies.delete(listId);
      copy = undefined;
    }
    if (copy) {
      const head = await headSeq(tx, listId);
      if (head > copy.seq) {
        // Caught up from the journal's new rows, not from the start.
        for (const row of await journal.readUpdates(listId, copy.seq, head))
          Y.applyUpdate(copy.doc, row.update, "journal");
        copy.seq = head;
      }
      return copy;
    }
    const doc = new Y.Doc({ gc: false });
    const snapshot = await journal.read(listId);
    if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint, "journal");
    for (const row of snapshot.updates) Y.applyUpdate(doc, row.update, "journal");
    // After the history, so Yjs never sees an item of its own id arrive from elsewhere.
    const [id] = await tx.execute<{ id: string }>(
      sql`SELECT nextval('tree_server_client_id')::int AS id`,
    );
    doc.clientID = Number(id?.id);
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
   * One transaction on one list: its lock, its head and the copy at the journal's head. A
   * failure discards the copy, which `body` may have changed in place.
   */
  function withList<T>(
    list: TreeList,
    body: (tx: DrizzleDb, copy: Copy, listId: string) => Promise<T>,
  ): Promise<T> {
    const listId = listIdOf(list);
    return runInDrizzleTransaction(db, async () => {
      const tx = currentDrizzleDb(db);
      await lockDocumentMutation(tx as Database, listId);
      await initializeHead(tx as Database, listId as DocumentId, ownerOf(list));
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
    copy: Copy,
    listId: string,
    before: Uint8Array,
    added: readonly TreeRecord[],
  ): Promise<CommittedTreeUpdate | null> {
    if (sameBytes(Y.encodeStateVector(copy.doc), before)) return null;
    copy.pending = tx;
    const update = Y.encodeStateAsUpdate(copy.doc, before);
    // The system path: a person's path would read the whole list under the lock to record an
    // edit, and a list's receipt is the record itself.
    const seq = await journal.append(listId, update, { origin: "system", seq: 0 });
    copy.seq = seq;
    await testHook("treeList.afterAppend");
    await syncRows(tx, listId, copy.doc, added);
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
    admit: ({ list, accountId, update }) =>
      withList(list, async (tx, copy, listId) => {
        const taken = await usedNodeIds(tx, createdNodes(update));
        const connection: Connection | null = await readConnection(tx, list, accountId, taken);
        if (!connection) return { ok: false as const, reason: "no write access" };
        const before = Y.encodeStateVector(copy.doc);
        const verdict = admit(copy.writer, update, connection);
        if (!verdict.ok) return verdict;
        const refused = new Set(verdict.refused.map((entry) => entry.id));
        const added = [
          ...verdict.records.filter((record) => !refused.has(record.id)),
          ...keptCreateRecords(verdict.records, verdict.kept, connection.user),
        ];
        return {
          ok: true as const,
          committed: await commitChange(tx, copy, listId, before, added),
        };
      }),

    submit: ({ list, entries }) =>
      withList(list, async (tx, copy, listId) => {
        const before = Y.encodeStateVector(copy.doc);
        copy.writer.transact(() => {
          recordsOf(copy.doc).push([...entries.records]);
          settleLogOf(copy.doc).push([...(entries.settlements ?? [])]);
        });
        return commitChange(tx, copy, listId, before, entries.records);
      }),

    onCommitted(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
