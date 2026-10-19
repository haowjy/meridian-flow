/** In-memory agent-edit adapters for tests and the in-memory app graph. */

import {
  type DocumentAccess,
  type DocumentCoordinator,
  type DocumentLifecycle,
  DocumentNotFoundError,
  type PersistedUpdate,
  type UpdateJournal,
} from "@meridian/agent-edit/integration";
import { InMemoryAgentEditJournal } from "@meridian/agent-edit/test-support";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { KeyedMutex } from "../../../../shared/keyed-mutex.js";
import type { CapturedCheckpointCut } from "../../domain/checkpoint-cut.js";
import { documentContainsUpdate } from "../../domain/document-containment.js";
import { bindDocumentAuthority } from "../../domain/document-handle.js";
import type {
  CheckpointAuthority,
  CheckpointJournal,
} from "../../domain/ports/checkpoint-authority.js";
import type {
  LiveWriterAppend,
  LiveWriterJournal,
} from "../../domain/ports/live-writer-journal.js";
import { mintCheckpointCut, resolveCheckpointCut } from "../checkpoint-capability.js";
import { materializeCheckpoint } from "../checkpoint-materialization.js";
import { loadDocumentState, storedDocument } from "../document-loader.js";
import { liveRoomFor, withStaged } from "../hocuspocus-coordinator.js";

export type InMemoryCheckpointRecord = {
  id: string;
  documentId: string;
  state: Uint8Array;
  reason: string;
  createdAt: string;
};

export type InMemoryJournal = CheckpointJournal &
  LiveWriterJournal & {
    createCheckpoint(cut: CapturedCheckpointCut, reason: string): Promise<string>;
    seedInitialDocument(docId: string, state: Uint8Array): Promise<boolean>;
    getCheckpoint(id: string): Promise<InMemoryCheckpointRecord | null>;
    listCheckpoints(docId: string): Promise<InMemoryCheckpointRecord[]>;
    latestUpdate(docId: string): Promise<PersistedUpdate | null>;
    latestUpdateSeq(docId: string): Promise<number>;
    updateRecords(docId: string): PersistedUpdate[];
    documentsForTurn(threadId: string, turnId: string): Promise<string[]>;
  };

class InMemoryCollabJournal extends InMemoryAgentEditJournal implements InMemoryJournal {
  override async read(docId: string, opts?: Parameters<UpdateJournal["read"]>[1]) {
    return {
      ...(await super.read(docId, opts)),
      authority: { authorityId: docId, generation: 1n },
    };
  }

  private readonly checkpoints: InMemoryCheckpointRecord[] = [];
  private nextCheckpointId = 1;
  // The document lock the Drizzle journal judges novelty under.
  private readonly writerAdmissions = new KeyedMutex();

  appendWriterUpdate(
    docId: string,
    update: Uint8Array,
    meta: Parameters<UpdateJournal["append"]>[2],
  ): Promise<LiveWriterAppend> {
    return this.writerAdmissions.run(docId, async () => {
      const stored = storedDocument(await this.read(docId));
      try {
        if (documentContainsUpdate(stored, update)) return { status: "contained" };
      } finally {
        stored.destroy();
      }
      const seq = await this.append(docId, update, meta);
      return { status: "appended", seq, joinedSettlement: false };
    });
  }

  async captureCheckpoint(docId: string, authority: CheckpointAuthority) {
    if (authority.authorityId !== docId || authority.generation !== 1n) return null;
    // Copy synchronously so later writers cannot change this captured range.
    const entry = this.debugEntry(docId);
    const base = entry?.checkpoint;
    const updates = (entry?.updates ?? []).filter((row) => row.seq > (base?.upToSeq ?? 0));
    const bytes = base?.state.slice() ?? null;
    const suffix = updates.map((row) => row.update.slice());
    let state: Promise<Uint8Array> | undefined;
    return mintCheckpointCut({
      documentId: docId,
      authority: Object.freeze({ ...authority }),
      upToSeq: updates.at(-1)?.seq ?? base?.upToSeq ?? 0,
      validateInputs: async () => {},
      async materializeState() {
        state ??= materializeCheckpoint(bytes, suffix);
        return (await state).slice();
      },
    });
  }

  async createCheckpoint(cut: CapturedCheckpointCut, reason: string): Promise<string> {
    const payload = resolveCheckpointCut(cut);
    const state = await payload.materializeState();
    const record = this.checkpointRecord(payload.documentId, state, reason);
    await super.checkpoint(payload.documentId, state, payload.upToSeq);
    this.checkpoints.push(record);
    return record.id;
  }

  async seedInitialDocument(docId: string, state: Uint8Array): Promise<boolean> {
    const snapshot = await this.read(docId);
    if (snapshot.checkpoint || snapshot.updates.length) return false;
    await super.checkpoint(docId, state, 0);
    return true;
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

  async latestUpdateSeq(docId: string): Promise<number> {
    return Math.max(0, (this.debugEntry(docId)?.nextSeq ?? 1) - 1);
  }

  async storeCheckpoint(cut: CapturedCheckpointCut): Promise<void> {
    await this.createCheckpoint(cut, "checkpoint");
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
    const doc = createCollabYDoc({ gc: false });
    bindDocumentAuthority(doc, { authorityId: docId as never, generation: 1n });
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

    async readRoom(docId, staged) {
      const copy = createCollabYDoc({ gc: false });
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(requireDoc(docId)));
      await applyPersisted(docId, copy);
      bindDocumentAuthority(copy, { authorityId: docId as never, generation: 1n });
      return withStaged({ doc: copy, room: liveRoomFor(docId, copy) }, staged);
    },
    roomFor: liveRoomFor,

    withDocument<T>(
      docId: string,
      fn: (doc: Y.Doc) => Promise<T>,
      options?: DocumentAccess,
    ): Promise<T> {
      return mutex.run(docId, async () => fn(requireDoc(docId)), options);
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
