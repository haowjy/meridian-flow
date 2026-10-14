/** Drizzle import state, shared fences and commit-ordered incremental report cuts. */
import type { ImportCounts, ImportEntryState, ImportState } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { importEntries, importProgress, imports } from "@meridian/database/schema";
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  type DrizzleTransactionParticipant,
  enlistDrizzleTransactionParticipant,
  runInDrizzleTransaction,
  runInRootDrizzleReadSnapshot,
} from "../../../shared/drizzle-transaction.js";
import { lockSeamWorks } from "../../../shared/work-lifecycle-lock.js";
import type { ImportArea } from "../domain/export-marker.js";
import type { ImportLinkCandidate } from "../domain/link-index.js";
import type { PlannedRoot } from "../domain/plan.js";
import type {
  ImportEntry,
  ImportEntryColumnPatch,
  ImportEntryPatch,
  ImportEntryPayload,
  ImportEntryPayloadPatch,
  ImportRecord,
  ImportRepository,
} from "../ports/import-repository.js";

/** The plan header: every import column but the frozen existing-document snapshot. */
const headerColumns = {
  id: imports.id,
  projectId: imports.projectId,
  userId: imports.userId,
  destinationUri: imports.destinationUri,
  roots: imports.roots,
  fingerprint: imports.fingerprint,
  sourceId: imports.sourceId,
  folderId: imports.folderId,
  state: imports.state,
  createdAt: imports.createdAt,
};
function record(
  row: {
    [K in keyof typeof headerColumns]: (typeof imports.$inferSelect)[K];
  },
): ImportRecord {
  return { ...row, roots: row.roots as PlannedRoot[], state: row.state as ImportState };
}
function entry(row: typeof importEntries.$inferSelect): ImportEntry {
  return {
    ...(row.spec as ImportEntryPayload),
    id: row.id,
    order: row.ordinal,
    version: String(row.version),
    state: row.state as ImportEntryState,
    kind: row.kind as ImportEntry["kind"],
    entryId: row.entryId,
    parentId: row.parentId,
    ...(row.area ? { area: row.area as ImportArea } : {}),
    prepared: row.prepared,
    created: row.created,
    attemptId: row.attemptId,
    leaseUntil: row.leaseUntil,
    storageUrl: row.storageUrl,
    uri: row.uri,
    objectSweptAt: row.objectSweptAt,
  };
}
/** Column-owned patch fields with their column and SQL type; payload fields are listed in PAYLOAD_KEYS. */
const COLUMNS: Record<keyof ImportEntryColumnPatch, readonly [column: string, type: string]> = {
  state: ["state", "text"],
  prepared: ["prepared", "boolean"],
  created: ["created", "boolean"],
  attemptId: ["attempt_id", "uuid"],
  leaseUntil: ["lease_until", "timestamptz"],
  storageUrl: ["storage_url", "text"],
  uri: ["uri", "text"],
  objectSweptAt: ["object_swept_at", "timestamptz"],
};
const PAYLOAD_KEYS: ReadonlySet<string> = new Set<keyof ImportEntryPayloadPatch>([
  "name",
  "reason",
  "reasonParams",
  "prependOnRetry",
]);
/** Selects allowed keys positively; a key neither a column nor payload is a caller bug, never silently stored in `spec`. */
function splitPatch(patch: ImportEntryPatch) {
  const payload: ImportEntryPayloadPatch = {},
    columns: ImportEntryColumnPatch = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key in COLUMNS) Object.assign(columns, { [key]: value });
    else if (PAYLOAD_KEYS.has(key)) Object.assign(payload, { [key]: value });
    else throw new Error(`Import entry patch has unknown field ${key}`);
  }
  return { payload, columns };
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
   * Apply patches in one statement: payload fields merge into `spec`, column fields
   * set their columns, and a field is never in both. Callers already hold the rows'
   * locks, so nothing is reread.
   */
  async function updateEntries(
    patches: readonly { id: string; patch: ImportEntryPatch }[],
  ): Promise<void> {
    if (!patches.length) return;
    const values = sql.join(
      patches.map(({ id, patch }) => {
        const { payload, columns } = splitPatch(patch);
        return sql`(${id}::uuid, ${JSON.stringify(payload)}::jsonb, ${JSON.stringify(columns)}::jsonb)`;
      }),
      sql`, `,
    );
    const assignments = Object.entries(COLUMNS).map(([key, [column, type]]) =>
      sql.raw(
        `${column} = CASE WHEN v.columns ? '${key}' THEN (v.columns->>'${key}')::${type} ELSE e.${column} END`,
      ),
    );
    const updated = await tx().execute<{ id: string; import_id: string }>(sql`
      UPDATE import_entries AS e SET
        spec = e.spec || v.payload,
        ${sql.join(assignments, sql`, `)}
      FROM (VALUES ${values}) AS v(id, payload, columns)
      WHERE e.id = v.id
      RETURNING e.id::text AS id, e.import_id::text AS import_id
    `);
    if (updated.length !== patches.length) throw new Error("Import entry missing");
    for (const row of updated) changed(row.import_id, row.id);
  }
  async function read(id: string, projectId: string) {
    const [row] = await tx()
      .select(headerColumns)
      .from(imports)
      .where(and(eq(imports.id, id), eq(imports.projectId, projectId)));
    return row ? record(row) : null;
  }
  async function counts(id: string): Promise<ImportCounts> {
    const rows = await tx()
      .select({
        state: importEntries.state,
        count: sql<number>`count(*)::int`,
      })
      .from(importEntries)
      .where(and(eq(importEntries.importId, id), isNotNull(importEntries.entryId)))
      .groupBy(importEntries.state);
    const result: ImportCounts = {
      total: 0,
      landed: 0,
      failed: 0,
      arriving: 0,
      deleted: 0,
      notImported: 0,
      skipped: 0,
    };
    for (const row of rows) {
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
    async insert(input, existingLinks, nodes) {
      const inserted = await tx()
        .insert(imports)
        .values({ ...input, existingLinks })
        .onConflictDoNothing()
        .returning({ id: imports.id });
      if (!inserted.length) return;
      await tx().insert(importProgress).values({ importId: input.id });
      for (let offset = 0; offset < nodes.length; offset += 200)
        await tx()
          .insert(importEntries)
          .values(
            nodes
              .slice(offset, offset + 200)
              .map(({ id, state, kind, entryId, parentId, area, ...planned }, index) => ({
                id,
                importId: input.id,
                ordinal: offset + index,
                spec: { ...planned, prependOnRetry: false } satisfies ImportEntryPayload,
                kind,
                entryId,
                parentId,
                area: area ?? null,
                state,
              })),
          );
      for (const node of nodes) changed(input.id, node.id);
      if (!nodes.length) changed(input.id);
    },
    read,
    async fence(id, projectId, exclusive = false) {
      const [row] = await tx()
        .select({ state: imports.state, sourceId: imports.sourceId })
        .from(imports)
        .where(and(eq(imports.id, id), eq(imports.projectId, projectId)))
        .for(exclusive ? "update" : "share");
      return row ? { ...row, state: row.state as ImportState } : null;
    },
    async existingLinks(id) {
      const [row] = await tx()
        .select({ existingLinks: imports.existingLinks })
        .from(imports)
        .where(eq(imports.id, id));
      return (row?.existingLinks ?? []) as ImportLinkCandidate[];
    },
    async fileEntryIds(importId, entryIds) {
      if (!entryIds.length) return new Set();
      const rows = await tx()
        .select({ entryId: importEntries.entryId })
        .from(importEntries)
        .where(
          and(
            eq(importEntries.importId, importId),
            inArray(importEntries.entryId, [...entryIds]),
            gte(importEntries.entryId, 0),
          ),
        );
      return new Set(rows.flatMap((row) => (row.entryId === null ? [] : [row.entryId])));
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
          .select(headerColumns)
          .from(imports)
          .where(and(eq(imports.projectId, projectId), sql`${imports.state} <> 'finished'`))
          .orderBy(desc(imports.createdAt));
        return Promise.all(rows.map((row) => summary(record(row))));
      }),
    async touch(id) {
      changed(id);
    },
    async fileEntry(importId, entryId) {
      const [row] = await tx()
        .select()
        .from(importEntries)
        .where(and(eq(importEntries.importId, importId), eq(importEntries.entryId, entryId)));
      return row ? entry(row) : null;
    },
    async hasUnfinished(importId) {
      const [row] = await tx()
        .select({ id: importEntries.id })
        .from(importEntries)
        .where(
          and(
            eq(importEntries.importId, importId),
            ne(importEntries.kind, "folder"),
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
            eq(importEntries.prepared, false),
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
      const unprepared = eq(importEntries.prepared, false);
      const [first] = await tx()
        .select({
          parentId: importEntries.parentId,
          area: importEntries.area,
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
            sql`${importEntries.parentId} IS NOT DISTINCT FROM ${first.parentId}::uuid`,
            sql`${importEntries.area} IS NOT DISTINCT FROM ${first.area}`,
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
          entryId: importEntries.entryId,
        })
        .from(importEntries)
        .where(
          and(
            scope.importId ? eq(importEntries.importId, scope.importId) : undefined,
            sql`${importEntries.attemptId} IS NOT NULL`,
            inArray(importEntries.state, ["deleted", "not_imported"]),
            eq(importEntries.kind, "binary"),
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
      return rows.map((row) => ({ ...row, entryId: row.entryId as number }));
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
