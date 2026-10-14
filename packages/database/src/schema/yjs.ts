import type {
  DocumentAuthorityId,
  DocumentId,
  DraftBaseRevision,
  DraftCommandId,
  DraftCommandKind,
  DraftCommandOutcome,
  DraftId,
  ModelResponseId,
  ThreadId,
  TurnId,
  UserId,
  WorkId,
} from "@meridian/contracts";
import { COLLAB_SCHEMA_VERSION, packCollabSchemaVersion } from "@meridian/prosemirror-schema";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
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
import { documentEdits } from "./document-edits";
import { drafts } from "./drafts";
import { users } from "./users";

type DocumentBranchKind = "work_draft" | "thread_peer";
type DocumentBranchStatus = "active" | "closed";
type BranchWriteJournalSource = "agent" | "writer";
type BranchWriteJournalStatus = "active" | "pushed" | "discarded" | "rollback_pending";
type BranchPushSettlementState = "pending" | "blocked" | "completed" | "abandoned";
type BranchPushSettlementClaimKind = "warm" | "recovery";
type BranchPushSettlementUpdateSource = "journal" | "staged_push" | "initial_reconcile";
type ChangeTrailOwnerKind = "turn" | "shared";
type ChangeTrailState = "building" | "settling" | "settled";
type ChangeTrailEventKind = "updated" | "settled";

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
    /**
     * The draft this branch belongs to (decision 3: a draft is its own record). A thread
     * peer carries its upstream Work-draft branch's draft.
     */
    draftId: uuid("draft_id")
      .$type<DraftId>()
      .notNull()
      .references(() => drafts.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .references(() => threads.id, { onDelete: "cascade" }),
    status: text("status").$type<DocumentBranchStatus>().notNull().default("active"),
    state: byteaColumn("state").notNull(),
    stateVector: byteaColumn("state_vector").notNull(),
    /**
     * The text differs from its base. Every write sets it explicitly; the default only governs an
     * ensure that writes nothing.
     */
    hasEffect: boolean("has_effect").notNull().default(false),
    blocking: boolean("blocking").notNull().default(false),
    /**
     * The live revision the draft's `review_base` fragment reflects. Null means uninitialized: no
     * base was ever written, and rebase refuses it.
     */
    baseRevision: jsonb("base_revision").$type<DraftBaseRevision>(),
    /** Encoded rebase cuts, oldest first, retained for late-peer recovery. */
    rebaseCuts: byteaColumn("rebase_cuts").array().notNull().default(sql`'{}'::bytea[]`),
    liveCut: byteaColumn("live_cut"),
    discardedStateVector: byteaColumn("discarded_state_vector"),
    schemaVersion: integer("schema_version")
      .notNull()
      .default(packCollabSchemaVersion(COLLAB_SCHEMA_VERSION)),
    generation: integer("generation").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("document_branches_active_draft_document")
      .on(table.documentId, table.draftId)
      .where(sql`${table.kind} = 'work_draft' AND ${table.status} = 'active'`),
    index("document_branches_active_work_draft_by_draft")
      .on(table.draftId, table.id, table.generation)
      .where(sql`${table.kind} = 'work_draft' AND ${table.status} = 'active'`),
    uniqueIndex("document_branches_active_thread_peer")
      .on(table.documentId, table.threadId)
      .where(sql`${table.kind} = 'thread_peer' AND ${table.status} = 'active'`),
    check("document_branches_kind_valid", sql`${table.kind} IN ('work_draft', 'thread_peer')`),
    check("document_branches_status_valid", sql`${table.status} IN ('active', 'closed')`),
    check(
      "document_branches_owner_shape",
      sql`(${table.kind} = 'work_draft' AND ${table.threadId} IS NULL) OR (${table.kind} = 'thread_peer' AND ${table.threadId} IS NOT NULL)`,
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
    /** The model's tool call that made this write; the chat transcript row to jump to. */
    toolCallId: text("tool_call_id"),
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
    branchGeneration: integer("branch_generation").notNull(),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    journalIds: bigint("journal_ids", { mode: "number" }).array().notNull(),
    upstreamUpdateSeq: bigint("upstream_update_seq", { mode: "number" }),
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
    /** A content Apply's durable input and result; null for a publication that pushed journal rows. */
    applyPayload: jsonb("apply_payload").$type<unknown>(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("push_lineage_idempotency").on(table.idempotencyKey),
    index("push_lineage_document").on(table.documentId),
    index("push_lineage_branch").on(table.branchId, table.branchGeneration),
    index("push_lineage_turn").on(table.threadId, table.turnId),
    index("push_lineage_receipt").on(table.receiptId),
  ],
);

/**
 * One settlement identity for a batch of staged pushes: recovery claims the batch
 * whole, and one completion transaction settles every member.
 */
export const branchPushSettlementBatches = pgTable(
  "branch_push_settlement_batches",
  {
    id: uuid("id").primaryKey(),
    state: text("state").$type<BranchPushSettlementState>().notNull().default("pending"),
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
    /** A publication step refused the staged batch; nothing of it reached live. */
    abandonedAt: timestamp("abandoned_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("branch_push_settlement_batches_recovery")
      .on(table.availableAt, table.leaseExpiresAt, table.createdAt)
      .where(sql`${table.state} = 'pending'`),
    // Writer admissions join unresolved members; few batches are ever unresolved.
    index("branch_push_settlement_batches_unresolved")
      .on(table.id)
      .where(sql`${table.state} IN ('pending', 'blocked')`),
    check(
      "branch_push_settlement_batches_state_valid",
      sql`${table.state} IN ('pending', 'blocked', 'completed', 'abandoned')`,
    ),
    check(
      "branch_push_settlement_batches_terminal_shape",
      sql`(
        (${table.state} = 'completed' AND ${table.completedAt} IS NOT NULL AND ${table.blockedAt} IS NULL AND ${table.abandonedAt} IS NULL AND ${table.claimToken} IS NULL AND ${table.claimKind} IS NULL AND ${table.claimedAt} IS NULL AND ${table.leaseExpiresAt} IS NULL)
        OR (${table.state} = 'blocked' AND ${table.blockedAt} IS NOT NULL AND ${table.lastErrorCode} IS NOT NULL AND ${table.completedAt} IS NULL AND ${table.abandonedAt} IS NULL AND ${table.claimToken} IS NULL AND ${table.claimKind} IS NULL AND ${table.claimedAt} IS NULL AND ${table.leaseExpiresAt} IS NULL)
        OR (${table.state} = 'abandoned' AND ${table.abandonedAt} IS NOT NULL AND ${table.lastErrorCode} IS NOT NULL AND ${table.completedAt} IS NULL AND ${table.blockedAt} IS NULL AND ${table.claimToken} IS NULL AND ${table.claimKind} IS NULL AND ${table.claimedAt} IS NULL AND ${table.leaseExpiresAt} IS NULL)
        OR (${table.state} = 'pending' AND ${table.blockedAt} IS NULL AND ${table.completedAt} IS NULL AND ${table.abandonedAt} IS NULL)
      )`,
    ),
    check(
      "branch_push_settlement_batches_claim_shape",
      sql`${table.state} <> 'pending' OR (
        (${table.claimToken} IS NOT NULL AND ${table.claimKind} IS NOT NULL AND ${table.claimedAt} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)
        OR (${table.claimToken} IS NULL AND ${table.claimKind} IS NULL AND ${table.claimedAt} IS NULL AND ${table.leaseExpiresAt} IS NULL)
      )`,
    ),
    check(
      "branch_push_settlement_batches_claim_kind_valid",
      sql`${table.claimKind} IS NULL OR ${table.claimKind} IN ('warm', 'recovery')`,
    ),
    check(
      "branch_push_settlement_batches_counters_valid",
      sql`${table.attemptCount} >= 0 AND ${table.claimEpoch} >= 0`,
    ),
  ],
);

/** A publication step's durable input, staged with its batch and read on claim and recovery. */
export const branchPushSettlementPayloads = pgTable(
  "branch_push_settlement_payloads",
  {
    batchId: uuid("batch_id")
      .notNull()
      .references(() => branchPushSettlementBatches.id, { onDelete: "cascade" }),
    stepKind: text("step_kind").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.batchId, table.stepKind] })],
);

/**
 * An item a publication step kept out of a batch, and why: staged with the batch
 * when the pre-staging check decided it, written in completion otherwise.
 */
export const branchPushSettlementHolds = pgTable(
  "branch_push_settlement_holds",
  {
    batchId: uuid("batch_id")
      .notNull()
      .references(() => branchPushSettlementBatches.id, { onDelete: "cascade" }),
    itemKey: text("item_key").notNull(),
    /** The text member held with the item; null for a branchless item. */
    documentId: uuid("document_id").$type<DocumentId>(),
    reason: jsonb("reason").$type<unknown>().notNull(),
    decidedIn: text("decided_in").$type<"check" | "completion">().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.batchId, table.itemKey] }),
    check(
      "branch_push_settlement_holds_decided_in_valid",
      sql`${table.decidedIn} IN ('check', 'completion')`,
    ),
  ],
);

/** One staged push of a settlement batch: its lock cut, update, trail and joins. */
export const branchPushSettlementOutbox = pgTable(
  "branch_push_settlement_outbox",
  {
    pushId: bigint("push_id", { mode: "number" })
      .primaryKey()
      .references(() => pushLineage.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => branchPushSettlementBatches.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    documentTitle: text("document_title").notNull(),
    lockCutUpdate: byteaColumn("lock_cut_update").notNull(),
    pushUpdate: byteaColumn("push_update").notNull(),
    trailSeed: jsonb("trail_seed").$type<unknown>().notNull(),
    joinVersion: bigint("join_version", { mode: "number" }).notNull().default(0),
    classifiedJoinVersion: bigint("classified_join_version", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("branch_push_settlement_outbox_document").on(table.documentId),
    uniqueIndex("branch_push_settlement_outbox_batch_document").on(table.batchId, table.documentId),
    check(
      "branch_push_settlement_outbox_counters_valid",
      sql`${table.joinVersion} >= 0 AND ${table.classifiedJoinVersion} <= ${table.joinVersion}`,
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
    documentCount: integer("document_count").notNull(),
    documents: jsonb("documents")
      .$type<Array<{ documentId: string; title: string }>>()
      .notNull()
      .default([]),
    wordsAdded: integer("words_added"),
    wordsRemoved: integer("words_removed"),
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
      sql`${table.state} IN ('building', 'settling', 'settled') AND ${table.version} > 0 AND ${table.changeCount} >= 0 AND ${table.documentCount} >= 0 AND ((${table.state} = 'settled') = (${table.settledAt} IS NOT NULL))`,
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
    wordsAdded: integer("words_added"),
    wordsRemoved: integer("words_removed"),
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
    changeCount: integer("change_count").notNull(),
    documentCount: integer("document_count").notNull(),
    documents: jsonb("documents")
      .$type<Array<{ documentId: string; title: string }>>()
      .notNull()
      .default([]),
    wordsAdded: integer("words_added"),
    wordsRemoved: integer("words_removed"),
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
      sql`${table.changeCount} >= 0 AND ${table.documentCount} >= 0`,
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
    editId: uuid("edit_id").references(() => documentEdits.id, { onDelete: "set null" }),
    editPartOrdinal: integer("edit_part_ordinal"),
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
  schemaVersion: integer("schema_version")
    .notNull()
    .default(packCollabSchemaVersion(COLLAB_SCHEMA_VERSION)),
  retiredThroughSeq: bigint("retired_through_seq", { mode: "number" }).notNull().default(0),
  latestUpdateSeq: bigint("latest_update_seq", { mode: "number" }).notNull().default(0),
  latestStateVector: byteaColumn("latest_state_vector"),
  latestCheckpointId: bigint("latest_checkpoint_id", { mode: "number" }).references(
    () => documentYjsCheckpoints.id,
    { onDelete: "set null" },
  ),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Independently certifiable outputs of the live-document derive step. */
export const documentDerivations = pgTable("document_derivations", {
  documentId: uuid("document_id")
    .$type<DocumentId>()
    .primaryKey()
    .references(() => documents.id, { onDelete: "cascade" }),
  projectionGeneration: bigint("projection_generation", { mode: "bigint" }).notNull(),
  projectionAdmissionSequence: bigint("projection_admission_sequence", {
    mode: "bigint",
  }).notNull(),
  projectionLocationVersion: bigint("projection_location_version", { mode: "bigint" }).notNull(),
  projectionExtractorVersion: integer("projection_extractor_version").notNull(),
  linksGeneration: bigint("links_generation", { mode: "bigint" }),
  linksAdmissionSequence: bigint("links_admission_sequence", { mode: "bigint" }),
  linksLocationVersion: bigint("links_location_version", { mode: "bigint" }),
  linksExtractorVersion: integer("links_extractor_version"),
});

/** Transaction-local dirty signals; sequence is identity, never commit order. */
export const changeTrailDirtyLog = pgTable(
  "change_trail_dirty_log",
  {
    seq: bigint("seq", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id")
      .$type<TurnId>()
      .references(() => turns.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("change_trail_dirty_log_owner_seq").on(table.threadId, table.turnId, table.seq),
  ],
);

/**
 * The record of one writer Apply or Discard, keyed by the client's command id so a resend
 * answers the first command's outcome. It lives beside the batches it points at, which keeps
 * `drafts.ts` free of an import cycle.
 */
export const draftCommands = pgTable(
  "draft_commands",
  {
    id: uuid("id").$type<DraftCommandId>().primaryKey(),
    workId: uuid("work_id")
      .$type<WorkId>()
      .notNull()
      .references(() => works.id, { onDelete: "cascade" }),
    draftId: uuid("draft_id")
      .$type<DraftId>()
      .references(() => drafts.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<DraftCommandKind>().notNull(),
    /** Hash of the canonical command envelope; another digest under this id is a conflict. */
    requestDigest: text("request_digest").notNull(),
    /** Set when an Apply stages; completion or withdrawal settles the row with the batch. */
    settlementBatchId: uuid("settlement_batch_id").references(
      () => branchPushSettlementBatches.id,
      { onDelete: "set null" },
    ),
    state: text("state").$type<"pending" | "done">().notNull().default("pending"),
    result: jsonb("result").$type<DraftCommandOutcome>(),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("draft_commands_work").on(table.workId),
    index("draft_commands_settlement_batch")
      .on(table.settlementBatchId)
      .where(sql`${table.settlementBatchId} IS NOT NULL`),
    check(
      "draft_commands_kind_valid",
      sql`${table.kind} IN ('apply_items', 'apply_changes', 'discard_items', 'discard_changes', 'discard_draft')`,
    ),
    check("draft_commands_state_valid", sql`${table.state} IN ('pending', 'done')`),
    check(
      "draft_commands_done_shape",
      sql`(${table.state} = 'done') = (${table.completedAt} IS NOT NULL)`,
    ),
  ],
);
