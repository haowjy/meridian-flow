/** Namespace receipts outlive moved/deleted documents and never cascade with document rows. */
import type { ContextOperationReceipt } from "@meridian/contracts/protocol";
import { jsonb, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import { createdAt } from "./_shared";
import { projects } from "./content";
import { users } from "./users";

export const contextOperationReceipts = pgTable(
  "context_operation_receipts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    operationId: uuid("operation_id").notNull(),
    receipt: jsonb("receipt").$type<ContextOperationReceipt>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.projectId, table.operationId] })],
);
