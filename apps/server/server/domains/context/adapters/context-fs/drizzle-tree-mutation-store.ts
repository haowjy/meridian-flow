/** Drizzle backing-scoped atomic ContextFS tree mutations. */

import type { ContextSourceId } from "@meridian/contracts";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documents, folders } from "@meridian/database/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { lockDocumentMutation } from "../../../../shared/document-mutation-lock.js";
import { currentDrizzleDb, runInDrizzleSavepoint } from "../../../../shared/drizzle-transaction.js";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import { parseFilename } from "../../context/paths.js";
import { countIncomingLinks } from "../../links/move-link-count.js";
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
import type { DocumentArrivals } from "../../ports/document-arrivals.js";
import { ensureLiveFolderPath } from "../../tree/hidden-nodes.js";
import { createTreeReader, LIVE_TREE } from "../../tree/tree-view.js";
import { isStorageBackedDocument } from "../catalog-file-mapper.js";
import {
  lockContextSources,
  lockMovedDocumentRows,
  type NamespaceLocation,
  readTreeLocations,
  recordDocumentMove,
} from "./document-locations.js";

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
    private readonly catalogMutations?: ContextCatalogMutationPort,
    private readonly arrivals?: Pick<DocumentArrivals, "settle">,
  ) {}

  /** Test hook: runs after CAS rechecks, immediately before destructive writes. */
  setBeforeDestructiveWrite(hook: (() => void | Promise<void>) | null): void {
    this.beforeDestructiveWrite = hook;
  }

  private async runBeforeDestructiveWrite(): Promise<void> {
    await this.beforeDestructiveWrite?.();
  }

  /**
   * Move-in arrival (contract §9.3): once per move, after all DML and history, so a folder
   * move settles against its final tree. Every participating namespace is already locked.
   * The destination source determines project visibility. The note's count includes refs this
   * settlement just bound (contract §10).
   */
  private async settleMovedIn(
    input: ContextTreeMoveCommand,
    previous: readonly NamespaceLocation[],
  ): Promise<{ links: number; documents: number }> {
    const moved = previous.flatMap((entry) =>
      entry.kind === "file" ? [entry.id as DocumentId] : [],
    );
    if (moved.length > 0) {
      await this.arrivals?.settle(moved);
    }
    return input.linkNoteProjectId
      ? countIncomingLinks(this.db, {
          projectId: input.linkNoteProjectId as ProjectId,
          movedDocumentIds: moved,
        })
      : { links: 0, documents: 0 };
  }

  private async withMutationTransaction<T>(
    operation: () => Promise<Result<T, ContextTreeMutationError>>,
  ): Promise<Result<T, ContextTreeMutationError>> {
    let result: Result<T, ContextTreeMutationError>;
    try {
      result = await runInDrizzleSavepoint(this.db, operation);
    } catch (error) {
      if (error instanceof ContextTreeMutationRollback) return Err({ code: error.code });
      if (isPgConstraintError(error)) return Err({ code: "conflict" });
      throw error;
    }
    return result;
  }

  /** Destination folders through the live tree: a hidden folder at a path is revealed, never twinned. */
  private async ensureFolderPath(sourceId: string, dir: readonly string[]): Promise<string | null> {
    const ensured = await ensureLiveFolderPath(this.db, {
      contextSourceId: sourceId as ContextSourceId,
      dir,
    });
    if (!ensured.ok) rollback("conflict");
    return ensured.value;
  }

  /** The live node at `path`: a hidden node is never moved or deleted live. */
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
    const found = await createTreeReader(this.db).resolvePath(LIVE_TREE, {
      contextSourceId: sourceId as ContextSourceId,
      path: normalized,
    });
    if (found.kind !== "found") return null;
    if (found.node.kind === "folder") {
      return { kind: "directory", nodeId: found.node.folder.id, sourceId, path: normalized };
    }
    const document = found.node.document;
    return {
      kind: "file",
      nodeId: document.id,
      sourceId,
      path: normalized,
      filetype: isStorageBackedDocument(document) ? null : document.fileType,
    };
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
    return this.withMutationTransaction(async () => {
      await lockContextSources(this.db, [input.source.sourceId, input.destinationSourceId]);
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

      const previousLocations = await readTreeLocations(this.db, input.source);
      // A move between sources can change a document's owner, so it waits for
      // any write that confirmed the old owner (file-access §5, step 3).
      if (input.source.sourceId !== input.destinationSourceId) {
        const moved = previousLocations.filter((location) => location.kind === "file");
        for (const id of moved.map((location) => location.id).sort()) {
          await lockDocumentMutation(currentDrizzleDb(this.db), id);
        }
      }
      // Moved files and an overwrite victim, row-locked in id order: orders this move against
      // derive certification and journal FK inserts. A move writes nothing into any holder.
      await lockMovedDocumentRows(this.db, [
        ...previousLocations.flatMap((entry) =>
          entry.kind === "file" ? [entry.id as DocumentId] : [],
        ),
        ...(targetToken?.kind === "file" ? [targetToken.nodeId as DocumentId] : []),
      ]);
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
        await recordDocumentMove(
          this.db,
          input.source.sourceId,
          input.destinationSourceId,
          previousLocations,
          input.source.path,
          destinationPath,
        );
        const linkUpdate = await this.settleMovedIn(input, previousLocations);
        await this.catalogMutations?.refreshSources(
          [input.source.sourceId, input.destinationSourceId],
          [input.source.nodeId],
        );
        return Ok({ movedNodeId: input.source.nodeId, linkUpdate });
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
        await recordDocumentMove(
          this.db,
          input.source.sourceId,
          input.destinationSourceId,
          previousLocations,
          input.source.path,
          destinationPath,
        );
        const linkUpdate = await this.settleMovedIn(input, previousLocations);
        await this.catalogMutations?.refreshSources([input.source.sourceId], [input.source.nodeId]);
        return Ok({ movedNodeId: input.source.nodeId, linkUpdate });
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
          AND folder_id IN (SELECT id FROM subtree)
      `);

      await recordDocumentMove(
        this.db,
        input.source.sourceId,
        input.destinationSourceId,
        previousLocations,
        input.source.path,
        destinationPath,
      );
      const linkUpdate = await this.settleMovedIn(input, previousLocations);
      await this.catalogMutations?.refreshSources(
        [input.source.sourceId, input.destinationSourceId],
        [input.source.nodeId],
      );

      return Ok({ movedNodeId: input.source.nodeId, linkUpdate });
    });
  }

  async commitProvisionalGraduation(
    source: Extract<ContextLocationToken, { kind: "file" }>,
  ): Promise<Result<void, ContextTreeMutationError>> {
    return this.withMutationTransaction(async () => {
      await lockContextSources(this.db, [source.sourceId]);
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
    return this.withMutationTransaction(async () => {
      const token = command.root;
      await lockContextSources(this.db, [token.sourceId]);
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
              isNull(documents.deletedAt),
            ),
          )
          .returning({ id: documents.id });
        const [deletedDocument] = deleted;
        if (!deletedDocument || deleted.length !== 1) rollback("stale_source");
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
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.contextSourceId, token.sourceId),
            inArray(documents.folderId, folderIds as never),
            isNull(documents.deletedAt),
          ),
        );
      const deletedDocumentIds = documentClosure.map((row) => row.id).sort();

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
      const availabilityGeneration = await catalogMutations.refreshSources(
        [token.sourceId],
        [token.nodeId],
      );
      return Ok({ deletedDocumentIds, availabilityGeneration });
    });
  }
}
