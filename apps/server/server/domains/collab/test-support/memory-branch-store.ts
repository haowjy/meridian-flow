/** The checkpoint + tail branch store in memory, for unit tests whose flows write a branch. */
import { COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import {
  type AppendBranchJournalInput,
  type AppendRowsInput,
  type AppendRowsOutcome,
  type BranchRead,
  type BranchReadSince,
  type BranchSnapshot,
  type BranchStore,
  type CommitRewriteInput,
  type EffectBaseline,
  mergeStateVectors,
  type RewriteOutcome,
  type StaleEffectCursor,
} from "../domain/branch-store.js";

/** A branch row, defaulting every field the test does not name. */
export function testBranchRow(
  input: Pick<BranchSnapshot, "branchId" | "documentId"> & Partial<BranchSnapshot>,
): BranchSnapshot {
  return {
    kind: "work_draft",
    upstreamBranchId: null,
    draftId: "draft-1" as BranchSnapshot["draftId"],
    workId: null,
    threadId: null,
    status: "active",
    generation: 1,
    revision: 0,
    checkpointRevision: 0,
    checkpointSeq: 0,
    lifecycle: "active",
    hasEffect: false,
    blocking: false,
    schemaVersion: COLLAB_SCHEMA_VERSION,
    ...input,
  };
}

type MemoryRow = { id: number; generation: number; update: Uint8Array; source: "agent" | "writer" };

/** A branch as the store keeps it: the row, its checkpoint and every journal row it has. */
export type MemoryBranch = BranchSnapshot & {
  checkpoint: { state: Uint8Array; stateVector: Uint8Array };
  rows: MemoryRow[];
  /** The work draft's effect baseline; a seeded branch's is its seed. */
  liveCut?: Uint8Array;
  /** The revision `hasEffect` was judged at; absent is the stale sentinel. */
  hasEffectRevision?: number;
};

/** A stored branch: `row` with `content` (a document or its update bytes) as its checkpoint. */
export function memoryBranch(row: BranchSnapshot, content: Y.Doc | Uint8Array): MemoryBranch {
  const state = content instanceof Uint8Array ? content : Y.encodeStateAsUpdate(content);
  return {
    ...row,
    checkpoint: { state, stateVector: Y.encodeStateVectorFromUpdate(state) },
    rows: [],
    liveCut: state,
  };
}

/**
 * The checkpoint + tail store in memory: every committed write bumps `revision`, an append
 * adds tail rows at whatever revision the branch holds (finalized on the prefix past its base,
 * as under the row lock), a rewrite replaces the checkpoint and moves `checkpointSeq` past
 * every row. One call runs with no await between its read and its write, so it is atomic.
 */
export class MemoryBranchStore implements BranchStore {
  readonly branches = new Map<string, MemoryBranch>();
  /** Every journal row ever appended, in order. */
  readonly journal: Uint8Array[] = [];
  failNextCas = false;
  failNextJournal = false;
  private nextRowId = 1;

  constructor(branches: readonly MemoryBranch[] = []) {
    for (const branch of branches) this.branches.set(branch.branchId, branch);
  }

  deferUntilCommit(callback: () => void): boolean {
    callback();
    return true;
  }

  async getBranch(branchId: string): Promise<BranchSnapshot | null> {
    const branch = this.branches.get(branchId);
    return branch ? rowOf(branch) : null;
  }

  /** One observation: the row, checkpoint and tail are taken together, with no await between. */
  async readBranchAt(branchId: string, since?: BranchReadSince): Promise<BranchRead | null> {
    return this.readNow(branchId, since);
  }

  private readNow(branchId: string, since?: BranchReadSince): BranchRead | null {
    const branch = this.branches.get(branchId);
    if (!branch) return null;
    const held = since?.checkpointRevision === branch.checkpointRevision;
    const after = held ? Math.max(since.seq, branch.checkpointSeq) : branch.checkpointSeq;
    return {
      branch: rowOf(branch),
      checkpoint: held ? null : branch.checkpoint,
      tail: branch.rows
        .filter((row) => row.generation === branch.generation && row.id > after)
        .map(({ id, update, source }) => ({ id, update, source })),
    };
  }

  async readEffectBaseline(branchId: string): Promise<EffectBaseline | null> {
    const branch = this.branches.get(branchId);
    if (branch?.kind !== "work_draft") return null;
    return { state: branch.liveCut ?? null, checkpointRevision: branch.checkpointRevision };
  }

  async appendRows(input: AppendRowsInput): Promise<AppendRowsOutcome> {
    const branch = this.branches.get(input.branchId);
    if (
      branch?.status !== "active" ||
      branch.lifecycle !== "active" ||
      branch.generation !== input.expectedGeneration
    )
      return { status: "refused" };
    const read = this.readNow(input.branchId, input.base);
    if (!read) return { status: "refused" };
    const finalized = await input.finalize(read);
    if (finalized.status !== "appended") return finalized;
    if (this.failNextJournal) {
      this.failNextJournal = false;
      throw new Error("injected journal failure");
    }
    const rowIds = finalized.rows.map((row) => this.append(branch, row));
    branch.revision += 1;
    return {
      status: "appended",
      revision: branch.revision,
      checkpointRevision: branch.checkpointRevision,
      rowIds,
    };
  }

  async writeEffect(input: {
    branchId: string;
    revision: number;
    hasEffect: boolean;
  }): Promise<"written" | "moved" | "contended"> {
    const branch = this.branches.get(input.branchId);
    if (branch?.revision !== input.revision) return "moved";
    branch.hasEffect = input.hasEffect;
    branch.hasEffectRevision = input.revision;
    return "written";
  }

  async staleEffectBranches(input: {
    after?: StaleEffectCursor;
    limit: number;
  }): Promise<readonly StaleEffectCursor[]> {
    const updatedAt = new Date(0);
    return [...this.branches.values()]
      .filter(
        (branch) =>
          branch.kind === "work_draft" &&
          branch.status === "active" &&
          (branch.hasEffectRevision ?? -1) < branch.revision &&
          (!input.after || branch.branchId < input.after.branchId),
      )
      .sort((left, right) => (left.branchId < right.branchId ? 1 : -1))
      .slice(0, input.limit)
      .map((branch) => ({ branchId: branch.branchId, updatedAt }));
  }

  async commitRewrite(input: CommitRewriteInput): Promise<RewriteOutcome> {
    if (input.upstream) {
      const upstream = this.branches.get(input.upstream.branchId);
      if (upstream?.status !== "active" || upstream.generation !== input.upstream.generation)
        return { status: "upstreamMoved" };
    }
    const branch = this.branches.get(input.branchId);
    if (branch?.status !== "active") return { status: "closed" };
    if (this.takeCasFailure()) return { status: "moved" };
    if (
      input.policy.kind === "exact"
        ? branch.revision !== input.policy.revision
        : branch.checkpointRevision !== input.policy.checkpointRevision
    )
      return { status: "moved" };
    const tail = branch.rows.filter(
      (row) => row.generation === branch.generation && row.id > branch.checkpointSeq,
    );
    const { operation } = input;
    // A fold applies what landed after its cursor; a reset discards it.
    let folded = 0;
    if (input.policy.kind === "fold" && operation.kind !== "reset") {
      const after = input.policy.seq;
      for (const row of tail) {
        if (row.id <= after) continue;
        Y.applyUpdate(input.doc, row.update);
        folded += 1;
      }
    }
    if (operation.kind === "reset") {
      branch.discardedStateVector = tail.reduce(
        (vector, row) =>
          mergeStateVectors(vector, Y.encodeStateVector(Y.parseUpdateMeta(row.update).to)),
        mergeStateVectors(branch.discardedStateVector, branch.checkpoint.stateVector),
      );
      branch.generation += 1;
      branch.schemaVersion = operation.schemaVersion;
    }
    branch.checkpoint = {
      state: Y.encodeStateAsUpdate(input.doc),
      stateVector: Y.encodeStateVector(input.doc),
    };
    if (operation.kind === "reset") {
      branch.liveCut = branch.checkpoint.state;
      branch.hasEffectRevision = branch.revision + 1;
    }
    if (operation.kind === "pull" && operation.effect) {
      const { effect } = operation;
      branch.liveCut = effect.liveCut;
      branch.hasEffect = folded && effect.refolded ? effect.refolded(input.doc) : effect.hasEffect;
      branch.hasEffectRevision = branch.revision + 1;
    }
    branch.checkpointSeq = Math.max(0, ...branch.rows.map((row) => row.id));
    branch.revision += 1;
    branch.checkpointRevision = branch.revision;
    return {
      status: "committed",
      revision: branch.revision,
      checkpointRevision: branch.checkpointRevision,
      seq: branch.checkpointSeq,
      generation: branch.generation,
    };
  }

  private append(branch: MemoryBranch, row: AppendBranchJournalInput): number {
    const id = this.nextRowId++;
    branch.rows.push({
      id,
      generation: row.generation,
      update: row.updateData,
      source: row.source,
    });
    this.journal.push(row.updateData);
    return id;
  }

  private takeCasFailure(): boolean {
    if (!this.failNextCas) return false;
    this.failNextCas = false;
    return true;
  }
}

function rowOf(branch: MemoryBranch): BranchSnapshot {
  const {
    checkpoint: _checkpoint,
    rows: _rows,
    liveCut: _liveCut,
    hasEffectRevision: _hasEffectRevision,
    ...snapshot
  } = branch;
  return snapshot;
}
