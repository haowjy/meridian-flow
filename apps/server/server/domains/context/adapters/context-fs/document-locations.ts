/** Transactional namespace locks and live-path occupancy checks for context commands. */
import type { Database } from "@meridian/database";
import { contextSources, projects, treeNodes, works } from "@meridian/database/schema";
import { eq, inArray, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  getDrizzleTransactionLocal,
  setDrizzleTransactionLocal,
} from "../../../../shared/drizzle-transaction.js";
import { requireLockedActiveWorks } from "../../../../shared/work-lifecycle-lock.js";
import type { ContextCommandScope } from "../../ports/context-command-transaction.js";

export type ContextNamespace = {
  projectId: string;
  userId: string;
  scheme: string;
  workId: string | null;
};

export function contextNamespaceKey(input: ContextNamespace): string {
  return input.scheme === "user"
    ? `context-user:${input.userId}`
    : `context-project:${input.projectId}:${input.workId ?? "none"}:${input.scheme}`;
}

/** Acquire only namespace locks. Callers are responsible for Work checks. */
export async function lockNamespaceKeys(
  db: Database,
  namespaces: readonly ContextNamespace[],
): Promise<void> {
  await lockAdvisoryKeys(db, namespaces.map(contextNamespaceKey));
}

/**
 * Seam C (file-access §5): Work rows in id order, the lineages' draft-owner locks and the bound
 * edit grants' confirmation, then `afterWorkLocks` (a branch write's branch row, contract §14).
 * No namespace key: a tree write is a record in the project's list, whose lock a document or
 * namespace key must follow (`context/.context/tree-list-store.md`). An arrival takes the
 * namespace keys it settles ahead refs under after its records (`lockDocumentNamespaces`).
 */
export async function lockContextNamespaces(
  db: Database,
  scopes: readonly ContextCommandScope[],
  options: {
    workIds?: readonly string[];
    /** Lineages whose draft-owner locks join the Work locks, right after them. */
    lineageRootIds?: readonly string[];
    sourceIds?: readonly string[];
    afterWorkLocks?: () => Promise<void>;
  } = {},
): Promise<void> {
  const sources = await sourceNamespaces(db, options.sourceIds ?? []);
  const workIds = [
    ...new Set([
      ...scopes.flatMap((scope) => (scope.workId ? [scope.workId] : [])),
      ...(options.workIds ?? []),
      ...sources.flatMap((source) => (source.workId ? [source.workId] : [])),
    ]),
  ];
  await requireLockedActiveWorks(db, workIds, options.lineageRootIds);
  await options.afterWorkLocks?.();
}

/**
 * Namespace keys of the sources these documents occupy now, Trash included, together with explicit sources (an Apply's final locations), in one
 * sorted acquisition. Arrivals that are not authored writes (Apply, Work restore) take these
 * after their Work locks and before any holder lock (contract §9.2, O6).
 */
export async function lockDocumentNamespaces(
  db: Database,
  documentIds: readonly string[],
  sourceIds: readonly string[] = [],
): Promise<void> {
  if (documentIds.length === 0 && sourceIds.length === 0) return;
  const rows =
    documentIds.length === 0
      ? []
      : await currentDrizzleDb(db)
          .selectDistinct({ sourceId: treeNodes.contextSourceId })
          .from(treeNodes)
          .where(inArray(treeNodes.id, [...new Set(documentIds)]));
  await lockNamespaceKeys(
    db,
    await sourceNamespaces(db, [...rows.map((row) => row.sourceId), ...sourceIds]),
  );
}

async function sourceNamespaces(
  db: Database,
  sourceIds: readonly string[],
): Promise<ContextNamespace[]> {
  if (sourceIds.length === 0) return [];
  const rows = await currentDrizzleDb(db)
    .select({
      projectId: contextSources.projectId,
      userId: projects.userId,
      workId: contextSources.workId,
      workProjectId: works.projectId,
      scheme: contextSources.slug,
    })
    .from(contextSources)
    .leftJoin(projects, eq(projects.id, contextSources.projectId))
    .leftJoin(works, eq(works.id, contextSources.workId))
    .where(inArray(contextSources.id, [...new Set(sourceIds)]));
  return rows.map((row) => ({
    projectId: (row.projectId ?? row.workProjectId) as string,
    userId: row.userId ?? "",
    workId: row.workId,
    scheme: row.scheme,
  }));
}

const namespaceLocks = {};
export function assertNamespaceKeysHeld(namespaces: readonly ContextNamespace[]): void {
  const held = getDrizzleTransactionLocal<ReadonlySet<string>>(namespaceLocks);
  for (const namespace of namespaces) {
    const key = contextNamespaceKey(namespace);
    if (!held?.has(key)) throw new Error(`Namespace not locked: ${key}`);
  }
}

async function lockAdvisoryKeys(db: Database, keys: readonly string[]): Promise<void> {
  const ordered = [...new Set(keys)].sort();
  if (!ordered.length) return;
  await currentDrizzleDb(db).execute(sql`
    select pg_advisory_xact_lock(hashtextextended(key, 0::bigint))
    from (select value as key from jsonb_array_elements_text(${JSON.stringify(ordered)}::jsonb) order by value) ordered`);
  setDrizzleTransactionLocal(
    namespaceLocks,
    new Set([
      ...(getDrizzleTransactionLocal<ReadonlySet<string>>(namespaceLocks) ?? []),
      ...ordered,
    ]),
  );
}
