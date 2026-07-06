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
export type BranchStatus = "active" | "closed";

export type BranchSnapshot = {
  branchId: string;
  documentId: DocumentId;
  kind: BranchKind;
  upstreamBranchId: string | null;
  workId: WorkId | null;
  threadId: ThreadId | null;
  pushPolicy: BranchPushPolicy;
  status: BranchStatus;
  generation: number;
  state: Uint8Array;
  stateVector: Uint8Array;
  schemaVersion: number;
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

export type ResetBranchSnapshotInput = {
  branchId: string;
  expectedGeneration: number;
  expectedStateVector: Uint8Array;
  state: Uint8Array;
  stateVector: Uint8Array;
  schemaVersion: number;
};

export type BranchStore = {
  getBranch(branchId: string): Promise<BranchSnapshot | null>;
  updateBranchSnapshot(input: PersistBranchInput): Promise<boolean>;
  resetBranchSnapshot?(input: ResetBranchSnapshotInput): Promise<boolean>;
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
  resetFromDoc(branchId: string, upstream: Y.Doc, schemaVersion: number): Promise<void>;
  resetFromBranch(branchId: string, upstreamBranchId?: string): Promise<void>;
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

  async function persistReset(
    snapshot: BranchSnapshot,
    upstream: Y.Doc,
    schemaVersion: number,
  ): Promise<void> {
    if (!input.store.resetBranchSnapshot) {
      throw new Error("Branch store does not support branch reset");
    }
    const state = Y.encodeStateAsUpdate(upstream);
    const stateVector = Y.encodeStateVector(upstream);
    const ok = await input.store.resetBranchSnapshot({
      branchId: snapshot.branchId,
      expectedGeneration: snapshot.generation,
      expectedStateVector: snapshot.stateVector,
      state,
      stateVector,
      schemaVersion,
    });
    if (!ok) {
      cached.delete(snapshot.branchId);
      throw new BranchCasConflictError(snapshot.branchId);
    }
    const resetDoc = createCollabYDoc({ gc: false });
    Y.applyUpdate(resetDoc, state);
    cached.set(snapshot.branchId, {
      generation: snapshot.generation + 1,
      stateVector,
      doc: resetDoc,
    });
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

  function assertWorkDraftResetTarget(snapshot: BranchSnapshot): void {
    if (snapshot.kind !== "work_draft" || snapshot.status !== "active") {
      throw new Error(`Branch ${snapshot.branchId} is not an active work draft reset target`);
    }
  }

  function assertThreadPeerResetLineage(child: BranchSnapshot, upstream: BranchSnapshot): void {
    if (child.kind !== "thread_peer" || child.status !== "active") {
      throw new Error(`Branch ${child.branchId} is not an active thread peer reset target`);
    }
    if (
      upstream.kind !== "work_draft" ||
      upstream.status !== "active" ||
      upstream.documentId !== child.documentId
    ) {
      throw new Error(
        `Branch ${child.branchId} reset upstream ${upstream.branchId} is not its active same-document work draft`,
      );
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

    resetFromDoc(branchId, upstream, schemaVersion) {
      return runWithRetry(branchId, async (snapshot) => {
        assertWorkDraftResetTarget(snapshot);
        await persistReset(snapshot, upstream, schemaVersion);
      });
    },

    async resetFromBranch(branchId, upstreamBranchId) {
      return runWithRetry(branchId, async (child) => {
        const parentId = upstreamBranchId ?? child.upstreamBranchId;
        if (!parentId) throw new Error(`Branch ${branchId} has no upstream branch`);
        const upstream = await loadSnapshot(parentId);
        assertThreadPeerResetLineage(child, upstream);
        const { doc: upstreamDoc } = await materialize(upstream);
        await persistReset(child, upstreamDoc, upstream.schemaVersion);
      });
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
      snapshot.schemaVersion,
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
