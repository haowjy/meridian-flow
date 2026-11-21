/** Tests for Hocuspocus room persistence: writer frames and deferred live checkpoints.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Checkpoint coalescing (kb/wiki/architecture/collaboration/durability-and-honest-outcomes.md#journal-first-then-live)
 */

import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createInMemoryJournal } from "./adapters/in-memory/agent-edit.js";
import { bindDocumentAuthority } from "./domain/document-handle.js";
import type { CheckpointJournal } from "./domain/ports/checkpoint-authority.js";
import type { LiveWriterJournal } from "./domain/ports/live-writer-journal.js";
import { createHocuspocusPersistenceService } from "./hocuspocus-persistence.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000001" as never;

describe("createHocuspocusPersistenceService live checkpoints", () => {
  function liveCheckpointFixture(
    input: { checkpoint?: CheckpointJournal["storeCheckpoint"] } = {},
  ) {
    const journal = fakeJournal();
    if (input.checkpoint) journal.storeCheckpoint = vi.fn(input.checkpoint);
    // Stands in for the caller's DB transaction: commit runs the queued
    // callbacks, rollback drops them.
    let queued: Array<() => void> = [];
    const documents = new Map<string, Y.Doc>();
    const persistence = createHocuspocusPersistenceService({
      journal,
      hocuspocus: () => ({ documents, closeConnections: vi.fn() }) as never,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      afterCallerCommit: (callback) => {
        queued.push(callback);
      },
    });
    return {
      journal,
      documents,
      persistence,
      commit() {
        const callbacks = queued;
        queued = [];
        for (const callback of callbacks) callback();
      },
    };
  }

  it("writes one checkpoint at a time and coalesces queued capture requests", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let notifyFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      notifyFirstStarted = resolve;
    });
    let calls = 0;
    const fixture = liveCheckpointFixture({
      checkpoint: async () => {
        calls += 1;
        if (calls === 1) {
          notifyFirstStarted();
          await firstBlocked;
        }
      },
    });
    const first = docWithText("first");
    const second = docWithText("second");
    const third = docWithText("third");

    await fixture.persistence.storeHocuspocusDocument(DOCUMENT_ID, first);
    fixture.commit();
    await firstStarted;
    await fixture.persistence.storeHocuspocusDocument(DOCUMENT_ID, second);
    await fixture.persistence.storeHocuspocusDocument(DOCUMENT_ID, third);
    fixture.commit();
    expect(fixture.journal.storeCheckpoint).toHaveBeenCalledOnce();

    releaseFirst?.();
    await fixture.persistence.drainHocuspocusPersistence();
    expect(fixture.journal.storeCheckpoint).toHaveBeenCalledTimes(2);
    expect(fixture.journal.captureCheckpoint).toHaveBeenCalledTimes(2);
    expect(fixture.journal.captureCheckpoint).toHaveBeenLastCalledWith(DOCUMENT_ID, {
      authorityId: DOCUMENT_ID,
      generation: 1n,
    });
    expect(fixture.journal.storeCheckpoint).toHaveBeenLastCalledWith(
      expect.objectContaining({
        documentId: DOCUMENT_ID,
        authority: { authorityId: DOCUMENT_ID, generation: 1n },
        upToSeq: 0,
      }),
    );
  });
});

describe("createHocuspocusPersistenceService writer frames", () => {
  it("admits novel insertion and delete-only updates", async () => {
    const liveDocument = tombstoneBearingDoc();
    const journal = fakeJournal();
    const persistence = createHocuspocusPersistenceService({
      journal,
      hocuspocus: () => ({ documents: new Map([[DOCUMENT_ID, liveDocument]]) }) as never,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
    });
    const insertionClient = cloneDoc(liveDocument);
    const beforeInsertion = Y.encodeStateVector(insertionClient);
    insertionClient.getText("content").insert(insertionClient.getText("content").length, "!");
    const insertion = Y.encodeStateAsUpdate(insertionClient, beforeInsertion);

    await expect(
      persistence.admitLiveWriterUpdate({
        documentId: DOCUMENT_ID,
        document: liveDocument,
        update: insertion,
        origin: { type: "user", userId: "user-1" },
        expectedGeneration: 1n,
      }),
    ).resolves.toEqual({ admitted: true });

    const deletionClient = cloneDoc(liveDocument);
    const beforeDeletion = Y.encodeStateVector(deletionClient);
    deletionClient.getText("content").delete(0, 1);
    const deletion = Y.encodeStateAsUpdate(deletionClient, beforeDeletion);
    expect(Y.decodeUpdate(deletion).structs).toHaveLength(0);

    await expect(
      persistence.admitLiveWriterUpdate({
        documentId: DOCUMENT_ID,
        document: liveDocument,
        update: deletion,
        origin: { type: "user", userId: "user-1" },
        expectedGeneration: 1n,
      }),
    ).resolves.toEqual({ admitted: true });

    expect(journal.appendWriterUpdate).toHaveBeenNthCalledWith(
      1,
      DOCUMENT_ID,
      insertion,
      expect.anything(),
      { authorityId: DOCUMENT_ID, generation: 1n },
    );
    expect(journal.appendWriterUpdate).toHaveBeenNthCalledWith(
      2,
      DOCUMENT_ID,
      deletion,
      expect.anything(),
      { authorityId: DOCUMENT_ID, generation: 1n },
    );
  });

  it("rejects a caller-supplied document that is not the bound room liveDocument", async () => {
    const liveDocument = boundDoc({ gc: false });
    const wrongDocument = boundDoc({ gc: false });
    const journal = fakeJournal();
    const persistence = createHocuspocusPersistenceService({
      journal,
      hocuspocus: () => ({ documents: new Map([[DOCUMENT_ID, liveDocument]]) }) as never,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
    });

    await expect(
      persistence.admitLiveWriterUpdate({
        documentId: DOCUMENT_ID,
        document: wrongDocument,
        update: writerUpdate(),
        origin: { type: "user", userId: "user-1" },
        expectedGeneration: 1n,
      }),
    ).rejects.toThrow("live-document-room-mismatch");
    expect(journal.appendWriterUpdate).not.toHaveBeenCalled();
  });

  it("does not resolve admission until the journal transaction commits", async () => {
    const liveDocument = boundDoc({ gc: false });
    const events: string[] = [];
    let commit: (() => void) | undefined;
    const journal = fakeJournal();
    journal.appendWriterUpdate = vi.fn(
      () =>
        new Promise<{ seq: number }>((resolve) => {
          events.push("journal:start");
          commit = () => {
            events.push("journal:commit");
            resolve({ seq: 1 });
          };
        }),
    );
    const persistence = createHocuspocusPersistenceService({
      journal,
      hocuspocus: () => ({ documents: new Map([[DOCUMENT_ID, liveDocument]]) }) as never,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
    });
    const update = writerUpdate();
    const admission = persistence
      .admitLiveWriterUpdate({
        documentId: DOCUMENT_ID,
        document: liveDocument,
        update,
        origin: { type: "user", userId: "user-1" },
        expectedGeneration: 1n,
      })
      .then((result) => {
        events.push("apply/broadcast/ack");
        return result;
      });

    await Promise.resolve();
    expect(events).toEqual(["journal:start"]);
    commit?.();
    await expect(admission).resolves.toEqual({ admitted: true });
    expect(events).toEqual(["journal:start", "journal:commit", "apply/broadcast/ack"]);
  });

  it("rejects journal failure before the transport can apply or acknowledge", async () => {
    const liveDocument = boundDoc({ gc: false });
    const journal = fakeJournal();
    journal.appendWriterUpdate = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const persistence = createHocuspocusPersistenceService({
      journal,
      hocuspocus: () =>
        ({
          documents: new Map([[DOCUMENT_ID, liveDocument]]),
          getDocumentsCount: () => 1,
          getConnectionsCount: () => 0,
        }) as never,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
    });
    let appliedOrAcknowledged = false;

    await expect(
      persistence
        .admitLiveWriterUpdate({
          documentId: DOCUMENT_ID,
          document: liveDocument,
          update: writerUpdate(),
          origin: { type: "user", userId: "user-1" },
          expectedGeneration: 1n,
        })
        .then(() => {
          appliedOrAcknowledged = true;
        }),
    ).rejects.toThrow("database unavailable");
    expect(appliedOrAcknowledged).toBe(false);
  });
});

function writerUpdate(): Uint8Array {
  const doc = boundDoc();
  doc.getText("content").insert(0, "writer");
  return Y.encodeStateAsUpdate(doc);
}

function tombstoneBearingDoc(): Y.Doc {
  const doc = docWithText("seed");
  const text = doc.getText("content");
  text.delete(0, text.length);
  text.insert(0, "seed replaced");
  return doc;
}

function docWithText(text: string, generation = 1n): Y.Doc {
  const doc = boundDoc({ gc: false }, generation);
  doc.getText("content").insert(0, text);
  return doc;
}

function cloneDoc(doc: Y.Doc, generation = 1n): Y.Doc {
  const clone = boundDoc({ gc: false }, generation);
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
  return clone;
}

function fakeJournal(): CheckpointJournal & LiveWriterJournal {
  return {
    appendWriterUpdate: vi.fn(async () => ({ seq: 1 })),
    reserveWriteOrdinal: async () => {
      throw new Error("Transport does not allocate edit ordinals");
    },
    append: vi.fn(async () => 1),
    appendBatch: vi.fn(async () => []),
    read: vi.fn(async () => ({ checkpoint: null, updates: [] })),
    readUpdates: vi.fn(async () => []),
    captureCheckpoint: vi.fn(async (docId, authority) =>
      createInMemoryJournal().captureCheckpoint(docId, authority),
    ),
    storeCheckpoint: vi.fn(async () => undefined),
  };
}

function boundDoc(options?: ConstructorParameters<typeof Y.Doc>[0], generation = 1n): Y.Doc {
  const doc = new Y.Doc(options);
  bindDocumentAuthority(doc, { authorityId: DOCUMENT_ID, generation });
  return doc;
}
