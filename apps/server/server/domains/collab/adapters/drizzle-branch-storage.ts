/**
 * The Drizzle storage half of the branch store: the branch row and its derived Work lifecycle,
 * the one read (`readBranchAt`), and the transactional journal and checkpoint primitives every
 * branch content write commits through (`appendRowsWithinTx`, `commitRewriteWithinTx`;
 * metadata writes use `shared/branch-revisions.ts`). Runs inside the caller's transaction and
 * takes no lock but the branch rows'; Work admission, receipts and effect policy belong to the
 * callers.
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
import {
  type AppendBranchJournalInput,
  type AppendRowsInput,
  type AppendRowsOutcome,
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

/**
 * A commit that must not stand: thrown inside the write's transaction (or an append's
 * savepoint) to roll it back, carrying the outcome the caller maps once it has unwound.
 */
export class BranchWriteRollback extends Error {
  constructor(
    readonly outcome: RewriteOutcome | Exclude<AppendRowsOutcome, { status: "appended" }> = {
      status: "moved",
    },
  ) {
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
  };
}

/**
 * A work draft's effect baseline: its stored `live_cut`, null for a legacy row no creator,
 * pull or reset has cut yet (the projection job establishes it with a pull).
 */
export async function readEffectBaselineWithin(
  db: DrizzleDb,
  branchId: string,
): Promise<{ state: Uint8Array | null; checkpointRevision: number } | null> {
  const [row] = await db
    .select({
      kind: documentBranches.kind,
      liveCut: documentBranches.liveCut,
      checkpointRevision: documentBranches.checkpointRevision,
    })
    .from(documentBranches)
    .where(eq(documentBranches.id, branchId))
    .limit(1);
  if (row?.kind !== "work_draft") return null;
  return {
    state: row.liveCut ? new Uint8Array(row.liveCut) : null,
    checkpointRevision: Number(row.checkpointRevision),
  };
}

/** What an append's sequence point committed, with the lock's wait and hold. */
export type AppendCommitted = {
  revision: number;
  checkpointRevision: number;
  rowIds: number[];
  /** `performance.now()` when the row lock was acquired (the `UPDATE` returned). */
  lockedAt: number;
};

/**
 * Shape A's storage half, inside the caller's savepoint. The `UPDATE` is the sequence point:
 * it bumps `revision` at whatever value it holds (no revision predicate, no retry) and holds
 * the row lock to `COMMIT`, so journal ids are allocated in commit order per branch (tail
 * order). It still refuses a closed, re-forked or frozen branch. After the lock, one separate
 * statement reads the committed prefix `since` the caller's base (a fresh READ COMMITTED
 * snapshot, so every row committed before this lock), and `finalize` decides what to insert.
 * Any outcome but `appended` throws `BranchWriteRollback` so the savepoint undoes the bump.
 */
export async function appendRowsWithinTx(
  db: DrizzleDb,
  input: Pick<AppendRowsInput, "branchId" | "expectedGeneration" | "base" | "finalize">,
): Promise<AppendCommitted> {
  const [locked] = await db
    .update(documentBranches)
    .set({
      revision: sql`${documentBranches.revision} + 1`,
      schemaVersion: monotonicSchemaStamp(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(documentBranches.id, input.branchId),
        eq(documentBranches.status, "active"),
        eq(documentBranches.generation, input.expectedGeneration),
        branchWorkActive,
      ),
    )
    .returning({
      revision: documentBranches.revision,
      checkpointRevision: documentBranches.checkpointRevision,
    });
  // Zero rows: the branch closed, re-forked or its Work is no longer active. Never a writer.
  if (!locked) throw new BranchWriteRollback({ status: "refused" });
  const lockedAt = performance.now();
  // Must stay its own statement: a CTE would share the UPDATE's snapshot and miss rows
  // committed while it waited for the lock.
  const read = await readBranchAt(db, input.branchId, input.base);
  if (!read) throw new Error(`Branch ${input.branchId} vanished under its row lock`);
  const finalized = await input.finalize(read);
  if (finalized.status !== "appended") throw new BranchWriteRollback(finalized);
  if (
    finalized.rows.some(
      (row) => row.generation !== input.expectedGeneration || row.branchId !== input.branchId,
    )
  )
    throw new Error(`Branch ${input.branchId} append names another branch or generation`);
  return {
    revision: Number(locked.revision),
    checkpointRevision: Number(locked.checkpointRevision),
    rowIds: await insertJournalRows(db, finalized.rows),
    lockedAt,
  };
}

export type RewriteCommit = {
  branchId: string;
  policy: RewritePolicy;
  fence: RewriteFence;
  /**
   * `active`: the checkpoint `UPDATE` carries the branch's Work-is-active predicate (a content
   * write the Work admits); zero rows is `moved`. `any`: a pull, reset or compaction, which no
   * Work lifecycle gates: an archived Work's drafts keep rebasing on live.
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
  const settlement = await fencingSettlement(db, input.fence, locked.documentId);
  if (settlement) return { status: settlement === "pending" ? "fenced" : "blocked" };

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
        hasEffectRevision: sql`${documentBranches.revision} + 1`,
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
      ...(effect
        ? {
            hasEffect: effect.hasEffect,
            hasEffectRevision: sql`${documentBranches.revision} + 1`,
            liveCut: Buffer.from(effect.liveCut),
          }
        : {}),
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

/**
 * The settlement state fencing a pull on `documentId`: `pending` while one can still complete,
 * `blocked` when the only fence is a terminally blocked batch (nothing will lift it on its own).
 */
async function fencingSettlement(
  db: DrizzleDb,
  fence: RewriteFence,
  documentId: string,
): Promise<"pending" | "blocked" | null> {
  if (fence.kind !== "pending-settlement") return null;
  const states = await db
    .selectDistinct({ state: branchPushSettlementBatches.state })
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
    );
  if (states.some(({ state }) => state === "pending")) return "pending";
  return states.length ? "blocked" : null;
}
