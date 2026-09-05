/** Drizzle backing-scoped atomic ContextFS tree mutations. */
import type { DocumentFileType } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import {
  contentDocumentKindSql,
  contentDocumentPredicate,
  contextSources,
  documents,
  folders,
  works,
} from "@meridian/database/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runAfterDrizzleCommit,
  runInDrizzleSavepoint,
} from "../../../../shared/drizzle-transaction.js";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import type { EventSink } from "../../../observability/index.js";
import { parseFilename, splitPath } from "../../context/paths.js";
import type { ContextCatalogMutationPort } from "../../ports/context-catalog.js";
import {
  CONTEXT_ROOT_DIRECTORY_ID,
  type ContextLocationToken,
  type ContextTargetExpectation,
  type ContextTreeDeleteCommand,
  type ContextTreeDeleteResult,
  type ContextTreeMoveCommand,
  type ContextTreeMutationError,
  type ContextTreeMutationResult,
  type ContextTreeMutationStore,
} from "../../ports/context-tree-mutation-store.js";
import {
  type ContextDocumentMembershipEvent,
  type ContextDocumentMembershipObserver,
  createMembershipCommandId,
  dispatchMembershipEvents,
} from "./membership-event-dispatcher.js";

type FolderRow = typeof folders.$inferSelect;
const BINARY_FILE_TYPES = new Set<DocumentFileType>(["docx", "image", "pdf", "binary"]);

function normalizeTreePath(path: string): string {
  return path.split("/").filter(Boolean).join("/");
}

function treePathSegments(path: string): string[] {
  return normalizeTreePath(path).split("/").filter(Boolean);
}

function treeBasename(path: string): string {
  const segments = treePathSegments(path);
  return segments[segments.length - 1] ?? "";
}

function treeDirname(path: string): string {
  const segments = treePathSegments(path);
  segments.pop();
  return segments.join("/");
}

function sameLocation(a: ContextLocationToken | null, b: ContextLocationToken | null): boolean {
  return (
    a?.kind === b?.kind &&
    a?.nodeId === b?.nodeId &&
    a?.sourceId === b?.sourceId &&
    a?.path === b?.path &&
    (a?.kind !== "file" || b?.kind !== "file" || a.filetype === b.filetype)
  );
}

function isPgConstraintError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : null;
  return code === "23505" || code === "23503" || code === "23514";
}

class ContextTreeMutationRollback extends Error {
  constructor(readonly code: ContextTreeMutationError["code"]) {
    super(code);
    this.name = "ContextTreeMutationRollback";
  }
}

function rollback(code: ContextTreeMutationError["code"]): never {
  throw new ContextTreeMutationRollback(code);
}

/** Drizzle implementation of the backing-scoped atomic ContextFS tree mutator. */
export class DrizzleContextTreeMutationStore implements ContextTreeMutationStore {
  private beforeDestructiveWrite: (() => void | Promise<void>) | null = null;

  constructor(
    private readonly db: Database,
    private readonly membershipObserver?: ContextDocumentMembershipObserver,
    private readonly catalogMutations?: ContextCatalogMutationPort,
    private readonly eventSink?: EventSink,
  ) {}

  /** Test hook: runs after CAS rechecks, immediately before destructive writes. */
  setBeforeDestructiveWrite(hook: (() => void | Promise<void>) | null): void {
    this.beforeDestructiveWrite = hook;
  }

  private async runBeforeDestructiveWrite(): Promise<void> {
    await this.beforeDestructiveWrite?.();
  }

  private async withMutationTransaction<T>(
    operation: (
      events: ContextDocumentMembershipEvent[],
    ) => Promise<Result<T, ContextTreeMutationError>>,
  ): Promise<Result<T, ContextTreeMutationError>> {
    const events: ContextDocumentMembershipEvent[] = [];
    const commandId = createMembershipCommandId();
    let result: Result<T, ContextTreeMutationError>;
    try {
      result = await runInDrizzleSavepoint(this.db, async () => {
        const mutationResult = await operation(events);
        if (mutationResult.ok && events.length > 0) {
          runAfterDrizzleCommit(() =>
            dispatchMembershipEvents({
              observer: this.membershipObserver,
              events,
              commandId,
              eventSink: this.eventSink,
            }),
          );
        }
        return mutationResult;
      });
    } catch (error) {
      if (error instanceof ContextTreeMutationRollback) return Err({ code: error.code });
      if (isPgConstraintError(error)) return Err({ code: "conflict" });
      throw error;
    }
    return result;
  }

  private async lockSources(sourceIds: readonly string[]): Promise<void> {
    const uniqueIds = [...new Set(sourceIds)].sort();
    const db = currentDrizzleDb(this.db);
    for (const sourceId of uniqueIds) {
      // Serialize ContextFS tree mutations per involved source. Row locks cannot
      // protect absent target paths, so the advisory lock is the operation-level
      // mutex while unique indexes remain the final guard against non-mutator writes.
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`context-tree:${sourceId}`}))`);
    }
    const lockedWorks = await db
      .select({ id: works.id, deletedAt: works.deletedAt })
      .from(works)
      .innerJoin(contextSources, eq(contextSources.workId, works.id))
      .where(inArray(contextSources.id, uniqueIds))
      .orderBy(works.id)
      .for("update", { of: works });
    const unavailable = lockedWorks.find((work) => work.deletedAt !== null);
    if (unavailable) throw new Error(`Work not found: ${unavailable.id}`);
  }

  private async findDirectFolder(
    sourceId: string,
    parentId: string | null,
    name: string,
  ): Promise<FolderRow | null> {
    const [row] = await currentDrizzleDb(this.db)
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.contextSourceId, sourceId),
          parentId === null ? isNull(folders.parentId) : eq(folders.parentId, parentId),
          eq(folders.name, name),
          isNull(folders.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private async findFolderId(
    sourceId: string,
    dir: readonly string[],
  ): Promise<string | null | undefined> {
    let parentId: string | null = null;
    for (const name of dir) {
      const row = await this.findDirectFolder(sourceId, parentId, name);
      if (!row) return undefined;
      parentId = row.id;
    }
    return parentId;
  }

  private async ensureFolderPath(sourceId: string, dir: readonly string[]): Promise<string | null> {
    let parentId: string | null = null;
    for (const name of dir) {
      const existing = await this.findDirectFolder(sourceId, parentId, name);
      if (existing) {
        parentId = existing.id;
        continue;
      }
      const createdRows: Array<{ id: string }> = await currentDrizzleDb(this.db)
        .insert(folders)
        .values({ contextSourceId: sourceId, parentId, name })
        .returning({ id: folders.id });
      const createdFolderId = createdRows[0]?.id;
      if (!createdFolderId) rollback("conflict");
      parentId = createdFolderId;
    }
    return parentId;
  }

  private async findFolderAtPath(
    sourceId: string,
    path: string,
  ): Promise<{ id: string; updatedAt: string } | null> {
    const segments = treePathSegments(path);
    if (segments.length === 0) return null;
    const folderId = await this.findFolderId(sourceId, segments);
    if (folderId === undefined || folderId === null) return null;
    const [row] = await currentDrizzleDb(this.db)
      .select({
        id: folders.id,
        updatedAt: sql<string>`${folders.updatedAt}::text`,
      })
      .from(folders)
      .where(
        and(
          eq(folders.id, folderId),
          eq(folders.contextSourceId, sourceId),
          isNull(folders.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private async findDocumentAtPath(
    sourceId: string,
    path: string,
  ): Promise<{ id: string; updatedAt: string; filetype: string | null } | null> {
    const { dir, filename } = splitPath(normalizeTreePath(path));
    if (!filename) return null;
    const folderId = await this.findFolderId(sourceId, dir);
    if (folderId === undefined) return null;
    const { name, extension } = parseFilename(filename);
    const [row] = await currentDrizzleDb(this.db)
      .select({
        id: documents.id,
        updatedAt: sql<string>`${documents.updatedAt}::text`,
        storedType: documents.fileType,
        storageUrl: documents.storageUrl,
      })
      .from(documents)
      .where(
        and(
          eq(documents.contextSourceId, sourceId),
          contentDocumentPredicate(),
          folderId === null ? isNull(documents.folderId) : eq(documents.folderId, folderId),
          eq(documents.name, name),
          eq(documents.extension, extension),
          isNull(documents.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return null;
    const isStorageBacked =
      row.storageUrl !== null || BINARY_FILE_TYPES.has(row.storedType as DocumentFileType);
    return {
      id: row.id,
      updatedAt: row.updatedAt,
      filetype: isStorageBacked ? null : row.storedType,
    };
  }

  async inspect(sourceId: string, path: string): Promise<ContextLocationToken | null> {
    const normalized = normalizeTreePath(path);
    if (!normalized) {
      return {
        kind: "directory",
        nodeId: CONTEXT_ROOT_DIRECTORY_ID,
        sourceId,
        path: "",
      };
    }
    const doc = await this.findDocumentAtPath(sourceId, normalized);
    if (doc) {
      return {
        kind: "file",
        nodeId: doc.id,
        sourceId,
        path: normalized,
        filetype: doc.filetype,
      };
    }
    const folder = await this.findFolderAtPath(sourceId, normalized);
    if (folder) {
      return {
        kind: "directory",
        nodeId: folder.id,
        sourceId,
        path: normalized,
      };
    }
    return null;
  }

  private async expectationStillMatches(
    sourceId: string,
    path: string,
    expectation: ContextTargetExpectation,
  ): Promise<boolean> {
    const inspected = await this.inspect(sourceId, path);
    return expectation.state === "absent"
      ? inspected === null
      : sameLocation(inspected, expectation.token);
  }

  async commitMove(
    input: ContextTreeMoveCommand,
  ): Promise<Result<ContextTreeMutationResult, ContextTreeMutationError>> {
    return this.withMutationTransaction(async (events) => {
      await this.lockSources([input.source.sourceId, input.destinationSourceId]);
      const destinationPath = normalizeTreePath(input.destinationPath);
      const targetBasename = treeBasename(destinationPath);
      if (!targetBasename || input.source.nodeId === CONTEXT_ROOT_DIRECTORY_ID) {
        return Err({ code: "invalid_operation" });
      }

      const sourceNow = await this.inspect(input.source.sourceId, input.source.path);
      if (!sameLocation(sourceNow, input.source)) return Err({ code: "stale_source" });
      if (
        !(await this.expectationStillMatches(
          input.destinationSourceId,
          destinationPath,
          input.expectedTarget,
        ))
      ) {
        return Err({ code: "stale_target" });
      }

      const targetToken =
        input.expectedTarget.state === "occupied" ? input.expectedTarget.token : null;
      if (targetToken) {
        if (targetToken.kind !== input.source.kind) return Err({ code: "invalid_operation" });
        if (targetToken.nodeId === input.source.nodeId) return Err({ code: "invalid_operation" });
        if (!input.overwrite || input.source.kind === "directory") {
          return Err({ code: "conflict" });
        }
      }

      const targetParentPath = treeDirname(destinationPath);
      if (
        input.source.kind === "directory" &&
        input.source.sourceId === input.destinationSourceId &&
        (targetParentPath === input.source.path ||
          targetParentPath.startsWith(`${input.source.path}/`))
      ) {
        return Err({ code: "invalid_operation" });
      }

      const destParentId = await this.ensureFolderPath(
        input.destinationSourceId,
        treePathSegments(targetParentPath),
      );
      const now = new Date();

      if (input.source.kind === "file") {
        if (targetToken?.kind === "file") {
          await this.runBeforeDestructiveWrite();
          const deletedTarget = await currentDrizzleDb(this.db)
            .update(documents)
            .set({ deletedAt: now, updatedAt: now })
            .where(
              and(
                eq(documents.id, targetToken.nodeId),
                eq(documents.contextSourceId, input.destinationSourceId),
                isNull(documents.deletedAt),
              ),
            )
            .returning({ id: documents.id });
          if (deletedTarget.length !== 1) rollback("stale_target");
          events.push({ method: "documentDeleted", documentId: targetToken.nodeId });
        }

        const { name, extension } = parseFilename(targetBasename);
        const basenameChanged = targetBasename !== treeBasename(input.source.path);
        await this.runBeforeDestructiveWrite();
        const moved = await currentDrizzleDb(this.db)
          .update(documents)
          .set({
            contextSourceId: input.destinationSourceId,
            folderId: destParentId,
            name,
            extension,
            ...(basenameChanged ||
            ("graduateProvisionalName" in input && input.graduateProvisionalName)
              ? { provisionalName: false }
              : {}),
            ...(input.destinationFiletype == null ? {} : { fileType: input.destinationFiletype }),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(documents.id, input.source.nodeId),
              eq(documents.contextSourceId, input.source.sourceId),
              isNull(documents.deletedAt),
            ),
          )
          .returning({ id: documents.id });
        if (moved.length !== 1) rollback("stale_source");
        await this.catalogMutations?.refreshSources(
          [input.source.sourceId, input.destinationSourceId],
          [input.source.nodeId],
        );
        return Ok({ movedNodeId: input.source.nodeId });
      }

      if (input.source.sourceId === input.destinationSourceId) {
        await this.runBeforeDestructiveWrite();
        const movedRoot = await currentDrizzleDb(this.db)
          .update(folders)
          .set({
            parentId: destParentId,
            name: targetBasename,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(folders.id, input.source.nodeId),
              eq(folders.contextSourceId, input.source.sourceId),
              isNull(folders.deletedAt),
            ),
          )
          .returning({ id: folders.id });
        if (movedRoot.length !== 1) rollback("stale_source");
        await this.catalogMutations?.refreshSources([input.source.sourceId], [input.source.nodeId]);
        return Ok({ movedNodeId: input.source.nodeId });
      }

      await this.runBeforeDestructiveWrite();
      const movedRoot = await currentDrizzleDb(this.db)
        .update(folders)
        .set({
          contextSourceId: input.destinationSourceId,
          parentId: destParentId,
          name: targetBasename,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(folders.id, input.source.nodeId),
            eq(folders.contextSourceId, input.source.sourceId),
            isNull(folders.deletedAt),
          ),
        )
        .returning({ id: folders.id });
      if (movedRoot.length !== 1) rollback("stale_source");

      await currentDrizzleDb(this.db).execute(sql`
        WITH RECURSIVE subtree AS (
          SELECT id FROM folders
          WHERE parent_id = ${input.source.nodeId}
            AND context_source_id = ${input.source.sourceId}
            AND deleted_at IS NULL
          UNION ALL
          SELECT f.id FROM folders f
          JOIN subtree s ON f.parent_id = s.id
          WHERE f.context_source_id = ${input.source.sourceId}
            AND f.deleted_at IS NULL
        )
        UPDATE folders
        SET context_source_id = ${input.destinationSourceId},
            updated_at = NOW()
        WHERE id IN (SELECT id FROM subtree)
      `);

      await currentDrizzleDb(this.db).execute(sql`
        WITH RECURSIVE subtree AS (
          SELECT id FROM folders
          WHERE id = ${input.source.nodeId}
            AND deleted_at IS NULL
          UNION ALL
          SELECT f.id FROM folders f
          JOIN subtree s ON f.parent_id = s.id
          WHERE f.deleted_at IS NULL
        )
        UPDATE documents
        SET context_source_id = ${input.destinationSourceId},
            updated_at = NOW()
        WHERE deleted_at IS NULL
          AND ${contentDocumentKindSql()}
          AND folder_id IN (SELECT id FROM subtree)
      `);

      await this.catalogMutations?.refreshSources(
        [input.source.sourceId, input.destinationSourceId],
        [input.source.nodeId],
      );

      return Ok({ movedNodeId: input.source.nodeId });
    });
  }

  async commitProvisionalGraduation(
    source: Extract<ContextLocationToken, { kind: "file" }>,
  ): Promise<Result<void, ContextTreeMutationError>> {
    return this.withMutationTransaction(async () => {
      await this.lockSources([source.sourceId]);
      const current = await this.inspect(source.sourceId, source.path);
      if (!sameLocation(current, source)) return Err({ code: "stale_source" });
      const graduated = await currentDrizzleDb(this.db)
        .update(documents)
        .set({ provisionalName: false })
        .where(
          and(
            eq(documents.id, source.nodeId),
            eq(documents.contextSourceId, source.sourceId),
            isNull(documents.deletedAt),
          ),
        )
        .returning({ id: documents.id });
      if (graduated.length !== 1) rollback("stale_source");
      await this.catalogMutations?.refreshSources([source.sourceId]);
      return Ok(undefined);
    });
  }

  async commitRecursiveDelete(
    command: ContextTreeDeleteCommand,
  ): Promise<Result<ContextTreeDeleteResult, ContextTreeMutationError>> {
    if (!this.catalogMutations) {
      throw new Error("Recursive deletion requires catalog generation authority");
    }
    const catalogMutations = this.catalogMutations;
    return this.withMutationTransaction(async (events) => {
      const token = command.root;
      await this.lockSources([token.sourceId]);
      if (token.nodeId === CONTEXT_ROOT_DIRECTORY_ID) return Err({ code: "invalid_operation" });
      const current = await this.inspect(token.sourceId, token.path);
      if (!sameLocation(current, token)) return Err({ code: "stale_source" });
      const now = new Date();

      if (token.kind === "file") {
        await this.runBeforeDestructiveWrite();
        const deleted = await currentDrizzleDb(this.db)
          .update(documents)
          .set({ deletedAt: now, updatedAt: now })
          .where(
            and(
              eq(documents.id, token.nodeId),
              eq(documents.contextSourceId, token.sourceId),
              contentDocumentPredicate(),
              isNull(documents.deletedAt),
            ),
          )
          .returning({ id: documents.id });
        const [deletedDocument] = deleted;
        if (!deletedDocument || deleted.length !== 1) rollback("stale_source");
        events.push({ method: "documentDeleted", documentId: deletedDocument.id });
        const availabilityGeneration = await catalogMutations.refreshSources(
          [token.sourceId],
          [token.nodeId],
        );
        return Ok({ deletedDocumentIds: [deletedDocument.id], availabilityGeneration });
      }

      const folderClosure = await currentDrizzleDb(this.db).execute<{ id: string }>(sql`
        WITH RECURSIVE subtree AS (
          SELECT id FROM folders
          WHERE id = ${token.nodeId}
            AND context_source_id = ${token.sourceId}
            AND deleted_at IS NULL
          UNION ALL
          SELECT child.id FROM folders child
          JOIN subtree parent ON child.parent_id = parent.id
          WHERE child.context_source_id = ${token.sourceId}
            AND child.deleted_at IS NULL
        )
        SELECT id::text FROM subtree ORDER BY id
      `);
      const folderIds = folderClosure.map((row) => row.id);
      if (!folderIds.includes(token.nodeId)) rollback("stale_source");
      const documentClosure = await currentDrizzleDb(this.db)
        .select({ id: documents.id, kind: documents.kind })
        .from(documents)
        .where(
          and(
            eq(documents.contextSourceId, token.sourceId),
            inArray(documents.folderId, folderIds as never),
            isNull(documents.deletedAt),
          ),
        );
      const deletedDocumentIds = documentClosure
        .filter((row) => row.kind === "content")
        .map((row) => row.id)
        .sort();

      await this.runBeforeDestructiveWrite();
      if (documentClosure.length > 0) {
        await currentDrizzleDb(this.db)
          .update(documents)
          .set({ deletedAt: now, updatedAt: now })
          .where(
            inArray(
              documents.id,
              documentClosure.map((row) => row.id),
            ),
          );
      }
      const deletedFolders = await currentDrizzleDb(this.db)
        .update(folders)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(
            eq(folders.contextSourceId, token.sourceId),
            inArray(folders.id, folderIds as never),
            isNull(folders.deletedAt),
          ),
        )
        .returning({ id: folders.id });
      if (deletedFolders.length !== folderIds.length) rollback("stale_source");
      for (const documentId of deletedDocumentIds) {
        events.push({ method: "documentDeleted", documentId });
      }
      const availabilityGeneration = await catalogMutations.refreshSources(
        [token.sourceId],
        [token.nodeId],
      );
      return Ok({ deletedDocumentIds, availabilityGeneration });
    });
  }
}
