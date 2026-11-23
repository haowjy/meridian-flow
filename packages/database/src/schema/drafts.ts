/**
 * Drafts: everything pending in one draft, its forks of documents (`document_forks`) and its tree
 * records (`draft_tree_nodes`, tree-nodes.ts). A Work has several, one of them its default, and
 * they go with it (`work_id`); a No Work chat's lineage has its own. Every root chat names the
 * draft its lineage writes into (`threads.draft_id`).
 */
import type { DraftId, ProjectId, UserId, WorkId } from "@meridian/contracts";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt } from "./_shared";
import { projects, works } from "./content";
import { users } from "./users";

export const drafts = pgTable(
  "drafts",
  {
    /** 12 base-36 characters (`newDraftId`): it names the draft's fork rooms (`fork:<draft>:<doc>`). */
    id: text("id").$type<DraftId>().primaryKey(),
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /**
     * The Work the draft belongs to (a Work holds several), in the draft's own project
     * (`drafts_work_same_project_fk`); null for a No Work lineage's draft.
     */
    workId: uuid("work_id").$type<WorkId>(),
    /** The draft a new chat of its Work writes into: one per Work. */
    isDefault: boolean("is_default").notNull().default(false),
    /** The writer's name for the draft; null shows the default name. */
    name: text("name"),
    /**
     * `Delete draft`: listed nowhere from then on, its forks untouched so the Undo finds them;
     * retention purges it 30 days on.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** The draft's pending documents; recounted at commit for every draft a write set locked. */
    pendingDocumentCount: integer("pending_document_count").notNull().default(0),
    pendingFolderCount: integer("pending_folder_count").notNull().default(0),
    createdBy: uuid("created_by")
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [
    index("drafts_project").on(table.projectId),
    index("drafts_work").on(table.workId),
    uniqueIndex("drafts_work_default").on(table.workId).where(sql`${table.isDefault}`),
    foreignKey({
      columns: [table.projectId, table.workId],
      foreignColumns: [works.projectId, works.id],
      name: "drafts_work_same_project_fk",
    }).onDelete("cascade"),
    check("drafts_id_shape", sql`${table.id} ~ '^[0-9a-z]{12}$'`),
  ],
);

/** A draft id column referencing `drafts`. */
export const draftIdColumn = (name: string) =>
  text(name)
    .$type<DraftId>()
    .references(() => drafts.id, { onDelete: "cascade" });

export type DraftTreeNodeKind = "document" | "folder";
export type DraftTreeParentKind = "source" | "folder";
