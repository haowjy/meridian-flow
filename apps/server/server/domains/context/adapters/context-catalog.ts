/**
 * Drizzle catalog publisher: owns per-scope heads, snapshots, replay, and the
 * single transactional commit/version/wake path for catalog mutations.
 */
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
import type { Database } from "@meridian/database";
import {
  contextCatalogCommits,
  contextCatalogEntries,
  contextCatalogScopeHeads,
  contextSources,
  documents,
  projects,
  works,
} from "@meridian/database/schema";
import { and, asc, eq, gt, inArray, lt, lte, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  deferUntilDrizzleCommit,
  runAfterDrizzleCommit,
  runInDrizzleTransaction,
  runInRootDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { type DetachedWorkTracker, processDetachedWork } from "../../runtime/detached-work.js";
import type {
  ContextCatalog,
  ContextCatalogFileMutationPort,
  ContextCatalogMutationPort,
  ContextCatalogWakePort,
  ProjectCatalogLifecyclePort,
  ProjectDocumentCatalogRefreshPort,
  WorkAuthorityCatalogMutationPort,
} from "../ports/context-catalog.js";
import { normalizeCatalogChangesLimit } from "../ports/context-catalog.js";
import type { ProjectContextAvailabilityMutationPort } from "../ports/project-context-availability.js";
import type { ManifestMembershipResolver } from "../visible-document-membership.js";
import { type CatalogRepairRequest, createCatalogRepairQueue } from "./catalog-repair-queue.js";
import {
  buildAuthoritativeEntries,
  type CatalogDb,
  type CatalogRefreshSelection,
  FULL_SCOPE_SELECTION,
  sourceScopes,
  workAuthorityEntry,
} from "./context-catalog-authority.js";
import { createDrizzleProjectContextAvailability } from "./project-context-availability.js";

const DEFAULT_RETAINED_COMMITS_PER_SCOPE = 1_000;
const REFRESH_RETRY_DELAYS_MS = [10, 50, 250, 1_000] as const;

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

function isLockTimeout(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  if ("code" in cause && cause.code === "55P03") return true;
  return "cause" in cause && isLockTimeout(cause.cause);
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
    manifestMembership?: ManifestMembershipResolver;
    eventSink?: EventSink;
    delay?: (milliseconds: number) => Promise<void>;
    /** Owns the post-commit repair so shutdown and test resets can drain it. */
    backgroundTasks?: DetachedWorkTracker;
  } = {},
): ContextCatalog &
  ContextCatalogMutationPort &
  ContextCatalogFileMutationPort &
  ProjectCatalogLifecyclePort &
  ProjectDocumentCatalogRefreshPort &
  WorkAuthorityCatalogMutationPort {
  const availabilityMutations =
    options.availabilityMutations ?? createDrizzleProjectContextAvailability(db);
  const retainedCommitsPerScope = Math.max(
    1,
    Math.floor(options.retainedCommitsPerScope ?? DEFAULT_RETAINED_COMMITS_PER_SCOPE),
  );
  async function retryRefresh<T>(operation: () => Promise<T>): Promise<T> {
    let lastCause: unknown;
    for (const delayMs of REFRESH_RETRY_DELAYS_MS) {
      await (options.delay ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(
        delayMs,
      );
      try {
        return await operation();
      } catch (cause) {
        lastCause = cause;
      }
    }
    throw lastCause;
  }
  const repairQueue = createCatalogRepairQueue(async (requests) => {
    const scopes = new Map<string, { scope: CatalogScope; roots: Set<string> }>();
    const publications = new Map<
      string,
      {
        generation: string | undefined;
        projectIds: string[];
        userIds: string[];
      }
    >();
    const sourceIds = new Set<string>();
    for (const request of requests) {
      for (const scope of request.scopes) {
        const key = catalogScopeKey(scope);
        const entry = scopes.get(key) ?? { scope, roots: new Set<string>() };
        for (const root of request.invalidatedRootIds) entry.roots.add(root);
        scopes.set(key, entry);
      }
      for (const sourceId of request.sourceIds) sourceIds.add(sourceId);
      for (const [kind, ids] of [
        ["project", request.projectIds],
        ["user", request.userIds],
      ] as const) {
        for (const id of ids) {
          const key = `${kind}:${id}`;
          const previous = publications.get(key);
          // Generations order an authority, not a group of unrelated authorities.
          // A post-draft refresh reserves a fresh generation inside the repair.
          if (
            !previous ||
            request.availabilityGeneration === undefined ||
            (previous.generation !== undefined &&
              BigInt(request.availabilityGeneration) > BigInt(previous.generation))
          ) {
            publications.set(key, {
              generation: request.availabilityGeneration,
              projectIds: kind === "project" ? [id] : [],
              userIds: kind === "user" ? [id] : [],
            });
          }
        }
      }
    }
    const commitId = randomUUID();
    try {
      await retryRefresh(() =>
        runInRootDrizzleTransaction(
          db,
          async () => {
            await currentDrizzleDb(db).execute(sql`set local lock_timeout = '250ms'`);
            const reservedPublications = [];
            for (const publication of publications.values()) {
              reservedPublications.push({
                ...publication,
                generation: publication.generation ?? (await availabilityMutations.reserve()),
              });
            }
            for (const [, { scope, roots }] of [...scopes].sort(([a], [b]) => a.localeCompare(b))) {
              await refreshScope(scope, [...roots], commitId);
            }
            for (const publication of reservedPublications) {
              await availabilityMutations.publishReserved(publication);
            }
          },
          { isolationLevel: "repeatable read" },
        ),
      );
    } catch (cause) {
      if (options.eventSink) {
        emitEvent(options.eventSink, {
          level: isLockTimeout(cause) ? "warn" : "error",
          source: "context-catalog",
          name: "DeferredRefreshFailure",
          payload: {
            sourceIds: [...sourceIds],
            scopeKeys: [...scopes.keys()],
            ...unknownToEventPayload(cause),
          },
        });
      }
      throw cause;
    }
  });
  function enqueueRepair(request: CatalogRepairRequest): Promise<void> {
    // Track at enqueue, not at the immediate: drains must include queued reruns.
    return (options.backgroundTasks ?? processDetachedWork).track(
      repairQueue.enqueue(request),
      "context catalog repair",
    );
  }
  /** Locks a scope head for the rest of the ambient transaction and returns it fresh. */
  async function lockHead(tx: Database, scope: CatalogScope) {
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
    return head;
  }

  /**
   * The only catalog publication path: appends one commit after the locked
   * head, advances and prunes the head, and wakes subscribers after commit.
   * Callers have already written the cached entry rows for `changes`.
   */
  async function publishCommit(
    tx: Database,
    scope: CatalogScope,
    head: { scopeKey: string; headRevision: number },
    changes: CatalogChange[],
    commitId: string,
  ) {
    const revision = head.headRevision + 1;
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

  async function refreshScope(
    scope: CatalogScope,
    invalidatedRootIds: readonly string[] = [],
    commitId = randomUUID(),
    selection: CatalogRefreshSelection = FULL_SCOPE_SELECTION,
  ) {
    await runInDrizzleTransaction(db, async () => {
      const tx = currentDrizzleDb(db) as Database;
      const head = await lockHead(tx, scope);
      const authoritative = await buildAuthoritativeEntries(
        tx,
        scope,
        selection,
        options.manifestMembership,
      );
      const selectedRows = and(
        eq(contextCatalogEntries.scopeKey, head.scopeKey),
        selection.kind === "documents"
          ? inArray(contextCatalogEntries.entryId, [...selection.documentIds])
          : undefined,
      );
      const existing = await tx.select().from(contextCatalogEntries).where(selectedRows);
      const oldById = new Map(existing.map((row) => [row.entryId, row.entry]));
      // Deduplicate complete observations below: equal payloads with newer namespace
      // versions still publish, including moves back before deferred repair catches up.
      const nextById = new Map(authoritative.map((entry) => [entry.entryId, entry]));
      // Replay clears the old subtree before installing this commit. Restore every
      // survivor, including entries already published by a separate repair and
      // descendants that moved out of the root during this refresh.
      const replacedIds = new Set(invalidatedRootIds);
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
      for (const rootEntryId of new Set(invalidatedRootIds)) {
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
      await tx.delete(contextCatalogEntries).where(selectedRows);
      if (authoritative.length > 0) {
        await tx.insert(contextCatalogEntries).values(
          authoritative.map((entry) => ({
            scopeKey: head.scopeKey,
            entryId: entry.entryId,
            entry,
          })),
        );
      }
      await publishCommit(tx, scope, head, changes, commitId);
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
          const entries = await buildAuthoritativeEntries(
            tx as never,
            scope,
            FULL_SCOPE_SELECTION,
            options.manifestMembership,
          );
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
      if (!documentIds.length) return;
      await runInDrizzleTransaction(db, async () => {
        const tx = currentDrizzleDb(db) as Database;
        const rows = await tx
          .select({ sourceId: documents.contextSourceId })
          .from(documents)
          .where(inArray(documents.id, [...documentIds]));
        const scopes = new Map<string, CatalogScope>();
        for (const sourceId of new Set(rows.map((row) => row.sourceId))) {
          for (const scope of await sourceScopes(tx, sourceId))
            scopes.set(catalogScopeKey(scope), scope);
        }
        // Metadata/content changed, not location or membership. Serialize catalog
        // publication, but do not advance every sibling's namespace observation.
        await availabilityMutations.reserve();
        const commitId = randomUUID();
        for (const [_, scope] of [...scopes].sort(([a], [b]) => a.localeCompare(b)))
          await refreshScope(scope, [], commitId, { kind: "documents", documentIds });
      });
    },
    async refreshSources(sourceIds, invalidatedRootIds = []) {
      const tx = currentDrizzleDb(db) as Database;
      const scopes = new Map<string, CatalogScope>();
      const commitId = randomUUID();
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
      const manifestBackedProjectIds = new Set(
        options.manifestMembership
          ? ownershipRows.flatMap((row) =>
              row.sourceSlug === "manuscript" && row.projectId ? [row.projectId] : [],
            )
          : [],
      );
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
      const orderedScopes = [...scopes.values()].sort((a, b) =>
        catalogScopeKey(a).localeCompare(catalogScopeKey(b)),
      );
      if (manifestBackedProjectIds.size > 0) {
        const availabilityGeneration = await availabilityMutations.reserve({ projectIds, userIds });
        const request: CatalogRepairRequest = {
          scopes: orderedScopes,
          invalidatedRootIds,
          availabilityGeneration,
          projectIds,
          userIds,
          sourceIds,
        };
        const launchRepair = () => {
          void enqueueRepair(request).catch(() => undefined);
        };
        if (deferUntilDrizzleCommit(launchRepair)) return availabilityGeneration;
        await enqueueRepair(request);
        return availabilityGeneration;
      }
      const availabilityGeneration = await availabilityMutations.advance({ projectIds, userIds });
      for (const scope of orderedScopes) {
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
    refreshProjectDocuments(projectId) {
      // The queue reports failures; waitUntil must not reclassify contention as error.
      return enqueueRepair({
        scopes: [{ kind: "project", projectId }],
        invalidatedRootIds: [],
        projectIds: [projectId],
        userIds: [],
        sourceIds: [],
      }).catch(() => undefined);
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
          const head = await lockHead(tx, scope);
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
            const entry = workAuthorityEntry(scope, work);
            if (!entry) continue;
            const existing = existingById.get(work.id);
            if (existing && stableJson(existing) === stableJson(entry)) continue;
            entries.push(entry);
            changes.push({ operation: "upsert", ordinal: changes.length, entry });
          }
          if (changes.length === 0) continue;
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
          await publishCommit(tx, scope, head, changes, randomUUID());
        }
      });
    },
  };
}
