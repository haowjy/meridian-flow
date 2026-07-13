/** Tests for the Hocuspocus-backed DocumentCoordinator adapter. */

import type { Hocuspocus } from "@hocuspocus/server";
import {
  DocumentNotFoundError,
  type JournalBatchAppendEntry,
  type JournalBatchAppendResult,
  type PersistedUpdate,
  type UpdateJournal,
  type UpdateMeta,
} from "@meridian/agent-edit";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  createHocuspocusCoordinatorForTest,
  type OpenLiveDocument,
} from "./hocuspocus-coordinator.js";

const DOC_ID = "doc.md";

class MemoryJournal implements UpdateJournal {
  private readonly entries = new Map<
    string,
    { checkpoint: Uint8Array | null; checkpointUpToSeq: number; updates: PersistedUpdate[] }
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
    return { updatesFolded: 0, reversalsExpired: 0 };
  }

  async persistReversal(): Promise<void> {}

  async persistRedo() {
    return { consumed: false };
  }

  async readReversals() {
    return [];
  }

  private entry(docId: string) {
    const existing = this.entries.get(docId);
    if (existing) return existing;
    const created = { checkpoint: null, checkpointUpToSeq: 0, updates: [] };
    this.entries.set(docId, created);
    return created;
  }
}

describe("createHocuspocusCoordinator", () => {
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

  it("runs withDocument calls for different documents concurrently", async () => {
    const docs = new Map([
      ["a.md", new Y.Doc({ gc: false })],
      ["b.md", new Y.Doc({ gc: false })],
    ]);
    const coordinator = coordinatorFor(docs, new MemoryJournal());
    const release = deferred();
    const bothStarted = deferred();
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;

    const run = (docId: string) =>
      coordinator.withDocument(docId, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        started.push(docId);
        if (started.length === 2) bothStarted.resolve();
        await release.promise;
        active -= 1;
        return docId;
      });

    const first = run("a.md");
    const second = run("b.md");
    const concurrent = await Promise.race([
      bothStarted.promise.then(() => true),
      delay(50).then(() => false),
    ]);
    release.resolve();
    await Promise.allSettled([first, second]);

    expect(concurrent).toBe(true);
    expect(maxActive).toBe(2);
    expect(new Set(started)).toEqual(new Set(["a.md", "b.md"]));
  });

  it("rejects missing documents before opening a live doc", async () => {
    const docs = new Map<string, Y.Doc>();
    const openLiveDoc = vi.fn(openFrom(docs));
    const coordinator = coordinatorFor(docs, new MemoryJournal(), openLiveDoc);

    await expect(
      coordinator.withDocument("missing.md", async () => undefined),
    ).rejects.toBeInstanceOf(DocumentNotFoundError);
    expect(openLiveDoc).not.toHaveBeenCalled();
  });

  it("writes through the canonical Hocuspocus room", async () => {
    const journal = new MemoryJournal();
    await journal.checkpoint(DOC_ID, Y.encodeStateAsUpdate(new Y.Doc({ gc: false })), 0);
    const docs = new Map<string, Y.Doc>();
    const openLiveDoc = vi.fn(openFrom(docs));
    const coordinator = coordinatorFor(docs, journal, openLiveDoc);

    await coordinator.withDocument(DOC_ID, async (doc) => {
      doc.getText("body").insert(0, "First saved content");
      await journal.append(DOC_ID, Y.encodeStateAsUpdate(doc), { origin: "system", seq: 0 });
    });

    expect(openLiveDoc).toHaveBeenCalledOnce();
    expect(text(requireDoc(docs, DOC_ID))).toBe("First saved content");
    const recovered = new Y.Doc({ gc: false });
    Y.applyUpdate(recovered, (await loadState(journal, DOC_ID)) as Uint8Array);
    expect(text(recovered)).toBe("First saved content");
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

async function loadState(journal: UpdateJournal, docId: string): Promise<Uint8Array | null> {
  const snapshot = await journal.read(docId);
  if (!snapshot.checkpoint && snapshot.updates.length === 0) return null;
  const doc = new Y.Doc({ gc: false });
  if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
  for (const update of snapshot.updates) Y.applyUpdate(doc, update.update);
  return Y.encodeStateAsUpdate(doc);
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
