/** Drizzle adapter for authoritative catalog snapshots, replay, and mutation reconciliation. */
import { randomUUID } from "node:crypto";
import type { ContextSourceId, DocumentId } from "@meridian/contracts";
import { type ContextUriScheme, canonicalContextUri } from "@meridian/contracts/context-uri";
import type {
  CatalogChange,
  CatalogChanges,
  CatalogChildrenRequest,
  CatalogChildrenResult,
  CatalogCommit,
  CatalogEntry,
  CatalogLookupRequest,
  CatalogLookupResult,
  CatalogScope,
  CatalogSnapshot,
} from "@meridian/contracts/protocol";
import { catalogScopeKey } from "@meridian/contracts/protocol";
import { decodeWorkHandle } from "@meridian/contracts/works";
import type { Database } from "@meridian/database";
import {
  contextAvailabilityHeads,
  contextCatalogCommits,
  contextCatalogEntries,
  contextCatalogScopeHeads,
  contextSources,
  projects,
  threads,
  uploadIntakes,
  works,
} from "@meridian/database/schema";
import { and, asc, eq, gt, inArray, isNull, lt, lte, ne, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runAfterDrizzleCommit,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import type {
  ContextCatalog,
  ContextCatalogFileMutationPort,
  ContextCatalogMutationPort,
  ContextCatalogWakePort,
  ProjectCatalogLifecyclePort,
  WorkAuthorityCatalogMutationPort,
} from "../ports/context-catalog.js";
import { normalizeCatalogChangesLimit } from "../ports/context-catalog.js";
import type { ProjectContextAvailabilityMutationPort } from "../ports/project-context-availability.js";
import { loadJoinedFrom } from "../tree/forwards.js";
import {
  createTreeReader,
  LIVE_TREE,
  visibleDocuments,
  visibleFolders,
} from "../tree/tree-view.js";
import { catalogSourceAuthority, mapAuthoritativeFile } from "./catalog-file-mapper.js";
import { createDrizzleProjectContextAvailability } from "./project-context-availability.js";

const DEFAULT_RETAINED_COMMITS_PER_SCOPE = 1_000;
/** Postgres binds at most 65,534 parameters per statement; an entry row binds three. */
const ENTRY_INSERT_ROWS = 10_000;

type CatalogDb = Pick<Database, "delete" | "insert" | "select" | "update">;

type CursorPayload = { scopeKey: string; generation: string; revision: number };

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Partial<CursorPayload>;
    if (
      typeof value.scopeKey !== "string" ||
      typeof value.generation !== "string" ||
      typeof value.revision !== "number" ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0
    )
      return null;
    return value as CursorPayload;
  } catch {
    return null;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** An entry without its namespace stamp: what a namespace change compares. */
function unstamped(entry: CatalogEntry): unknown {
  if (entry.kind !== "file" && entry.kind !== "folder") return entry;
  const { observationVersion: _stamp, ...rest } = entry;
  return rest;
}

function scopeForSource(row: {
  sourceProjectId: string | null;
  sourceWorkId: string | null;
  sourceRootThreadId: string | null;
  sourceChatThreadId: string | null;
  projectUserId: string | null;
  projectIsPersonal: boolean | null;
  workProjectId: string | null;
  sourceSlug: string;
}): CatalogScope | null {
  if (row.sourceRootThreadId && row.sourceProjectId)
    return {
      kind: "lineage",
      projectId: row.sourceProjectId,
      rootThreadId: row.sourceRootThreadId,
    };
  if (row.sourceChatThreadId && row.sourceProjectId)
    return { kind: "chat", projectId: row.sourceProjectId, chatId: row.sourceChatThreadId };
  if (row.sourceWorkId && row.workProjectId) {
    return { kind: "work", projectId: row.workProjectId, workId: row.sourceWorkId };
  }
  if (!row.sourceProjectId) return null;
  if (row.sourceSlug === "user" && row.projectIsPersonal && row.projectUserId) {
    return { kind: "user", userId: row.projectUserId };
  }
  if (row.sourceSlug === "scratch" || row.sourceSlug === "uploads") return null;
  return { kind: "project", projectId: row.sourceProjectId };
}

function catalogDispatchScopes(row: Parameters<typeof scopeForSource>[0]): readonly CatalogScope[] {
  const scope = scopeForSource(row);
  return scope ? [scope] : [];
}

async function sourceScopes(db: CatalogDb, sourceId: string): Promise<readonly CatalogScope[]> {
  const [row] = await db
    .select({
      sourceProjectId: contextSources.projectId,
      sourceWorkId: contextSources.workId,
      sourceRootThreadId: contextSources.rootThreadId,
      sourceChatThreadId: contextSources.chatThreadId,
      sourceSlug: contextSources.slug,
      projectUserId: projects.userId,
      projectIsPersonal: projects.isPersonal,
      workProjectId: works.projectId,
    })
    .from(contextSources)
    .leftJoin(projects, eq(contextSources.projectId, projects.id))
    .leftJoin(works, eq(contextSources.workId, works.id))
    .where(eq(contextSources.id, sourceId as never))
    .limit(1);
  return row ? catalogDispatchScopes(row) : [];
}

async function sourcesForScope(db: CatalogDb, scope: CatalogScope) {
  const conditions =
    scope.kind === "lineage"
      ? and(
          eq(contextSources.rootThreadId, scope.rootThreadId),
          eq(contextSources.projectId, scope.projectId),
          isNull(contextSources.deletedAt),
        )
      : scope.kind === "chat"
        ? and(
            eq(contextSources.chatThreadId, scope.chatId),
            eq(contextSources.projectId, scope.projectId),
            isNull(contextSources.deletedAt),
          )
        : scope.kind === "work"
          ? and(eq(contextSources.workId, scope.workId), isNull(contextSources.deletedAt))
          : scope.kind === "user"
            ? and(
                eq(projects.userId, scope.userId),
                eq(projects.isPersonal, true),
                eq(contextSources.slug, "user"),
                isNull(projects.deletedAt),
                isNull(contextSources.deletedAt),
              )
            : and(
                eq(contextSources.projectId, scope.projectId),
                inArray(contextSources.slug, ["manuscript", "kb", "unfiled"]),
                isNull(contextSources.deletedAt),
              );
  return db
    .select({
      id: contextSources.id,
      name: contextSources.name,
      slug: contextSources.slug,
      workId: contextSources.workId,
      workHandle: works.handle,
      chatThreadId: contextSources.chatThreadId,
      ownerThreadRef: threads.ref,
      orderPolicy: contextSources.orderPolicy,
    })
    .from(contextSources)
    .leftJoin(projects, eq(contextSources.projectId, projects.id))
    .leftJoin(works, eq(contextSources.workId, works.id))
    .leftJoin(
      threads,
      eq(threads.id, sql`coalesce(${contextSources.rootThreadId}, ${contextSources.chatThreadId})`),
    )
    .where(conditions)
    .orderBy(asc(contextSources.sortOrder), asc(contextSources.id));
}

/** The catalog is the live tree: hidden rows and folders never reach it (contract §3.4). */
async function buildScopeEntries(db: CatalogDb, scope: CatalogScope): Promise<CatalogEntry[]> {
  if (scope.kind !== "user") {
    const [activeProject] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, scope.projectId), isNull(projects.deletedAt)))
      .limit(1);
    if (!activeProject) return [];
    if (scope.kind === "work") {
      const [visibleWork] = await db
        .select({ id: works.id })
        .from(works)
        .where(
          and(
            eq(works.id, scope.workId),
            eq(works.projectId, scope.projectId),
            isNull(works.deletedAt),
          ),
        )
        .limit(1);
      if (!visibleWork) return [];
    }
  }
  const [namespaceHead] = await db
    .select({ version: contextAvailabilityHeads.namespaceGeneration })
    .from(contextAvailabilityHeads)
    .where(
      eq(
        contextAvailabilityHeads.authorityKey,
        scope.kind === "user" ? `user:${scope.userId}` : `project:${scope.projectId}`,
      ),
    );
  const observationVersion = String(namespaceHead?.version ?? 0n);
  const sourceRows = await sourcesForScope(db, scope);
  const sourceIds = sourceRows.map((row) => row.id as ContextSourceId);
  const vf = visibleFolders(LIVE_TREE);
  const vd = visibleDocuments(LIVE_TREE);
  const folderRows =
    sourceIds.length === 0
      ? []
      : await db
          .select({
            id: vf.id,
            contextSourceId: vf.contextSourceId,
            parentId: vf.parentId,
            name: vf.name,
            description: vf.description,
            rank: vf.rank,
            locationVersion: vf.locationVersion,
            orderPolicy: vf.orderPolicy,
            createdAt: vf.createdAt,
            updatedAt: vf.updatedAt,
          })
          .from(vf)
          .where(inArray(vf.contextSourceId, sourceIds));
  const documentRows =
    sourceIds.length === 0
      ? []
      : await db
          .select({
            id: vd.id,
            contextSourceId: vd.contextSourceId,
            folderId: vd.folderId,
            name: vd.name,
            extension: vd.extension,
            fileType: vd.fileType,
            storageUrl: vd.storageUrl,
            mimeType: vd.mimeType,
            metadata: vd.metadata,
            provisionalName: vd.provisionalName,
            rank: vd.rank,
            locationVersion: vd.locationVersion,
          })
          .from(vd)
          .where(inArray(vd.contextSourceId, sourceIds));
  const joinedFrom = await loadJoinedFrom(
    db as Database,
    documentRows.map((document) => document.id as DocumentId),
  );
  const chatSourceIds = new Set(sourceRows.filter((r) => r.chatThreadId !== null).map((r) => r.id));
  const chatDocumentIds = documentRows
    .filter((document) => chatSourceIds.has(document.contextSourceId))
    .map((document) => document.id);
  // `used` is the intake's `already_used` rule: a sent message consumed the upload.
  const uploadFacts = new Map(
    chatDocumentIds.length === 0
      ? []
      : (
          await db
            .select({
              documentId: uploadIntakes.documentId,
              createdAt: uploadIntakes.createdAt,
              consumedAt: uploadIntakes.consumedAt,
              intakeId: uploadIntakes.intakeId,
              locationRevision: uploadIntakes.locationRevision,
            })
            .from(uploadIntakes)
            .where(
              and(
                inArray(uploadIntakes.documentId, chatDocumentIds as DocumentId[]),
                ne(uploadIntakes.state, "deleted"),
              ),
            )
        ).map((row) => [
          row.documentId as string,
          {
            attachedAt: row.createdAt,
            consumed: row.consumedAt !== null,
            intakeId: row.intakeId,
            locationRevision: row.locationRevision,
          },
        ]),
  );
  const foldersById = new Map(folderRows.map((folder) => [folder.id, folder]));
  const childCounts = new Map<string, number>();
  for (const folder of folderRows) {
    const parent = folder.parentId ?? folder.contextSourceId;
    childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
  }
  for (const document of documentRows) {
    const parent = document.folderId ?? document.contextSourceId;
    childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
  }
  const pathForFolder = (folderId: string | null, sourceId: string): string[] | null => {
    const result: string[] = [];
    const visited = new Set<string>();
    let current = folderId;
    while (current) {
      if (visited.has(current)) return null;
      visited.add(current);
      const folder = foldersById.get(current);
      if (!folder || folder.contextSourceId !== sourceId) return null;
      result.unshift(folder.name);
      current = folder.parentId;
    }
    return result;
  };
  const entries: CatalogEntry[] = [];
  for (const source of sourceRows) {
    const scheme = source.slug as ContextUriScheme;
    const authority = catalogSourceAuthority(
      scheme,
      source.workId,
      source.workHandle,
      source.ownerThreadRef,
      source.chatThreadId !== null,
    );
    entries.push({
      kind: "source",
      entryId: source.id,
      scope,
      scheme,
      name: source.name,
      uri: canonicalContextUri(scheme, "", authority),
      orderPolicy: source.orderPolicy,
    });
    for (const folder of folderRows.filter((item) => item.contextSourceId === source.id)) {
      const path = pathForFolder(folder.id, source.id);
      if (!path) continue;
      entries.push({
        kind: "folder",
        observationVersion,
        locationVersion: folder.locationVersion.toString(),
        entryId: folder.id,
        scope,
        sourceId: source.id,
        parentId: folder.parentId ?? source.id,
        name: folder.name,
        path,
        uri: canonicalContextUri(scheme, path.join("/"), authority),
        hasChildren: (childCounts.get(folder.id) ?? 0) > 0,
        rank: folder.rank,
        orderPolicy: folder.orderPolicy,
      });
    }
    for (const document of documentRows.filter((item) => item.contextSourceId === source.id)) {
      const parentPath = pathForFolder(document.folderId, source.id);
      if (!parentPath) continue;
      entries.push(
        mapAuthoritativeFile({
          document: { ...document, joinedFrom: joinedFrom.get(document.id as DocumentId) },
          scope,
          observationVersion,
          scheme,
          workId: source.workId,
          workHandle: source.workHandle,
          ownerThreadRef: source.ownerThreadRef,
          chatOwned: source.chatThreadId !== null,
          upload: uploadFacts.get(document.id),
          parentPath,
        }),
      );
    }
  }
  if (scope.kind === "project") {
    const workRows = await db
      .select({
        id: works.id,
        handle: works.handle,
        name: works.name,
        archivedAt: works.archivedAt,
        deletedAt: works.deletedAt,
        entityRevision: works.entityRevision,
      })
      .from(works)
      .where(eq(works.projectId, scope.projectId));
    for (const work of workRows) {
      const workHandle = work.handle === null ? null : decodeWorkHandle(work.handle);
      if (work.handle !== null && !workHandle) continue;
      entries.push({
        kind: "authority",
        entryId: work.id,
        scope,
        authority: { workId: work.id, workHandle },
        name: work.name,
        available: work.deletedAt === null && work.archivedAt === null,
        entityRevision: String(work.entityRevision),
      });
    }
  }
  return entries.sort((left, right) => left.entryId.localeCompare(right.entryId));
}

async function ensureHead(db: CatalogDb, scope: CatalogScope) {
  const key = catalogScopeKey(scope);
  await db.insert(contextCatalogScopeHeads).values({ scopeKey: key, scope }).onConflictDoNothing();
  const [head] = await db
    .select()
    .from(contextCatalogScopeHeads)
    .where(eq(contextCatalogScopeHeads.scopeKey, key))
    .limit(1);
  if (!head) throw new Error(`Failed to create catalog head: ${key}`);
  return head;
}

function mapCommit(row: typeof contextCatalogCommits.$inferSelect): CatalogCommit {
  return {
    eventId: row.eventId,
    commitId: row.commitId,
    firstRevision: String(row.firstRevision),
    lastRevision: String(row.lastRevision),
    changes: row.changes,
  };
}

export function createDrizzleContextCatalog(
  db: Database,
  wakePort?: ContextCatalogWakePort,
  options: {
    retainedCommitsPerScope?: number;
    availabilityMutations?: ProjectContextAvailabilityMutationPort;
  } = {},
): ContextCatalog &
  ContextCatalogMutationPort &
  ContextCatalogFileMutationPort &
  ProjectCatalogLifecyclePort &
  WorkAuthorityCatalogMutationPort {
  const availabilityMutations =
    options.availabilityMutations ?? createDrizzleProjectContextAvailability(db);
  const retainedCommitsPerScope = Math.max(
    1,
    Math.floor(options.retainedCommitsPerScope ?? DEFAULT_RETAINED_COMMITS_PER_SCOPE),
  );
  type ScopePlan = {
    scope: CatalogScope;
    head: typeof contextCatalogScopeHeads.$inferSelect;
    authoritative: CatalogEntry[];
    oldById: Map<string, CatalogEntry>;
    invalidatedRoots: string[];
    namespaceChanged: boolean;
  };

  /** Lock the scope's head and read what it publishes now against what it last published. */
  async function planScope(
    tx: Database,
    scope: CatalogScope,
    invalidatedRootIds: readonly string[],
  ): Promise<ScopePlan> {
    const initialHead = await ensureHead(tx, scope);
    await tx.execute(
      sql`select 1 from ${contextCatalogScopeHeads} where ${contextCatalogScopeHeads.scopeKey} = ${initialHead.scopeKey} for update`,
    );
    const [head] = await tx
      .select()
      .from(contextCatalogScopeHeads)
      .where(eq(contextCatalogScopeHeads.scopeKey, initialHead.scopeKey))
      .limit(1);
    if (!head) throw new Error(`Catalog head disappeared: ${initialHead.scopeKey}`);
    const authoritative = await buildScopeEntries(tx, scope);
    const existing = await tx
      .select()
      .from(contextCatalogEntries)
      .where(eq(contextCatalogEntries.scopeKey, head.scopeKey));
    const oldById = new Map(existing.map((row) => [row.entryId, row.entry]));
    const nextById = new Map(authoritative.map((entry) => [entry.entryId, entry]));
    // Only roots this scope has published or publishes now: a hidden node a branch let go
    // (Discard) was never in a live scope, and naming it would leak it.
    const invalidatedRoots = [...new Set(invalidatedRootIds)].filter(
      (id) => oldById.has(id) || nextById.has(id),
    );
    const isNamespace = (entry: CatalogEntry) => entry.kind !== "authority";
    const namespaceChanged =
      invalidatedRoots.length > 0 ||
      authoritative.some((entry) => {
        const old = oldById.get(entry.entryId);
        return (
          isNamespace(entry) &&
          (!old || stableJson(unstamped(old)) !== stableJson(unstamped(entry)))
        );
      }) ||
      [...oldById.values()].some((entry) => isNamespace(entry) && !nextById.has(entry.entryId));
    return { scope, head, authoritative, oldById, invalidatedRoots, namespaceChanged };
  }

  /** Install one scope's plan as one catalog commit, or nothing when nothing changed. */
  async function commitScope(tx: Database, plan: ScopePlan, commitId: string) {
    const { scope, head, authoritative, oldById, invalidatedRoots } = plan;
    const nextById = new Map(authoritative.map((entry) => [entry.entryId, entry]));
    // Replay clears the old subtree before installing this commit. Restore every
    // survivor, including entries already published by a separate repair and
    // descendants that moved out of the root during this refresh.
    const replacedIds = new Set(invalidatedRoots);
    const children = new Map<string, Set<string>>();
    for (const entry of [...oldById.values(), ...nextById.values()]) {
      if (entry.kind !== "folder" && entry.kind !== "file") continue;
      const ids = children.get(entry.parentId) ?? new Set<string>();
      ids.add(entry.entryId);
      children.set(entry.parentId, ids);
    }
    for (const entryId of replacedIds) {
      for (const childId of children.get(entryId) ?? []) replacedIds.add(childId);
    }
    const changes: CatalogChange[] = [];
    for (const rootEntryId of invalidatedRoots) {
      changes.push({ operation: "invalidate-subtree", ordinal: changes.length, rootEntryId });
    }
    for (const [entryId, entry] of nextById) {
      const old = oldById.get(entryId);
      if (replacedIds.has(entryId) || !old || stableJson(old) !== stableJson(entry)) {
        changes.push({ operation: "upsert", ordinal: changes.length, entry });
      }
    }
    for (const entryId of oldById.keys()) {
      if (!nextById.has(entryId)) {
        changes.push({ operation: "delete", ordinal: changes.length, entryId });
      }
    }
    if (changes.length === 0) return;
    const revision = head.headRevision + 1;
    await tx.delete(contextCatalogEntries).where(eq(contextCatalogEntries.scopeKey, head.scopeKey));
    for (let offset = 0; offset < authoritative.length; offset += ENTRY_INSERT_ROWS) {
      await tx.insert(contextCatalogEntries).values(
        authoritative.slice(offset, offset + ENTRY_INSERT_ROWS).map((entry) => ({
          scopeKey: head.scopeKey,
          entryId: entry.entryId,
          entry,
        })),
      );
    }
    await tx.insert(contextCatalogCommits).values({
      commitId,
      scopeKey: head.scopeKey,
      firstRevision: revision,
      lastRevision: revision,
      changes,
    });
    const oldestRevision = Math.max(1, revision - retainedCommitsPerScope + 1);
    await tx
      .update(contextCatalogScopeHeads)
      .set({ headRevision: revision, oldestRevision, updatedAt: new Date() })
      .where(eq(contextCatalogScopeHeads.scopeKey, head.scopeKey));
    await tx
      .delete(contextCatalogCommits)
      .where(
        and(
          eq(contextCatalogCommits.scopeKey, head.scopeKey),
          lt(contextCatalogCommits.lastRevision, oldestRevision),
        ),
      );
    runAfterDrizzleCommit(async () => {
      if (!wakePort) return;
      try {
        await wakePort.publish({
          type: "context-catalog-hint",
          scope,
          headRevision: String(revision),
        });
      } catch {
        // Wake hints are explicitly lossy. Pull-on-focus/poll repairs delivery.
      }
    });
  }

  /**
   * Reconcile `scopes` against the authoritative tree. Only a namespace change (a live
   * file, folder or source added, removed, changed or invalidated) allocates a namespace
   * observation version, and it stamps only the scopes that changed. A scope without one,
   * such as a branch's hidden-only lifecycle, keeps its published entries and stamps, so it
   * publishes at most its authority entries.
   */
  async function reconcileScopes(
    scopes: readonly CatalogScope[],
    authorities: { projectIds: readonly string[]; userIds: readonly string[] },
    invalidatedRootIds: readonly string[] = [],
  ): Promise<string> {
    return runInDrizzleTransaction(db, async () => {
      const tx = currentDrizzleDb(db) as Database;
      const commitId = randomUUID();
      // Availability's publisher fence before any catalog head lock (lock order).
      const availabilityGeneration = await availabilityMutations.advance(authorities);
      const plans: ScopePlan[] = [];
      for (const scope of [...scopes].sort((a, b) =>
        catalogScopeKey(a).localeCompare(catalogScopeKey(b)),
      )) {
        plans.push(await planScope(tx, scope, invalidatedRootIds));
      }
      const changed = plans.filter((plan) => plan.namespaceChanged);
      if (changed.length > 0) {
        const userIds = new Set<string>();
        const projectIds = new Set<string>();
        for (const { scope } of changed) {
          if (scope.kind === "user") userIds.add(scope.userId);
          else projectIds.add(scope.projectId);
        }
        const version = await availabilityMutations.publishNamespace({
          projectIds: [...projectIds],
          userIds: [...userIds],
        });
        for (const plan of changed) {
          plan.authoritative = plan.authoritative.map((entry) =>
            entry.kind === "file" || entry.kind === "folder"
              ? { ...entry, observationVersion: version }
              : entry,
          );
        }
      }
      for (const plan of plans) {
        if (!plan.namespaceChanged) {
          // Structurally equal: keep each published entry, stamp and all.
          plan.authoritative = plan.authoritative.map((entry) =>
            entry.kind === "authority" ? entry : (plan.oldById.get(entry.entryId) ?? entry),
          );
        }
        await commitScope(tx, plan, commitId);
      }
      return availabilityGeneration;
    });
  }

  return {
    async snapshot(scope) {
      await ensureHead(db, scope);
      return db.transaction(
        async (tx) => {
          const [head] = await tx
            .select()
            .from(contextCatalogScopeHeads)
            .where(eq(contextCatalogScopeHeads.scopeKey, catalogScopeKey(scope)))
            .limit(1);
          if (!head) throw new Error(`Catalog head disappeared: ${catalogScopeKey(scope)}`);
          const entries = await buildScopeEntries(tx as never, scope);
          return {
            scope,
            generation: head.generation,
            headRevision: String(head.headRevision),
            cursor: encodeCursor({
              scopeKey: head.scopeKey,
              generation: head.generation,
              revision: head.headRevision,
            }),
            entries,
          } satisfies CatalogSnapshot;
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
    async changes(scope, cursor, requestedLimit): Promise<CatalogChanges> {
      await ensureHead(db, scope);
      const limit = normalizeCatalogChangesLimit(requestedLimit);
      return db.transaction(
        async (tx) => {
          const [head] = await tx
            .select()
            .from(contextCatalogScopeHeads)
            .where(eq(contextCatalogScopeHeads.scopeKey, catalogScopeKey(scope)))
            .limit(1);
          if (!head) throw new Error(`Catalog head disappeared: ${catalogScopeKey(scope)}`);
          const parsed = decodeCursor(cursor);
          if (
            !parsed ||
            parsed.scopeKey !== head.scopeKey ||
            parsed.generation !== head.generation
          ) {
            return { kind: "reset-required", scope, reason: "scope_changed" } as const;
          }
          if (parsed.revision < head.oldestRevision - 1) {
            return { kind: "reset-required", scope, reason: "expired" } as const;
          }
          if (parsed.revision > head.headRevision) {
            return { kind: "reset-required", scope, reason: "gap" } as const;
          }
          const rows = await tx
            .select()
            .from(contextCatalogCommits)
            .where(
              and(
                eq(contextCatalogCommits.scopeKey, head.scopeKey),
                gt(contextCatalogCommits.firstRevision, parsed.revision),
                lte(contextCatalogCommits.lastRevision, head.headRevision),
              ),
            )
            .orderBy(asc(contextCatalogCommits.firstRevision))
            .limit(limit + 1);
          const selected = rows.slice(0, limit);
          const nextRevision = selected.at(-1)?.lastRevision ?? parsed.revision;
          let expectedRevision = parsed.revision + 1;
          const hasGap = selected.some((row) => {
            if (row.firstRevision !== expectedRevision) return true;
            expectedRevision = row.lastRevision + 1;
            return false;
          });
          if (hasGap || (selected.length === 0 && parsed.revision < head.headRevision)) {
            return { kind: "reset-required", scope, reason: "gap" } as const;
          }
          return {
            kind: "delta",
            scope,
            commits: selected.map(mapCommit),
            nextCursor: encodeCursor({
              scopeKey: head.scopeKey,
              generation: head.generation,
              revision: nextRevision,
            }),
            headRevision: String(head.headRevision),
            hasMore: rows.length > limit,
          } as const;
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
    async children(input: CatalogChildrenRequest): Promise<CatalogChildrenResult> {
      const snapshot = await this.snapshot(input.scope);
      return {
        scope: input.scope,
        parentId: input.parentId,
        entries: snapshot.entries.filter(
          (entry) =>
            (entry.kind === "folder" || entry.kind === "file") && entry.parentId === input.parentId,
        ),
        headRevision: snapshot.headRevision,
      };
    },
    async lookup(input: CatalogLookupRequest): Promise<CatalogLookupResult> {
      const snapshot = await this.snapshot(input.scope);
      const entry = snapshot.entries.find((candidate) =>
        input.entryId !== undefined
          ? candidate.entryId === input.entryId
          : "uri" in candidate && candidate.uri === input.uri,
      );
      return { entry: entry ?? null, headRevision: snapshot.headRevision };
    },
    async refreshFiles(documentIds) {
      if (documentIds.length === 0) return;
      const rows = await Promise.all(
        documentIds.map((id) => createTreeReader(db).findById(LIVE_TREE, id as DocumentId)),
      );
      await this.refreshSources([
        ...new Set(
          rows.flatMap((row) => (row.kind === "found" ? [row.document.contextSourceId] : [])),
        ),
      ]);
    },
    async refreshSources(sourceIds, invalidatedRootIds = []) {
      const tx = currentDrizzleDb(db) as Database;
      const scopes = new Map<string, CatalogScope>();
      for (const sourceId of new Set(sourceIds)) {
        for (const scope of await sourceScopes(tx, sourceId)) {
          scopes.set(catalogScopeKey(scope), scope);
        }
      }
      const ownershipRows =
        sourceIds.length === 0
          ? []
          : await tx
              .select({
                projectId: contextSources.projectId,
                sourceSlug: contextSources.slug,
                projectUserId: projects.userId,
                projectIsPersonal: projects.isPersonal,
                workProjectId: works.projectId,
              })
              .from(contextSources)
              .leftJoin(projects, eq(contextSources.projectId, projects.id))
              .leftJoin(works, eq(contextSources.workId, works.id))
              .where(inArray(contextSources.id, [...new Set(sourceIds)] as never));
      const projectIds = [
        ...new Set(
          ownershipRows.flatMap(
            (row) => [row.projectId ?? row.workProjectId].filter(Boolean) as string[],
          ),
        ),
      ];
      const userIds = [
        ...new Set(
          ownershipRows.flatMap((row) =>
            row.sourceSlug === "user" && row.projectIsPersonal && row.projectUserId
              ? [row.projectUserId]
              : [],
          ),
        ),
      ];
      return reconcileScopes([...scopes.values()], { projectIds, userIds }, invalidatedRootIds);
    },
    async refreshProject(projectId) {
      const tx = currentDrizzleDb(db) as Database;
      const [project] = await tx
        .select({ userId: projects.userId, isPersonal: projects.isPersonal })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      const workRows = await tx
        .select({ id: works.id })
        .from(works)
        .where(eq(works.projectId, projectId));
      const scopes: CatalogScope[] = [
        { kind: "project", projectId },
        ...workRows.map(({ id }) => ({ kind: "work" as const, projectId, workId: id })),
        ...(project?.isPersonal ? [{ kind: "user" as const, userId: project.userId }] : []),
      ];
      await reconcileScopes(scopes, {
        projectIds: [projectId],
        userIds: project?.isPersonal ? [project.userId] : [],
      });
    },
    async upsertWorkAuthorities(workIds) {
      const unique = [...new Set(workIds)].sort();
      if (unique.length === 0) return;
      await runInDrizzleTransaction(db, async () => {
        const tx = currentDrizzleDb(db) as Database;
        const rows = await tx
          .select({
            id: works.id,
            projectId: works.projectId,
            handle: works.handle,
            name: works.name,
            archivedAt: works.archivedAt,
            deletedAt: works.deletedAt,
            entityRevision: works.entityRevision,
          })
          .from(works)
          .where(inArray(works.id, unique as never));
        const byProject = new Map<string, typeof rows>();
        for (const row of rows) {
          const projectRows = byProject.get(row.projectId) ?? [];
          projectRows.push(row);
          byProject.set(row.projectId, projectRows);
        }
        for (const [projectId, projectRows] of [...byProject].sort(([left], [right]) =>
          left.localeCompare(right),
        )) {
          const scope = { kind: "project" as const, projectId };
          const initialHead = await ensureHead(tx, scope);
          await tx.execute(
            sql`select 1 from ${contextCatalogScopeHeads} where ${contextCatalogScopeHeads.scopeKey} = ${initialHead.scopeKey} for update`,
          );
          const [head] = await tx
            .select()
            .from(contextCatalogScopeHeads)
            .where(eq(contextCatalogScopeHeads.scopeKey, initialHead.scopeKey))
            .limit(1);
          if (!head) throw new Error(`Catalog head disappeared: ${initialHead.scopeKey}`);
          const changes: CatalogChange[] = [];
          const entries: CatalogEntry[] = [];
          const existingRows = await tx
            .select({ entryId: contextCatalogEntries.entryId, entry: contextCatalogEntries.entry })
            .from(contextCatalogEntries)
            .where(
              and(
                eq(contextCatalogEntries.scopeKey, head.scopeKey),
                inArray(
                  contextCatalogEntries.entryId,
                  projectRows.map(({ id }) => id),
                ),
              ),
            );
          const existingById = new Map(existingRows.map(({ entryId, entry }) => [entryId, entry]));
          for (const work of projectRows.sort((left, right) => left.id.localeCompare(right.id))) {
            const workHandle = work.handle === null ? null : decodeWorkHandle(work.handle);
            if (work.handle !== null && !workHandle) continue;
            const entry: CatalogEntry = {
              kind: "authority",
              entryId: work.id,
              scope,
              authority: { workId: work.id, workHandle },
              name: work.name,
              available: work.deletedAt === null && work.archivedAt === null,
              entityRevision: String(work.entityRevision),
            };
            const existing = existingById.get(work.id);
            if (existing && stableJson(existing) === stableJson(entry)) continue;
            entries.push(entry);
            changes.push({ operation: "upsert", ordinal: changes.length, entry });
          }
          if (changes.length === 0) continue;
          const revision = head.headRevision + 1;
          await tx
            .insert(contextCatalogEntries)
            .values(
              entries.map((entry) => ({
                scopeKey: head.scopeKey,
                entryId: entry.entryId,
                entry,
              })),
            )
            .onConflictDoUpdate({
              target: [contextCatalogEntries.scopeKey, contextCatalogEntries.entryId],
              set: { entry: sql`excluded.entry` },
            });
          await tx.insert(contextCatalogCommits).values({
            commitId: randomUUID(),
            scopeKey: head.scopeKey,
            firstRevision: revision,
            lastRevision: revision,
            changes,
          });
          const oldestRevision = Math.max(1, revision - retainedCommitsPerScope + 1);
          await tx
            .update(contextCatalogScopeHeads)
            .set({ headRevision: revision, oldestRevision, updatedAt: new Date() })
            .where(eq(contextCatalogScopeHeads.scopeKey, head.scopeKey));
          await tx
            .delete(contextCatalogCommits)
            .where(
              and(
                eq(contextCatalogCommits.scopeKey, head.scopeKey),
                lt(contextCatalogCommits.lastRevision, oldestRevision),
              ),
            );
          runAfterDrizzleCommit(async () => {
            if (!wakePort) return;
            try {
              await wakePort.publish({
                type: "context-catalog-hint",
                scope,
                headRevision: String(revision),
              });
            } catch {
              // Wake hints are explicitly lossy. Pull-on-focus/poll repairs delivery.
            }
          });
        }
      });
    },
  };
}
