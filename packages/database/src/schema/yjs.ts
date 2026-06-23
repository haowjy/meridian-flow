import type {
  DocumentId,
  DocumentRestorePointId,
  ThreadId,
  TurnId,
  UserId,
} from "@meridian/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { byteaColumn, createdAt, idColumn } from "./_shared";
import { threads, turns } from "./agent-threads";
import { documents } from "./content";
import { users } from "./users";

type ReversalStatus = "active" | "reversed" | "redone" | "reconciled" | "expired";
type MutationStatus = "active" | "reversed";
type MutationReversedBy = "user" | "agent";

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
    actorAgentRunId: uuid("actor_agent_run_id"),
    createdAt: createdAt(),
  },
  (table) => [index("document_yjs_updates_document_id").on(table.documentId, table.id)],
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
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    status: text("status").$type<ReversalStatus>().notNull(),
    // No FK: compaction can delete the undo update row after expiring reversal metadata.
    undoUpdateSeq: bigint("undo_update_seq", { mode: "number" }).notNull(),
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
    uniqueIndex("document_yjs_reversals_document_thread_turn").on(
      table.documentId,
      table.threadId,
      table.turnId,
    ),
    index("document_yjs_reversals_document_thread").on(table.documentId, table.threadId),
    check(
      "document_yjs_reversals_status_valid",
      sql`${table.status} IN ('active', 'reversed', 'redone', 'reconciled', 'expired')`,
    ),
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
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    status: text("status").$type<MutationStatus>().notNull().default("active"),
    createdSeq: integer("created_seq").notNull(),
    // No FK: compaction can delete the update row while durable mutation metadata remains.
    undoUpdateSeq: integer("undo_update_seq"),
    createdAt: createdAt(),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: text("reversed_by").$type<MutationReversedBy>(),
  },
  (table) => [
    uniqueIndex("agent_edit_mutations_document_thread_w_id").on(
      table.documentId,
      table.threadId,
      table.wId,
    ),
    index("agent_edit_mutations_thread_status").on(table.documentId, table.threadId, table.status),
    index("agent_edit_mutations_turn").on(table.documentId, table.threadId, table.turnId),
    check("agent_edit_mutations_status_valid", sql`${table.status} IN ('active', 'reversed')`),
  ],
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
  latestCheckpointId: bigint("latest_checkpoint_id", { mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const documentRestorePoints = pgTable("document_restore_points", {
  id: idColumn<DocumentRestorePointId>(),
  documentId: uuid("document_id")
    .$type<DocumentId>()
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  checkpointId: bigint("checkpoint_id", { mode: "number" }).references(
    () => documentYjsCheckpoints.id,
  ),
  upToSeq: bigint("up_to_seq", { mode: "number" }),
  createdByUserId: uuid("created_by_user_id")
    .$type<UserId>()
    .references(() => users.id, {
      onDelete: "set null",
    }),
  createdAt: createdAt(),
});

// document_yjs_heads.latest_checkpoint_id FK added in custom SQL
