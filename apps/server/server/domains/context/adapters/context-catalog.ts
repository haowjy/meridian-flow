/** Drizzle adapter for authoritative catalog snapshots, replay, and mutation reconciliation. */
import { randomUUID } from "node:crypto";
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
import { decodeWorkSlug } from "@meridian/contracts/works";
import type { Database } from "@meridian/database";
import {
  contextCatalogCommits,
  contextCatalogEntries,
  contextCatalogScopeHeads,
  contextSources,
  documents,
  folders,
  projects,
  works,
} from "@meridian/database/schema";
import { and, asc, eq, gt, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runAfterDrizzleCommit,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import type {
  ContextCatalog,
  ContextCatalogMutationPort,
  ContextCatalogWakePort,
  WorkAuthorityCatalogMutationPort,
} from "../ports/context-catalog.js";
import { normalizeCatalogChangesLimit } from "../ports/context-catalog.js";
import type { ProjectContextAvailabilityMutationPort } from "../ports/project-context-availability.js";
import { catalogSourceAuthority, mapAuthoritativeFile } from "./catalog-file-mapper.js";
import { createDrizzleProjectContextAvailability } from "./project-context-availability.js";

const DEFAULT_RETAINED_COMMITS_PER_SCOPE = 1_000;

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

function scopeForSource(row: {
  sourceProjectId: string | null;
  sourceWorkId: string | null;
  projectUserId: string | null;
  projectIsPersonal: boolean | null;
  workProjectId: string | null;
  sourceSlug: string;
}): CatalogScope | null {
  if (row.sourceWorkId && row.workProjectId) {
    return { kind: "work", projectId: row.workProjectId, workId: row.sourceWorkId };
  }
  if (!row.sourceProjectId) return null;
  if (row.sourceSlug === "user" && row.projectIsPersonal && row.projectUserId) {
    return { kind: "user", userId: row.projectUserId };
  }
  if (row.sourceSlug === "scratch" || row.sourceSlug === "uploads") {
    return { kind: "none", projectId: row.sourceProjectId };
  }
  return { kind: "project", projectId: row.sourceProjectId };
}

async function sourceScope(db: CatalogDb, sourceId: string): Promise<CatalogScope | null> {
  const [row] = await db
    .select({
      sourceProjectId: contextSources.projectId,
      sourceWorkId: contextSources.workId,
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
  return row ? scopeForSource(row) : null;
}

async function sourcesForScope(db: CatalogDb, scope: CatalogScope) {
  const conditions =
    scope.kind === "work"
      ? and(eq(contextSources.workId, scope.workId), isNull(contextSources.deletedAt))
      : scope.kind === "user"
        ? and(
            eq(projects.userId, scope.userId),
            eq(projects.isPersonal, true),
            eq(contextSources.slug, "user"),
            isNull(projects.deletedAt),
            isNull(contextSources.deletedAt),
          )
        : scope.kind === "none"
          ? and(
              eq(contextSources.projectId, scope.projectId),
              inArray(contextSources.slug, ["scratch", "uploads"]),
              isNull(contextSources.deletedAt),
            )
          : and(
              eq(contextSources.projectId, scope.projectId),
              inArray(contextSources.slug, ["manuscript", "kb"]),
              isNull(contextSources.deletedAt),
            );
  return db
    .select({
      id: contextSources.id,
      name: contextSources.name,
      slug: contextSources.slug,
      workId: contextSources.workId,
      workSlug: works.slug,
    })
    .from(contextSources)
    .leftJoin(projects, eq(contextSources.projectId, projects.id))
    .leftJoin(works, eq(contextSources.workId, works.id))
    .where(conditions)
    .orderBy(asc(contextSources.sortOrder), asc(contextSources.id));
}

async function buildScopeEntries(db: CatalogDb, scope: CatalogScope): Promise<CatalogEntry[]> {
  if (scope.kind !== "user") {
    const [activeProject] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, scope.projectId), isNull(projects.deletedAt)))
      .limit(1);
    if (!activeProject) return [];
    if (scope.kind === "work") {
      const [activeWork] = await db
        .select({ id: works.id })
        .from(works)
        .where(
          and(
            eq(works.id, scope.workId),
            eq(works.projectId, scope.projectId),
            eq(works.status, "active"),
            isNull(works.deletedAt),
          ),
        )
        .limit(1);
      if (!activeWork) return [];
    }
  }
  const sourceRows = await sourcesForScope(db, scope);
  const sourceIds = sourceRows.map((row) => row.id);
  const folderRows =
    sourceIds.length === 0
      ? []
      : await db
          .select()
          .from(folders)
          .where(and(inArray(folders.contextSourceId, sourceIds), isNull(folders.deletedAt)));
  const documentRows =
    sourceIds.length === 0
      ? []
      : await db
          .select()
          .from(documents)
          .where(
            and(
              inArray(documents.contextSourceId, sourceIds),
              eq(documents.kind, "content"),
              isNull(documents.deletedAt),
            ),
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
    const authority = catalogSourceAuthority(scheme, source.workId, source.workSlug);
    entries.push({
      kind: "source",
      entryId: source.id,
      scope,
      scheme,
      name: source.name,
      uri: canonicalContextUri(scheme, "", authority),
    });
    for (const folder of folderRows.filter((item) => item.contextSourceId === source.id)) {
      const path = pathForFolder(folder.id, source.id);
      if (!path) continue;
      entries.push({
        kind: "folder",
        entryId: folder.id,
        scope,
        sourceId: source.id,
        parentId: folder.parentId ?? source.id,
        name: folder.name,
        path,
        uri: canonicalContextUri(scheme, path.join("/"), authority),
        hasChildren: (childCounts.get(folder.id) ?? 0) > 0,
      });
    }
    for (const document of documentRows.filter((item) => item.contextSourceId === source.id)) {
      const parentPath = pathForFolder(document.folderId, source.id);
      if (!parentPath) continue;
      entries.push(
        mapAuthoritativeFile({
          document,
          scope,
          scheme,
          workId: source.workId,
          workSlug: source.workSlug,
          parentPath,
        }),
      );
    }
  }
  if (scope.kind === "project") {
    const workRows = await db
      .select({
        id: works.id,
        slug: works.slug,
        name: works.name,
        status: works.status,
        deletedAt: works.deletedAt,
        entityRevision: works.entityRevision,
      })
      .from(works)
      .where(eq(works.projectId, scope.projectId));
    entries.push({
      kind: "authority",
      entryId: `none:${scope.projectId}`,
      scope,
      authority: { kind: "none" },
      name: "No Work",
      available: true,
    });
    for (const work of workRows) {
      const slug = decodeWorkSlug(work.slug);
      if (!slug) continue;
      entries.push({
        kind: "authority",
        entryId: work.id,
        scope,
        authority: { kind: "work", workId: work.id, workSlug: slug },
        name: work.name,
        available: work.deletedAt === null && work.status === "active",
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
): ContextCatalog & ContextCatalogMutationPort & WorkAuthorityCatalogMutationPort {
  const availabilityMutations =
    options.availabilityMutations ?? createDrizzleProjectContextAvailability(db);
  const retainedCommitsPerScope = Math.max(
    1,
    Math.floor(options.retainedCommitsPerScope ?? DEFAULT_RETAINED_COMMITS_PER_SCOPE),
  );
  async function refreshScope(
    scope: CatalogScope,
    invalidatedRootIds: readonly string[] = [],
    commitId = randomUUID(),
  ) {
    await runInDrizzleTransaction(db, async () => {
      const tx = currentDrizzleDb(db) as Database;
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
      const changes: CatalogChange[] = [];
      for (const rootEntryId of new Set(invalidatedRootIds)) {
        changes.push({ operation: "invalidate-subtree", ordinal: changes.length, rootEntryId });
      }
      for (const [entryId, entry] of nextById) {
        const old = oldById.get(entryId);
        if (!old || stableJson(old) !== stableJson(entry)) {
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
      await tx
        .delete(contextCatalogEntries)
        .where(eq(contextCatalogEntries.scopeKey, head.scopeKey));
      if (authoritative.length > 0) {
        await tx.insert(contextCatalogEntries).values(
          authoritative.map((entry) => ({
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
    async refreshSources(sourceIds, invalidatedRootIds = []) {
      const tx = currentDrizzleDb(db) as Database;
      const scopes = new Map<string, CatalogScope>();
      const commitId = randomUUID();
      for (const sourceId of new Set(sourceIds)) {
        const scope = await sourceScope(tx, sourceId);
        if (scope) scopes.set(catalogScopeKey(scope), scope);
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
      const availabilityGeneration = await availabilityMutations.advance({
        projectIds: [
          ...new Set(
            ownershipRows.flatMap(
              (row) => [row.projectId ?? row.workProjectId].filter(Boolean) as string[],
            ),
          ),
        ],
        userIds: [
          ...new Set(
            ownershipRows.flatMap((row) =>
              row.sourceSlug === "user" && row.projectIsPersonal && row.projectUserId
                ? [row.projectUserId]
                : [],
            ),
          ),
        ],
      });
      for (const scope of [...scopes.values()].sort((a, b) =>
        catalogScopeKey(a).localeCompare(catalogScopeKey(b)),
      )) {
        await refreshScope(scope, invalidatedRootIds, commitId);
      }
      return availabilityGeneration;
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
      await availabilityMutations.advance({
        projectIds: [projectId],
        userIds: project?.isPersonal ? [project.userId] : [],
      });
      const scopes: CatalogScope[] = [
        { kind: "project", projectId },
        { kind: "none", projectId },
        ...workRows.map(({ id }) => ({ kind: "work" as const, projectId, workId: id })),
        ...(project?.isPersonal ? [{ kind: "user" as const, userId: project.userId }] : []),
      ];
      const commitId = randomUUID();
      for (const scope of scopes.sort((a, b) =>
        catalogScopeKey(a).localeCompare(catalogScopeKey(b)),
      )) {
        await refreshScope(scope, [], commitId);
      }
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
            slug: works.slug,
            name: works.name,
            status: works.status,
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
            const slug = decodeWorkSlug(work.slug);
            if (!slug) continue;
            const entry: CatalogEntry = {
              kind: "authority",
              entryId: work.id,
              scope,
              authority: { kind: "work", workId: work.id, workSlug: slug },
              name: work.name,
              available: work.deletedAt === null && work.status === "active",
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
