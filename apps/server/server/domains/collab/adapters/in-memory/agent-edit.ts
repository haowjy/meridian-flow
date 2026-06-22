/** In-memory agent-edit adapters for tests and the in-memory app graph. */
import {
  type CompactionResult,
  type DocumentCoordinator,
  type DocumentLifecycle,
  DocumentNotFoundError,
  type JournalSnapshot,
  type PersistedUpdate,
  type ReversalRecord,
  type UpdateJournal,
} from "@meridian/agent-edit";
import * as Y from "yjs";
import { KeyedMutex } from "../../../../shared/keyed-mutex.js";
import { loadDocumentState } from "../document-loader.js";

export type InMemoryCheckpointRecord = {
  id: string;
  documentId: string;
  state: Uint8Array;
  reason: string;
  createdAt: string;
};

type JournalEntry = {
  checkpoint: Uint8Array | null;
  checkpointUpToSeq: number;
  nextSeq: number;
  updates: PersistedUpdate[];
  reversals: ReversalRecord[];
  checkpoints: InMemoryCheckpointRecord[];
};

export type InMemoryJournal = UpdateJournal & {
  createCheckpoint(
    docId: string,
    state: Uint8Array,
    reason: string,
    upToSeq: number,
  ): Promise<string>;
  getCheckpoint(id: string): Promise<InMemoryCheckpointRecord | null>;
  listCheckpoints(docId: string): Promise<InMemoryCheckpointRecord[]>;
  latestUpdate(docId: string): Promise<PersistedUpdate | null>;
};

export function createInMemoryJournal(): InMemoryJournal {
  const data = new Map<string, JournalEntry>();
  let nextCheckpointId = 1;

  function entry(docId: string): JournalEntry {
    let existing = data.get(docId);
    if (!existing) {
      existing = {
        checkpoint: null,
        checkpointUpToSeq: 0,
        nextSeq: 1,
        updates: [],
        reversals: [],
        checkpoints: [],
      };
      data.set(docId, existing);
    }
    return existing;
  }

  async function createCheckpoint(
    docId: string,
    state: Uint8Array,
    reason: string,
    upToSeq: number,
  ): Promise<string> {
    const record: InMemoryCheckpointRecord = {
      id: String(nextCheckpointId++),
      documentId: docId,
      state: new Uint8Array(state),
      reason,
      createdAt: new Date().toISOString(),
    };
    const current = entry(docId);
    current.checkpoint = record.state;
    current.checkpointUpToSeq = upToSeq;
    current.checkpoints.push(record);
    return record.id;
  }

  return {
    async append(docId, update, meta) {
      const current = entry(docId);
      const seq = current.nextSeq++;
      if (meta.seq && meta.seq !== seq) throw new Error(`Expected seq ${seq}, got ${meta.seq}`);
      current.updates.push({
        seq,
        update: new Uint8Array(update),
        meta: { ...meta, seq },
      });
      return seq;
    },

    async read(docId, opts = {}): Promise<JournalSnapshot> {
      const current = entry(docId);
      return {
        checkpoint: current.checkpoint,
        updates: current.updates.filter(
          (update) =>
            update.seq > current.checkpointUpToSeq &&
            (opts.since === undefined || update.seq >= opts.since) &&
            (opts.until === undefined || update.seq <= opts.until),
        ),
      };
    },

    async checkpoint(docId, state, upToSeq) {
      await createCheckpoint(docId, state, "checkpoint", upToSeq);
    },

    async compact(docId, _before): Promise<CompactionResult> {
      const current = entry(docId);
      const doc = new Y.Doc({ gc: false });
      if (current.checkpoint) Y.applyUpdate(doc, current.checkpoint);
      const retained = current.updates.filter((update) => update.seq > current.checkpointUpToSeq);
      for (const update of retained) Y.applyUpdate(doc, update.update);
      const updatesFolded = retained.length;
      const upToSeq = retained.at(-1)?.seq ?? current.checkpointUpToSeq;
      await createCheckpoint(docId, Y.encodeStateAsUpdate(doc), "compact", upToSeq);
      current.updates = current.updates.filter((update) => update.seq > upToSeq);
      return { updatesFolded, reversalsExpired: 0 };
    },

    async persistReversal(docId, undoUpdate, record) {
      const seq = await this.append(docId, undoUpdate, { origin: "system", seq: 0 });
      record.undoUpdateSeq = seq;
      entry(docId).reversals.push({ ...record });
    },

    createCheckpoint,

    async getCheckpoint(id) {
      for (const current of data.values()) {
        const checkpoint = current.checkpoints.find((candidate) => candidate.id === id);
        if (checkpoint) return checkpoint;
      }
      return null;
    },

    async listCheckpoints(docId) {
      return [...entry(docId).checkpoints].sort((a, b) => Number(b.id) - Number(a.id));
    },

    async latestUpdate(docId) {
      return entry(docId).updates.at(-1) ?? null;
    },
  };
}

export function createInMemoryCoordinator(journal: UpdateJournal): DocumentCoordinator & {
  ensureEmpty(docId: string): Y.Doc;
} {
  const docs = new Map<string, Y.Doc>();
  const mutex = new KeyedMutex();

  function ensureEmpty(docId: string): Y.Doc {
    const existing = docs.get(docId);
    if (existing) return existing;
    const doc = new Y.Doc({ gc: false });
    docs.set(docId, doc);
    return doc;
  }

  function requireDoc(docId: string): Y.Doc {
    const doc = docs.get(docId);
    if (!doc) throw new DocumentNotFoundError(docId);
    return doc;
  }

  async function applyPersisted(docId: string, doc: Y.Doc): Promise<void> {
    const persisted = await loadDocumentState(journal, docId);
    if (!persisted) return;
    const missing = Y.diffUpdate(persisted, Y.encodeStateVector(doc));
    Y.applyUpdate(doc, missing, { type: "system" });
  }

  return {
    ensureEmpty,

    withDocument<T>(docId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T> {
      return mutex.run(docId, async () => fn(requireDoc(docId)));
    },

    recover(docId: string): Promise<void> {
      return mutex.run(docId, async () => {
        const state = await loadDocumentState(journal, docId);
        if (!state && !docs.has(docId)) return;
        const doc = ensureEmpty(docId);
        if (state) await applyPersisted(docId, doc);
      });
    },
  };
}

export function createInMemoryDocumentLifecycle(coordinator: {
  ensureEmpty(docId: string): Y.Doc;
}): DocumentLifecycle {
  return {
    async ensureDocument(docId) {
      coordinator.ensureEmpty(docId);
    },
  };
}
