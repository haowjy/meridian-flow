/** Postgres import locks, durable receipts, and retained summary counts. */
import { IMPORT_NEEDS_LOOK_REASONS, type ImportCounts } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { importEntries, imports, projects } from "@meridian/database/schema";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { lockProjectLifecycleShared } from "../../../shared/project-lifecycle-lock.js";
import type { FileReceipt } from "../domain/receipt.js";
import type {
  ImportEntry,
  ImportEntrySelection,
  ImportRecord,
  ImportRepository,
} from "../ports/import-repository.js";

type EntryRow = typeof importEntries.$inferSelect;
type StoredSpec = ImportEntrySelection &
  Partial<Omit<FileReceipt["facts"], "kind">> & {
    fileKind?: FileReceipt["facts"]["kind"];
    aliases?: string[];
  };
function projectEntry(row: EntryRow): ImportEntry {
  const { fileKind, filetype, mimeType, name, extension, aliases, ...selection } =
    row.spec as StoredSpec;
  let receipt: FileReceipt | null = null;
  if (row.kind === "file" && row.objectKey !== null) {
    if (
      row.storageUrl === null ||
      row.receivedSize === null ||
      row.sha256 === null ||
      fileKind === undefined ||
      filetype === undefined ||
      mimeType === undefined ||
      name === undefined ||
      extension === undefined ||
      aliases === undefined
    )
      throw new Error(`Incomplete import receipt: ${row.id}`);
    receipt = {
      objectKey: row.objectKey,
      storageUrl: row.storageUrl,
      receivedSize: row.receivedSize,
      sha256: row.sha256,
      facts: { kind: fileKind, filetype, mimeType, name, extension },
      aliases,
    };
  }
  return {
    id: row.id,
    importId: row.importId,
    ordinal: row.ordinal,
    kind: row.kind,
    entryId: row.entryId,
    selection,
    receipt,
    state: row.state,
    reason: row.reason,
    changedAfterUpload: row.changedAfterUpload,
    convertedKey: row.convertedKey,
  } as ImportEntry;
}
function receiptColumns(receipt: FileReceipt | null) {
  const { kind: fileKind, ...facts } = receipt?.facts ?? {};
  return {
    objectKey: receipt?.objectKey ?? null,
    storageUrl: receipt?.storageUrl ?? null,
    receivedSize: receipt?.receivedSize ?? null,
    sha256: receipt?.sha256 ?? null,
    facts: receipt ? { ...facts, fileKind, aliases: receipt.aliases } : {},
  };
}
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
    async organizeTransaction(fence, run) {
      return runInDrizzleTransaction(db, async () => {
        const database = currentDrizzleDb(db);
        const [record] = await database
          .select()
          .from(imports)
          .where(eq(imports.id, fence.importId))
          .for("update");
        if (
          record?.state !== "organizing" ||
          record.leaseToken !== fence.token ||
          record.leaseUntil === null ||
          (fence.generation !== undefined && record.placementGeneration !== fence.generation)
        )
          return { kind: "stale_owner" as const };
        const [lease] = await database
          .select({ current: sql<boolean>`${imports.leaseUntil} > clock_timestamp()` })
          .from(imports)
          .where(eq(imports.id, fence.importId));
        if (!lease?.current) return { kind: "stale_owner" as const };
        if (!record.projectId) return { kind: "project_unavailable" as const };
        await lockProjectLifecycleShared(db, record.projectId);
        const [project] = await database
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, record.projectId), isNull(projects.deletedAt)));
        if (!project) return { kind: "project_unavailable" as const };
        return { kind: "committed" as const, value: await run(record as ImportRecord) };
      });
    },
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
          .values(
            entries.slice(offset, offset + 1000).map(({ selection, receipt, ...entry }) => {
              const { facts, ...columns } = receiptColumns(receipt);
              return { ...entry, ...columns, spec: { ...selection, ...facts } };
            }),
          );
    },
    async update(id, patch) {
      await tx().update(imports).set(patch).where(eq(imports.id, id));
    },
    async entries(id) {
      return (
        await tx()
          .select()
          .from(importEntries)
          .where(eq(importEntries.importId, id))
          .orderBy(importEntries.ordinal)
      ).map(projectEntry);
    },
    async fileEntries(importId, entryIds) {
      return (
        await tx()
          .select()
          .from(importEntries)
          .where(
            and(
              eq(importEntries.importId, importId),
              eq(importEntries.kind, "file"),
              inArray(importEntries.entryId, entryIds),
            ),
          )
      ).map((row) => projectEntry(row) as Extract<ImportEntry, { kind: "file" }>);
    },
    async updateEntries(importId, patches) {
      // Presence flags distinguish omitted fields from explicit NULL. Each values column is typed,
      // including all-NULL batches; chunking bounds bind parameters, not transaction concurrency.
      const columns = [
        ["facts", "spec", "jsonb"],
        ["state", "state", "text"],
        ["reason", "reason", "text"],
        ["changedAfterUpload", "changed_after_upload", "boolean"],
        ["storageUrl", "storage_url", "text"],
        ["objectKey", "object_key", "text"],
        ["convertedKey", "converted_key", "text"],
        ["receivedSize", "received_size", "bigint"],
        ["sha256", "sha256", "text"],
      ] as const satisfies readonly (readonly [
        (
          | keyof ReturnType<typeof receiptColumns>
          | "state"
          | "reason"
          | "changedAfterUpload"
          | "convertedKey"
        ),
        string,
        string,
      ])[];
      const names = columns.flatMap(([, name]) => [
        sql.identifier(`has_${name}`),
        sql.identifier(name),
      ]);
      for (let offset = 0; offset < patches.length; offset += 500) {
        const rows = patches
          .slice(offset, offset + 500)
          .map(({ id, patch: { receipt, ...patch } }) => ({
            id,
            patch: { ...patch, ...(receipt === undefined ? {} : receiptColumns(receipt)) },
          }))
          .map(
            ({ id, patch }) =>
              sql`(${sql.join(
                [
                  sql`${id}::uuid`,
                  ...columns.flatMap(([key, , type]) => [
                    sql`${patch[key] !== undefined}::boolean`,
                    sql`${key === "facts" && patch.facts !== undefined ? JSON.stringify(patch.facts) : (patch[key] ?? null)}::${sql.raw(type)}`,
                  ]),
                ],
                sql`, `,
              )})`,
          );
        const assignments = columns.map(([, name]) => {
          const column = sql.identifier(name);
          return sql`${column} = CASE WHEN v.${sql.identifier(`has_${name}`)} THEN ${name === "spec" ? sql`e.${column} || v.${column}` : sql`v.${column}`} ELSE e.${column} END`;
        });
        await tx().execute(sql`
          UPDATE import_entries AS e SET ${sql.join(assignments, sql`, `)}
          FROM (VALUES ${sql.join(rows, sql`, `)}) AS v(id, ${sql.join(names, sql`, `)})
          WHERE e.import_id = ${importId}::uuid AND e.id = v.id
        `);
      }
    },
    async transitionEntries(importId, from, patch, ids) {
      await tx()
        .update(importEntries)
        .set(patch)
        .where(
          and(
            eq(importEntries.importId, importId),
            inArray(importEntries.state, from),
            ids === undefined ? undefined : inArray(importEntries.id, ids),
          ),
        );
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
          needsLook: sql<number>`count(*) FILTER (WHERE ${inArray(importEntries.reason, IMPORT_NEEDS_LOOK_REASONS)} OR ${importEntries.changedAfterUpload})::int`,
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
    async maintenanceCandidates(limit, cutoffs) {
      return (await tx()
        .select()
        .from(imports)
        .where(sql`
        (${imports.projectId} IS NULL AND (${imports.state} <> 'cancelled' OR EXISTS (SELECT 1 FROM import_entries e WHERE e.import_id = ${imports.id})))
        OR (${imports.state} IN ('uploading','failed') AND ${imports.lastActivityAt} < ${cutoffs.expiryBefore.toISOString()}::timestamptz)
        OR (${imports.state} IN ('uploading','organizing','failed') AND ${imports.lastActivityAt} > ${cutoffs.activeSince.toISOString()}::timestamptz AND (${imports.objectsSweptAt} IS NULL OR ${imports.objectsSweptAt} < ${cutoffs.resweepBefore.toISOString()}::timestamptz))
        OR (${imports.state} IN ('finished','cancelled') AND (${imports.objectsSweptAt} IS NULL OR (${imports.finalSweepAt} IS NULL AND ${imports.finishedAt} <= ${cutoffs.finalSweepBefore.toISOString()}::timestamptz) OR (${imports.objectsSweptAt} < ${imports.finishedAt} + ${cutoffs.resweepDelayMs} * interval '1 millisecond' AND ${imports.finishedAt} < ${cutoffs.resweepBefore.toISOString()}::timestamptz)))
        OR (${imports.acknowledgedAt} < ${cutoffs.retentionBefore.toISOString()}::timestamptz AND EXISTS (SELECT 1 FROM import_entries e WHERE e.import_id = ${imports.id}))
      `)
        .orderBy(imports.lastActivityAt)
        .limit(limit)) as ImportRecord[];
    },
    async deleteEntries(id) {
      await tx().delete(importEntries).where(eq(importEntries.importId, id));
    },
  };
}
