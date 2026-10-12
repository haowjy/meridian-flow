/** Drizzle import state, shared fences and commit-ordered incremental report cuts. */
import type {
  ImportCounts,
  ImportEntryState,
  ImportManifest,
  ImportState,
} from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { importEntries, importProgress, imports } from "@meridian/database/schema";
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  type DrizzleTransactionParticipant,
  enlistDrizzleTransactionParticipant,
  runInDrizzleTransaction,
  runInRootDrizzleReadSnapshot,
} from "../../../shared/drizzle-transaction.js";
import { lockSeamWorks } from "../../../shared/work-lifecycle-lock.js";
import type { ImportArea } from "../domain/export-marker.js";
import type { ImportEntry, ImportRecord, ImportRepository } from "../ports/import-repository.js";

function record(row: typeof imports.$inferSelect): ImportRecord {
  return { ...row, manifest: row.manifest as ImportManifest, state: row.state as ImportState };
}
function entry(row: typeof importEntries.$inferSelect): ImportEntry {
  const spec = row.spec as ImportEntry;
  return {
    ...spec,
    id: row.id,
    order: row.ordinal,
    version: String(row.version),
    state: row.state as ImportEntryState,
    created: row.created,
    prepared: !!spec.prepared,
    prependOnRetry: !!spec.prependOnRetry,
    exists: spec.exists ?? row.created,
    pendingRefs: spec.pendingRefs ?? [],
    attemptId: row.attemptId,
    leaseUntil: row.leaseUntil,
    storageUrl: row.storageUrl,
    uri: row.uri,
    objectSweptAt: row.objectSweptAt,
  };
}
export function createDrizzleImportRepository(db: Database): ImportRepository {
  const tx = () => currentDrizzleDb(db);
  type Changes = Map<string, Set<string>>;
  const publication: DrizzleTransactionParticipant<Changes> = {
    key: {},
    create: () => new Map(),
    fork: (parent) => new Map([...parent].map(([id, entries]) => [id, new Set(entries)])),
    merge: (parent, child) => {
      for (const [id, entries] of child) {
        const next = parent.get(id) ?? new Set<string>();
        for (const entry of entries) next.add(entry);
        parent.set(id, next);
      }
      return parent;
    },
    async beforeCommit(changes) {
      // Allocate versions only after every content/entry lock is acquired. Holding this
      // small progress row through commit orders publication without upgrading the fence.
      for (const [id, entries] of [...changes].sort(([a], [b]) => a.localeCompare(b))) {
        const [progress] = await tx()
          .update(importProgress)
          .set({
            version: sql`${importProgress.version} + ${Math.max(1, entries.size)}`,
            lastActivityAt: new Date(),
          })
          .where(eq(importProgress.importId, id))
          .returning();
        if (!progress) throw new Error("Import progress missing");
        if (entries.size)
          await tx()
            .update(importEntries)
            .set({ version: progress.version })
            .where(inArray(importEntries.id, [...entries]));
      }
    },
  };
  function changed(importId: string, entryId?: string) {
    const changes = enlistDrizzleTransactionParticipant(publication),
      ids = changes.get(importId) ?? new Set<string>();
    if (entryId) ids.add(entryId);
    changes.set(importId, ids);
  }
  /**
   * Merge patches into spec and their mirrored columns in one statement. Callers
   * already hold the rows' locks, so nothing is reread.
   */
  async function updateEntries(
    patches: readonly { id: string; patch: Partial<ImportEntry> }[],
  ): Promise<void> {
    if (!patches.length) return;
    const values = sql.join(
      patches.map(({ id, patch }) => sql`(${id}::uuid, ${JSON.stringify(patch)}::jsonb)`),
      sql`, `,
    );
    const column = (key: keyof ImportEntry, name: string, type: string) =>
      sql.raw(
        `${name} = CASE WHEN v.patch ? '${key}' THEN (v.patch->>'${key}')::${type} ELSE e.${name} END`,
      );
    const updated = await tx().execute<{ id: string; import_id: string }>(sql`
      UPDATE import_entries AS e SET
        spec = e.spec || v.patch,
        ${column("state", "state", "text")},
        ${column("created", "created", "boolean")},
        ${column("attemptId", "attempt_id", "uuid")},
        ${column("leaseUntil", "lease_until", "timestamptz")},
        ${column("storageUrl", "storage_url", "text")},
        ${column("uri", "uri", "text")},
        ${column("objectSweptAt", "object_swept_at", "timestamptz")}
      FROM (VALUES ${values}) AS v(id, patch)
      WHERE e.id = v.id
      RETURNING e.id::text AS id, e.import_id::text AS import_id
    `);
    if (updated.length !== patches.length) throw new Error("Import entry missing");
    for (const row of updated) changed(row.import_id, row.id);
  }
  async function read(id: string, projectId: string) {
    const [row] = await tx()
      .select()
      .from(imports)
      .where(and(eq(imports.id, id), eq(imports.projectId, projectId)));
    return row ? record(row) : null;
  }
  async function counts(id: string): Promise<ImportCounts> {
    const rows = await tx()
      .select({
        state: importEntries.state,
        count: sql<number>`count(*)::int`,
        findings: sql<number>`coalesce(sum(jsonb_array_length(${importEntries.spec}->'findings')),0)::int`,
      })
      .from(importEntries)
      .where(
        and(eq(importEntries.importId, id), sql`${importEntries.spec}->>'entryId' is not null`),
      )
      .groupBy(importEntries.state);
    const result: ImportCounts = {
      total: 0,
      landed: 0,
      failed: 0,
      arriving: 0,
      deleted: 0,
      notImported: 0,
      skipped: 0,
      findings: 0,
    };
    for (const row of rows) {
      result.findings += row.findings;
      if (row.state !== "skipped") result.total += row.count;
      if (row.state === "planned" || row.state === "landing") result.arriving += row.count;
      else if (row.state === "not_imported") result.notImported += row.count;
      else if (
        row.state === "landed" ||
        row.state === "failed" ||
        row.state === "deleted" ||
        row.state === "skipped"
      )
        result[row.state] += row.count;
    }
    return result;
  }
  async function summary(row: ImportRecord) {
    const [progress] = await tx()
      .select()
      .from(importProgress)
      .where(eq(importProgress.importId, row.id));
    if (!progress) throw new Error("Import progress missing");
    return {
      record: row,
      counts: await counts(row.id),
      lastActivityAt: progress.lastActivityAt.toISOString(),
      version: String(progress.version),
    };
  }
  return {
    transaction: (run) =>
      runInDrizzleTransaction(db, async () => {
        await lockSeamWorks(db, []);
        return run();
      }),
    async insert(input, nodes) {
      const inserted = await tx().insert(imports).values(input).onConflictDoNothing().returning();
      if (!inserted.length) return;
      await tx().insert(importProgress).values({ importId: input.id });
      for (let offset = 0; offset < nodes.length; offset += 200)
        await tx()
          .insert(importEntries)
          .values(
            nodes.slice(offset, offset + 200).map((node, index) => ({
              id: node.id,
              importId: input.id,
              ordinal: offset + index,
              spec: node,
              state: node.state,
            })),
          );
      for (const node of nodes) changed(input.id, node.id);
      if (!nodes.length) changed(input.id);
    },
    read,
    async fence(id, projectId, exclusive = false) {
      const [row] = await tx()
        .select()
        .from(imports)
        .where(and(eq(imports.id, id), eq(imports.projectId, projectId)))
        .for(exclusive ? "update" : "share");
      return row ? record(row) : null;
    },
    async entries(id) {
      return (
        await tx()
          .select()
          .from(importEntries)
          .where(eq(importEntries.importId, id))
          .orderBy(importEntries.ordinal)
      ).map(entry);
    },
    snapshot: (id, projectId, since) =>
      runInRootDrizzleReadSnapshot(db, async () => {
        const row = await read(id, projectId);
        if (!row) return null;
        const cut = await summary(row);
        const rows = await tx()
          .select()
          .from(importEntries)
          .where(
            and(
              eq(importEntries.importId, id),
              since === undefined ? undefined : gt(importEntries.version, BigInt(since)),
            ),
          )
          .orderBy(importEntries.ordinal);
        return { ...cut, entries: rows.map(entry) };
      }),
    listOpen: (projectId) =>
      runInRootDrizzleReadSnapshot(db, async () => {
        const rows = await tx()
          .select()
          .from(imports)
          .where(
            and(
              eq(imports.projectId, projectId),
              or(sql`${imports.state} <> 'finished'`, isNull(imports.dismissedAt)),
            ),
          )
          .orderBy(desc(imports.createdAt));
        return Promise.all(rows.map((row) => summary(record(row))));
      }),
    async touch(id) {
      changed(id);
    },
    async dismiss(id) {
      await tx().update(imports).set({ dismissedAt: new Date() }).where(eq(imports.id, id));
      changed(id);
    },
    async fileEntry(importId, entryId) {
      const [row] = await tx()
        .select()
        .from(importEntries)
        .where(
          and(
            eq(importEntries.importId, importId),
            sql`${importEntries.spec}->>'entryId' = ${String(entryId)}`,
          ),
        );
      return row ? entry(row) : null;
    },
    async hasUnfinished(importId) {
      const [row] = await tx()
        .select({ id: importEntries.id })
        .from(importEntries)
        .where(
          and(
            eq(importEntries.importId, importId),
            sql`${importEntries.spec}->>'kind' <> 'folder'`,
            sql`${importEntries.state} NOT IN ('landed','skipped','deleted')`,
          ),
        )
        .limit(1);
      return !!row;
    },
    async hasUnprepared(importId) {
      const [row] = await tx()
        .select({ id: importEntries.id })
        .from(importEntries)
        .where(
          and(
            eq(importEntries.importId, importId),
            eq(importEntries.state, "planned"),
            sql`coalesce((${importEntries.spec}->>'prepared')::boolean, false) = false`,
          ),
        )
        .limit(1);
      return !!row;
    },
    async lockEntries(ids, options) {
      if (!ids.length) return [];
      const rows = await tx()
        .select()
        .from(importEntries)
        .where(inArray(importEntries.id, [...ids]))
        .orderBy(importEntries.ordinal)
        .for("update", options?.skipLocked ? { skipLocked: true } : {});
      return rows.map(entry);
    },
    async nextPlanningGroup(importId) {
      const unprepared = sql`coalesce((${importEntries.spec}->>'prepared')::boolean, false) = false`;
      const [first] = await tx()
        .select({
          parentId: sql<string | null>`${importEntries.spec}->>'parentId'`,
          area: sql<string | null>`${importEntries.spec}->>'area'`,
        })
        .from(importEntries)
        .where(
          and(eq(importEntries.importId, importId), eq(importEntries.state, "planned"), unprepared),
        )
        .orderBy(importEntries.ordinal)
        .limit(1);
      if (!first) return null;
      const rows = await tx()
        .select()
        .from(importEntries)
        .where(
          and(
            eq(importEntries.importId, importId),
            eq(importEntries.state, "planned"),
            eq(importEntries.created, false),
            sql`${importEntries.spec}->>'parentId' IS NOT DISTINCT FROM ${first.parentId}`,
            sql`${importEntries.spec}->>'area' IS NOT DISTINCT FROM ${first.area}`,
          ),
        )
        .orderBy(importEntries.ordinal);
      const group = rows.map(entry);
      return {
        parentId: first.parentId,
        ...(first.area ? { area: first.area as ImportArea } : {}),
        pending: group.filter((item) => !item.prepared),
        reserved: group.filter((item) => item.prepared),
      };
    },
    async lockEntry(id) {
      const [row] = await tx()
        .select()
        .from(importEntries)
        .where(eq(importEntries.id, id))
        .for("update");
      if (!row) throw new Error("Import entry missing");
      return entry(row);
    },
    async updateEntry(id, patch) {
      await updateEntries([{ id, patch }]);
    },
    updateEntries,
    async setState(id, state) {
      await tx().update(imports).set({ state }).where(eq(imports.id, id));
      changed(id);
    },
    async sweepCandidates(now, scope) {
      const grace = sql`${importEntries.leaseUntil} + make_interval(secs => ${scope.graceMs / 1000})`;
      const rows = await tx()
        .select({
          id: importEntries.id,
          importId: importEntries.importId,
          entryId: sql<string>`${importEntries.spec}->>'entryId'`,
        })
        .from(importEntries)
        .where(
          and(
            scope.importId ? eq(importEntries.importId, scope.importId) : undefined,
            sql`${importEntries.attemptId} IS NOT NULL`,
            inArray(importEntries.state, ["deleted", "not_imported"]),
            sql`${importEntries.spec}->>'kind' = 'binary'`,
            or(isNull(importEntries.leaseUntil), lte(importEntries.leaseUntil, now)),
            or(
              isNull(importEntries.objectSweptAt),
              and(
                sql`${importEntries.objectSweptAt} < ${grace}`,
                sql`${now.toISOString()}::timestamptz >= ${grace}`,
              ),
            ),
          ),
        )
        .orderBy(importEntries.leaseUntil)
        .limit(scope.limit);
      return rows.map((row) => ({ ...row, entryId: Number(row.entryId) }));
    },
    async markSwept(ids, at) {
      if (!ids.length) return;
      await tx()
        .update(importEntries)
        .set({ objectSweptAt: at })
        .where(inArray(importEntries.id, [...ids]));
    },
  };
}
