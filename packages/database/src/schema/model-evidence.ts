import type { DocumentId, ProjectId, ThreadId, TurnBlockId, TurnId } from "@meridian/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { byteaColumn } from "./_shared";
import { documents, projects } from "./content";

// keep: Store a SHA-256 beside exact unbounded link values; exact-equality guard must not merge distinct tuples
export const threadShownLinks = pgTable(
  "thread_shown_links",
  {
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").$type<ThreadId>().notNull(),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    ref: text("ref").notNull(),
    address: text("address").notNull(),
    holderUri: text("holder_uri").notNull(),
    view: text("view").notNull(),
    showingDigest: text("showing_digest").notNull(),
    turnId: uuid("turn_id").$type<TurnId>().notNull(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "thread_shown_links_pk",
      columns: [table.threadId, table.documentId, table.showingDigest, table.turnId],
    }),
    index("thread_shown_links_project").on(table.projectId),
    check("thread_shown_links_digest_valid", sql`${table.showingDigest} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const observationFrontiers = pgTable(
  "observation_frontiers",
  {
    sourceBlockId: uuid("source_block_id").$type<TurnBlockId>().notNull(),
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").$type<ThreadId>().notNull(),
    roomKey: text("room_key").notNull(),
    snapshot: byteaColumn("snapshot").notNull(),
    recordedSeq: bigint("recorded_seq", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceBlockId, table.roomKey] }),
    index("observation_frontiers_room_latest").on(table.roomKey, table.recordedSeq.desc()),
    index("observation_frontiers_thread").on(table.threadId),
    index("observation_frontiers_project").on(table.projectId),
  ],
);
