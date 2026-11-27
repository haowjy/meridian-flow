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
    id: text("id").$type<DraftId>().primaryKey(),
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workId: uuid("work_id").$type<WorkId>(),
    isDefault: boolean("is_default").notNull().default(false),
    name: text("name"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
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

export const draftIdColumn = (name: string) =>
  text(name)
    .$type<DraftId>()
    .references(() => drafts.id, { onDelete: "cascade" });
