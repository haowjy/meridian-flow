import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documents } from "@meridian/database";
import { COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createInMemoryEventSink } from "../../observability/index.js";
import { createInMemoryDocumentStore } from "../adapters/in-memory/document-store.js";
import { createHocuspocusCollabAdapter } from "./hocuspocus-collab-adapter.js";
import { createMirror, encodeState, encodeStateVector, originColumns } from "./yjs-mirror.js";

const DOC = "00000000-0000-4000-8000-000000000501" as DocumentId;

function mockRecoveryDb(markdownProjection: string, fileType = "markdown"): Database {
  type MockTx = {
    transaction<T>(fn: (tx: MockTx) => Promise<T>): Promise<T>;
    delete(): { where: () => Promise<void> };
    select(): {
      from: (table: unknown) => {
        where: () => { limit: () => Promise<{ markdown: string; fileType: string }[]> };
      };
    };
  };
  const db: MockTx = {
    transaction<T>(fn: (tx: MockTx) => Promise<T>): Promise<T> {
      return fn(db);
    },
    delete() {
      return {
        where: () => Promise.resolve(),
      };
    },
    select() {
      return {
        from: (table: unknown) => ({
          where: () => ({
            limit: () => {
              if (table === documents) {
                return Promise.resolve([{ markdown: markdownProjection, fileType }]);
              }
              return Promise.resolve([]);
            },
          }),
        }),
      };
    },
  };
  return db as unknown as Database;
}

describe("createHocuspocusCollabAdapter", () => {
  it("rebuilds from markdown projection when the stored schema version is stale", async () => {
    const store = createInMemoryDocumentStore();
    const eventSink = createInMemoryEventSink();
    const entry = createMirror("stale yjs body", "markdown");
    await store.transaction(async (tx) => {
      const seq = await tx.appendUpdate({
        documentId: DOC,
        updateData: encodeState(entry),
        ...originColumns({ type: "system" }),
      });
      await tx.upsertHead({
        documentId: DOC,
        fragmentName: "prosemirror",
        schemaVersion: COLLAB_SCHEMA_VERSION - 1,
        filetype: "markdown",
        latestUpdateSeq: seq,
        latestStateVector: encodeStateVector(entry),
        latestCheckpointId: null,
      });
    });

    const adapter = createHocuspocusCollabAdapter({
      db: mockRecoveryDb("# Rebuilt from projection"),
      store,
      autoCheckpointEvery: 100,
      eventSink,
    });

    const loaded = await adapter.loadDocument(DOC);
    expect(loaded).toBeDefined();
    if (!loaded) throw new Error("expected loaded document");

    const doc = new Y.Doc({ gc: false, gcFilter: () => true });
    Y.applyUpdate(doc, loaded);
    const fragment = doc.getXmlFragment("prosemirror");
    expect(fragment.toString()).toContain("Rebuilt from projection");

    const head = await store.getHead(DOC);
    expect(head?.schemaVersion).toBe(COLLAB_SCHEMA_VERSION);
    expect(head?.latestUpdateSeq).toBeGreaterThan(0);

    const events = eventSink.events;
    expect(events.some((event) => event.name === "document.schema_version_mismatch")).toBe(true);
  });

  it("reports live document and connection counts when the runtime is bound", () => {
    const adapter = createHocuspocusCollabAdapter({
      db: mockRecoveryDb(""),
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
});
