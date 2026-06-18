import type { DocumentId, DocumentRestorePointId, TurnId, UserId } from "@meridian/contracts";
import {
  bigint,
  bigserial,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { byteaColumn, createdAt, idColumn } from "./_shared";
import { turns } from "./agent-threads";
import { documents } from "./content";
import { users } from "./users";

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

export const documentYjsHeads = pgTable("document_yjs_heads", {
  documentId: uuid("document_id")
    .$type<DocumentId>()
    .primaryKey()
    .references(() => documents.id, { onDelete: "cascade" }),
  fragmentName: text("fragment_name").notNull().default("prosemirror"),
  /** Must stay aligned with COLLAB_SCHEMA_VERSION in @meridian/prosemirror-schema. */
  schemaVersion: integer("schema_version").notNull().default(1),
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
