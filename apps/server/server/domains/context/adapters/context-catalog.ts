/** Drizzle adapter for authoritative catalog snapshots, replay, and mutation reconciliation. */
import { randomUUID } from "node:crypto";
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
  projects,
  threads,
  works,
} from "@meridian/database/schema";
import { and, asc, eq, gt, inArray, lt, lte, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runAfterDrizzleCommit,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import type {
  ContextCatalog,
  ContextCatalogMutationPort,
  ContextCatalogWakePort,
  ProjectCatalogLifecyclePort,
  ThreadFolderLabelMutationPort,
  WorkAuthorityCatalogMutationPort,
} from "../ports/context-catalog.js";
import { normalizeCatalogChangesLimit } from "../ports/context-catalog.js";
import type { ProjectContextAvailabilityMutationPort } from "../ports/project-context-availability.js";
import { LIVE_TREE, visibleFolders } from "../tree/tree-view.js";
import { buildScopeEntries, sourceScopes } from "./catalog-reader.js";
import { createDrizzleProjectContextAvailability } from "./project-context-availability.js";
import { loadThreadFolderLabels } from "./thread-folder-labels.js";

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

/** An entry without its namespace stamp: what a namespace change compares. */
function unstamped(entry: CatalogEntry): unknown {
  if (entry.kind !== "file" && entry.kind !== "folder") return entry;
  const { observationVersion: _stamp, ...rest } = entry;
  return rest;
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
  ProjectCatalogLifecyclePort &
  WorkAuthorityCatalogMutationPort &
  ThreadFolderLabelMutationPort {
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
    await publishChanges(tx, scope, head, changes, commitId);
  }

  async function publishChanges(
    tx: Database,
    scope: CatalogScope,
    head: typeof contextCatalogScopeHeads.$inferSelect,
    changes: CatalogChange[],
    commitId: string,
  ) {
    const revision = head.headRevision + 1;
    const removed = changes.flatMap((change) =>
      change.operation === "delete" ? [change.entryId] : [],
    );
    if (removed.length)
      await tx
        .delete(contextCatalogEntries)
        .where(
          and(
            eq(contextCatalogEntries.scopeKey, head.scopeKey),
            inArray(contextCatalogEntries.entryId, removed),
          ),
        );
    const entries = changes.flatMap((change) =>
      change.operation === "upsert" ? [change.entry] : [],
    );
    if (entries.length)
      await tx
        .insert(contextCatalogEntries)
        .values(
          entries.map((entry) => ({ scopeKey: head.scopeKey, entryId: entry.entryId, entry })),
        )
        .onConflictDoUpdate({
          target: [contextCatalogEntries.scopeKey, contextCatalogEntries.entryId],
          set: { entry: sql`excluded.entry` },
        });
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
    async updateThreadFolderLabels(threadId) {
      await runInDrizzleTransaction(db, async () => {
        const tx = currentDrizzleDb(db) as Database;
        const vf = visibleFolders(LIVE_TREE);
        const affected = await tx
          .select({
            id: vf.id,
            workId: contextSources.workId,
            rootThreadId: contextSources.rootThreadId,
            projectId: sql<
              string | null
            >`COALESCE(${contextSources.projectId}, ${works.projectId})`,
          })
          .from(vf)
          .innerJoin(threads, eq(threads.id, vf.threadId))
          .innerJoin(contextSources, eq(contextSources.id, vf.contextSourceId))
          .leftJoin(works, eq(works.id, contextSources.workId))
          .where(
            and(
              eq(contextSources.slug, "scratch"),
              sql`(${threads.id} = ${threadId} OR (${threads.kind} = 'subagent' AND ${threads.parentThreadId} = ${threadId}))`,
            ),
          );
        if (!affected.length) return;
        const ids = affected.map((row) => row.id);
        const scopes = new Map<string, CatalogScope>();
        const rootsByScope = new Map<string, string[]>();
        for (const row of affected) {
          if (!row.projectId) continue;
          const scope: CatalogScope | null = row.workId
            ? { kind: "work", projectId: row.projectId, workId: row.workId }
            : row.rootThreadId
              ? { kind: "lineage", projectId: row.projectId, rootThreadId: row.rootThreadId }
              : null;
          if (!scope) continue;
          const key = catalogScopeKey(scope);
          scopes.set(key, scope);
          const roots = rootsByScope.get(key) ?? [];
          roots.push(row.id);
          rootsByScope.set(key, roots);
        }
        if (!scopes.size) return;
        const projectIds = [
          ...new Set(
            [...scopes.values()].flatMap((scope) =>
              scope.kind === "user" ? [] : [scope.projectId],
            ),
          ),
        ];
        await availabilityMutations.advance({ projectIds, userIds: [] });
        const version = await availabilityMutations.publishNamespace({ projectIds, userIds: [] });
        const labels = await loadThreadFolderLabels(tx, ids);
        for (const [scopeKey, scope] of [...scopes].sort(([a], [b]) => a.localeCompare(b))) {
          await tx.execute(
            sql`SELECT 1 FROM ${contextCatalogScopeHeads} WHERE ${contextCatalogScopeHeads.scopeKey} = ${scopeKey} FOR UPDATE`,
          );
          const [head] = await tx
            .select()
            .from(contextCatalogScopeHeads)
            .where(eq(contextCatalogScopeHeads.scopeKey, scopeKey));
          if (!head) throw new Error("Catalog head disappeared");
          // Re-read only these rows under the head lock, so a rename/delete commit cannot be overwritten.
          const rows = await tx
            .select()
            .from(contextCatalogEntries)
            .where(
              and(
                eq(contextCatalogEntries.scopeKey, scopeKey),
                inArray(contextCatalogEntries.entryId, rootsByScope.get(scopeKey) ?? []),
              ),
            );
          const changes: CatalogChange[] = [];
          for (const row of rows) {
            if (
              row.entry.kind !== "folder" ||
              !labels.has(row.entryId) ||
              row.entry.displayName === labels.get(row.entryId)
            )
              continue;
            changes.push({
              operation: "upsert",
              ordinal: changes.length,
              entry: {
                ...row.entry,
                displayName: labels.get(row.entryId),
                observationVersion: version,
              },
            });
          }
          if (changes.length) await publishChanges(tx, scope, head, changes, randomUUID());
        }
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
            slug: works.slug,
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
            const workSlug = work.slug === null ? null : decodeWorkSlug(work.slug);
            if (work.slug !== null && !workSlug) continue;
            const entry: CatalogEntry = {
              kind: "authority",
              entryId: work.id,
              scope,
              authority: { workId: work.id, workSlug },
              name: work.name,
              available: work.deletedAt === null && work.archivedAt === null,
              entityRevision: String(work.entityRevision),
            };
            const existing = existingById.get(work.id);
            if (existing && stableJson(existing) === stableJson(entry)) continue;
            changes.push({ operation: "upsert", ordinal: changes.length, entry });
          }
          if (changes.length === 0) continue;
          await publishChanges(tx, scope, head, changes, randomUUID());
        }
      });
    },
  };
}
