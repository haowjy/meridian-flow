import type {
  DocumentAuthorityId,
  DocumentId,
  ModelResponseId,
  ThreadId,
  TurnId,
  UserId,
  WorkId,
} from "@meridian/contracts";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { byteaColumn, createdAt, updatedAt } from "./_shared";
import { modelResponses, threads, turns } from "./agent-threads";
import { documents, works } from "./content";
import { users } from "./users";

type ReversalStatus = "active" | "reversed" | "redone" | "reconciled" | "expired";
type MutationStatus = "active" | "reversed";
type MutationReversedBy = "user" | "agent";
type ReversalOpDirection = "undo" | "redo";
type DocumentBranchKind = "work_draft" | "thread_peer";
type DocumentBranchPushPolicy = "manual" | "auto";
type DocumentBranchStatus = "active" | "closed";
type BranchWriteJournalSource = "agent" | "writer";
type BranchWriteJournalStatus = "active" | "pushed" | "discarded" | "rollback_pending";
type PushKind = "whole" | "selective";
type BranchPushSettlementState = "pending" | "blocked" | "completed";
type BranchPushSettlementClaimKind = "warm" | "recovery";
type BranchPushSettlementUpdateSource = "journal" | "staged_push" | "initial_reconcile";
type ChangeTrailOwnerKind = "turn" | "shared";
type ChangeTrailState = "building" | "settling" | "settled";
type ChangeTrailEventKind = "updated" | "settled";
type TurnTrailWorkState = "pending" | "running" | "complete" | "no_op" | "exhausted";

export const documentBranches = pgTable(
  "document_branches",
  {
    id: text("id").primaryKey(),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    kind: text("kind").$type<DocumentBranchKind>().notNull(),
    upstreamBranchId: text("upstream_branch_id").references(
      (): AnyPgColumn => documentBranches.id,
      {
        onDelete: "set null",
      },
    ),
    workId: uuid("work_id")
      .$type<WorkId>()
      .references(() => works.id, { onDelete: "restrict" }),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .references(() => threads.id, { onDelete: "cascade" }),
    pushPolicy: text("push_policy").$type<DocumentBranchPushPolicy>().notNull().default("manual"),
    status: text("status").$type<DocumentBranchStatus>().notNull().default("active"),
    state: byteaColumn("state").notNull(),
    stateVector: byteaColumn("state_vector").notNull(),
    discardedStateVector: byteaColumn("discarded_state_vector"),
    schemaVersion: integer("schema_version").notNull(),
    generation: integer("generation").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("document_branches_active_work_draft")
      .on(table.documentId, table.workId)
      .where(sql`${table.kind} = 'work_draft' AND ${table.status} = 'active'`),
    uniqueIndex("document_branches_active_thread_peer")
      .on(table.documentId, table.threadId)
      .where(sql`${table.kind} = 'thread_peer' AND ${table.status} = 'active'`),
    check("document_branches_kind_valid", sql`${table.kind} IN ('work_draft', 'thread_peer')`),
    check("document_branches_push_policy_valid", sql`${table.pushPolicy} IN ('manual', 'auto')`),
    check("document_branches_status_valid", sql`${table.status} IN ('active', 'closed')`),
    check(
      "document_branches_owner_shape",
      sql`(${table.kind} = 'work_draft' AND ${table.workId} IS NOT NULL AND ${table.threadId} IS NULL) OR (${table.kind} = 'thread_peer' AND ${table.threadId} IS NOT NULL)`,
    ),
  ],
);

export const branchWriteJournal = pgTable(
  "branch_write_journal",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    branchId: text("branch_id")
      .notNull()
      .references(() => documentBranches.id, { onDelete: "cascade" }),
    generation: integer("generation").notNull(),
    wId: integer("w_id"),
    source: text("source").$type<BranchWriteJournalSource>().notNull().default("agent"),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .references(() => threads.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id")
      .$type<TurnId>()
      .references(() => turns.id, { onDelete: "set null" }),
    actorUserId: uuid("actor_user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    updateData: byteaColumn("update_data").notNull(),
    /** Immutable live-journal head captured when this draft mutation row is created. */
    draftBaseUpdateSeq: bigint("draft_base_update_seq", { mode: "number" }).notNull(),
    updateMeta: jsonb("update_meta"),
    status: text("status").$type<BranchWriteJournalStatus>().notNull().default("active"),
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index("branch_write_journal_branch").on(table.branchId, table.generation, table.id),
    index("branch_write_journal_thread_turn").on(table.branchId, table.threadId, table.turnId),
    index("branch_write_journal_active")
      .on(table.branchId, table.generation, table.status)
      .where(sql`${table.status} = 'active'`),
    check("branch_write_journal_source_valid", sql`${table.source} IN ('agent', 'writer')`),
    check(
      "branch_write_journal_status_valid",
      sql`${table.status} IN ('active', 'pushed', 'discarded', 'rollback_pending')`,
    ),
  ],
);

export const pushLineage = pgTable(
  "push_lineage",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    branchId: text("branch_id").references(() => documentBranches.id, { onDelete: "set null" }),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    pushKind: text("push_kind").$type<PushKind>().notNull(),
    journalIds: bigint("journal_ids", { mode: "number" }).array().notNull(),
    upstreamUpdateSeq: bigint("upstream_update_seq", { mode: "number" }),
    receiptPayload: jsonb("receipt_payload"),
    pushedByUserId: uuid("pushed_by_user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .references(() => threads.id, { onDelete: "set null" }),
    turnId: uuid("turn_id")
      .$type<TurnId>()
      .references(() => turns.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key").notNull(),
    receiptId: uuid("receipt_id").notNull().default(sql`gen_random_uuid()`),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("push_lineage_idempotency").on(table.idempotencyKey),
    index("push_lineage_document").on(table.documentId),
    index("push_lineage_branch").on(table.branchId),
    index("push_lineage_turn").on(table.threadId, table.turnId),
    index("push_lineage_receipt").on(table.receiptId),
  ],
);

/** Durable authority for classifying and completing one staged branch push. */
export const branchPushSettlementOutbox = pgTable(
  "branch_push_settlement_outbox",
  {
    pushId: bigint("push_id", { mode: "number" })
      .primaryKey()
      .references(() => pushLineage.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    state: text("state").$type<BranchPushSettlementState>().notNull().default("pending"),
    documentTitle: text("document_title").notNull(),
    lockCutUpdate: byteaColumn("lock_cut_update").notNull(),
    pushUpdate: byteaColumn("push_update").notNull(),
    lineageEvidence: jsonb("lineage_evidence").$type<unknown>().notNull(),
    trailSeed: jsonb("trail_seed").$type<unknown>().notNull(),
    beforeContentRef: bigint("before_content_ref", { mode: "number" }),
    joinVersion: bigint("join_version", { mode: "number" }).notNull().default(0),
    classifiedJoinVersion: bigint("classified_join_version", { mode: "number" })
      .notNull()
      .default(0),
    settledJoinVersion: bigint("settled_join_version", { mode: "number" }),
    claimToken: uuid("claim_token"),
    claimEpoch: bigint("claim_epoch", { mode: "number" }).notNull().default(1),
    claimKind: text("claim_kind").$type<BranchPushSettlementClaimKind>(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    lastError: text("last_error"),
    blockedAt: timestamp("blocked_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("branch_push_settlement_outbox_recovery")
      .on(table.availableAt, table.leaseExpiresAt, table.createdAt)
      .where(sql`${table.state} = 'pending'`),
    index("branch_push_settlement_outbox_document_unresolved")
      .on(table.documentId)
      .where(sql`${table.state} <> 'completed'`),
    check(
      "branch_push_settlement_outbox_state_valid",
      sql`${table.state} IN ('pending', 'blocked', 'completed')`,
    ),
    check(
      "branch_push_settlement_outbox_terminal_shape",
      sql`(
        (${table.state} = 'completed' AND ${table.completedAt} IS NOT NULL AND ${table.blockedAt} IS NULL AND ${table.claimToken} IS NULL AND ${table.claimKind} IS NULL AND ${table.claimedAt} IS NULL AND ${table.leaseExpiresAt} IS NULL)
        OR (${table.state} = 'blocked' AND ${table.blockedAt} IS NOT NULL AND ${table.lastErrorCode} IS NOT NULL AND ${table.completedAt} IS NULL AND ${table.claimToken} IS NULL AND ${table.claimKind} IS NULL AND ${table.claimedAt} IS NULL AND ${table.leaseExpiresAt} IS NULL)
        OR (${table.state} = 'pending' AND ${table.blockedAt} IS NULL AND ${table.completedAt} IS NULL)
      )`,
    ),
    check(
      "branch_push_settlement_outbox_claim_shape",
      sql`${table.state} <> 'pending' OR (
        (${table.claimToken} IS NOT NULL AND ${table.claimKind} IS NOT NULL AND ${table.claimedAt} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)
        OR (${table.claimToken} IS NULL AND ${table.claimKind} IS NULL AND ${table.claimedAt} IS NULL AND ${table.leaseExpiresAt} IS NULL)
      )`,
    ),
    check(
      "branch_push_settlement_outbox_claim_kind_valid",
      sql`${table.claimKind} IS NULL OR ${table.claimKind} IN ('warm', 'recovery')`,
    ),
    check(
      "branch_push_settlement_outbox_counters_valid",
      sql`${table.attemptCount} >= 0 AND ${table.joinVersion} >= 0 AND ${table.claimEpoch} >= 0 AND ${table.classifiedJoinVersion} <= ${table.joinVersion} AND (${table.settledJoinVersion} IS NULL OR ${table.settledJoinVersion} <= ${table.joinVersion})`,
    ),
  ],
);

/** Exact admitted updates joined to a not-yet-completed staged push. */
export const branchPushOutboxUpdates = pgTable(
  "branch_push_outbox_updates",
  {
    pushId: bigint("push_id", { mode: "number" })
      .notNull()
      .references(() => branchPushSettlementOutbox.pushId, { onDelete: "cascade" }),
    ordinal: bigint("ordinal", { mode: "number" }).notNull(),
    sourceKind: text("source_kind").$type<BranchPushSettlementUpdateSource>().notNull(),
    sourceId: bigint("source_id", { mode: "number" }).notNull(),
    update: byteaColumn("update").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.pushId, table.sourceKind, table.sourceId] }),
    uniqueIndex("branch_push_outbox_updates_ordinal").on(table.pushId, table.ordinal),
    check("branch_push_outbox_updates_ordinal_valid", sql`${table.ordinal} >= 0`),
    check(
      "branch_push_outbox_updates_source_kind_valid",
      sql`${table.sourceKind} IN ('journal', 'staged_push', 'initial_reconcile')`,
    ),
  ],
);

/** Thread-owned aggregate history; intentionally independent of document lifetime. */
export const changeTrailShells = pgTable(
  "change_trail_shells",
  {
    id: uuid("id").primaryKey(),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id")
      .$type<TurnId>()
      .references(() => turns.id, { onDelete: "cascade" }),
    ownerKind: text("owner_kind").$type<ChangeTrailOwnerKind>().notNull(),
    state: text("state").$type<ChangeTrailState>().notNull().default("building"),
    version: integer("version").notNull().default(1),
    changeCount: integer("change_count").notNull(),
    sweptChangeCount: integer("swept_change_count").notNull(),
    documentCount: integer("document_count").notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("change_trail_shells_turn_owner")
      .on(table.threadId, table.turnId)
      .where(sql`${table.ownerKind} = 'turn'`),
    uniqueIndex("change_trail_shells_shared_owner")
      .on(table.threadId)
      .where(sql`${table.ownerKind} = 'shared'`),
    check("change_trail_shells_owner_kind_valid", sql`${table.ownerKind} IN ('turn', 'shared')`),
    check(
      "change_trail_shells_owner_shape",
      sql`(${table.ownerKind} = 'turn' AND ${table.turnId} IS NOT NULL) OR (${table.ownerKind} = 'shared' AND ${table.turnId} IS NULL)`,
    ),
    check(
      "change_trail_shells_state_counts_valid",
      sql`${table.state} IN ('building', 'settling', 'settled') AND ${table.version} > 0 AND ${table.changeCount} >= 0 AND ${table.sweptChangeCount} >= 0 AND ${table.sweptChangeCount} <= ${table.changeCount} AND ${table.documentCount} >= 0 AND ((${table.state} = 'settled') = (${table.settledAt} IS NOT NULL))`,
    ),
  ],
);

/** Non-sensitive document occurrence retained after manuscript hard deletion. */
export const changeTrailDocumentOccurrences = pgTable(
  "change_trail_document_occurrences",
  {
    trailId: uuid("trail_id")
      .notNull()
      .references(() => changeTrailShells.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").$type<DocumentId>().notNull(),
    /**
     * Durable replace-set cursor for marker delivery. This lives on the
     * non-sensitive occurrence so an empty refinement cannot reset the cursor.
     */
    projectionRevision: integer("projection_revision").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.trailId, table.documentId] })],
);

/** Manuscript-bearing detail; document deletion deliberately cascades only this layer. */
export const changeTrailDocumentDetails = pgTable(
  "change_trail_document_details",
  {
    trailId: uuid("trail_id")
      .notNull()
      .references(() => changeTrailShells.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    documentTitle: text("document_title").notNull(),
    changes: jsonb("changes").$type<unknown[]>().notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.trailId, table.documentId] })],
);

/** Transactional handoff to the thread event journal; drained by the slice-3 dispatcher. */
export const changeTrailDeliveryOutbox = pgTable(
  "change_trail_delivery_outbox",
  {
    eventId: uuid("event_id").primaryKey(),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    trailId: uuid("trail_id")
      .notNull()
      .references(() => changeTrailShells.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    eventKind: text("event_kind").$type<ChangeTrailEventKind>().notNull(),
    changeCount: integer("change_count"),
    sweptChangeCount: integer("swept_change_count"),
    documentCount: integer("document_count"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("change_trail_delivery_outbox_version").on(
      table.trailId,
      table.version,
      table.eventKind,
    ),
    index("change_trail_delivery_outbox_pending")
      .on(table.createdAt)
      .where(sql`${table.deliveredAt} IS NULL`),
    check(
      "change_trail_delivery_outbox_event_kind_valid",
      sql`${table.eventKind} IN ('updated', 'settled')`,
    ),
    check(
      "change_trail_delivery_outbox_counts_valid",
      sql`(${table.eventKind} = 'settled' AND ${table.changeCount} IS NULL AND ${table.sweptChangeCount} IS NULL AND ${table.documentCount} IS NULL) OR (${table.eventKind} = 'updated' AND ${table.changeCount} >= 0 AND ${table.sweptChangeCount} >= 0 AND ${table.sweptChangeCount} <= ${table.changeCount} AND ${table.documentCount} >= 0)`,
    ),
  ],
);

/** Durable completion fact for every turn-owned branch journal row. */
export const turnTrailWork = pgTable(
  "turn_trail_work",
  {
    journalId: bigint("journal_id", { mode: "number" })
      .primaryKey()
      .references(() => branchWriteJournal.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id")
      .$type<TurnId>()
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    branchId: text("branch_id")
      .notNull()
      .references(() => documentBranches.id, { onDelete: "cascade" }),
    state: text("state").$type<TurnTrailWorkState>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("turn_trail_work_ready").on(table.nextAttemptAt).where(sql`${table.state} = 'pending'`),
    index("turn_trail_work_owner").on(table.threadId, table.turnId, table.state),
    check(
      "turn_trail_work_state_valid",
      sql`${table.state} IN ('pending', 'running', 'complete', 'no_op', 'exhausted')`,
    ),
  ],
);

export const documentYjsCheckpoints = pgTable(
  "document_yjs_checkpoints",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    authorityId: uuid("authority_id").$type<DocumentAuthorityId>().notNull(),
    authorityGeneration: bigint("authority_generation", { mode: "bigint" }).notNull(),
    attributionManifest: jsonb("attribution_manifest").$type<unknown>().notNull(),
    state: byteaColumn("state").notNull(),
    stateVector: byteaColumn("state_vector").notNull(),
    upToSeq: bigint("up_to_seq", { mode: "number" }).notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (table) => [
    index("document_yjs_checkpoints_document_id_desc").on(table.documentId, table.id.desc()),
    uniqueIndex("document_yjs_checkpoints_initial")
      .on(table.documentId)
      .where(sql`${table.upToSeq} = 0`),
  ],
);

export const documentYjsUpdates = pgTable(
  "document_yjs_updates",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    authorityId: uuid("authority_id").$type<DocumentAuthorityId>().notNull(),
    authorityGeneration: bigint("authority_generation", { mode: "bigint" }).notNull(),
    admissionSequence: bigint("admission_sequence", { mode: "bigint" }).notNull(),
    batchOrdinal: integer("batch_ordinal").notNull().default(0),
    updateData: byteaColumn("update_data").notNull(),
    originType: text("origin_type"),
    actorUserId: uuid("actor_user_id")
      .$type<UserId>()
      .references(() => users.id, {
        onDelete: "set null",
      }),
    actorTurnId: uuid("actor_turn_id")
      .$type<TurnId>()
      .references(() => turns.id, {
        onDelete: "set null",
      }),
    authoringResponseId: uuid("authoring_response_id")
      .$type<ModelResponseId>()
      .references(() => modelResponses.id, { onDelete: "restrict" }),
    reversalActorType: text("reversal_actor_type").$type<"agent" | "user">(),
    reversalActorUserId: uuid("reversal_actor_user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [
    index("document_yjs_updates_document_id").on(table.documentId, table.id),
    uniqueIndex("document_yjs_updates_authority_admission").on(
      table.authorityId,
      table.authorityGeneration,
      table.admissionSequence,
      table.batchOrdinal,
    ),
  ],
);

export const documentYjsReversals = pgTable(
  "document_yjs_reversals",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id")
      .$type<TurnId>()
      .references(() => turns.id, { onDelete: "cascade" }),
    authoringResponseId: uuid("authoring_response_id")
      .$type<ModelResponseId>()
      .references(() => modelResponses.id, { onDelete: "restrict" }),
    // Model-facing reversal handle (for example, "w3"), not a durable idempotency key.
    writeId: text("write_id").notNull(),
    status: text("status").$type<ReversalStatus>().notNull(),
    // No FK: compaction can delete the undo update row after expiring reversal metadata.
    undoUpdateSeq: bigint("undo_update_seq", { mode: "number" }).notNull(),
    // Current redo re-apply update for redone rows; cleared on the next undo cycle.
    redoUpdateSeq: bigint("redo_update_seq", { mode: "number" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedByUserId: uuid("reversed_by_user_id")
      .$type<UserId>()
      .references(() => users.id, {
        onDelete: "set null",
      }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("document_yjs_reversals_document_thread_write").on(
      table.documentId,
      table.threadId,
      table.writeId,
    ),
    index("document_yjs_reversals_document_thread").on(table.documentId, table.threadId),
    check(
      "document_yjs_reversals_status_valid",
      sql`${table.status} IN ('active', 'reversed', 'redone', 'reconciled', 'expired')`,
    ),
  ],
);

export const documentYjsReversalOps = pgTable(
  "document_yjs_reversal_ops",
  {
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    // No FK: compaction prunes update rows while retaining reversal history until matching pruning.
    updateSeq: bigint("update_seq", { mode: "number" }).notNull(),
    handle: text("handle").notNull(),
    direction: text("direction").$type<ReversalOpDirection>().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.documentId, table.threadId, table.updateSeq, table.handle],
    }),
    index("document_yjs_reversal_ops_document_thread_handle").on(
      table.documentId,
      table.threadId,
      table.handle,
    ),
    check("document_yjs_reversal_ops_direction_valid", sql`${table.direction} IN ('undo', 'redo')`),
  ],
);

export const agentEditMutations = pgTable(
  "agent_edit_mutations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    wId: integer("w_id").notNull(),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id")
      .$type<TurnId>()
      .references(() => turns.id, { onDelete: "cascade" }),
    authoringResponseId: uuid("authoring_response_id")
      .$type<ModelResponseId>()
      .references(() => modelResponses.id, { onDelete: "restrict" }),
    actorKind: text("actor_kind").$type<"agent" | "human" | "system">().notNull().default("agent"),
    userId: text("user_id"),
    // Durable idempotency key for the edit mutation, distinct from reversal handles.
    writeId: text("write_id").notNull(),
    status: text("status").$type<MutationStatus>().notNull().default("active"),
    createdSeq: bigint("created_seq", { mode: "number" }).notNull(),
    // No FK: compaction can delete the update row while durable mutation metadata remains.
    undoUpdateSeq: bigint("undo_update_seq", { mode: "number" }),
    createdAt: createdAt(),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: text("reversed_by").$type<MutationReversedBy>(),
  },
  (table) => [
    uniqueIndex("agent_edit_mutations_document_thread_write_id")
      .on(table.documentId, table.threadId, table.writeId)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex("agent_edit_mutations_document_thread_w_id").on(
      table.documentId,
      table.threadId,
      table.wId,
    ),
    index("agent_edit_mutations_thread_status").on(table.documentId, table.threadId, table.status),
    index("agent_edit_mutations_turn").on(table.documentId, table.threadId, table.turnId),
    index("agent_edit_mutations_thread_turn").on(table.threadId, table.turnId),
    check("agent_edit_mutations_status_valid", sql`${table.status} IN ('active', 'reversed')`),
  ],
);

export const pendingNotices = pgTable(
  "pending_notices",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull(),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    message: text("message").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("pending_notices_thread").on(table.threadId, table.createdAt, table.id)],
);

export const agentEditWidCounters = pgTable(
  "agent_edit_wid_counters",
  {
    documentId: uuid("document_id").$type<DocumentId>().notNull(),
    threadId: uuid("thread_id").$type<ThreadId>().notNull(),
    nextWid: integer("next_wid").notNull(),
  },
  (table) => [primaryKey({ columns: [table.documentId, table.threadId] })],
);

export const documentYjsHeads = pgTable("document_yjs_heads", {
  documentId: uuid("document_id")
    .$type<DocumentId>()
    .primaryKey()
    .references(() => documents.id, { onDelete: "cascade" }),
  authorityId: uuid("authority_id")
    .$type<DocumentAuthorityId>()
    .notNull()
    .default(sql`gen_random_uuid()`),
  authorityGeneration: bigint("authority_generation", { mode: "bigint" }).notNull().default(sql`1`),
  nextAdmissionSequence: bigint("next_admission_sequence", { mode: "bigint" })
    .notNull()
    .default(sql`1`),
  fragmentName: text("fragment_name").notNull().default("prosemirror"),
  /** Must stay aligned with COLLAB_SCHEMA_VERSION in @meridian/prosemirror-schema. */
  schemaVersion: integer("schema_version").notNull().default(3),
  latestUpdateSeq: bigint("latest_update_seq", { mode: "number" }).notNull().default(0),
  latestStateVector: byteaColumn("latest_state_vector"),
  // SET NULL is effectively unreachable: checkpoints delete only via document cascade,
  // which also deletes the head row.
  latestCheckpointId: bigint("latest_checkpoint_id", { mode: "number" }).references(
    () => documentYjsCheckpoints.id,
    { onDelete: "set null" },
  ),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
