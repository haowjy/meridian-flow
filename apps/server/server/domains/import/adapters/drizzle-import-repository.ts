/** Postgres import locks, durable receipts, and retained summary counts. */
import type { ImportCounts } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { importEntries, imports, projects } from "@meridian/database/schema";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import type { ImportEntry, ImportRecord, ImportRepository } from "../ports/import-repository.js";

export function createDrizzleImportRepository(db: Database): ImportRepository {
  const tx = () => currentDrizzleDb(db);
  const read = async (id: string, lock = false) => {
    const query = tx().select().from(imports).where(eq(imports.id, id));
    const [row] = await (lock ? query.for("update") : query);
    return row ? (row as ImportRecord) : null;
  };
  const open = (userId: string) =>
    and(eq(imports.userId, userId), isNull(imports.acknowledgedAt), isNull(projects.deletedAt));
  return {
    transaction: (run) => runInDrizzleTransaction(db, run),
    async lockUser(userId) {
      await tx().execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`import-user:${userId}`}, 0))`,
      );
    },
    async lockIdentity(id) {
      await tx().execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`import-id:${id}`}, 0))`,
      );
    },
    async now() {
      const rows = await tx().execute(sql`SELECT clock_timestamp() AS now`);
      return new Date(rows[0].now as string);
    },
    read,
    lock: (id) => read(id, true),
    async insert(record, entries) {
      await tx().insert(imports).values(record);
      for (let offset = 0; offset < entries.length; offset += 1000)
        await tx()
          .insert(importEntries)
          .values(entries.slice(offset, offset + 1000));
    },
    async update(id, patch) {
      await tx().update(imports).set(patch).where(eq(imports.id, id));
    },
    async entries(id) {
      return (await tx()
        .select()
        .from(importEntries)
        .where(eq(importEntries.importId, id))
        .orderBy(importEntries.ordinal)) as ImportEntry[];
    },
    async updateEntries(patches) {
      for (const { id, patch } of patches)
        await tx().update(importEntries).set(patch).where(eq(importEntries.id, id));
    },
    async skipEntries(id, states, reason) {
      await tx()
        .update(importEntries)
        .set({ state: "skipped", reason })
        .where(and(eq(importEntries.importId, id), inArray(importEntries.state, states)));
    },
    async refreshCounts(id) {
      const [counts] = await tx()
        .select({
          files: sql<number>`count(*)::int`,
          bytes: sql<number>`coalesce(sum(coalesce(${importEntries.receivedSize}, CASE WHEN ${importEntries.state} IN ('failed','skipped') THEN 0 ELSE (${importEntries.spec}->>'size')::bigint END)), 0)::float8`,
          received: sql<number>`count(*) FILTER (WHERE ${importEntries.objectKey} IS NOT NULL)::int`,
          receivedBytes: sql<number>`coalesce(sum(${importEntries.receivedSize}),0)::float8`,
          prepared: sql<number>`count(*) FILTER (WHERE ${importEntries.state} = 'prepared')::int`,
          organized: sql<number>`count(*) FILTER (WHERE ${importEntries.state} = 'organized')::int`,
          skipped: sql<number>`count(*) FILTER (WHERE ${importEntries.state} = 'skipped')::int`,
          failed: sql<number>`count(*) FILTER (WHERE ${importEntries.state} = 'failed')::int`,
          needsLook: sql<number>`count(*) FILTER (WHERE ${importEntries.reason} IS NOT NULL AND ${importEntries.reason} NOT IN ('obsidian_canvas','trash','hidden','export_works'))::int`,
        })
        .from(importEntries)
        .where(and(eq(importEntries.importId, id), ne(importEntries.kind, "folder")));
      await tx().update(imports).set({ counts }).where(eq(imports.id, id));
      return counts as ImportCounts;
    },
    async hasAwaiting(id) {
      const [row] = await tx()
        .select({ id: importEntries.id })
        .from(importEntries)
        .where(and(eq(importEntries.importId, id), eq(importEntries.state, "awaiting")))
        .limit(1);
      return Boolean(row);
    },
    async listOpen(userId) {
      return (
        await tx()
          .select({ record: imports })
          .from(imports)
          .innerJoin(projects, eq(projects.id, imports.projectId))
          .where(open(userId))
          .orderBy(desc(imports.createdAt))
      ).map(({ record }) => record as ImportRecord);
    },
    async countOpen(userId) {
      const [row] = await tx()
        .select({ count: sql<number>`count(*)::int` })
        .from(imports)
        .innerJoin(projects, eq(projects.id, imports.projectId))
        .where(and(open(userId), inArray(imports.state, ["uploading", "organizing", "failed"])));
      return row.count;
    },
    async waiting(record) {
      if (record.state !== "organizing" || !record.projectId) return false;
      const [row] = await tx()
        .select({ id: imports.id })
        .from(imports)
        .where(
          and(
            eq(imports.projectId, record.projectId),
            ne(imports.id, record.id),
            eq(imports.state, "organizing"),
            sql`${imports.leaseUntil} > now()`,
          ),
        )
        .limit(1);
      return Boolean(row);
    },
    async maintenanceCandidates(limit) {
      return (await tx()
        .select()
        .from(imports)
        .where(sql`
        (${imports.projectId} IS NULL AND (${imports.state} <> 'cancelled' OR EXISTS (SELECT 1 FROM import_entries e WHERE e.import_id = ${imports.id})))
        OR (${imports.state} IN ('uploading','failed') AND ${imports.lastActivityAt} < now() - interval '7 days')
        OR (${imports.state} IN ('uploading','organizing','failed') AND ${imports.lastActivityAt} > now() - interval '1 day' AND (${imports.objectsSweptAt} IS NULL OR ${imports.objectsSweptAt} < now() - interval '2 hours'))
        OR (${imports.state} IN ('finished','cancelled') AND (${imports.objectsSweptAt} IS NULL OR (${imports.finalSweepAt} IS NULL AND ${imports.finishedAt} < now() - interval '1 day') OR (${imports.objectsSweptAt} < ${imports.finishedAt} + interval '2 hours' AND ${imports.finishedAt} < now() - interval '2 hours')))
        OR (${imports.acknowledgedAt} < now() - interval '30 days' AND EXISTS (SELECT 1 FROM import_entries e WHERE e.import_id = ${imports.id}))
      `)
        .orderBy(imports.lastActivityAt)
        .limit(limit)) as ImportRecord[];
    },
    async deleteEntries(id) {
      await tx().delete(importEntries).where(eq(importEntries.importId, id));
    },
  };
}
