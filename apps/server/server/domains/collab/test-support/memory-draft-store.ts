/** The checkpoint + tail draft store in memory, for unit tests whose flows write a draft. */
import { COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type {
  AppendDraftJournalInput,
  AppendRowsInput,
  AppendRowsOutcome,
  CommitRewriteInput,
  DraftRead,
  DraftReadSince,
  DraftSnapshot,
  DraftStore,
  RewriteOutcome,
  StaleEffectCursor,
} from "../domain/draft-store.js";

/** A draft row, defaulting every field the test does not name. */
export function testDraftRow(
  input: Pick<DraftSnapshot, "draftId" | "documentId"> & Partial<DraftSnapshot>,
): DraftSnapshot {
  return {
    kind: "work_draft",
    upstreamDraftId: null,
    branchId: "branch-1" as DraftSnapshot["branchId"],
    workId: null,
    threadId: null,
    status: "active",
    closedCause: null,
    revision: 0,
    checkpointRevision: 0,
    checkpointSeq: 0,
    lifecycle: "active",
    hasEffect: false,
    schemaVersion: COLLAB_SCHEMA_VERSION,
    ...input,
    seed: input.seed ?? null,
  };
}

type MemoryRow = {
  id: number;
  update: Uint8Array;
  source: "agent" | "writer" | "server";
};

/** A draft as the store keeps it: the row, its checkpoint and every journal row it has. */
export type MemoryDraft = DraftSnapshot & {
  checkpoint: { state: Uint8Array; stateVector: Uint8Array };
  rows: MemoryRow[];
  /** The work draft's effect baseline; a seeded draft's is its seed. */
  liveCut?: Uint8Array;
  /** The revision `hasEffect` was judged at; absent is the stale sentinel. */
  hasEffectRevision?: number;
};

/** A stored draft: `row` with `content` (a document or its update bytes) as its checkpoint. */
export function memoryDraft(row: DraftSnapshot, content: Y.Doc | Uint8Array): MemoryDraft {
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
 * adds tail rows at whatever revision the draft holds (finalized on the prefix past its base,
 * as under the row lock), a rewrite replaces the checkpoint and moves `checkpointSeq` past
 * every row. One call runs with no await between its read and its write, so it is atomic.
 */
export class MemoryDraftStore implements DraftStore {
  readonly drafts = new Map<string, MemoryDraft>();
  /** Every journal row ever appended, in order. */
  readonly journal: Uint8Array[] = [];
  failNextCas = false;
  failNextJournal = false;
  private nextRowId = 1;

  constructor(drafts: readonly MemoryDraft[] = []) {
    for (const documentDraft of drafts) this.drafts.set(documentDraft.draftId, documentDraft);
  }

  deferUntilCommit(callback: () => void): boolean {
    callback();
    return true;
  }

  async getDraft(draftId: string): Promise<DraftSnapshot | null> {
    const documentDraft = this.drafts.get(draftId);
    return documentDraft ? rowOf(documentDraft) : null;
  }

  /** One observation: the row, checkpoint and tail are taken together, with no await between. */
  async readDraftAt(draftId: string, since?: DraftReadSince): Promise<DraftRead | null> {
    return this.readNow(draftId, since);
  }

  private readNow(draftId: string, since?: DraftReadSince): DraftRead | null {
    const documentDraft = this.drafts.get(draftId);
    if (!documentDraft) return null;
    const held = since?.checkpointRevision === documentDraft.checkpointRevision;
    const after = held
      ? Math.max(since.seq, documentDraft.checkpointSeq)
      : documentDraft.checkpointSeq;
    return {
      documentDraft: rowOf(documentDraft),
      checkpoint: held ? null : documentDraft.checkpoint,
      tail: documentDraft.rows
        .filter((row) => row.id > after)
        .map(({ id, update, source }) => ({ id, update, source })),
    };
  }

  async serverDeletedBlocks(
    _draftId: string,
    _ids: readonly { client: number; clock: number }[],
  ): Promise<ReadonlySet<string>> {
    return new Set();
  }

  async appendRows(input: AppendRowsInput): Promise<AppendRowsOutcome> {
    const documentDraft = this.drafts.get(input.draftId);
    if (
      documentDraft?.status !== "active" ||
      (input.work !== "any" && documentDraft.lifecycle !== "active")
    )
      return { status: "refused" };
    const read = this.readNow(input.draftId, input.base);
    if (!read) return { status: "refused" };
    const finalized = await input.finalize(read);
    if (finalized.status !== "appended") return finalized;
    if (this.failNextJournal) {
      this.failNextJournal = false;
      throw new Error("injected journal failure");
    }
    const rowIds = finalized.rows.map((row) => this.append(documentDraft, row));
    documentDraft.revision += 1;
    return {
      status: "appended",
      revision: documentDraft.revision,
      checkpointRevision: documentDraft.checkpointRevision,
      rowIds,
    };
  }

  async writeEffect(input: {
    draftId: string;
    revision: number;
    hasEffect: boolean;
  }): Promise<"written" | "moved" | "contended"> {
    const documentDraft = this.drafts.get(input.draftId);
    if (documentDraft?.revision !== input.revision) return "moved";
    documentDraft.hasEffect = input.hasEffect;
    documentDraft.hasEffectRevision = input.revision;
    return "written";
  }

  async staleEffectDrafts(input: {
    after?: StaleEffectCursor;
    limit: number;
  }): Promise<readonly StaleEffectCursor[]> {
    const updatedAt = "1970-01-01 00:00:00+00";
    return [...this.drafts.values()]
      .filter(
        (documentDraft) =>
          documentDraft.kind === "work_draft" &&
          documentDraft.status === "active" &&
          (documentDraft.hasEffectRevision ?? -1) < documentDraft.revision &&
          (!input.after || documentDraft.draftId < input.after.draftId),
      )
      .sort((left, right) => (left.draftId < right.draftId ? 1 : -1))
      .slice(0, input.limit)
      .map((documentDraft) => ({ draftId: documentDraft.draftId, updatedAt }));
  }

  async commitRewrite(input: CommitRewriteInput): Promise<RewriteOutcome> {
    const documentDraft = this.drafts.get(input.draftId);
    if (documentDraft?.status !== "active") return { status: "closed" };
    if (this.takeCasFailure()) return { status: "moved" };
    if (
      input.policy.kind === "exact"
        ? documentDraft.revision !== input.policy.revision
        : documentDraft.checkpointRevision !== input.policy.checkpointRevision
    )
      return { status: "moved" };
    const tail = documentDraft.rows.filter((row) => row.id > documentDraft.checkpointSeq);
    // A fold applies what landed after its cursor.
    if (input.policy.kind === "fold") {
      const after = input.policy.seq;
      for (const row of tail) {
        if (row.id <= after) continue;
        Y.applyUpdate(input.doc, row.update);
      }
    }
    documentDraft.checkpoint = {
      state: Y.encodeStateAsUpdate(input.doc),
      stateVector: Y.encodeStateVector(input.doc),
    };

    documentDraft.checkpointSeq = Math.max(0, ...documentDraft.rows.map((row) => row.id));
    documentDraft.revision += 1;
    documentDraft.checkpointRevision = documentDraft.revision;
    return {
      status: "committed",
      revision: documentDraft.revision,
      checkpointRevision: documentDraft.checkpointRevision,
      seq: documentDraft.checkpointSeq,
    };
  }

  private append(documentDraft: MemoryDraft, row: AppendDraftJournalInput): number {
    const id = this.nextRowId++;
    documentDraft.rows.push({
      id,
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

function rowOf(documentDraft: MemoryDraft): DraftSnapshot {
  const {
    checkpoint: _checkpoint,
    rows: _rows,
    liveCut: _liveCut,
    hasEffectRevision: _hasEffectRevision,
    ...snapshot
  } = documentDraft;
  return snapshot;
}
