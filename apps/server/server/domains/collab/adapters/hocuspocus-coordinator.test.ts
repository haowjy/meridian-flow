/** Consolidated test contracts; each block retains its original fixture scope. */

import type { Connection, Hocuspocus } from "@hocuspocus/server";
import type {
  JournalBatchAppendEntry,
  JournalBatchAppendResult,
  PersistedUpdate,
  UpdateJournal,
  UpdateMeta,
} from "@meridian/agent-edit/integration";
import { describe as __mergedSuite, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createHocuspocusChangeEventDelivery } from "./hocuspocus-change-event-delivery.js";
import {
  createHocuspocusCoordinatorForTest,
  type OpenLiveDocument,
} from "./hocuspocus-coordinator.js";

__mergedSuite("hocuspocus-coordinator.test.ts", () => {
  // Merged from apps/server/server/domains/collab/adapters/hocuspocus-coordinator.test.ts.
  const DOC_ID = "doc.md";

  class MemoryJournal implements UpdateJournal {
    async reserveWriteOrdinal(): Promise<number> {
      throw new Error("Transport does not allocate edit ordinals");
    }
    private readonly entries = new Map<
      string,
      {
        checkpoint: Uint8Array | null;
        checkpointUpToSeq: number;
        updates: PersistedUpdate[];
      }
    >();
    async append(docId: string, update: Uint8Array, meta: UpdateMeta): Promise<number> {
      const entry = this.entry(docId);
      const seq = entry.updates.length + 1;
      entry.updates.push({ seq, update, meta: { ...meta, seq } });
      return seq;
    }
    async appendBatch(
      entries: readonly JournalBatchAppendEntry[],
    ): Promise<JournalBatchAppendResult[]> {
      const results: JournalBatchAppendResult[] = [];
      for (const batchEntry of entries) {
        const seq = await this.append(batchEntry.docId, batchEntry.update, batchEntry.meta);
        results.push({ seq, journalCommitKind: "durable" });
      }
      return results;
    }
    async read(docId: string) {
      const entry = this.entries.get(docId);
      return entry
        ? {
            checkpoint: entry.checkpoint,
            updates: entry.updates.filter((update) => update.seq > entry.checkpointUpToSeq),
          }
        : { checkpoint: null, updates: [] };
    }
    async checkpoint(docId: string, state: Uint8Array, upToSeq: number): Promise<void> {
      const entry = this.entry(docId);
      entry.checkpoint = state;
      entry.checkpointUpToSeq = upToSeq;
    }
    async compact() {
      return { updatesFolded: 0 };
    }
    private entry(docId: string) {
      const existing = this.entries.get(docId);
      if (existing) return existing;
      const created = { checkpoint: null, checkpointUpToSeq: 0, updates: [] };
      this.entries.set(docId, created);
      return created;
    }
  }

  __mergedSuite("createHocuspocusCoordinator", () => {
    it("serializes concurrent withDocument calls for the same document", async () => {
      const docs = new Map([[DOC_ID, new Y.Doc({ gc: false })]]);
      const coordinator = coordinatorFor(docs, new MemoryJournal());
      const firstEntered = deferred();
      const finishFirst = deferred();
      const events: string[] = [];
      let active = 0;
      const first = coordinator.withDocument(DOC_ID, async () => {
        events.push("first:start");
        active += 1;
        firstEntered.resolve();
        await finishFirst.promise;
        active -= 1;
        events.push("first:end");
        return "first";
      });
      await firstEntered.promise;
      const second = coordinator.withDocument(DOC_ID, async () => {
        events.push("second:start");
        expect(active).toBe(0);
        events.push("second:end");
        return "second";
      });
      await delay(0);
      expect(events).toEqual(["first:start"]);
      finishFirst.resolve();
      await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
      expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    });
    it("shares a room opened while a coordinated write is acquiring it", async () => {
      const journal = new MemoryJournal();
      const initial = new Y.Doc({ gc: false });
      initial.getText("body").insert(0, "initial");
      await journal.checkpoint(DOC_ID, Y.encodeStateAsUpdate(initial), 0);
      const docs = new Map<string, Y.Doc>();
      const acquisitionStarted = deferred();
      const finishAcquisition = deferred();
      const openLiveDoc: OpenLiveDocument = async (docId) => {
        acquisitionStarted.resolve();
        await finishAcquisition.promise;
        return openFrom(docs)(docId);
      };
      const coordinator = coordinatorFor(docs, journal, openLiveDoc);
      const coordinated = coordinator.withDocument(DOC_ID, async (doc) => {
        doc.getText("body").insert(doc.getText("body").length, " + server");
      });
      await acquisitionStarted.promise;
      const websocketDoc = new Y.Doc({ gc: false });
      docs.set(DOC_ID, websocketDoc);
      finishAcquisition.resolve();
      await coordinated;
      expect(requireDoc(docs, DOC_ID)).toBe(websocketDoc);
      expect(text(websocketDoc)).toBe("initial + server");
    });
    it("recovers idempotently and rebuilds a dropped live doc from the journal", async () => {
      const journal = new MemoryJournal();
      const persisted = new Y.Doc({ gc: false });
      persisted.getText("body").insert(0, "Alpha");
      await journal.checkpoint(DOC_ID, Y.encodeStateAsUpdate(persisted), 0);
      const live = new Y.Doc({ gc: false });
      const docs = new Map([[DOC_ID, live]]);
      const openLiveDoc = vi.fn(openFrom(docs));
      const coordinator = coordinatorFor(docs, journal, openLiveDoc);
      await coordinator.recover(DOC_ID);
      expect(text(live)).toBe("Alpha");
      const recoveredBytes = Array.from(Y.encodeStateAsUpdate(live));
      await coordinator.recover(DOC_ID);
      expect(text(live)).toBe("Alpha");
      expect(Array.from(Y.encodeStateAsUpdate(live))).toEqual(recoveredBytes);
      docs.delete(DOC_ID);
      await coordinator.recover(DOC_ID);
      expect(text(requireDoc(docs, DOC_ID))).toBe("Alpha");
      expect(openLiveDoc).toHaveBeenCalledTimes(1);
    });
  });

  function coordinatorFor(
    docs: Map<string, Y.Doc>,
    journal: UpdateJournal,
    openLiveDoc: OpenLiveDocument = openFrom(docs),
  ) {
    return createHocuspocusCoordinatorForTest({
      hocuspocus: () => ({ documents: docs }) as unknown as Hocuspocus,
      journal,
      openLiveDoc,
    });
  }

  function openFrom(docs: Map<string, Y.Doc>): OpenLiveDocument {
    return async (docId) => {
      let doc = docs.get(docId);
      if (!doc) {
        doc = new Y.Doc({ gc: false });
        docs.set(docId, doc);
      }
      return { doc, release: async () => {} };
    };
  }

  function requireDoc(docs: Map<string, Y.Doc>, docId: string): Y.Doc {
    const doc = docs.get(docId);
    if (!doc) throw new Error(`Missing test doc ${docId}`);
    return doc;
  }

  function text(doc: Y.Doc): string {
    return doc.getText("body").toString();
  }

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
});

__mergedSuite("hocuspocus-change-event-delivery.test.ts", () => {
  // Merged from apps/server/server/domains/collab/adapters/hocuspocus-change-event-delivery.test.ts.
  const message = {
    documentId: "00000000-0000-4000-8000-000000000001",
    threadId: "thread-1",
    trailId: "trail-1",
    projectionRevision: 1,
    author: { kind: "agent" as const, threadId: "thread-1", turnId: "turn-1" },
    changes: [
      {
        admittedByUserId: null,
        changeId: "change-1",
        kind: "delete" as const,
        navigation: { kind: "unavailable" as const, reason: "test" },
        swept: false,
        excerpt: "Removed prose",
        pureDeletionOffset: null,
      },
    ],
    truncated: false,
  };

  function connection(userId: string): Connection {
    return { context: { userId } } as Connection;
  }

  __mergedSuite("Hocuspocus change-event delivery", () => {
    it("targets each connected writer with only that writer's sweep classification", () => {
      const writerA = connection("writer-a");
      const writerB = connection("writer-b");
      const unidentified = { context: {} } as Connection;
      const liveConnections = [writerA, writerB, unidentified];
      const deliveries = new Map<Connection, unknown>();
      const liveBroadcast = vi.fn(
        (payload: string, filter: (connection: Connection) => boolean) => {
          for (const candidate of liveConnections) {
            if (filter(candidate)) {
              deliveries.set(candidate, JSON.parse(payload));
            }
          }
        },
      );
      const branchBroadcast = vi.fn();
      const disconnectedBroadcast = vi.fn();
      const documents = new Map<string, unknown>([
        [
          message.documentId,
          { getConnections: () => liveConnections, broadcastStateless: liveBroadcast },
        ],
        [
          `branch:${message.documentId}:gen:1`,
          { getConnections: () => [connection("writer-a")], broadcastStateless: branchBroadcast },
        ],
        [
          "00000000-0000-4000-8000-000000000002",
          { getConnections: () => [], broadcastStateless: disconnectedBroadcast },
        ],
      ]);
      const delivery = createHocuspocusChangeEventDelivery({
        hocuspocus: () => ({ documents }) as unknown as Hocuspocus,
      });
      delivery.deliver(message, new Map([["writer-a" as never, new Set(["change-1"])]]));
      delivery.deliver(
        { ...message, documentId: "00000000-0000-4000-8000-000000000002" },
        new Map(),
      );
      expect(liveBroadcast).toHaveBeenCalledTimes(2);
      expect(deliveries.get(writerA)).toMatchObject({
        type: "change_event",
        documentId: message.documentId,
        changes: [{ changeId: "change-1", swept: true }],
      });
      expect(deliveries.get(writerB)).toMatchObject({
        changes: [{ changeId: "change-1", swept: false }],
      });
      expect(deliveries.has(unidentified)).toBe(false);
      expect(branchBroadcast).not.toHaveBeenCalled();
      expect(disconnectedBroadcast).not.toHaveBeenCalled();
    });
  });
});
