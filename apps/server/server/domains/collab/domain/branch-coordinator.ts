/** Coordinates persisted branch-peer Y.Docs behind one mutation surface. */
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import { COLLAB_SCHEMA_VERSION, createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { KeyedMutex } from "../../../shared/keyed-mutex.js";
import { BranchCorruptError } from "./branch-resolver.js";
import { sync } from "./branch-sync.js";
import { isStaleSchema, StaleDocumentSchemaError } from "./stale-schema.js";

export type BranchKind = "work_draft" | "thread_peer";
export type BranchPushPolicy = "manual" | "auto";

export type BranchSnapshot = {
  branchId: string;
  documentId: DocumentId;
  kind: BranchKind;
  upstreamBranchId: string | null;
  workId: WorkId | null;
  threadId: ThreadId | null;
  pushPolicy: BranchPushPolicy;
  generation: number;
  state: Uint8Array;
  stateVector: Uint8Array;
  schemaVersion?: number | null;
};

export type PersistBranchInput = {
  branchId: string;
  expectedGeneration: number;
  expectedStateVector: Uint8Array;
  state: Uint8Array;
  stateVector: Uint8Array;
};

export type AppendBranchJournalInput = {
  branchId: string;
  generation: number;
  updateData: Uint8Array;
  source: "agent" | "writer";
  wId?: number | null;
  threadId?: ThreadId | null;
  turnId?: string | null;
  actorUserId?: string | null;
  updateMeta?: unknown;
};

export type BranchStore = {
  getBranch(branchId: string): Promise<BranchSnapshot | null>;
  updateBranchSnapshot(input: PersistBranchInput): Promise<boolean>;
  appendJournal?(input: AppendBranchJournalInput): Promise<void>;
};

export class BranchCasConflictError extends Error {
  constructor(readonly branchId: string) {
    super(`Branch ${branchId} changed before its snapshot could be persisted`);
    this.name = "BranchCasConflictError";
  }
}

type CachedBranchDoc = {
  generation: number;
  stateVector: Uint8Array;
  doc: Y.Doc;
};

export type BranchCoordinator = {
  withBranch<T>(
    branchId: string,
    fn: (doc: Y.Doc, snapshot: BranchSnapshot) => Promise<T>,
  ): Promise<T>;
  pullFromDoc(branchId: string, upstream: Y.Doc): Promise<Uint8Array>;
  pullFromBranch(branchId: string, upstreamBranchId?: string): Promise<Uint8Array>;
  appendJournaledUpdate(input: AppendBranchJournalInput): Promise<void>;
};

export function createBranchCoordinator(input: {
  store: BranchStore;
  mutex?: KeyedMutex;
  maxCasRetries?: number;
}): BranchCoordinator {
  const mutex = input.mutex ?? new KeyedMutex();
  const cached = new Map<string, CachedBranchDoc>();
  const maxCasRetries = input.maxCasRetries ?? 3;

  async function loadSnapshot(branchId: string): Promise<BranchSnapshot> {
    const snapshot = await input.store.getBranch(branchId);
    if (!snapshot) throw new Error(`Branch ${branchId} does not exist`);
    assertReadableBranch(snapshot);
    return snapshot;
  }

  async function materialize(snapshot: BranchSnapshot): Promise<CachedBranchDoc> {
    const current = cached.get(snapshot.branchId);
    if (
      current &&
      current.generation === snapshot.generation &&
      bytesEqual(current.stateVector, snapshot.stateVector)
    ) {
      return current;
    }
    try {
      const doc = createCollabYDoc({ gc: false });
      Y.applyUpdate(doc, snapshot.state);
      const next = { generation: snapshot.generation, stateVector: snapshot.stateVector, doc };
      cached.set(snapshot.branchId, next);
      return next;
    } catch (cause) {
      throw new BranchCorruptError({
        branchId: snapshot.branchId,
        documentId: snapshot.documentId,
        threadId: snapshot.threadId ?? ("" as ThreadId),
        cause,
      });
    }
  }

  async function persist(snapshot: BranchSnapshot, doc: Y.Doc): Promise<void> {
    const state = Y.encodeStateAsUpdate(doc);
    const stateVector = Y.encodeStateVector(doc);
    if (bytesEqual(stateVector, snapshot.stateVector)) return;
    const ok = await input.store.updateBranchSnapshot({
      branchId: snapshot.branchId,
      expectedGeneration: snapshot.generation,
      expectedStateVector: snapshot.stateVector,
      state,
      stateVector,
    });
    if (!ok) {
      cached.delete(snapshot.branchId);
      throw new BranchCasConflictError(snapshot.branchId);
    }
    cached.set(snapshot.branchId, { generation: snapshot.generation, stateVector, doc });
  }

  async function runWithRetry<T>(
    branchId: string,
    operation: (snapshot: BranchSnapshot, doc: Y.Doc) => Promise<T>,
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await mutex.run(branchId, async () => {
          const snapshot = await loadSnapshot(branchId);
          const { doc } = await materialize(snapshot);
          const result = await operation(snapshot, doc);
          await persist(snapshot, doc);
          return result;
        });
      } catch (cause) {
        if (!(cause instanceof BranchCasConflictError) || attempt++ >= maxCasRetries) throw cause;
      }
    }
  }

  return {
    withBranch(branchId, fn) {
      return runWithRetry(branchId, (snapshot, doc) => fn(doc, snapshot));
    },

    pullFromDoc(branchId, upstream) {
      return runWithRetry(branchId, async (_snapshot, doc) => sync(upstream, doc));
    },

    async pullFromBranch(branchId, upstreamBranchId) {
      const child = await loadSnapshot(branchId);
      const parentId = upstreamBranchId ?? child.upstreamBranchId;
      if (!parentId) throw new Error(`Branch ${branchId} has no upstream branch`);
      const upstream = await loadSnapshot(parentId);
      const { doc: upstreamDoc } = await materialize(upstream);
      return this.pullFromDoc(branchId, upstreamDoc);
    },

    appendJournaledUpdate(inputJournal) {
      return runWithRetry(inputJournal.branchId, async (snapshot, doc) => {
        if (snapshot.generation !== inputJournal.generation) {
          throw new Error(
            `Branch ${snapshot.branchId} generation ${snapshot.generation} did not match journal generation ${inputJournal.generation}`,
          );
        }
        Y.applyUpdate(doc, inputJournal.updateData);
        await input.store.appendJournal?.(inputJournal);
      });
    },
  };
}

export function assertReadableBranch(snapshot: BranchSnapshot): void {
  if (isStaleSchema(snapshot.schemaVersion, COLLAB_SCHEMA_VERSION)) {
    throw new StaleDocumentSchemaError(
      snapshot.documentId,
      snapshot.schemaVersion ?? 0,
      COLLAB_SCHEMA_VERSION,
    );
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
