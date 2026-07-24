/** Coordinates persisted branch-peer Y.Docs behind one mutation surface. */

import type { SemanticEditIRV1 } from "@meridian/agent-edit";
import { bytesEqual, yjsDeltaUpdate } from "@meridian/agent-edit";
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import { COLLAB_SCHEMA_VERSION, createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import {
  assertBranchLeaseCovers,
  type BranchCriticalSections,
  type BranchLockLease,
  createBranchCriticalSections,
} from "./branch-critical-sections.js";
import { BranchCorruptError } from "./branch-resolver.js";
import { admitWriterUpdate, createDocumentAuthority } from "./document-authority.js";
import { createDocumentContainment } from "./document-containment.js";
import { currentResponseTransactionId, enlistResponseParticipant } from "./response-transaction.js";
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
  discardedStateVector?: Uint8Array | null;
  schemaVersion: number;
};

export type PersistBranchInput = {
  branchId: string;
  expectedGeneration: number;
  expectedStateVector: Uint8Array;
  expectedState: Uint8Array;
  state: Uint8Array;
  stateVector: Uint8Array;
};

export type CommitBranchMutationInput = PersistBranchInput & {
  journal?: AppendBranchJournalInput;
};

export type AppendBranchJournalInput = {
  branchId: string;
  generation: number;
  /** Rejects a staged reversal if branch history advanced after planning. */
  expectedJournalWatermark?: number;
  /** Rejects status-only Apply/discard/redo transitions after planning. */
  expectedJournalRevision?: string;
  updateData: Uint8Array;
  source: "agent" | "writer";
  wId?: number | null;
  threadId?: ThreadId | null;
  turnId?: string | null;
  actorUserId?: string | null;
  updateMeta?: unknown;
  semanticEditIr?: SemanticEditIRV1;
};

export type ResetBranchSnapshotInput = {
  branchId: string;
  expectedGeneration: number;
  expectedStateVector: Uint8Array;
  expectedState: Uint8Array;
  state: Uint8Array;
  stateVector: Uint8Array;
  discardedStateVector: Uint8Array;
  schemaVersion: number;
};

export type BranchStore = {
  getBranch(branchId: string): Promise<BranchSnapshot | null>;
  updateBranchSnapshot(input: PersistBranchInput): Promise<boolean>;
  commitBranchMutation?(input: CommitBranchMutationInput): Promise<boolean>;
  resetBranchSnapshot?(input: ResetBranchSnapshotInput): Promise<boolean>;
  appendJournal?(input: AppendBranchJournalInput): Promise<void>;
  /** Defers cache-visible effects when persistence joined a response transaction. */
  deferUntilCommit(callback: () => void): boolean;
};

export class BranchStaleUpdateError extends Error {
  constructor(readonly branchId: string) {
    super(`Branch ${branchId} update did not apply to the current generation`);
    this.name = "BranchStaleUpdateError";
  }
}

export class BranchCasConflictError extends Error {
  constructor(readonly branchId: string) {
    super(`Branch ${branchId} changed before its snapshot could be persisted`);
    this.name = "BranchCasConflictError";
  }
}

type CachedBranchDoc = {
  generation: number;
  state: Uint8Array;
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
  resetFromDoc(branchId: string, upstream: Y.Doc, schemaVersion?: number): Promise<void>;
  resetFromDocIfUnchanged(input: {
    branchId: string;
    upstream: Y.Doc;
    expectedGeneration: number;
    expectedStateVector: Uint8Array;
    expectedState: Uint8Array;
    schemaVersion?: number;
  }): Promise<boolean>;
  resetFromDocIfUnchangedWithLease(
    lease: BranchLockLease,
    input: {
      branchId: string;
      upstream: Y.Doc;
      expectedGeneration: number;
      expectedStateVector: Uint8Array;
      expectedState: Uint8Array;
      schemaVersion?: number;
    },
  ): Promise<boolean>;
  resetFromBranch(branchId: string, upstreamBranchId?: string): Promise<void>;
  checkpointBranch(branchId: string): Promise<void>;
  withBranchTransient<T>(
    branchId: string,
    fn: (doc: Y.Doc, snapshot: BranchSnapshot) => Promise<T>,
  ): Promise<T>;
  readBranch<T>(
    branchId: string,
    fn: (doc: Y.Doc, snapshot: BranchSnapshot) => Promise<T>,
  ): Promise<T>;
  commitUpdate(
    input: Omit<AppendBranchJournalInput, "generation"> & { expectedGeneration?: number },
  ): Promise<void>;
  commitWriterUpdate(input: {
    branchId: string;
    expectedGeneration: number;
    updateData: Uint8Array;
    actorUserId?: string;
    roomDocument: Y.Doc;
  }): Promise<{ admitted: boolean }>;
  commitSyncFromDoc(
    input: Omit<AppendBranchJournalInput, "generation" | "updateData"> & {
      sourceDoc: Y.Doc;
      expectedGeneration: number;
    },
  ): Promise<boolean>;
  appendJournaledUpdate(input: AppendBranchJournalInput): Promise<void>;
  broadcastUpdate(input: { branchId: string; update: Uint8Array }): void;
};

export function createBranchCoordinator(input: {
  store: BranchStore;
  criticalSections?: BranchCriticalSections;
  maxCasRetries?: number;
  onBranchUpdate?: (input: { branchId: string; update: Uint8Array }) => void;
  onBranchReset?: (input: { branchId: string; generation: number }) => void;
}): BranchCoordinator {
  const criticalSections = input.criticalSections ?? createBranchCriticalSections();
  const documentContainment = createDocumentContainment();
  const cached = new Map<string, CachedBranchDoc>();
  const pendingTransients = new Map<string, CachedBranchDoc>();
  const dirtyTransientBranches = new Set<string>();
  const maxCasRetries = input.maxCasRetries ?? 3;

  async function resetFromDocIfUnchangedWithLease(
    lease: BranchLockLease,
    resetInput: {
      branchId: string;
      upstream: Y.Doc;
      expectedGeneration: number;
      expectedStateVector: Uint8Array;
      expectedState: Uint8Array;
      schemaVersion?: number;
    },
  ): Promise<boolean> {
    assertBranchLeaseCovers(lease, resetInput.branchId);
    const snapshot = await loadSnapshot(resetInput.branchId);
    assertWorkDraftResetTarget(snapshot);
    if (
      snapshot.generation !== resetInput.expectedGeneration ||
      !bytesEqual(snapshot.stateVector, resetInput.expectedStateVector) ||
      !bytesEqual(snapshot.state, resetInput.expectedState)
    ) {
      cached.delete(resetInput.branchId);
      return false;
    }
    await persistReset(
      snapshot,
      resetInput.upstream,
      resetInput.schemaVersion ?? snapshot.schemaVersion,
    );
    return true;
  }

  async function loadSnapshot(branchId: string): Promise<BranchSnapshot> {
    const snapshot = await input.store.getBranch(branchId);
    if (!snapshot) throw new Error(`Branch ${branchId} does not exist`);
    assertReadableBranch(snapshot);
    return snapshot;
  }

  async function materialize(snapshot: BranchSnapshot): Promise<CachedBranchDoc> {
    const transactionId = currentResponseTransactionId();
    const pending = transactionId
      ? pendingTransients.get(pendingTransientKey(transactionId, snapshot.branchId))
      : undefined;
    if (pending) return pending;
    const current = cached.get(snapshot.branchId);
    if (
      current &&
      current.generation === snapshot.generation &&
      (dirtyTransientBranches.has(snapshot.branchId) ||
        (bytesEqual(current.stateVector, snapshot.stateVector) &&
          bytesEqual(current.state, snapshot.state)))
    ) {
      return current;
    }
    try {
      const doc = createCollabYDoc({ gc: false });
      Y.applyUpdate(doc, snapshot.state);
      const next = {
        generation: snapshot.generation,
        state: snapshot.state,
        stateVector: snapshot.stateVector,
        doc,
      };
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

  async function persist(
    snapshot: BranchSnapshot,
    doc: Y.Doc,
    journal?: AppendBranchJournalInput,
    publishUpdate?: Uint8Array,
  ): Promise<void> {
    const state = Y.encodeStateAsUpdate(doc);
    const stateVector = Y.encodeStateVector(doc);
    if (!journal && bytesEqual(state, snapshot.state)) return;
    const mutation = {
      branchId: snapshot.branchId,
      expectedGeneration: snapshot.generation,
      expectedStateVector: snapshot.stateVector,
      expectedState: snapshot.state,
      state,
      stateVector,
      ...(journal ? { journal } : {}),
    };
    const ok = input.store.commitBranchMutation
      ? await input.store.commitBranchMutation(mutation)
      : await legacyCommitBranchMutation(mutation);
    if (!ok) {
      cached.delete(snapshot.branchId);
      dirtyTransientBranches.delete(snapshot.branchId);
      throw new BranchCasConflictError(snapshot.branchId);
    }
    const publish = () => {
      dirtyTransientBranches.delete(snapshot.branchId);
      cached.set(snapshot.branchId, { generation: snapshot.generation, state, stateVector, doc });
      const update = journal?.updateData ?? publishUpdate;
      if (update) input.onBranchUpdate?.({ branchId: snapshot.branchId, update });
    };
    if (currentResponseTransactionId()) {
      enlistResponseParticipant({ commit: publish, abort() {} });
      return;
    }
    if (!input.store.deferUntilCommit(publish)) publish();
  }

  async function legacyCommitBranchMutation(
    inputMutation: CommitBranchMutationInput,
  ): Promise<boolean> {
    if (inputMutation.journal) await input.store.appendJournal?.(inputMutation.journal);
    return input.store.updateBranchSnapshot(inputMutation);
  }

  async function persistReset(
    snapshot: BranchSnapshot,
    upstream: Y.Doc,
    schemaVersion: number,
  ): Promise<void> {
    if (!input.store.resetBranchSnapshot) {
      throw new Error("Branch store does not support branch reset");
    }
    const resetDoc = createCollabYDoc({ gc: false });
    await replicateFrozenCut(upstream, resetDoc);
    const state = Y.encodeStateAsUpdate(resetDoc);
    const stateVector = Y.encodeStateVector(resetDoc);
    const ok = await input.store.resetBranchSnapshot({
      branchId: snapshot.branchId,
      expectedGeneration: snapshot.generation,
      expectedStateVector: snapshot.stateVector,
      expectedState: snapshot.state,
      state,
      stateVector,
      discardedStateVector: mergeStateVectors(snapshot.discardedStateVector, snapshot.stateVector),
      schemaVersion,
    });
    if (!ok) {
      resetDoc.destroy();
      cached.delete(snapshot.branchId);
      dirtyTransientBranches.delete(snapshot.branchId);
      throw new BranchCasConflictError(snapshot.branchId);
    }
    dirtyTransientBranches.delete(snapshot.branchId);
    cached.set(snapshot.branchId, {
      generation: snapshot.generation + 1,
      state,
      stateVector,
      doc: resetDoc,
    });
    input.onBranchReset?.({ branchId: snapshot.branchId, generation: snapshot.generation + 1 });
  }

  async function runWithRetry<T>(
    branchId: string,
    operation: (snapshot: BranchSnapshot, doc: Y.Doc) => Promise<T>,
    updateToPublish?: (result: T) => Uint8Array,
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await criticalSections.withBranches([branchId], async () => {
          const snapshot = await loadSnapshot(branchId);
          const { doc: cachedDoc } = await materialize(snapshot);
          // O(doc) clone-before-write is intentional per GATE-1 spec §9 (Q4 headroom):
          // failed CAS/rollback must never mutate the cached branch doc.
          const doc = cloneDoc(cachedDoc);
          const result = await operation(snapshot, doc);
          await persist(snapshot, doc, undefined, updateToPublish?.(result));
          return result;
        });
      } catch (cause) {
        if (!(cause instanceof BranchCasConflictError) || attempt++ >= maxCasRetries) throw cause;
      }
    }
  }

  async function replicateFrozenCut(source: Y.Doc, target: Y.Doc): Promise<Uint8Array> {
    let admittedUpdate: Uint8Array | undefined;
    const cutState = Y.encodeStateAsUpdate(source);
    const frozenSource = cloneDoc(source);
    try {
      const authority = createDocumentAuthority({
        readMutableAuthority: () => ({ documentId: "branch", generation: 0n, doc: target }),
        readFrozenCut: async (cutId) =>
          cutId === "captured-upstream"
            ? {
                cutId,
                documentId: "branch",
                authorityId: "captured-upstream",
                generation: 0n,
                doc: frozenSource,
              }
            : null,
        admitImmediate: async ({ update }) => {
          admittedUpdate = update;
          Y.applyUpdate(target, update);
          return { sequence: 0n, joined: 0 };
        },
        readCurrentRevision: unsupportedAuthorityOperation,
        lowerCertifiedMutation: unsupportedAuthorityOperation,
        loadCheckpoint: unsupportedAuthorityOperation,
        unresolvedSettlements: unsupportedAuthorityOperation,
        replaceGeneration: unsupportedAuthorityOperation,
        disconnectGeneration: unsupportedAuthorityOperation,
        stagePush: unsupportedAuthorityOperation,
        completePush: unsupportedAuthorityOperation,
      });
      await authority.mutate({
        kind: "identityReplication",
        sourceAuthorityCutId: "captured-upstream",
        plan: { kind: "wholeDocument" },
      });
      if (!admittedUpdate) throw new Error("Identity replication produced no branch update");
      // Prove the aggregate used the immutable cut rather than rereading its mutable caller.
      if (!bytesEqual(cutState, Y.encodeStateAsUpdate(frozenSource))) {
        throw new Error("Captured authority cut changed during replication");
      }
      return admittedUpdate;
    } finally {
      frozenSource.destroy();
    }
  }

  async function persistJournaledUpdate(
    snapshot: BranchSnapshot,
    inputJournal: Omit<AppendBranchJournalInput, "generation">,
    authoritative?: Y.Doc,
  ): Promise<boolean> {
    const cachedDoc = authoritative ?? (await materialize(snapshot)).doc;
    // O(doc) clone-before-write is intentional per GATE-1 spec §9 (Q4 headroom):
    // failed CAS/rollback must never mutate the cached branch doc.
    const doc = cloneDoc(cachedDoc);
    const beforeState = Y.encodeStateAsUpdate(doc);
    Y.applyUpdate(doc, inputJournal.updateData);
    if (bytesEqual(beforeState, Y.encodeStateAsUpdate(doc))) {
      throw new BranchStaleUpdateError(inputJournal.branchId);
    }
    await persist(snapshot, doc, { ...inputJournal, generation: snapshot.generation });
    return true;
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

    readBranch(branchId, fn) {
      return criticalSections.withBranches([branchId], async () => {
        const snapshot = await loadSnapshot(branchId);
        const { doc } = await materialize(snapshot);
        return fn(doc, snapshot);
      });
    },

    withBranchTransient(branchId, fn) {
      return criticalSections.withBranches([branchId], async () => {
        const snapshot = await loadSnapshot(branchId);
        assertWritableBranch(snapshot);
        const { doc: cachedDoc } = await materialize(snapshot);
        const doc = cloneDoc(cachedDoc);
        const result = await fn(doc, snapshot);
        const next = {
          generation: snapshot.generation,
          state: Y.encodeStateAsUpdate(doc),
          stateVector: Y.encodeStateVector(doc),
          doc,
        };
        const transactionId = currentResponseTransactionId();
        if (!transactionId) {
          cached.set(snapshot.branchId, next);
          dirtyTransientBranches.add(snapshot.branchId);
          return result;
        }
        const key = pendingTransientKey(transactionId, snapshot.branchId);
        pendingTransients.set(key, next);
        enlistResponseParticipant({
          commit() {
            const pending = pendingTransients.get(key);
            if (!pending) return;
            pendingTransients.delete(key);
            cached.set(snapshot.branchId, pending);
            dirtyTransientBranches.add(snapshot.branchId);
          },
          abort() {
            pendingTransients.delete(key);
          },
        });
        return result;
      });
    },

    checkpointBranch(branchId) {
      return runWithRetry(branchId, async () => undefined);
    },

    pullFromDoc(branchId, upstream) {
      return runWithRetry(
        branchId,
        async (_snapshot, doc) => replicateFrozenCut(upstream, doc),
        (update) => update,
      );
    },

    async pullFromBranch(branchId, upstreamBranchId) {
      const child = await loadSnapshot(branchId);
      const parentId = upstreamBranchId ?? child.upstreamBranchId;
      if (!parentId) throw new Error(`Branch ${branchId} has no upstream branch`);
      const upstreamState = await criticalSections.withBranches([parentId], async () => {
        const upstream = await loadSnapshot(parentId);
        const { doc: upstreamDoc } = await materialize(upstream);
        return Y.encodeStateAsUpdate(upstreamDoc);
      });
      const upstreamDoc = createCollabYDoc({ gc: false });
      try {
        Y.applyUpdate(upstreamDoc, upstreamState);
        return this.pullFromDoc(branchId, upstreamDoc);
      } finally {
        upstreamDoc.destroy();
      }
    },

    async resetFromDoc(branchId, upstream, schemaVersion) {
      let attempt = 0;
      while (true) {
        try {
          return await criticalSections.withBranches([branchId], async () => {
            const snapshot = await loadSnapshot(branchId);
            assertWorkDraftResetTarget(snapshot);
            await persistReset(snapshot, upstream, schemaVersion ?? snapshot.schemaVersion);
          });
        } catch (cause) {
          if (!(cause instanceof BranchCasConflictError) || attempt++ >= maxCasRetries) throw cause;
        }
      }
    },

    resetFromDocIfUnchanged(resetInput) {
      return criticalSections.withBranches([resetInput.branchId], (lease) =>
        resetFromDocIfUnchangedWithLease(lease, resetInput),
      );
    },

    resetFromDocIfUnchangedWithLease,

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

    async appendJournaledUpdate(inputJournal) {
      let attempt = 0;
      while (true) {
        try {
          return await criticalSections.withBranches([inputJournal.branchId], async () => {
            const snapshot = await loadSnapshot(inputJournal.branchId);
            if (snapshot.generation !== inputJournal.generation) {
              throw new Error(
                `Branch ${snapshot.branchId} generation ${snapshot.generation} did not match journal generation ${inputJournal.generation}`,
              );
            }
            const { doc: cachedDoc } = await materialize(snapshot);
            // O(doc) clone-before-write is intentional per GATE-1 spec §9 (Q4 headroom):
            // failed CAS/rollback must never mutate the cached branch doc.
            const doc = cloneDoc(cachedDoc);
            Y.applyUpdate(doc, inputJournal.updateData);
            await persist(snapshot, doc, inputJournal);
          });
        } catch (cause) {
          if (!(cause instanceof BranchCasConflictError) || attempt++ >= maxCasRetries) throw cause;
        }
      }
    },

    broadcastUpdate(update) {
      const current = cached.get(update.branchId);
      if (current) {
        Y.applyUpdate(current.doc, update.update);
        current.state = Y.encodeStateAsUpdate(current.doc);
        current.stateVector = Y.encodeStateVector(current.doc);
      }
      input.onBranchUpdate?.(update);
    },

    async commitSyncFromDoc(inputJournal) {
      let attempt = 0;
      while (true) {
        try {
          return await criticalSections.withBranches([inputJournal.branchId], async () => {
            const snapshot = await loadSnapshot(inputJournal.branchId);
            assertWritableBranch(snapshot);
            if (snapshot.generation !== inputJournal.expectedGeneration) {
              throw new BranchStaleUpdateError(inputJournal.branchId);
            }
            const { doc: cachedDoc } = await materialize(snapshot);
            const doc = cloneDoc(cachedDoc);
            const updateData = encodeDeltaUpdate(inputJournal.sourceDoc, doc);
            if (!updateData) return false;
            const semanticIr = inputJournal.semanticEditIr;
            if (inputJournal.source === "agent" && semanticIr) {
              const authority = createDocumentAuthority({
                readMutableAuthority: () => ({
                  documentId: snapshot.documentId,
                  generation: BigInt(snapshot.generation),
                  doc,
                }),
                // A response may lower several certified IRs into one atomic branch delta.
                // The package validated each IR against its chained runtime revision before
                // the ambient response transaction began; rereading the pre-batch target here
                // would reject every IR after the first and force the durable unit to split.
                readCurrentRevision: async () => semanticIr.inputRevision,
                lowerCertifiedMutation: async () => updateData,
                admitImmediate: async ({ update }) => {
                  Y.applyUpdate(doc, update);
                  await persist(snapshot, doc, {
                    ...inputJournal,
                    updateData: update,
                    generation: snapshot.generation,
                  });
                  return { sequence: 0n, joined: 0 };
                },
                readFrozenCut: unsupportedAuthorityOperation,
                loadCheckpoint: unsupportedAuthorityOperation,
                unresolvedSettlements: unsupportedAuthorityOperation,
                replaceGeneration: unsupportedAuthorityOperation,
                disconnectGeneration: unsupportedAuthorityOperation,
                stagePush: unsupportedAuthorityOperation,
                completePush: unsupportedAuthorityOperation,
              });
              await authority.mutate({
                kind: "certifiedSemanticMutation",
                actor: "agent",
                ir: semanticIr,
              });
            } else {
              Y.applyUpdate(doc, updateData);
              await persist(snapshot, doc, {
                ...inputJournal,
                updateData,
                generation: snapshot.generation,
              });
            }
            return true;
          });
        } catch (cause) {
          if (!(cause instanceof BranchCasConflictError) || attempt++ >= maxCasRetries) throw cause;
        }
      }
    },

    async commitUpdate(inputJournal) {
      let attempt = 0;
      while (true) {
        try {
          return await criticalSections.withBranches([inputJournal.branchId], async () => {
            const snapshot = await loadSnapshot(inputJournal.branchId);
            if (
              inputJournal.expectedGeneration !== undefined &&
              snapshot.generation !== inputJournal.expectedGeneration
            ) {
              throw new BranchStaleUpdateError(inputJournal.branchId);
            }
            await persistJournaledUpdate(snapshot, inputJournal);
          });
        } catch (cause) {
          if (!(cause instanceof BranchCasConflictError) || attempt++ >= maxCasRetries) throw cause;
        }
      }
    },

    async commitWriterUpdate(inputWriter) {
      let attempt = 0;
      while (true) {
        try {
          return await criticalSections.withBranches([inputWriter.branchId], async () => {
            const snapshot = await loadSnapshot(inputWriter.branchId);
            const { doc: authoritative } = await materialize(snapshot);
            const admission = await admitWriterUpdate({
              authority: authoritative,
              update: inputWriter.updateData,
              validateAuthority() {
                if (
                  snapshot.kind !== "work_draft" ||
                  snapshot.status !== "active" ||
                  snapshot.generation !== inputWriter.expectedGeneration ||
                  !documentContainment.contains(inputWriter.roomDocument, snapshot.state)
                ) {
                  throw new BranchStaleUpdateError(inputWriter.branchId);
                }
              },
              isContained: () =>
                documentContainment.contains(authoritative, inputWriter.updateData),
              append: () =>
                persistJournaledUpdate(
                  snapshot,
                  {
                    branchId: inputWriter.branchId,
                    updateData: inputWriter.updateData,
                    source: "writer",
                    actorUserId: inputWriter.actorUserId,
                  },
                  authoritative,
                ),
            });
            return { admitted: admission.admitted };
          });
        } catch (cause) {
          if (!(cause instanceof BranchCasConflictError) || attempt++ >= maxCasRetries) throw cause;
        }
      }
    },
  };
}

function pendingTransientKey(transactionId: string, branchId: string): string {
  return `${transactionId}\0${branchId}`;
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

function assertWritableBranch(snapshot: BranchSnapshot): void {
  if (snapshot.status !== "active") {
    throw new BranchStaleUpdateError(snapshot.branchId);
  }
}

function cloneDoc(doc: Y.Doc): Y.Doc {
  const clone = createCollabYDoc({ gc: false });
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
  return clone;
}

function mergeStateVectors(left: Uint8Array | null | undefined, right: Uint8Array): Uint8Array {
  if (!left) return right;
  const merged = new Map(Y.decodeStateVector(left));
  for (const [client, clock] of Y.decodeStateVector(right)) {
    merged.set(client, Math.max(merged.get(client) ?? 0, clock));
  }
  return Y.encodeStateVector(new Map(merged));
}

function encodeDeltaUpdate(from: Y.Doc, to: Y.Doc): Uint8Array | null {
  return yjsDeltaUpdate(from, to);
}

async function unsupportedAuthorityOperation(): Promise<never> {
  throw new Error("Document authority strategy is unavailable for this branch operation");
}
