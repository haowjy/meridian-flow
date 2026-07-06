import type { DocumentId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts";
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
import { threads, turns } from "./agent-threads";
import { documents, works } from "./content";
import { users } from "./users";

type ReversalStatus = "active" | "reversed" | "redone" | "reconciled" | "expired";
type MutationStatus = "active" | "reversed";
type MutationReversedBy = "user" | "agent";
type UndoNotificationDirection = "undo" | "redo";
type ReversalOpDirection = "undo" | "redo";
type DraftStatus = "active" | "accepting" | "reactivating" | "applied" | "discarded";

type DocumentBranchKind = "work_draft" | "thread_peer";
type DocumentBranchPushPolicy = "manual" | "auto";
type DocumentBranchStatus = "active" | "closed";
type BranchWriteJournalSource = "agent" | "writer";
type BranchWriteJournalStatus = "active" | "pushed" | "discarded" | "rollback_pending";
type PushKind = "whole" | "selective";

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
    updateMeta: jsonb("update_meta"),
    status: text("status").$type<BranchWriteJournalStatus>().notNull().default("active"),
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
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

export const documentYjsCheckpoints = pgTable(
  "document_yjs_checkpoints",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    state: byteaColumn("state").notNull(),
    stateVector: byteaColumn("state_vector").notNull(),
    upToSeq: bigint("up_to_seq", { mode: "number" }).notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (table) => [
    index("document_yjs_checkpoints_document_id_desc").on(table.documentId, table.id.desc()),
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
    createdAt: createdAt(),
  },
  (table) => [index("document_yjs_updates_document_id").on(table.documentId, table.id)],
);

export const documentYjsDrafts = pgTable(
  "document_yjs_drafts",
  {
    id: text("id").primaryKey(),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    workId: uuid("work_id")
      .$type<WorkId>()
      .notNull()
      .references(() => works.id, { onDelete: "restrict" }),
    status: text("status").$type<DraftStatus>().notNull(),
    baseLiveUpdateSeq: bigint("base_live_update_seq", { mode: "number" }).notNull().default(0),
    acceptGeneration: integer("accept_generation").notNull().default(0),
    createdDocument: boolean("created_document").notNull().default(false),
    lastActorTurnId: uuid("last_actor_turn_id")
      .$type<TurnId>()
      .references(() => turns.id, { onDelete: "set null" }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    appliedByUserId: uuid("applied_by_user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    appliedUpdateSeq: bigint("applied_update_seq", { mode: "number" }),
    discardedAt: timestamp("discarded_at", { withTimezone: true }),
    /** Set once when an applied/discarded draft is reactivated for undo; not bumped by later draft edits. */
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimToken: uuid("claim_token"),
    wordsAdded: integer("words_added"),
    wordsRemoved: integer("words_removed"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("document_yjs_drafts_active_document_work")
      .on(table.documentId, table.workId)
      .where(sql`status IN ('active', 'accepting', 'reactivating')`),
    check(
      "document_yjs_drafts_status_valid",
      sql`${table.status} IN ('active', 'accepting', 'reactivating', 'applied', 'discarded')`,
    ),
  ],
);

export const documentYjsDraftUpdates = pgTable(
  "document_yjs_draft_updates",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    draftId: text("draft_id")
      .notNull()
      .references(() => documentYjsDrafts.id, { onDelete: "cascade" }),
    updateData: byteaColumn("update_data").notNull(),
    updateKind: text("update_kind"),
    actorUserId: uuid("actor_user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    actorTurnId: uuid("actor_turn_id")
      .$type<TurnId>()
      .references(() => turns.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [index("document_yjs_draft_updates_draft_id").on(table.draftId, table.id)],
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
    // 'live' for the canonical doc; a draft ULID for draft-scoped agent-edit state.
    scopeId: text("scope_id").notNull().default("live"),
    turnId: uuid("turn_id")
      .$type<TurnId>()
      .references(() => turns.id, { onDelete: "cascade" }),
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
      table.scopeId,
    ),
    index("document_yjs_reversals_document_thread").on(
      table.documentId,
      table.threadId,
      table.scopeId,
    ),
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
    // 'live' for the canonical doc; a draft ULID for draft-scoped reversal op state.
    scopeId: text("scope_id").notNull().default("live"),
    // No FK: compaction prunes update rows while retaining reversal history until matching pruning.
    updateSeq: bigint("update_seq", { mode: "number" }).notNull(),
    handle: text("handle").notNull(),
    direction: text("direction").$type<ReversalOpDirection>().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.documentId, table.threadId, table.scopeId, table.updateSeq, table.handle],
    }),
    index("document_yjs_reversal_ops_document_thread_handle").on(
      table.documentId,
      table.threadId,
      table.scopeId,
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
    // 'live' for the canonical doc; a draft ULID for draft-scoped agent-edit state.
    scopeId: text("scope_id").notNull().default("live"),
    turnId: uuid("turn_id")
      .$type<TurnId>()
      .references(() => turns.id, { onDelete: "cascade" }),
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
      .on(table.documentId, table.threadId, table.writeId, table.scopeId)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex("agent_edit_mutations_document_thread_w_id").on(
      table.documentId,
      table.threadId,
      table.wId,
      table.scopeId,
    ),
    index("agent_edit_mutations_thread_status").on(
      table.documentId,
      table.threadId,
      table.status,
      table.scopeId,
    ),
    index("agent_edit_mutations_turn").on(
      table.documentId,
      table.threadId,
      table.turnId,
      table.scopeId,
    ),
    index("agent_edit_mutations_thread_turn").on(table.threadId, table.turnId),
    check("agent_edit_mutations_status_valid", sql`${table.status} IN ('active', 'reversed')`),
  ],
);

export const pendingUndoNotifications = pgTable(
  "pending_undo_notifications",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    writeHandle: text("write_handle").notNull(),
    turnId: uuid("turn_id")
      .$type<TurnId>()
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    uri: text("uri").notNull(),
    direction: text("direction").$type<UndoNotificationDirection>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("pending_undo_notifications_thread").on(table.threadId),
    check(
      "pending_undo_notifications_direction_valid",
      sql`${table.direction} IN ('undo', 'redo')`,
    ),
  ],
);

export const agentEditWidCounters = pgTable(
  "agent_edit_wid_counters",
  {
    documentId: uuid("document_id").$type<DocumentId>().notNull(),
    threadId: uuid("thread_id").$type<ThreadId>().notNull(),
    // 'live' for the canonical doc; a draft ULID for draft-scoped agent-edit state.
    scopeId: text("scope_id").notNull().default("live"),
    nextWid: integer("next_wid").notNull(),
  },
  (table) => [primaryKey({ columns: [table.documentId, table.threadId, table.scopeId] })],
);

export const documentYjsHeads = pgTable("document_yjs_heads", {
  documentId: uuid("document_id")
    .$type<DocumentId>()
    .primaryKey()
    .references(() => documents.id, { onDelete: "cascade" }),
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
