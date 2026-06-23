/** In-memory agent-edit adapters for tests and the in-memory app graph. */
import {
  type DocumentCoordinator,
  type DocumentLifecycle,
  DocumentNotFoundError,
  type MutationStore,
  type PersistedUpdate,
  type UpdateJournal,
} from "@meridian/agent-edit";
import { InMemoryAgentEditJournal } from "@meridian/agent-edit/test-support";
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

export type InMemoryJournal = UpdateJournal &
  MutationStore & {
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

class InMemoryCollabJournal extends InMemoryAgentEditJournal implements InMemoryJournal {
  private readonly checkpoints: InMemoryCheckpointRecord[] = [];
  private nextCheckpointId = 1;

  async createCheckpoint(
    docId: string,
    state: Uint8Array,
    reason: string,
    upToSeq: number,
  ): Promise<string> {
    const record = this.checkpointRecord(docId, state, reason);
    await super.checkpoint(docId, state, upToSeq);
    this.checkpoints.push(record);
    return record.id;
  }

  async getCheckpoint(id: string): Promise<InMemoryCheckpointRecord | null> {
    const checkpoint = this.checkpoints.find((candidate) => candidate.id === id);
    return checkpoint ? copyCheckpointRecord(checkpoint) : null;
  }

  async listCheckpoints(docId: string): Promise<InMemoryCheckpointRecord[]> {
    return this.checkpoints
      .filter((checkpoint) => checkpoint.documentId === docId)
      .sort((left, right) => Number(right.id) - Number(left.id))
      .map(copyCheckpointRecord);
  }

  async latestUpdate(docId: string): Promise<PersistedUpdate | null> {
    return this.updateRecords(docId).at(-1) ?? null;
  }

  override async checkpoint(docId: string, state: Uint8Array, upToSeq: number): Promise<void> {
    await this.createCheckpoint(docId, state, "checkpoint", upToSeq);
  }

  override async compact(docId: string, before: Date) {
    const result = await super.compact(docId, before);
    if (result.updatesFolded > 0) {
      const snapshot = await super.read(docId);
      if (snapshot.checkpoint) {
        this.checkpoints.push(this.checkpointRecord(docId, snapshot.checkpoint, "compact"));
      }
    }
    return result;
  }

  private checkpointRecord(
    documentId: string,
    state: Uint8Array,
    reason: string,
  ): InMemoryCheckpointRecord {
    return {
      id: String(this.nextCheckpointId++),
      documentId,
      state: new Uint8Array(state),
      reason,
      createdAt: new Date().toISOString(),
    };
  }
}

export function createInMemoryJournal(): InMemoryJournal {
  return new InMemoryCollabJournal();
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

function copyCheckpointRecord(record: InMemoryCheckpointRecord): InMemoryCheckpointRecord {
  return {
    ...record,
    state: new Uint8Array(record.state),
  };
}
