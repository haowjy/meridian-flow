import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createInMemoryDocumentStore } from "../adapters/in-memory/document-store.js";
import { createHocuspocusCollabAdapter } from "./hocuspocus-collab-adapter.js";
import { createMirror, encodeState, encodeStateVector, originColumns } from "./yjs-mirror.js";

const DOC = "00000000-0000-4000-8000-000000000501" as DocumentId;

function stubDb(): Database {
  const noopChain: ProxyHandler<object> = {
    get(_, prop) {
      if (prop === "then") return (resolve: (v: never[]) => void) => resolve([]);
      return () => new Proxy({}, noopChain);
    },
  };
  return new Proxy({}, noopChain) as Database;
}

describe("createHocuspocusCollabAdapter", () => {
  it("reports live document and connection counts when the runtime is bound", () => {
    const adapter = createHocuspocusCollabAdapter({
      db: stubDb(),
      store: createInMemoryDocumentStore(),
      autoCheckpointEvery: 100,
    });

    expect(adapter.metrics()).toEqual({
      queues: [],
      liveDocumentCount: 0,
      openConnectionCount: 0,
    });

    adapter.bind({
      openDirectConnection: async () => {
        throw new Error("not used");
      },
      documents: new Map([["doc-a", {} as never]]),
      flushPendingStores: () => undefined,
      closeConnections: () => undefined,
      getDocumentsCount: () => 3,
      getConnectionsCount: () => 2,
    });

    expect(adapter.metrics()).toEqual({
      queues: [],
      liveDocumentCount: 3,
      openConnectionCount: 2,
    });
  });

  it("drains tasks enqueued while flushing pending stores", async () => {
    const store = createInMemoryDocumentStore();
    const entry = createMirror("# Drain loop", "markdown");
    await store.transaction(async (tx) => {
      const seq = await tx.appendUpdate({
        documentId: DOC,
        updateData: encodeState(entry),
        ...originColumns({ type: "system" }),
      });
      await tx.upsertHead({
        documentId: DOC,
        fragmentName: "prosemirror",
        schemaVersion: 1,
        filetype: "markdown",
        latestUpdateSeq: seq,
        latestStateVector: encodeStateVector(entry),
        latestCheckpointId: null,
      });
    });

    const adapter = createHocuspocusCollabAdapter({
      db: stubDb(),
      store,
      autoCheckpointEvery: 100,
    });

    let flushPasses = 0;
    const doc = new Y.Doc({ gc: false, gcFilter: () => true });
    Y.applyUpdate(doc, encodeState(entry));

    adapter.bind({
      openDirectConnection: async () => {
        throw new Error("not used");
      },
      documents: new Map([[DOC, doc as never]]),
      flushPendingStores: () => {
        flushPasses += 1;
        if (flushPasses === 1) {
          adapter.persistConnectionUpdate({
            documentId: DOC,
            update: Y.encodeStateAsUpdate(doc),
            origin: { type: "user", userId: "user-1" },
            document: doc,
          });
        }
      },
      closeConnections: () => undefined,
      getDocumentsCount: () => 1,
      getConnectionsCount: () => 0,
    });

    const before = (await store.listUpdatesAfter(DOC, 0)).length;
    await adapter.drain();
    const after = (await store.listUpdatesAfter(DOC, 0)).length;

    expect(after).toBeGreaterThan(before);
    expect(adapter.metrics().queues.every((queue) => queue.depth === 0)).toBe(true);
  });

  it("drains work enqueued after the first idle observation", async () => {
    const store = createInMemoryDocumentStore();
    const entry = createMirror("# Late disconnect", "markdown");
    await store.transaction(async (tx) => {
      const seq = await tx.appendUpdate({
        documentId: DOC,
        updateData: encodeState(entry),
        ...originColumns({ type: "system" }),
      });
      await tx.upsertHead({
        documentId: DOC,
        fragmentName: "prosemirror",
        schemaVersion: 1,
        filetype: "markdown",
        latestUpdateSeq: seq,
        latestStateVector: encodeStateVector(entry),
        latestCheckpointId: null,
      });
    });

    const adapter = createHocuspocusCollabAdapter({
      db: stubDb(),
      store,
      autoCheckpointEvery: 100,
    });

    let flushPasses = 0;
    const doc = new Y.Doc({ gc: false, gcFilter: () => true });
    Y.applyUpdate(doc, encodeState(entry));

    adapter.bind({
      openDirectConnection: async () => {
        throw new Error("not used");
      },
      documents: new Map([[DOC, doc as never]]),
      flushPendingStores: () => {
        flushPasses += 1;
        if (flushPasses === 1) {
          // Simulate async Hocuspocus disconnect callbacks enqueueing persist work
          // after drain's first idle observation.
          setTimeout(() => {
            adapter.persistConnectionUpdate({
              documentId: DOC,
              update: Y.encodeStateAsUpdate(doc),
              origin: { type: "user", userId: "user-late" },
              document: doc,
            });
          }, 5);
        }
      },
      closeConnections: () => undefined,
      getDocumentsCount: () => 1,
      getConnectionsCount: () => 0,
    });

    const before = (await store.listUpdatesAfter(DOC, 0)).length;
    await adapter.drain();
    const after = (await store.listUpdatesAfter(DOC, 0)).length;

    expect(after).toBeGreaterThan(before);
    expect(adapter.metrics().queues.every((queue) => queue.depth === 0)).toBe(true);
  });

  it("setLatestCheckpointId preserves latestUpdateSeq when checkpoint is recorded", async () => {
    const store = createInMemoryDocumentStore();
    const entry = createMirror("# Checkpoint race", "markdown");
    await store.transaction(async (tx) => {
      const seq = await tx.appendUpdate({
        documentId: DOC,
        updateData: encodeState(entry),
        ...originColumns({ type: "system" }),
      });
      await tx.upsertHead({
        documentId: DOC,
        fragmentName: "prosemirror",
        schemaVersion: 1,
        filetype: "markdown",
        latestUpdateSeq: seq,
        latestStateVector: encodeStateVector(entry),
        latestCheckpointId: null,
      });
    });

    const doc = new Y.Doc({ gc: false, gcFilter: () => true });
    Y.applyUpdate(doc, encodeState(entry));

    await store.transaction(async (tx) => {
      const head = await tx.getHead(DOC);
      if (!head) throw new Error("missing head");
      await tx.appendUpdate({
        documentId: DOC,
        updateData: Y.encodeStateAsUpdate(doc),
        ...originColumns({ type: "user", userId: "user-race" }),
      });
      await tx.upsertHead({ ...head, latestUpdateSeq: head.latestUpdateSeq + 1 });
      const checkpointId = await tx.insertCheckpoint({
        documentId: DOC,
        state: Y.encodeStateAsUpdate(doc),
        stateVector: Y.encodeStateVector(doc),
        upToSeq: head.latestUpdateSeq,
        reason: "store",
      });
      await tx.setLatestCheckpointId(DOC, checkpointId);
    });

    const head = await store.getHead(DOC);
    expect(head?.latestUpdateSeq).toBe(2);
    expect(head?.latestCheckpointId).not.toBeNull();
  });
});
