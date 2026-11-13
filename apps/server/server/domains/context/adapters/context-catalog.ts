import type { ContextSourceId, DocumentId } from "@meridian/contracts";
import { type ContextUriScheme, canonicalContextUri } from "@meridian/contracts/context-uri";
import type {
  CatalogChanges,
  CatalogChildrenRequest,
  CatalogChildrenResult,
  CatalogCommit,
  CatalogEntry,
  CatalogLookupRequest,
  CatalogLookupResult,
  CatalogScope,
  CatalogSnapshot,
  CatalogWakeHint,
  DraftOwnerHint,
} from "@meridian/contracts/protocol";
import { catalogScopeKey } from "@meridian/contracts/protocol";
import { decodeWorkHandle } from "@meridian/contracts/works";
import type { Database } from "@meridian/database";
import {
  contextAvailabilityHeads,
  contextCatalogCommits,
  contextCatalogScopeHeads,
  contextSources,
  projects,
  threads,
  uploadIntakes,
  works,
} from "@meridian/database/schema";
import { and, asc, eq, gt, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { runAfterDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import type {
  ContextCatalog,
  ContextCatalogWakePort,
  DraftOwnerHintPort,
} from "../ports/context-catalog.js";
import { normalizeCatalogChangesLimit } from "../ports/context-catalog.js";
import { LIVE_TREE, visibleDocuments, visibleFolders } from "../tree/tree-view.js";
import { catalogSourceAuthority, mapAuthoritativeFile } from "./catalog-file-mapper.js";

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
            rank: vf.rank,
            locationVersion: vf.locationVersion,
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
            rank: vd.rank,
            locationVersion: vd.locationVersion,
          })
          .from(vd)
          .where(inArray(vd.contextSourceId, sourceIds));
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
      });
    }
    for (const document of documentRows.filter((item) => item.contextSourceId === source.id)) {
      const parentPath = pathForFolder(document.folderId, source.id);
      if (!parentPath) continue;
      entries.push(
        mapAuthoritativeFile({
          document,
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
): ContextCatalog & DraftOwnerHintPort {
  /** Wake hints are explicitly lossy: pull-on-focus and polling repair a missed one. */
  function publishLossy(hints: readonly (CatalogWakeHint | DraftOwnerHint)[]) {
    if (!wakePort || hints.length === 0) return;
    runAfterDrizzleCommit(async () => {
      for (const hint of hints) {
        try {
          await wakePort.publish(hint);
        } catch {
          // Lossy by design.
        }
      }
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
    publishDraftOwnerHints(hints) {
      publishLossy(hints);
    },
  };
}
