import type { ProjectId, ThreadId, TurnId } from "@meridian/contracts";
import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, idColumn } from "./_shared";
import { threads, turns } from "./agent-threads";
import { projects } from "./content";

export const workbenchResults = pgTable(
  "workbench_results",
  {
    id: idColumn<string>(),
    workbenchId: uuid("workbench_id")
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    sourcePath: text("source_path").notNull(),
    resultsUri: text("results_uri").notNull(),
    storageUrl: text("storage_url").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    rootThreadId: uuid("root_thread_id")
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: "restrict" }),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: "restrict" }),
    turnId: uuid("turn_id")
      .$type<TurnId>()
      .notNull()
      .references(() => turns.id, { onDelete: "restrict" }),
    toolCallId: text("tool_call_id"),
    agentSlug: text("agent_slug").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check("workbench_results_size_bytes_nonneg", sql`${table.sizeBytes} >= 0`),
    index("workbench_results_workbench_created_idx").on(table.workbenchId, table.createdAt.desc()),
    index("workbench_results_root_thread_idx").on(table.rootThreadId, table.createdAt.desc()),
  ],
);
