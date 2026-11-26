import type { Database } from "@meridian/database";
import { contextSources, treeNodes, works } from "@meridian/database/schema";
import { eq, inArray, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  getDrizzleTransactionLocal,
  setDrizzleTransactionLocal,
} from "../../../../shared/drizzle-transaction.js";
import { requireLockedActiveWorks } from "../../../../shared/work-lifecycle-lock.js";
import type { ContextCommandScope } from "../../ports/context-command-transaction.js";
import type { TreeList } from "../../ports/tree-list-store.js";
import { ownerFrom, sourceOwnerProjectId } from "../../tree/source-owner.js";

export type ContextNamespace = {
  owner: TreeList;
  scheme: string;
  workId: string | null;
};

export function contextNamespaceKey(input: ContextNamespace): string {
  return input.owner.kind === "account"
    ? `context-user:${input.owner.userId}`
    : `context-project:${input.owner.projectId}:${input.workId ?? "none"}:${input.scheme}`;
}

export async function lockNamespaceKeys(
  db: Database,
  namespaces: readonly ContextNamespace[],
): Promise<void> {
  await lockAdvisoryKeys(db, namespaces.map(contextNamespaceKey));
}

export async function lockContextNamespaces(
  db: Database,
  scopes: readonly ContextCommandScope[],
  options: {
    workIds?: readonly string[];
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
      projectId: sourceOwnerProjectId,
      userId: contextSources.userId,
      workId: contextSources.workId,
      scheme: contextSources.slug,
    })
    .from(contextSources)
    .leftJoin(works, eq(works.id, contextSources.workId))
    .where(inArray(contextSources.id, [...new Set(sourceIds)]));
  return rows.map((row) => ({ owner: ownerFrom(row), workId: row.workId, scheme: row.scheme }));
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
