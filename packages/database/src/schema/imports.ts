/** Durable upload selections, receipts, and organize leases. Import identities are never reused. */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "./content";
export const imports = pgTable(
  "imports",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    userId: uuid("user_id").notNull(),
    destinationUri: text("destination_uri").notNull(),
    folderId: uuid("folder_id"),
    roots: jsonb("roots").notNull(),
    placement: jsonb("placement"),
    placementGeneration: integer("placement_generation").notNull().default(0),
    fingerprint: text("fingerprint").notNull(),
    state: text("state").notNull(),
    /** Retained when entries expire, so exact-command replay still returns the terminal summary. */
    counts: jsonb("counts").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    claimsWithoutProgress: integer("claims_without_progress").notNull().default(0),
    fellBack: boolean("fell_back").notNull().default(false),
    reason: text("reason"),
    revealedAt: timestamp("revealed_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    objectsSweptAt: timestamp("objects_swept_at", { withTimezone: true }),
    finalSweepAt: timestamp("final_sweep_at", { withTimezone: true }),
  },
  (table) => [
    index("imports_project_created").on(table.projectId, table.createdAt),
    index("imports_user_open").on(table.userId).where(sql`${table.acknowledgedAt} IS NULL`),
    index("imports_organize_claim")
      .on(table.state, table.leaseUntil)
      .where(sql`${table.state} = 'organizing'`),
    index("imports_upload_expiry")
      .on(table.lastActivityAt)
      .where(sql`${table.state} = 'uploading'`),
  ],
);
export const importEntries = pgTable(
  "import_entries",
  {
    id: uuid("id").primaryKey(),
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    spec: jsonb("spec").notNull(),
    kind: text("kind").notNull(),
    entryId: integer("entry_id"),
    state: text("state").notNull(),
    reason: text("reason"),
    storageUrl: text("storage_url"),
    objectKey: text("object_key"),
    convertedKey: text("converted_key"),
    receivedSize: bigint("received_size", { mode: "number" }),
    sha256: text("sha256"),
  },
  (table) => [
    index("import_entries_import_order").on(table.importId, table.ordinal),
    index("import_entries_import_state").on(table.importId, table.state),
  ],
);
