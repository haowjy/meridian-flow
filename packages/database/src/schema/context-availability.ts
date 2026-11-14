/** What the availability lookup orders its answers by. Deleted with the lookup (step 6b). */
import { sql } from "drizzle-orm";
import { bigint, pgSequence, pgTable, text } from "drizzle-orm/pg-core";
import { updatedAt } from "./_shared";

/** Global ordering source; heads contain watermarks only, never identity state. */
export const contextAvailabilityGeneration = pgSequence("context_availability_generation_seq");
export const contextNamespaceObservationVersion = pgSequence(
  "context_namespace_observation_version_seq",
);

export const contextAvailabilityHeads = pgTable("context_availability_heads", {
  authorityKey: text("authority_key").primaryKey(),
  generation: bigint("generation", { mode: "bigint" }).notNull(),
  /** Namespace commit watermark, including mutations whose manifest publication is deferred. */
  namespaceGeneration: bigint("namespace_generation", { mode: "bigint" }).notNull().default(sql`0`),
  updatedAt: updatedAt(),
});
