import type {
  BranchCommandId,
  BranchCommandKind,
  BranchId,
  DocumentAuthorityId,
  DocumentId,
  ModelResponseId,
  StoredBranchCommandResult,
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
import { branches } from "./branches";
import { documents, works } from "./content";
import { documentEdits } from "./document-edits";
import { users } from "./users";

type DocumentDraftKind = "work_draft" | "thread_peer";
type DocumentDraftStatus = "active" | "closed";
type DraftWriteJournalSource = "agent" | "writer" | "server";
type DraftWriteJournalStatus = "active" | "rollback_pending";
type ChangeTrailOwnerKind = "turn" | "shared";
type ChangeTrailState = "building" | "settling" | "settled";
type ChangeTrailEventKind = "updated" | "settled";

export const documentDrafts = pgTable(
  "document_drafts",
  {
    id: text("id").primaryKey(),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    kind: text("kind").$type<DocumentDraftKind>().notNull(),
    upstreamDraftId: text("upstream_draft_id").references((): AnyPgColumn => documentDrafts.id, {
      onDelete: "set null",
    }),
    /** The fresh active draft that continues this closed draft after create Redo. */
    successorDraftId: text("successor_draft_id").references((): AnyPgColumn => documentDrafts.id, {
      onDelete: "set null",
    }),
    /**
     * The branch this document draft belongs to. A thread peer shares its upstream
     * document draft's branch.
     */
    branchId: uuid("branch_id")
      .$type<BranchId>()
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .references(() => threads.id, { onDelete: "cascade" }),
    status: text("status").$type<DocumentDraftStatus>().notNull().default("active"),
    closedCause: text("closed_cause").$type<"discarded" | "document_removed">(),
    state: byteaColumn("state").notNull(),
    stateVector: byteaColumn("state_vector").notNull(),
    /** Current visible effect against the review base in the retained text. */
    hasEffect: boolean("has_effect").notNull().default(true),
    /**
     * The `revision` `has_effect` was judged at: equal is fresh, lower is stale and re-judged by
     * the projection sweep. `-1` (the default) is stale whatever the revision.
     */
    hasEffectRevision: bigint("has_effect_revision", { mode: "number" }).notNull().default(-1),
    schemaVersion: integer("schema_version")
      .notNull()
      .default(packCollabSchemaVersion(COLLAB_SCHEMA_VERSION)),
    /**
     * Bumped by every committed write to the draft: appends, checkpoint rewrites, closes, holds
     * and row status changes. Rewrites are fenced by it; appends bump it without checking it, and
     * the projection job writes `has_effect` at it without bumping it. Never reaches the client.
     */
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
    /** The `revision` the checkpoint (`state`, `state_vector`) was written at. */
    checkpointRevision: bigint("checkpoint_revision", { mode: "number" }).notNull().default(0),
    /** Highest `draft_write_journal.id` folded into the checkpoint; the tail is every later row. */
    checkpointSeq: bigint("checkpoint_seq", { mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("document_drafts_active_branch_document")
      .on(table.documentId, table.branchId)
      .where(sql`${table.kind} = 'work_draft' AND ${table.status} = 'active'`),
    index("document_drafts_active_work_draft_by_branch")
      .on(table.branchId, table.id)
      .where(sql`${table.kind} = 'work_draft' AND ${table.status} = 'active'`),
    uniqueIndex("document_drafts_active_thread_peer")
      .on(table.documentId, table.threadId)
      .where(sql`${table.kind} = 'thread_peer' AND ${table.status} = 'active'`),
    check("document_drafts_kind_valid", sql`${table.kind} IN ('work_draft', 'thread_peer')`),
    check(
      "document_drafts_closed_cause_presence",
      sql`(${table.status} = 'closed') = (${table.closedCause} IS NOT NULL)`,
    ),
    check(
      "document_drafts_closed_cause_valid",
      sql`${table.closedCause} IN ('discarded', 'document_removed')`,
    ),
    check("document_drafts_status_valid", sql`${table.status} IN ('active', 'closed')`),
    check(
      "document_drafts_owner_shape",
      sql`(${table.kind} = 'work_draft' AND ${table.threadId} IS NULL) OR (${table.kind} = 'thread_peer' AND ${table.threadId} IS NOT NULL)`,
    ),
  ],
);

export const draftWriteJournal = pgTable(
  "draft_write_journal",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    draftId: text("draft_id")
      .notNull()
      .references(() => documentDrafts.id, { onDelete: "cascade" }),
    wId: integer("w_id"),
    /** The model's tool call that made this write; the chat transcript row to jump to. */
    toolCallId: text("tool_call_id"),
    source: text("source").$type<DraftWriteJournalSource>().notNull().default("agent"),
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
    status: text("status").$type<DraftWriteJournalStatus>().notNull().default("active"),
    createdAt: createdAt(),
  },
  (table) => [
    index("draft_write_journal_draft").on(table.draftId, table.id),
    index("draft_write_journal_thread_turn").on(table.draftId, table.threadId, table.turnId),
    index("draft_write_journal_active")
      .on(table.draftId, table.status)
      .where(sql`${table.status} = 'active'`),
    check(
      "draft_write_journal_source_valid",
      sql`${table.source} IN ('agent', 'writer', 'server')`,
    ),
    check(
      "draft_write_journal_status_valid",
      sql`${table.status} IN ('active', 'rollback_pending')`,
    ),
  ],
);

export const pushLineage = pgTable(
  "push_lineage",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    draftId: text("draft_id").references(() => documentDrafts.id, { onDelete: "set null" }),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
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
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("push_lineage_idempotency").on(table.idempotencyKey),
    index("push_lineage_document").on(table.documentId),
    index("push_lineage_draft").on(table.draftId),
    index("push_lineage_turn").on(table.threadId, table.turnId),
    index("push_lineage_receipt").on(table.receiptId),
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
 * answers the first command's outcome.
 */
export const branchCommands = pgTable(
  "branch_commands",
  {
    id: uuid("id").$type<BranchCommandId>().primaryKey(),
    workId: uuid("work_id")
      .$type<WorkId>()
      .notNull()
      .references(() => works.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .$type<BranchId>()
      .references(() => branches.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<BranchCommandKind>().notNull(),
    /** Hash of the canonical command envelope; another digest under this id is a conflict. */
    requestDigest: text("request_digest").notNull(),
    state: text("state").$type<"pending" | "done">().notNull().default("pending"),
    result: jsonb("result").$type<StoredBranchCommandResult>(),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("branch_commands_work").on(table.workId),
    check(
      "branch_commands_kind_valid",
      sql`${table.kind} IN ('apply_click', 'apply_items', 'apply_changes', 'discard_items', 'discard_changes', 'discard_branch')`,
    ),
    check("branch_commands_state_valid", sql`${table.state} IN ('pending', 'done')`),
    check(
      "branch_commands_done_shape",
      sql`(${table.state} = 'done') = (${table.completedAt} IS NOT NULL)`,
    ),
  ],
);
