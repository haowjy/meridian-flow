// What the model was shown of documents: collab's tables, written at an edit and at a stored result.
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

/**
 * Links shown to the model in a holder document, per thread (host-only
 * evidence for ref assignment). Independent of transcript blocks, so
 * compaction and restart keep it. One row per showing key per turn: a repeat
 * in a later turn adds a row rather than moving the earlier one, so a fork
 * whose cutoff precedes the repeat still reads the showing it saw. Within a
 * turn the row keeps the greatest `seq` from the global sequence, which orders
 * showings ("latest"). Readers select the lineage's eligible rows by cutoff
 * first and only then keep the latest per key; nothing is copied.
 *
 * Addresses and holder URIs have no byte bound, so the key stores
 * `showing_digest`, a SHA-256 of the exact (ref, address, holder, view) tuple,
 * beside the exact values. Distinct tuples sharing a digest are treated as
 * impossible; were one to occur, the writer's exact-equality guard leaves the
 * first showing untouched rather than merging the two.
 *
 * `thread_id` and `turn_id` name rows of the runtime's tables without a foreign key: the
 * document side deletes by thread (`forgetThreads`), and a deleted project removes the rows
 * through `project_id`.
 */
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
    /** `live` or `branch:<branchId>`. */
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

/**
 * Observation frontiers: the document state the model was shown by one
 * transcript block (a tool result, or a writer turn's reference block whose
 * materialized read it is sent), per room. `snapshot` is a Yjs snapshot
 * (`encodeSnapshotV2`); `journal_position` is the host journal high-water mark
 * captured with that cut.
 * `room_key` is `draft:<workDraftId>` or `live:<documentId>:<authorityGeneration>`.
 *
 * Keyed by the block's own id, so a fork that renders the inherited block
 * finds its rows with nothing copied. The key has no foreign key to the block: the
 * runtime stores the block, and a row left behind by a crash is never read, because every
 * lookup names the block ids it asks about. `thread_id` is plain; the document side deletes
 * by it (`forgetThreads`), and `project_id` cascades a deleted project.
 * `recorded_seq` is global recording order: the latest row among a
 * conversation's blocks is the model's frontier for a room.
 */
export const observationFrontiers = pgTable(
  "observation_frontiers",
  {
    sourceBlockId: uuid("source_block_id").$type<TurnBlockId>().primaryKey(),
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").$type<ThreadId>().notNull(),
    roomKey: text("room_key").notNull(),
    snapshot: byteaColumn("snapshot").notNull(),
    journalPosition: bigint("journal_position", { mode: "number" }),
    recordedSeq: bigint("recorded_seq", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
  },
  (table) => [
    // The latest-row lookup walks a room's rows newest first and stops at the first in the conversation.
    index("observation_frontiers_room_latest").on(table.roomKey, table.recordedSeq.desc()),
    index("observation_frontiers_thread").on(table.threadId),
    index("observation_frontiers_project").on(table.projectId),
  ],
);
