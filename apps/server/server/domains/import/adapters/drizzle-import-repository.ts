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
    pendingRefs: spec.pendingRefs ?? [],
    attemptId: row.attemptId,
    leaseUntil: row.leaseUntil,
    storageUrl: row.storageUrl,
    uri: row.uri,
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
      const [row] = await tx().select().from(importEntries).where(eq(importEntries.id, id));
      if (!row) throw new Error("Import entry missing");
      const merged = { ...entry(row), ...patch };
      await tx()
        .update(importEntries)
        .set({
          spec: merged,
          state: merged.state,
          created: merged.created,
          attemptId: merged.attemptId,
          leaseUntil: merged.leaseUntil,
          storageUrl: merged.storageUrl,
          uri: merged.uri,
        })
        .where(eq(importEntries.id, id));
      changed(row.importId, id);
    },
    async setState(id, state) {
      await tx().update(imports).set({ state }).where(eq(imports.id, id));
      changed(id);
    },
    async sweepCandidates(now) {
      return (
        await tx()
          .select()
          .from(importEntries)
          .where(
            and(
              inArray(importEntries.state, ["deleted", "not_imported"]),
              or(isNull(importEntries.leaseUntil), lte(importEntries.leaseUntil, now)),
            ),
          )
      ).map((row) => ({
        id: row.id,
        importId: row.importId,
        storageUrl: row.storageUrl,
        entryId: entry(row).entryId,
      }));
    },
  };
}
