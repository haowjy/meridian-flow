/**
 * The Drizzle storage half of the draft store: the draft row and its derived Work lifecycle,
 * the one read (`readDraftAt`), and the transactional journal and checkpoint primitives every
 * draft content write commits through (`appendRowsWithinTx`, `commitRewriteWithinTx`;
 * metadata writes use `shared/draft-revisions.ts`). Runs inside the caller's transaction and
 * takes no lock but the draft rows'; Work admission, receipts and effect policy belong to the
 * callers.
 */
import type { WorkId } from "@meridian/contracts/runtime";
import {
  documentDrafts,
  documentYjsUpdates,
  draftWriteJournal,
  works,
} from "@meridian/database/schema";
import {
  COLLAB_SCHEMA_VERSION,
  type CollabSchemaVersion,
  packCollabSchemaVersion,
  unpackCollabSchemaVersion,
} from "@meridian/prosemirror-schema";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import * as Y from "yjs";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { draftBranchWork } from "../../../shared/work-branch-lifecycle.js";
import { assertFreshAgentUpdate } from "../domain/document-mutation-policy.js";
import type {
  AppendDraftJournalInput,
  AppendRowsInput,
  AppendRowsOutcome,
  DraftRead,
  DraftReadSince,
  DraftSnapshot,
  DraftTailRow,
  DraftWorkLifecycle,
  RewriteOutcome,
  RewritePolicy,
} from "../domain/draft-store.js";

/**
 * A commit that must not stand: thrown inside the write's transaction (or an append's
 * savepoint) to roll it back, carrying the outcome the caller maps once it has unwound.
 */
export class DraftWriteRollback extends Error {
  constructor(
    readonly outcome: RewriteOutcome | Exclude<AppendRowsOutcome, { status: "appended" }> = {
      status: "moved",
    },
  ) {
    super(`Draft write rolled back: ${outcome.status}`);
  }
}

export function monotonicSchemaStamp(version = COLLAB_SCHEMA_VERSION) {
  const packedVersion = packCollabSchemaVersion(version);
  const packedRunningVersion = packCollabSchemaVersion(COLLAB_SCHEMA_VERSION);
  return sql<number>`greatest(
    ${documentDrafts.schemaVersion},
    ${packedVersion},
    ${packedRunningVersion}
  )`;
}

function draftBaseForDraft(draftId: string) {
  return sql<number>`coalesce((
    select max(${documentYjsUpdates.id})
    from ${documentYjsUpdates}
    where ${documentYjsUpdates.documentId} = (
      select ${documentDrafts.documentId}
      from ${documentDrafts}
      where ${documentDrafts.id} = ${draftId}
    )
  ), 0)`;
}

export async function insertJournalRows(
  db: DrizzleDb,
  rows: readonly AppendDraftJournalInput[],
): Promise<number[]> {
  if (!rows.length) return [];
  const inserted = await db
    .insert(draftWriteJournal)
    .values(
      rows.map((journal) => ({
        draftId: journal.draftId,
        generation: journal.generation,
        updateData: Buffer.from(journal.updateData),
        draftBaseUpdateSeq: draftBaseForDraft(journal.draftId),
        source: journal.source,
        wId: journal.wId ?? null,
        toolCallId: journal.toolCallId ?? null,
        threadId: journal.threadId ?? null,
        turnId: journal.turnId ?? null,
        actorUserId: journal.actorUserId ?? null,
        updateMeta: journal.updateMeta ?? null,
      })),
    )
    .returning({ id: draftWriteJournal.id });
  return inserted.map((row) => row.id);
}

type DraftSelectRow = Awaited<ReturnType<ReturnType<typeof selectDraft>["limit"]>>[number];

const draftColumns = {
  draftId: documentDrafts.id,
  documentId: documentDrafts.documentId,
  kind: documentDrafts.kind,
  upstreamDraftId: documentDrafts.upstreamDraftId,
  branchId: documentDrafts.branchId,
  workId: draftBranchWork.workId,
  threadId: documentDrafts.threadId,
  status: documentDrafts.status,
  closedCause: documentDrafts.closedCause,
  generation: documentDrafts.generation,
  revision: documentDrafts.revision,
  checkpointRevision: documentDrafts.checkpointRevision,
  checkpointSeq: documentDrafts.checkpointSeq,
  lifecycle: sql<DraftWorkLifecycle>`case
    when ${works.id} is null then 'missing'
    when ${works.deletedAt} is not null then 'deleted'
    when ${works.archivedAt} is not null then 'archived'
    else 'active' end`,
  hasEffect: documentDrafts.hasEffect,
  blocking: documentDrafts.blocking,
  discardedStateVector: documentDrafts.discardedStateVector,
  schemaVersion: documentDrafts.schemaVersion,
};

/**
 * A draft row with its Work and that Work's lifecycle derived through its branch (contract
 * §2.4), never stored on the draft; no content.
 */
export function selectDraft(db: DrizzleDb) {
  return db
    .select(draftColumns)
    .from(documentDrafts)
    .innerJoin(draftBranchWork.branches, draftBranchWork.on)
    .leftJoin(works, eq(works.id, draftBranchWork.workId));
}

/**
 * The draft's branch has an origin Work that is neither archived nor deleted, evaluated inside
 * the write's own statement so the lifecycle decision and the write are one observation.
 */
const draftWorkActive = sql`exists (
  select 1 from branches d join works w on w.id = d.origin_work_id
  where d.id = ${documentDrafts.branchId} and w.archived_at is null and w.deleted_at is null
)`;

export function mapDraft(row: DraftSelectRow): DraftSnapshot {
  return {
    draftId: row.draftId,
    documentId: row.documentId,
    kind: row.kind,
    upstreamDraftId: row.upstreamDraftId,
    branchId: row.branchId,
    workId: (row.workId as WorkId | null) ?? null,
    threadId: row.threadId,
    status: row.status,
    closedCause: row.closedCause,
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
 * The read seam: the draft row, its checkpoint and its tail (`id > checkpoint_seq` of the
 * current generation) from one statement, so one snapshot. With `since` naming the checkpoint
 * the caller still holds, the checkpoint bytes are left out and the tail starts after its seq.
 * Nothing else reads `document_drafts.state`.
 */
export async function readDraftAt(
  db: DrizzleDb,
  draftId: string,
  since?: DraftReadSince,
): Promise<DraftRead | null> {
  const sinceRevision = since?.checkpointRevision ?? -1;
  const sinceSeq = since?.seq ?? 0;
  const held = sql`${documentDrafts.checkpointRevision} = ${sinceRevision}`;
  const [row] = await db
    .select({
      ...draftColumns,
      state: sql<Buffer | null>`case when ${held} then null else ${documentDrafts.state} end`,
      stateVector: sql<Buffer | null>`case when ${held} then null else ${documentDrafts.stateVector} end`,
      tail: sql<{ id: number; update: string; source: "agent" | "writer" | "server" }[]>`(
        select coalesce(json_agg(json_build_object(
          'id', j.id, 'update', encode(j.update_data, 'base64'), 'source', j.source
        ) order by j.id), '[]'::json)
        from ${draftWriteJournal} j
        where j.draft_id = ${documentDrafts.id}
          and j.generation = ${documentDrafts.generation}
          and j.id > case when ${held}
            then greatest(${sinceSeq}::bigint, ${documentDrafts.checkpointSeq})
            else ${documentDrafts.checkpointSeq} end
      )`,
    })
    .from(documentDrafts)
    .innerJoin(draftBranchWork.branches, draftBranchWork.on)
    .leftJoin(works, eq(works.id, draftBranchWork.workId))
    .where(eq(documentDrafts.id, draftId))
    .limit(1);
  if (!row) return null;
  const tail: DraftTailRow[] = (row.tail ?? []).map((entry) => ({
    id: Number(entry.id),
    update: new Uint8Array(Buffer.from(entry.update, "base64")),
    source: entry.source,
  }));
  return {
    documentDraft: mapDraft(row),
    checkpoint:
      row.state?.length && row.stateVector?.length
        ? { state: new Uint8Array(row.state), stateVector: new Uint8Array(row.stateVector) }
        : null,
    tail,
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
 * the row lock to `COMMIT`, so journal ids are allocated in commit order per draft (tail
 * order). It still refuses a closed, re-forked or frozen draft. After the lock, one separate
 * statement reads the committed prefix `since` the caller's base (a fresh READ COMMITTED
 * snapshot, so every row committed before this lock), and `finalize` decides what to insert.
 * Any outcome but `appended` throws `DraftWriteRollback` so the savepoint undoes the bump.
 */
export async function appendRowsWithinTx(
  db: DrizzleDb,
  input: Pick<AppendRowsInput, "draftId" | "expectedGeneration" | "base" | "finalize" | "work">,
): Promise<AppendCommitted> {
  const [locked] = await db
    .update(documentDrafts)
    .set({
      revision: sql`${documentDrafts.revision} + 1`,
      schemaVersion: monotonicSchemaStamp(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(documentDrafts.id, input.draftId),
        eq(documentDrafts.status, "active"),
        eq(documentDrafts.generation, input.expectedGeneration),
        input.work === "any" ? undefined : draftWorkActive,
      ),
    )
    .returning({
      revision: documentDrafts.revision,
      checkpointRevision: documentDrafts.checkpointRevision,
    });
  // Zero rows: the draft closed, re-forked or its Work is no longer active. Never a writer.
  if (!locked) throw new DraftWriteRollback({ status: "refused" });
  const lockedAt = performance.now();
  // Must stay its own statement: a CTE would share the UPDATE's snapshot and miss rows
  // committed while it waited for the lock.
  const read = await readDraftAt(db, input.draftId, input.base);
  if (!read) throw new Error(`Draft ${input.draftId} vanished under its row lock`);
  const finalized = await input.finalize(read);
  if (finalized.status !== "appended") throw new DraftWriteRollback(finalized);
  if (
    finalized.rows.some(
      (row) => row.generation !== input.expectedGeneration || row.draftId !== input.draftId,
    )
  )
    throw new Error(`Draft ${input.draftId} append names another draft or generation`);
  return {
    revision: Number(locked.revision),
    checkpointRevision: Number(locked.checkpointRevision),
    rowIds: await insertJournalRows(db, finalized.rows),
    lockedAt,
  };
}

export type RewriteCommit = {
  draftId: string;
  policy: RewritePolicy;
  /**
   * `active`: the checkpoint `UPDATE` carries the draft's Work-is-active predicate (a content
   * write the Work admits); zero rows is `moved`. `any`: a pull or compaction, which no
   * Work lifecycle gates: an archived Work's drafts keep rebasing on live.
   */
  work: "active" | "any";
  /** A peer's captured upstream: locked `FOR SHARE` before the peer row, then checked. */
  upstream?: { draftId: string; generation: number };
  /** The new checkpoint. Under `fold`, a pull applies the tail into it. */
  doc: Y.Doc;
  schemaVersion?: CollabSchemaVersion;
  /** A content-free fold: the reader-visible modification stamp (`updated_at`) stays. */
  keepUpdatedAt?: boolean;
  /** Writes under the locked row before the checkpoint `UPDATE` (rows the checkpoint contains). */
  withinLock?: () => Promise<void>;
  /** Told when the row lock was taken (`performance.now()`) and how many tail rows it read. */
  onLocked?: (lock: { lockedAt: number; tailRows: number }) => void;
};

/**
 * Shape B, the one checkpoint door, inside the caller's transaction: lock the upstream
 * (`FOR SHARE`) then the draft row (`FOR UPDATE`), validate the policy and the fence, fold
 * the tail, write the checkpoint at `revision + 1` with `checkpoint_seq` covering every row
 * the draft now has. No compute beyond the fold runs under the lock.
 */
export async function commitRewriteWithinTx(
  db: DrizzleDb,
  input: RewriteCommit,
): Promise<RewriteOutcome> {
  if (input.upstream) {
    const [upstream] = await db
      .select({ status: documentDrafts.status, generation: documentDrafts.generation })
      .from(documentDrafts)
      .where(eq(documentDrafts.id, input.upstream.draftId))
      .for("share");
    if (upstream?.status !== "active" || upstream.generation !== input.upstream.generation)
      return { status: "upstreamMoved" };
  }
  const [locked] = await db
    .select({
      documentId: documentDrafts.documentId,
      revision: documentDrafts.revision,
      checkpointRevision: documentDrafts.checkpointRevision,
      checkpointSeq: documentDrafts.checkpointSeq,
      status: documentDrafts.status,
      generation: documentDrafts.generation,
      stateVector: documentDrafts.stateVector,
      discardedStateVector: documentDrafts.discardedStateVector,
    })
    .from(documentDrafts)
    .where(eq(documentDrafts.id, input.draftId))
    .for("update");
  const lockedAt = performance.now();
  if (locked?.status !== "active") return { status: "closed" };
  const moved =
    input.policy.kind === "exact"
      ? Number(locked.revision) !== input.policy.revision
      : Number(locked.checkpointRevision) !== input.policy.checkpointRevision;
  if (moved) return { status: "moved" };

  // Every row past the checkpoint; under `exact` these are exactly the rows the caller read.
  // Only a fold applies rows beyond the captured cursor.
  const tail =
    input.policy.kind === "exact"
      ? []
      : await db
          .select({
            id: draftWriteJournal.id,
            update: draftWriteJournal.updateData,
            source: draftWriteJournal.source,
          })
          .from(draftWriteJournal)
          .where(
            and(
              eq(draftWriteJournal.draftId, input.draftId),
              eq(draftWriteJournal.generation, locked.generation),
              gt(draftWriteJournal.id, Number(locked.checkpointSeq)),
            ),
          )
          .orderBy(asc(draftWriteJournal.id));
  input.onLocked?.({ lockedAt, tailRows: tail.length });
  if (input.policy.kind === "fold") {
    const after = input.policy.seq;
    for (const row of tail) {
      if (row.id <= after) continue;
      if (row.source === "agent") assertFreshAgentUpdate(input.doc, row.update);
      Y.applyUpdate(input.doc, row.update);
    }
  }
  const state = Buffer.from(Y.encodeStateAsUpdate(input.doc));
  const stateVector = Buffer.from(Y.encodeStateVector(input.doc));
  await input.withinLock?.();

  const [written] = await db
    .update(documentDrafts)
    .set({
      state,
      stateVector,
      checkpointSeq: sql`(select coalesce(max(${draftWriteJournal.id}), 0) from ${draftWriteJournal} where ${draftWriteJournal.draftId} = ${input.draftId})`,
      revision: sql`${documentDrafts.revision} + 1`,
      checkpointRevision: sql`${documentDrafts.revision} + 1`,
      schemaVersion: monotonicSchemaStamp(input.schemaVersion),
      ...(input.keepUpdatedAt ? {} : { updatedAt: new Date() }),
    })
    .where(
      and(
        eq(documentDrafts.id, input.draftId),
        input.work === "active" ? draftWorkActive : undefined,
      ),
    )
    .returning({
      revision: documentDrafts.revision,
      checkpointRevision: documentDrafts.checkpointRevision,
      checkpointSeq: documentDrafts.checkpointSeq,
      generation: documentDrafts.generation,
    });
  if (!written) {
    if (input.work === "active") return { status: "moved" };
    throw new Error(`Draft ${input.draftId} vanished under its row lock`);
  }
  return {
    status: "committed",
    revision: Number(written.revision),
    checkpointRevision: Number(written.checkpointRevision),
    seq: Number(written.checkpointSeq),
    generation: written.generation,
  };
}
