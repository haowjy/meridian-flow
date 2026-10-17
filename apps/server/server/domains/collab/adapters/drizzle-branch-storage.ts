/**
 * The Drizzle storage half of the branch store: the branch row and its derived Work lifecycle,
 * the one read (`readBranchAt`), and the transactional journal and checkpoint primitives every
 * branch write commits through (`appendRowsWithinTx`, `commitRewriteWithinTx`,
 * `bumpBranchRevisions`). Runs inside the caller's transaction and takes no lock but the branch
 * rows'; Work admission, receipts and effect policy belong to the callers.
 */
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import {
  branchPushSettlementBatches,
  branchPushSettlementOutbox,
  branchWriteJournal,
  documentBranches,
  documentYjsUpdates,
  works,
} from "@meridian/database/schema";
import {
  COLLAB_SCHEMA_VERSION,
  type CollabSchemaVersion,
  packCollabSchemaVersion,
  unpackCollabSchemaVersion,
} from "@meridian/prosemirror-schema";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import * as Y from "yjs";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { branchDraftWork } from "../../../shared/work-draft-lifecycle.js";
import { branchJournalRevision } from "../domain/branch-journal.js";
import {
  type AppendBranchJournalInput,
  type AppendRowsInput,
  type BranchRead,
  type BranchReadSince,
  type BranchSnapshot,
  type BranchTailRow,
  type BranchWorkLifecycle,
  mergeStateVectors,
  type PullEffect,
  type RewriteFence,
  type RewriteOutcome,
  type RewritePolicy,
} from "../domain/branch-store.js";
import { assertFreshAgentUpdate } from "../domain/document-mutation-policy.js";

/** A commit that must not stand: thrown inside the write's transaction to roll it back. */
export class BranchWriteRollback extends Error {
  constructor(readonly outcome: RewriteOutcome = { status: "moved" }) {
    super(`Branch write rolled back: ${outcome.status}`);
  }
}

export function monotonicSchemaStamp(version = COLLAB_SCHEMA_VERSION) {
  const packedVersion = packCollabSchemaVersion(version);
  const packedRunningVersion = packCollabSchemaVersion(COLLAB_SCHEMA_VERSION);
  return sql<number>`greatest(
    ${documentBranches.schemaVersion},
    ${packedVersion},
    ${packedRunningVersion}
  )`;
}

function draftBaseForBranch(branchId: string) {
  return sql<number>`coalesce((
    select max(${documentYjsUpdates.id})
    from ${documentYjsUpdates}
    where ${documentYjsUpdates.documentId} = (
      select ${documentBranches.documentId}
      from ${documentBranches}
      where ${documentBranches.id} = ${branchId}
    )
  ), 0)`;
}

export async function insertJournalRows(
  db: DrizzleDb,
  rows: readonly AppendBranchJournalInput[],
): Promise<number[]> {
  if (!rows.length) return [];
  const inserted = await db
    .insert(branchWriteJournal)
    .values(
      rows.map((journal) => ({
        branchId: journal.branchId,
        generation: journal.generation,
        updateData: Buffer.from(journal.updateData),
        draftBaseUpdateSeq: draftBaseForBranch(journal.branchId),
        source: journal.source,
        wId: journal.wId ?? null,
        toolCallId: journal.toolCallId ?? null,
        threadId: journal.threadId ?? null,
        turnId: journal.turnId ?? null,
        actorUserId: journal.actorUserId ?? null,
        updateMeta: journal.updateMeta ?? null,
      })),
    )
    .returning({ id: branchWriteJournal.id });
  return inserted.map((row) => row.id);
}

/** A staged reversal's planning fences, checked under the branch row lock. */
export async function checkJournalExpectations(
  db: DrizzleDb,
  rows: readonly AppendBranchJournalInput[],
): Promise<void> {
  for (const journal of rows) {
    if (journal.expectedJournalWatermark !== undefined) {
      const [head] = await db
        .select({ id: sql<number>`coalesce(max(${branchWriteJournal.id}), 0)::bigint` })
        .from(branchWriteJournal)
        .where(
          and(
            eq(branchWriteJournal.branchId, journal.branchId),
            eq(branchWriteJournal.generation, journal.generation),
          ),
        );
      if (Number(head?.id ?? 0) > journal.expectedJournalWatermark) {
        throw new BranchWriteRollback();
      }
    }
    if (journal.expectedJournalRevision !== undefined) {
      const rows = await db
        .select({ id: branchWriteJournal.id, status: branchWriteJournal.status })
        .from(branchWriteJournal)
        .where(
          and(
            eq(branchWriteJournal.branchId, journal.branchId),
            eq(branchWriteJournal.generation, journal.generation),
          ),
        )
        .orderBy(branchWriteJournal.id)
        .for("update");
      if (branchJournalRevision(rows) !== journal.expectedJournalRevision) {
        throw new BranchWriteRollback();
      }
    }
  }
}

type BranchSelectRow = Awaited<ReturnType<ReturnType<typeof selectBranch>["limit"]>>[number];

const branchColumns = {
  branchId: documentBranches.id,
  documentId: documentBranches.documentId,
  kind: documentBranches.kind,
  upstreamBranchId: documentBranches.upstreamBranchId,
  draftId: documentBranches.draftId,
  workId: branchDraftWork.workId,
  threadId: documentBranches.threadId,
  status: documentBranches.status,
  generation: documentBranches.generation,
  revision: documentBranches.revision,
  checkpointRevision: documentBranches.checkpointRevision,
  checkpointSeq: documentBranches.checkpointSeq,
  lifecycle: sql<BranchWorkLifecycle>`case
    when ${works.id} is null then 'missing'
    when ${works.deletedAt} is not null then 'deleted'
    when ${works.archivedAt} is not null then 'archived'
    else 'active' end`,
  hasEffect: documentBranches.hasEffect,
  blocking: documentBranches.blocking,
  discardedStateVector: documentBranches.discardedStateVector,
  schemaVersion: documentBranches.schemaVersion,
};

/**
 * A branch row with its Work and that Work's lifecycle derived through its draft (contract
 * §2.4), never stored on the branch; no content.
 */
export function selectBranch(db: DrizzleDb) {
  return db
    .select(branchColumns)
    .from(documentBranches)
    .innerJoin(branchDraftWork.drafts, branchDraftWork.on)
    .leftJoin(works, eq(works.id, branchDraftWork.workId));
}

/**
 * The branch's draft has an origin Work that is neither archived nor deleted, evaluated inside
 * the write's own statement so the lifecycle decision and the write are one observation.
 */
const branchWorkActive = sql`exists (
  select 1 from drafts d join works w on w.id = d.origin_work_id
  where d.id = ${documentBranches.draftId} and w.archived_at is null and w.deleted_at is null
)`;

export function mapBranch(row: BranchSelectRow): BranchSnapshot {
  return {
    branchId: row.branchId,
    documentId: row.documentId,
    kind: row.kind,
    upstreamBranchId: row.upstreamBranchId,
    draftId: row.draftId,
    workId: (row.workId as WorkId | null) ?? null,
    threadId: row.threadId,
    status: row.status,
    generation: row.generation,
    revision: Number(row.revision),
    checkpointRevision: Number(row.checkpointRevision),
    checkpointSeq: Number(row.checkpointSeq),
    lifecycle: row.lifecycle,
    hasEffect: row.hasEffect,
    blocking: row.blocking,
    discardedStateVector: row.discardedStateVector,
    schemaVersion: unpackCollabSchemaVersion(row.schemaVersion),
  };
}

/**
 * The read seam: the branch row, its checkpoint and its tail (`id > checkpoint_seq` of the
 * current generation) from one statement, so one snapshot. With `since` naming the checkpoint
 * the caller still holds, the checkpoint bytes are left out and the tail starts after its seq.
 * Nothing else reads `document_branches.state`.
 */
export async function readBranchAt(
  db: DrizzleDb,
  branchId: string,
  since?: BranchReadSince,
): Promise<BranchRead | null> {
  const sinceRevision = since?.checkpointRevision ?? -1;
  const sinceSeq = since?.seq ?? 0;
  const held = sql`${documentBranches.checkpointRevision} = ${sinceRevision}`;
  const [row] = await db
    .select({
      ...branchColumns,
      state: sql<Buffer | null>`case when ${held} then null else ${documentBranches.state} end`,
      stateVector: sql<Buffer | null>`case when ${held} then null else ${documentBranches.stateVector} end`,
      tail: sql<{ id: number; update: string; source: "agent" | "writer" }[]>`(
        select coalesce(json_agg(json_build_object(
          'id', j.id, 'update', encode(j.update_data, 'base64'), 'source', j.source
        ) order by j.id), '[]'::json)
        from ${branchWriteJournal} j
        where j.branch_id = ${documentBranches.id}
          and j.generation = ${documentBranches.generation}
          and j.id > case when ${held}
            then greatest(${sinceSeq}::bigint, ${documentBranches.checkpointSeq})
            else ${documentBranches.checkpointSeq} end
      )`,
      pendingRows: sql<boolean>`exists (
        select 1 from ${branchWriteJournal} p
        where p.branch_id = ${documentBranches.id}
          and p.generation = ${documentBranches.generation}
          and p.status in ('active', 'rollback_pending')
      )`,
      liveCutStored: sql<boolean>`${documentBranches.liveCut} is not null`,
    })
    .from(documentBranches)
    .innerJoin(branchDraftWork.drafts, branchDraftWork.on)
    .leftJoin(works, eq(works.id, branchDraftWork.workId))
    .where(eq(documentBranches.id, branchId))
    .limit(1);
  if (!row) return null;
  const tail: BranchTailRow[] = (row.tail ?? []).map((entry) => ({
    id: Number(entry.id),
    update: new Uint8Array(Buffer.from(entry.update, "base64")),
    source: entry.source,
  }));
  return {
    branch: mapBranch(row),
    checkpoint:
      row.state && row.stateVector
        ? { state: new Uint8Array(row.state), stateVector: new Uint8Array(row.stateVector) }
        : null,
    tail,
    pendingRows: row.pendingRows,
    liveCutStored: row.liveCutStored,
  };
}

/**
 * A work draft's effect baseline: its stored `live_cut`, or when none is stored the live
 * journal's current state (main's fallback for a branch no pull or reset has cut yet).
 */
export async function readEffectBaselineWithin(
  db: DrizzleDb,
  branchId: string,
  readLive: (documentId: DocumentId) => Promise<Uint8Array>,
): Promise<{ state: Uint8Array; stored: boolean; checkpointRevision: number } | null> {
  const [row] = await db
    .select({
      kind: documentBranches.kind,
      documentId: documentBranches.documentId,
      liveCut: documentBranches.liveCut,
      checkpointRevision: documentBranches.checkpointRevision,
    })
    .from(documentBranches)
    .where(eq(documentBranches.id, branchId))
    .limit(1);
  if (row?.kind !== "work_draft") return null;
  const checkpointRevision = Number(row.checkpointRevision);
  if (row.liveCut) return { state: new Uint8Array(row.liveCut), stored: true, checkpointRevision };
  return { state: await readLive(row.documentId), stored: false, checkpointRevision };
}

/**
 * Shape A's storage half: rows past the checkpoint at `revision = expectedRevision`. One
 * `UPDATE` decides and locks (the branch is active, at the expected generation and revision,
 * and its Work is active); ids are allocated after it. A miss, or a staged reversal whose
 * planning fence moved, throws `BranchWriteRollback` for the caller's transaction.
 */
export async function appendRowsWithinTx(
  db: DrizzleDb,
  input: Pick<
    AppendRowsInput,
    "branchId" | "expectedRevision" | "expectedGeneration" | "rows" | "hasEffect" | "liveCut"
  >,
): Promise<{ revision: number; rowIds: number[] }> {
  if (
    input.rows.some(
      (row) => row.generation !== input.expectedGeneration || row.branchId !== input.branchId,
    )
  )
    throw new BranchWriteRollback();
  const [locked] = await db
    .update(documentBranches)
    .set({
      revision: sql`${documentBranches.revision} + 1`,
      schemaVersion: monotonicSchemaStamp(),
      updatedAt: new Date(),
      ...(input.hasEffect === undefined ? {} : { hasEffect: input.hasEffect }),
      // The baseline the effect was judged against, kept when the branch had none stored.
      ...(input.liveCut
        ? { liveCut: sql`coalesce(${documentBranches.liveCut}, ${Buffer.from(input.liveCut)})` }
        : {}),
    })
    .where(
      and(
        eq(documentBranches.id, input.branchId),
        eq(documentBranches.status, "active"),
        eq(documentBranches.generation, input.expectedGeneration),
        eq(documentBranches.revision, input.expectedRevision),
        branchWorkActive,
      ),
    )
    .returning({ revision: documentBranches.revision });
  // Zero rows: the revision or generation moved, the branch closed, or its Work is no longer
  // active. The caller re-reads and classifies.
  if (!locked) throw new BranchWriteRollback();
  await checkJournalExpectations(db, input.rows);
  return { revision: Number(locked.revision), rowIds: await insertJournalRows(db, input.rows) };
}

export type RewriteCommit = {
  branchId: string;
  policy: RewritePolicy;
  fence: RewriteFence;
  /**
   * `active`: the checkpoint `UPDATE` carries the branch's Work-is-active predicate (a content
   * write the Work admits); zero rows is `moved`. `any`: a pull, reset or compaction, which no
   * Work lifecycle gates.
   */
  work: "active" | "any";
  /** A peer's captured upstream: locked `FOR SHARE` before the peer row, then checked. */
  upstream?: { branchId: string; generation: number };
  /** The new checkpoint. Under `fold`, a pull applies the tail into it. */
  doc: Y.Doc;
  /**
   * A re-fork to the next generation; the discarded vector gains the checkpoint's clocks and
   * every tail row's insertion clocks. `discard` also discards the generation's pending rows;
   * `refork` leaves them to the caller. Their edit parts are the caller's either way.
   */
  reset?: { kind: "discard" } | { kind: "refork" };
  schemaVersion?: CollabSchemaVersion;
  /** A content-free fold: the reader-visible modification stamp (`updated_at`) stays. */
  keepUpdatedAt?: boolean;
  /** The effect the caller computed on `doc` before locking, with the baseline it used. */
  effect?: PullEffect;
  /** Writes under the locked row before the checkpoint `UPDATE` (rows the checkpoint contains). */
  withinLock?: () => Promise<void>;
  /** Told when the row lock was taken (`performance.now()`) and how many tail rows it read. */
  onLocked?: (lock: { lockedAt: number; tailRows: number }) => void;
};

/**
 * Shape B, the one checkpoint door, inside the caller's transaction: lock the upstream
 * (`FOR SHARE`) then the branch row (`FOR UPDATE`), validate the policy and the fence, fold
 * the tail, write the checkpoint at `revision + 1` with `checkpoint_seq` covering every row
 * the branch now has. No compute beyond the fold runs under the lock.
 */
export async function commitRewriteWithinTx(
  db: DrizzleDb,
  input: RewriteCommit,
): Promise<RewriteOutcome> {
  if (input.upstream) {
    const [upstream] = await db
      .select({ status: documentBranches.status, generation: documentBranches.generation })
      .from(documentBranches)
      .where(eq(documentBranches.id, input.upstream.branchId))
      .for("share");
    if (upstream?.status !== "active" || upstream.generation !== input.upstream.generation)
      return { status: "upstreamMoved" };
  }
  const [locked] = await db
    .select({
      documentId: documentBranches.documentId,
      revision: documentBranches.revision,
      checkpointRevision: documentBranches.checkpointRevision,
      checkpointSeq: documentBranches.checkpointSeq,
      status: documentBranches.status,
      generation: documentBranches.generation,
      stateVector: documentBranches.stateVector,
      discardedStateVector: documentBranches.discardedStateVector,
    })
    .from(documentBranches)
    .where(eq(documentBranches.id, input.branchId))
    .for("update");
  const lockedAt = performance.now();
  if (locked?.status !== "active") return { status: "closed" };
  const moved =
    input.policy.kind === "exact"
      ? Number(locked.revision) !== input.policy.revision
      : Number(locked.checkpointRevision) !== input.policy.checkpointRevision;
  if (moved) return { status: "moved" };
  if (await fenced(db, input.fence, locked.documentId)) return { status: "fenced" };

  // Every row past the checkpoint; under `exact` these are exactly the rows the caller read.
  // Only a fold applies them and only a reset fences their clocks.
  const tail =
    !input.reset && input.policy.kind === "exact"
      ? []
      : await db
          .select({
            id: branchWriteJournal.id,
            update: branchWriteJournal.updateData,
            source: branchWriteJournal.source,
          })
          .from(branchWriteJournal)
          .where(
            and(
              eq(branchWriteJournal.branchId, input.branchId),
              eq(branchWriteJournal.generation, locked.generation),
              gt(branchWriteJournal.id, Number(locked.checkpointSeq)),
            ),
          )
          .orderBy(asc(branchWriteJournal.id));
  input.onLocked?.({ lockedAt, tailRows: tail.length });
  let folded = 0;
  if (input.policy.kind === "fold" && !input.reset) {
    const after = input.policy.seq;
    for (const row of tail) {
      if (row.id <= after) continue;
      if (row.source === "agent") assertFreshAgentUpdate(input.doc, row.update);
      Y.applyUpdate(input.doc, row.update);
      folded += 1;
    }
  }
  const effect = input.effect && {
    hasEffect:
      folded && input.effect.refolded ? input.effect.refolded(input.doc) : input.effect.hasEffect,
    liveCut: input.effect.liveCut,
  };
  const state = Buffer.from(Y.encodeStateAsUpdate(input.doc));
  const stateVector = Buffer.from(Y.encodeStateVector(input.doc));
  await input.withinLock?.();

  const reset = input.reset
    ? {
        generation: sql`${documentBranches.generation} + 1`,
        hasEffect: false,
        blocking: false,
        liveCut: state,
        discardedStateVector: Buffer.from(
          tail.reduce(
            (vector, row) => {
              const to = Y.parseUpdateMeta(row.update).to;
              return to.size ? mergeStateVectors(vector, Y.encodeStateVector(to)) : vector;
            },
            mergeStateVectors(locked.discardedStateVector, locked.stateVector),
          ),
        ),
      }
    : {};
  const [written] = await db
    .update(documentBranches)
    .set({
      state,
      stateVector,
      checkpointSeq: sql`(select coalesce(max(${branchWriteJournal.id}), 0) from ${branchWriteJournal} where ${branchWriteJournal.branchId} = ${input.branchId})`,
      revision: sql`${documentBranches.revision} + 1`,
      checkpointRevision: sql`${documentBranches.revision} + 1`,
      schemaVersion: monotonicSchemaStamp(input.schemaVersion),
      ...(input.keepUpdatedAt ? {} : { updatedAt: new Date() }),
      ...(effect ? { hasEffect: effect.hasEffect, liveCut: Buffer.from(effect.liveCut) } : {}),
      ...reset,
    })
    .where(
      and(
        eq(documentBranches.id, input.branchId),
        input.work === "active" ? branchWorkActive : undefined,
      ),
    )
    .returning({
      revision: documentBranches.revision,
      checkpointRevision: documentBranches.checkpointRevision,
      checkpointSeq: documentBranches.checkpointSeq,
      generation: documentBranches.generation,
    });
  if (!written) {
    if (input.work === "active") return { status: "moved" };
    throw new Error(`Branch ${input.branchId} vanished under its row lock`);
  }
  if (input.reset?.kind === "discard") {
    await db
      .update(branchWriteJournal)
      .set({ status: "discarded" })
      .where(
        and(
          eq(branchWriteJournal.branchId, input.branchId),
          eq(branchWriteJournal.generation, locked.generation),
          inArray(branchWriteJournal.status, ["active", "rollback_pending"]),
        ),
      );
  }
  return {
    status: "committed",
    revision: Number(written.revision),
    checkpointRevision: Number(written.checkpointRevision),
    seq: Number(written.checkpointSeq),
    generation: written.generation,
  };
}

async function fenced(db: DrizzleDb, fence: RewriteFence, documentId: string): Promise<boolean> {
  if (fence.kind !== "pending-settlement") return false;
  const [pending] = await db
    .select({ id: branchPushSettlementOutbox.pushId })
    .from(branchPushSettlementOutbox)
    .innerJoin(
      branchPushSettlementBatches,
      eq(branchPushSettlementBatches.id, branchPushSettlementOutbox.batchId),
    )
    .where(
      and(
        eq(branchPushSettlementOutbox.documentId, documentId as DocumentId),
        inArray(branchPushSettlementBatches.state, ["pending", "blocked"]),
      ),
    )
    .limit(1);
  return Boolean(pending);
}

/**
 * A change to a review-membership input (`blocking`, a journal row's status, `has_effect`)
 * outside a content write: the branch rows are locked in id order and their `revision` bumped
 * before the input changes, so a write judged at the old revision cannot commit over it.
 */
export async function bumpBranchRevisions(
  db: DrizzleDb,
  branchIds: readonly string[],
  set: { blocking?: boolean } = {},
): Promise<string[]> {
  const ids = [...new Set(branchIds)].sort();
  if (!ids.length) return [];
  const changed =
    set.blocking === undefined
      ? undefined
      : sql`${documentBranches.blocking} IS DISTINCT FROM ${set.blocking}`;
  const locked = await db
    .select({ id: documentBranches.id })
    .from(documentBranches)
    .where(and(inArray(documentBranches.id, ids), changed))
    .orderBy(asc(documentBranches.id))
    .for("update");
  if (!locked.length) return [];
  const lockedIds = locked.map((row) => row.id);
  await db
    .update(documentBranches)
    .set({ ...set, revision: sql`${documentBranches.revision} + 1` })
    .where(inArray(documentBranches.id, lockedIds));
  return lockedIds;
}
