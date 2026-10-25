/** Drizzle backing-scoped atomic ContextFS tree mutations. */

import type { ContextSourceId, FolderId, ThreadId, UserId } from "@meridian/contracts";
import {
  parseDocumentFilename,
  renderFilename as renderDocumentFilename,
} from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documents, folders } from "@meridian/database/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleSavepoint } from "../../../../shared/drizzle-transaction.js";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import { splitPath } from "../../context/paths.js";
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
import type { DocumentRemoval } from "../../ports/document-removal.js";
import { splitHiddenContents } from "../../tree/folder-normalization.js";
import type { HiddenNodeRepair } from "../../tree/hidden-node-repair.js";
import { bumpLocationVersions } from "../../tree/node-locations.js";
import { moveNode } from "../../tree/node-moves.js";
import { lockDocuments } from "../../tree/node-rows.js";
import { createTreeReader, LIVE_TREE, type TreeView } from "../../tree/tree-view.js";
import { isStorageBackedDocument } from "../catalog-file-mapper.js";
import {
  lockContextSources,
  lockMovedDocumentRows,
  readTreeLocations,
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

/** The node at `path` in the selected tree, as a location token; null when nothing is there. */
export async function inspectTreeLocation(
  db: Database,
  sourceId: string,
  path: string,
  view: TreeView = LIVE_TREE,
  expectedKind?: ContextLocationToken["kind"],
): Promise<ContextLocationToken | null> {
  const normalized = normalizeTreePath(path);
  if (!normalized) {
    return {
      kind: "directory",
      nodeId: CONTEXT_ROOT_DIRECTORY_ID,
      sourceId,
      path: "",
    };
  }
  const tree = createTreeReader(db);
  if (expectedKind === "directory") {
    const found = await tree.resolvePath(view, {
      contextSourceId: sourceId as ContextSourceId,
      path: normalized,
    });
    const folderIds =
      found.kind === "found"
        ? found.node.kind === "folder"
          ? [found.node.folder.id]
          : []
        : found.kind === "ambiguous"
          ? found.nodes.flatMap((node) => (node.kind === "folder" ? [node.id] : []))
          : [];
    return folderIds.length === 1
      ? { kind: "directory", nodeId: folderIds[0] as FolderId, sourceId, path: normalized }
      : null;
  }
  // A document answers at its canonical name (`ch1.md` is `ch1`); a folder at its literal one.
  const documentPath = canonicalDocumentPath(normalized);
  const asDocument =
    documentPath === null
      ? null
      : await tree.resolvePath(view, {
          contextSourceId: sourceId as ContextSourceId,
          path: documentPath,
        });
  if (asDocument?.kind === "found" && asDocument.node.kind === "document") {
    const document = asDocument.node.document;
    return {
      kind: "file",
      nodeId: document.id,
      sourceId,
      path: documentPath as string,
      filetype: isStorageBackedDocument(document) ? null : document.fileType,
    };
  }
  const found =
    documentPath === normalized && asDocument
      ? asDocument
      : await tree.resolvePath(view, {
          contextSourceId: sourceId as ContextSourceId,
          path: normalized,
        });
  if (found.kind !== "found" || found.node.kind !== "folder") return null;
  return { kind: "directory", nodeId: found.node.folder.id, sourceId, path: normalized };
}

/** Drizzle implementation of the backing-scoped atomic ContextFS tree mutator. */
export class DrizzleContextTreeMutationStore implements ContextTreeMutationStore {
  private beforeDestructiveWrite: (() => void | Promise<void>) | null = null;

  private readonly catalogMutations?: ContextCatalogMutationPort;
  private readonly arrivals?: Pick<DocumentArrivals, "settle">;
  /** Repair on touch (§12.4): the move's link count reads identity with it. */
  private readonly repair?: Pick<HiddenNodeRepair, "schedule">;
  private readonly removal: DocumentRemoval;

  constructor(
    private readonly db: Database,
    options: {
      removal: DocumentRemoval;
      catalogMutations?: ContextCatalogMutationPort;
      arrivals?: Pick<DocumentArrivals, "settle">;
      repair?: Pick<HiddenNodeRepair, "schedule">;
    },
  ) {
    this.removal = options.removal;
    this.catalogMutations = options.catalogMutations;
    this.arrivals = options.arrivals;
    this.repair = options.repair;
  }

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
    moved: readonly DocumentId[],
  ): Promise<{ links: number; documents: number }> {
    if (moved.length > 0) {
      await this.arrivals?.settle(moved);
    }
    return input.linkNoteProjectId
      ? countIncomingLinks(
          this.db,
          { projectId: input.linkNoteProjectId as ProjectId, movedDocumentIds: moved },
          this.repair,
        )
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

  /** Reads the selected tree; mutation callers default to live and cannot touch hidden nodes. */
  inspect(sourceId: string, path: string, view: TreeView = LIVE_TREE) {
    return inspectTreeLocation(this.db, sourceId, path, view);
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

      // The writer's identity parent, still at its path under these locks: the path move
      // below lands in that live folder, and `destinationCreateFolders` beneath it are a
      // live create (revealing a hidden folder of the same name, §6.3).
      if (
        input.destinationParentToken &&
        !sameLocation(
          await this.inspect(input.destinationSourceId, input.destinationParentToken.path),
          input.destinationParentToken,
        )
      )
        return Err({ code: "destination_missing" });

      const targetToken =
        input.expectedTarget.state === "occupied" ? input.expectedTarget.token : null;
      if (targetToken) {
        if (targetToken.nodeId === input.source.nodeId) return Err({ code: "invalid_operation" });
        if (
          input.overwrite &&
          (targetToken.kind !== input.source.kind || input.source.kind === "directory")
        ) {
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
      const mutationIds = [
        ...(input.source.sourceId !== input.destinationSourceId || (targetToken && input.overwrite)
          ? previousLocations.flatMap((entry) => (entry.kind === "file" ? [entry.id] : []))
          : []),
        ...(targetToken?.kind === "file" && input.overwrite ? [targetToken.nodeId] : []),
      ];
      await lockDocuments(this.db, mutationIds);
      // Moved files and an overwrite victim, row-locked in id order: orders this move against
      // derive certification and journal FK inserts. A move writes nothing into any holder.
      await lockMovedDocumentRows(this.db, [
        ...previousLocations.flatMap((entry) =>
          entry.kind === "file" ? [entry.id as DocumentId] : [],
        ),
        ...(targetToken?.kind === "file" && input.overwrite
          ? [targetToken.nodeId as DocumentId]
          : []),
      ]);
      await this.runBeforeDestructiveWrite();
      if (targetToken?.kind === "file" && input.overwrite) {
        await this.removal.remove({
          documentIds: [targetToken.nodeId as DocumentId],
          reason: "deleted",
          userId: input.actorUserId as UserId,
        });
      }

      const isFile = input.source.kind === "file";
      const parsed = isFile ? parseDocumentFilename(targetBasename) : null;
      if (parsed && !parsed.ok) return Err({ code: "invalid_operation" });
      const { name, extension } = parsed?.ok
        ? parsed.value
        : { name: targetBasename, extension: undefined };
      const moved = await moveNode(this.db, {
        node: isFile
          ? { kind: "document", id: input.source.nodeId as DocumentId }
          : { kind: "folder", id: input.source.nodeId as FolderId },
        to: {
          contextSourceId: input.destinationSourceId as ContextSourceId,
          dir: treePathSegments(targetParentPath),
          name,
          ...(extension === undefined ? {} : { extension }),
        },
        filetype: input.destinationFiletype ?? null,
      });
      if (!moved.ok) rollback(moved.error.code);
      if (
        input.source.kind === "file" &&
        (targetBasename !== treeBasename(input.source.path) ||
          ("graduateProvisionalName" in input && input.graduateProvisionalName))
      ) {
        await currentDrizzleDb(this.db)
          .update(documents)
          .set({ provisionalName: false })
          .where(eq(documents.id, input.source.nodeId));
      }
      // What actually moved: a folder leaving its project left its hidden contents behind.
      const linkUpdate = await this.settleMovedIn(input, moved.value.documentIds);
      await this.catalogMutations?.refreshSources(
        [...new Set([input.source.sourceId, input.destinationSourceId])],
        [input.source.nodeId],
      );
      return Ok({
        movedNodeId: input.source.nodeId,
        destinationPath: [
          ...moved.value.target.dir,
          moved.value.target.extension
            ? renderDocumentFilename(moved.value.target.name, moved.value.target.extension)
            : moved.value.target.name,
        ].join("/"),
        linkUpdate,
      });
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
        await lockDocuments(this.db, [token.nodeId]);
        await this.runBeforeDestructiveWrite();
        const removed = await this.removal.remove({
          documentIds: [token.nodeId as DocumentId],
          reason: command.removal?.reason ?? "deleted",
          cause: command.removal?.cause,
          userId: command.actorUserId as UserId,
          threadId: command.actorThreadId as ThreadId | undefined,
        });
        const availabilityGeneration = await catalogMutations.refreshSources(
          [token.sourceId],
          [token.nodeId],
        );
        return Ok({ removed: [...removed], availabilityGeneration });
      }

      // Splitting also updates hidden boundary document rows. Lock the complete
      // pre-split subtree before any of those rows, not just the later delete set.
      await lockDocuments(
        this.db,
        (await readTreeLocations(this.db, token)).flatMap((entry) =>
          entry.kind === "file" ? [entry.id] : [],
        ),
      );
      // Hidden contents stay where their branches placed them, under twins at their paths (§8.3).
      await splitHiddenContents(this.db, token.nodeId as FolderId);
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
      await this.runBeforeDestructiveWrite();
      const removed = await this.removal.remove({
        documentIds: documentClosure.map((row) => row.id),
        reason: command.removal?.reason ?? "deleted",
        cause: command.removal?.cause,
        userId: command.actorUserId as UserId,
      });
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
      await bumpLocationVersions(this.db, {
        folderIds,
      });
      const availabilityGeneration = await catalogMutations.refreshSources(
        [token.sourceId],
        [token.nodeId],
      );
      return Ok({ removed: [...removed], availabilityGeneration });
    });
  }
}

/** `path` with its leaf spelled as the codec's canonical document name; null when it can't name one. */
function canonicalDocumentPath(path: string): string | null {
  const { dir, filename } = splitPath(path);
  const parsed = parseDocumentFilename(filename);
  if (!parsed.ok) return null;
  return [...dir, renderDocumentFilename(parsed.value.name, parsed.value.extension)].join("/");
}
