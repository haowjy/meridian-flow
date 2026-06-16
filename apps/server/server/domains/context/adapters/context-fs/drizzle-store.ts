/** Drizzle ContextDocumentStore for one Meridian context source. */
import type { DocumentFileType, Filetype } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documents, folders } from "@meridian/database/schema";
import { and, eq, ilike, isNull, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInDrizzleTransaction,
} from "../../../../shared/drizzle-transaction.js";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import { parseFilename, splitPath } from "../../context/paths.js";
import type {
  ContextDocument,
  ContextDocumentStore,
  ContextFolder,
  ContextSearchRow,
  CreateBinaryDocumentInput,
  UpsertBinaryDocumentInput,
  UpsertDocumentInput,
} from "../../ports/context-document-store.js";
import {
  CONTEXT_ROOT_DIRECTORY_ID,
  type ContextLocationToken,
  type ContextTargetExpectation,
  type ContextTreeDeleteResult,
  type ContextTreeMutationError,
  type ContextTreeMutationResult,
  type ContextTreeMutationStore,
  type PreparedContextMove,
} from "../../ports/context-tree-mutation-store.js";
import { firstLineMatch } from "./match.js";

type FolderRow = typeof folders.$inferSelect;
type DocumentRow = typeof documents.$inferSelect;

const BINARY_FILE_TYPES = new Set<DocumentFileType>(["docx", "image", "pdf", "binary"]);

function mapFolder(row: FolderRow): ContextFolder {
  return { id: row.id, parentId: row.parentId, name: row.name };
}

function mapDocument(row: DocumentRow): ContextDocument {
  const storedType = row.fileType as Filetype | DocumentFileType;
  const isBinary = BINARY_FILE_TYPES.has(storedType as DocumentFileType) || row.storageUrl !== null;
  return {
    id: row.id,
    folderId: row.folderId,
    name: row.name,
    extension: row.extension,
    markdown: row.markdownProjection,
    fileType: isBinary ? (storedType as DocumentFileType) : null,
    filetype: isBinary ? null : (storedType as Filetype),
    storageUrl: row.storageUrl,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface DrizzleContextDocumentStoreDeps {
  db: Database;
  contextSourceId: string;
}

export async function updateDocumentProjectionById(
  db: Database,
  documentId: string,
  markdown: string,
): Promise<boolean> {
  const [row] = await db
    .update(documents)
    .set({
      markdownProjection: markdown,
      sizeBytes: Buffer.byteLength(markdown, "utf8"),
      updatedAt: new Date(),
    })
    .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
    .returning({ id: documents.id });
  return Boolean(row);
}

export class DrizzleContextDocumentStore implements ContextDocumentStore {
  constructor(private readonly deps: DrizzleContextDocumentStoreDeps) {}

  private get db() {
    return this.deps.db;
  }

  private get sourceId() {
    return this.deps.contextSourceId;
  }

  async contextSourceId(): Promise<string> {
    return this.sourceId;
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    return runInDrizzleTransaction(this.db, operation);
  }

  async findFolder(parentId: string | null, name: string): Promise<ContextFolder | null> {
    const [row] = await this.db
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.contextSourceId, this.sourceId),
          parentId === null ? isNull(folders.parentId) : eq(folders.parentId, parentId),
          eq(folders.name, name),
          isNull(folders.deletedAt),
        ),
      )
      .limit(1);
    return row ? mapFolder(row) : null;
  }

  async createFolder(parentId: string | null, name: string): Promise<ContextFolder> {
    const [row] = await this.db
      .insert(folders)
      .values({ contextSourceId: this.sourceId, parentId, name })
      .returning();
    if (!row) throw new Error("Failed to create folder");
    return mapFolder(row);
  }

  async findDocument(
    folderId: string | null,
    name: string,
    extension: string,
  ): Promise<ContextDocument | null> {
    const [row] = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.contextSourceId, this.sourceId),
          folderId === null ? isNull(documents.folderId) : eq(documents.folderId, folderId),
          eq(documents.name, name),
          eq(documents.extension, extension),
          isNull(documents.deletedAt),
        ),
      )
      .limit(1);
    return row ? mapDocument(row) : null;
  }

  async upsertDocument(input: UpsertDocumentInput): Promise<ContextDocument> {
    const existing = await this.findDocument(input.folderId, input.name, input.extension);
    const values = {
      fileType: input.filetype,
      storageUrl: null,
      mimeType: null,
      markdownProjection: input.markdown,
      sizeBytes: Buffer.byteLength(input.markdown, "utf8"),
      updatedAt: new Date(),
    };
    if (existing) {
      const [row] = await this.db
        .update(documents)
        .set(values)
        .where(eq(documents.id, existing.id))
        .returning();
      if (!row) throw new Error(`Failed to update document: ${existing.id}`);
      return mapDocument(row);
    }
    const [row] = await this.db
      .insert(documents)
      .values({
        id: input.id,
        contextSourceId: this.sourceId,
        folderId: input.folderId,
        name: input.name,
        extension: input.extension,
        fileType: input.filetype,
        markdownProjection: input.markdown,
        sizeBytes: Buffer.byteLength(input.markdown, "utf8"),
      })
      .returning();
    if (!row) throw new Error("Failed to insert document");
    return mapDocument(row);
  }

  async upsertBinaryDocument(input: UpsertBinaryDocumentInput): Promise<ContextDocument> {
    const existing = await this.findDocument(input.folderId, input.name, input.extension);
    if (existing) {
      const [row] = await this.db
        .update(documents)
        .set({
          fileType: input.fileType,
          storageUrl: input.storageUrl,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, existing.id))
        .returning();
      if (!row) throw new Error(`Failed to update binary document: ${existing.id}`);
      return mapDocument(row);
    }
    return this.createBinaryDocument(input);
  }

  async createBinaryDocument(input: CreateBinaryDocumentInput): Promise<ContextDocument> {
    const [row] = await this.db
      .insert(documents)
      .values({
        id: input.id,
        contextSourceId: this.sourceId,
        folderId: input.folderId,
        name: input.name,
        extension: input.extension,
        fileType: input.fileType,
        storageUrl: input.storageUrl,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        markdownProjection: "",
      })
      .returning();
    if (!row) throw new Error("Failed to create binary document");
    return mapDocument(row);
  }

  async listFolders(parentId: string | null): Promise<ContextFolder[]> {
    const rows = await this.db
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.contextSourceId, this.sourceId),
          parentId === null ? isNull(folders.parentId) : eq(folders.parentId, parentId),
          isNull(folders.deletedAt),
        ),
      );
    return rows.map(mapFolder);
  }

  async listDocuments(folderId: string | null): Promise<ContextDocument[]> {
    const rows = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.contextSourceId, this.sourceId),
          folderId === null ? isNull(documents.folderId) : eq(documents.folderId, folderId),
          isNull(documents.deletedAt),
        ),
      );
    return rows.map(mapDocument);
  }

  private async folderPath(folderId: string | null): Promise<string> {
    const names: string[] = [];
    let current = folderId;
    while (current !== null) {
      const [row]: FolderRow[] = await this.db
        .select()
        .from(folders)
        .where(eq(folders.id, current))
        .limit(1);
      if (!row) break;
      names.unshift(row.name);
      current = row.parentId;
    }
    return names.join("/");
  }

  async searchDocuments(query: string): Promise<ContextSearchRow[]> {
    const rows = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.contextSourceId, this.sourceId),
          isNull(documents.deletedAt),
          ilike(documents.markdownProjection, `%${query}%`),
        ),
      );
    const out: ContextSearchRow[] = [];
    for (const row of rows) {
      const match = firstLineMatch(row.markdownProjection, query);
      if (!match) continue;
      out.push({
        document: mapDocument(row),
        folderPath: await this.folderPath(row.folderId),
        excerpt: match.excerpt,
        line: match.line,
      });
    }
    return out;
  }
}
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
    a?.revision === b?.revision
  );
}

function locationRevision(updatedAt: Date | string): string {
  return updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt;
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
  constructor(private readonly db: Database) {}

  private async withMutationTransaction<T>(
    operation: () => Promise<Result<T, ContextTreeMutationError>>,
  ): Promise<Result<T, ContextTreeMutationError>> {
    try {
      return await runInDrizzleTransaction(this.db, operation);
    } catch (error) {
      if (error instanceof ContextTreeMutationRollback) return Err({ code: error.code });
      if (isPgConstraintError(error)) return Err({ code: "conflict" });
      throw error;
    }
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

  private async findFolderAtPath(sourceId: string, path: string): Promise<FolderRow | null> {
    const segments = treePathSegments(path);
    if (segments.length === 0) return null;
    const folderId = await this.findFolderId(sourceId, segments);
    if (folderId === undefined || folderId === null) return null;
    const [row] = await currentDrizzleDb(this.db)
      .select()
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

  private async findDocumentAtPath(sourceId: string, path: string): Promise<DocumentRow | null> {
    const { dir, filename } = splitPath(normalizeTreePath(path));
    if (!filename) return null;
    const folderId = await this.findFolderId(sourceId, dir);
    if (folderId === undefined) return null;
    const { name, extension } = parseFilename(filename);
    const [row] = await currentDrizzleDb(this.db)
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.contextSourceId, sourceId),
          folderId === null ? isNull(documents.folderId) : eq(documents.folderId, folderId),
          eq(documents.name, name),
          eq(documents.extension, extension),
          isNull(documents.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async inspect(sourceId: string, path: string): Promise<ContextLocationToken | null> {
    const normalized = normalizeTreePath(path);
    if (!normalized) {
      return {
        kind: "directory",
        nodeId: CONTEXT_ROOT_DIRECTORY_ID,
        sourceId,
        path: "",
        revision: "",
      };
    }
    const doc = await this.findDocumentAtPath(sourceId, normalized);
    if (doc) {
      return {
        kind: "file",
        nodeId: doc.id,
        sourceId,
        path: normalized,
        revision: locationRevision(doc.updatedAt),
      };
    }
    const folder = await this.findFolderAtPath(sourceId, normalized);
    if (folder) {
      return {
        kind: "directory",
        nodeId: folder.id,
        sourceId,
        path: normalized,
        revision: locationRevision(folder.updatedAt),
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
    input: PreparedContextMove,
  ): Promise<Result<ContextTreeMutationResult, ContextTreeMutationError>> {
    return this.withMutationTransaction(async () => {
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
      const invalidatedDocumentIds: string[] = [];

      if (input.source.kind === "file") {
        if (targetToken?.kind === "file") {
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
          invalidatedDocumentIds.push(targetToken.nodeId);
        }

        const { name, extension } = parseFilename(targetBasename);
        const moved = await currentDrizzleDb(this.db)
          .update(documents)
          .set({
            contextSourceId: input.destinationSourceId,
            folderId: destParentId,
            name,
            extension,
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
        if (input.source.sourceId !== input.destinationSourceId) {
          invalidatedDocumentIds.push(input.source.nodeId);
        }
        return Ok({ movedNodeId: input.source.nodeId, invalidatedDocumentIds });
      }

      if (input.source.sourceId === input.destinationSourceId) {
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
        return Ok({ movedNodeId: input.source.nodeId, invalidatedDocumentIds });
      }

      const documentRows = await currentDrizzleDb(this.db)
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.contextSourceId, input.source.sourceId),
            isNull(documents.deletedAt),
            sql`${documents.folderId} IN (
              WITH RECURSIVE subtree AS (
                SELECT id FROM folders
                WHERE id = ${input.source.nodeId}
                  AND context_source_id = ${input.source.sourceId}
                  AND deleted_at IS NULL
                UNION ALL
                SELECT f.id FROM folders f
                JOIN subtree s ON f.parent_id = s.id
                WHERE f.context_source_id = ${input.source.sourceId}
                  AND f.deleted_at IS NULL
              )
              SELECT id FROM subtree
            )`,
          ),
        );

      const movedFolders = await currentDrizzleDb(this.db).execute<{ id: string }>(sql`
        WITH RECURSIVE subtree AS (
          SELECT id FROM folders
          WHERE id = ${input.source.nodeId}
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
        RETURNING id
      `);
      if (!movedFolders.some((row) => row.id === input.source.nodeId)) rollback("stale_source");

      const movedRoot = await currentDrizzleDb(this.db)
        .update(folders)
        .set({ parentId: destParentId, name: targetBasename, updatedAt: new Date() })
        .where(
          and(
            eq(folders.id, input.source.nodeId),
            eq(folders.contextSourceId, input.destinationSourceId),
            isNull(folders.deletedAt),
          ),
        )
        .returning({ id: folders.id });
      if (movedRoot.length !== 1) rollback("stale_source");

      await currentDrizzleDb(this.db).execute(sql`
        WITH RECURSIVE subtree AS (
          SELECT id FROM folders
          WHERE id = ${input.source.nodeId}
            AND context_source_id = ${input.destinationSourceId}
            AND deleted_at IS NULL
          UNION ALL
          SELECT f.id FROM folders f
          JOIN subtree s ON f.parent_id = s.id
          WHERE f.context_source_id = ${input.destinationSourceId}
            AND f.deleted_at IS NULL
        )
        UPDATE documents
        SET context_source_id = ${input.destinationSourceId},
            updated_at = NOW()
        WHERE context_source_id = ${input.source.sourceId}
          AND deleted_at IS NULL
          AND folder_id IN (SELECT id FROM subtree)
      `);

      invalidatedDocumentIds.push(...documentRows.map((row) => row.id));
      return Ok({ movedNodeId: input.source.nodeId, invalidatedDocumentIds });
    });
  }

  async commitDelete(
    token: ContextLocationToken,
  ): Promise<Result<ContextTreeDeleteResult, ContextTreeMutationError>> {
    return this.withMutationTransaction(async () => {
      await this.lockSources([token.sourceId]);
      if (token.nodeId === CONTEXT_ROOT_DIRECTORY_ID) return Err({ code: "invalid_operation" });
      const current = await this.inspect(token.sourceId, token.path);
      if (!sameLocation(current, token)) return Err({ code: "stale_source" });
      const now = new Date();

      if (token.kind === "file") {
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
        if (deleted.length !== 1) rollback("stale_source");
        return Ok({ deletedNodeId: token.nodeId, invalidatedDocumentIds: [token.nodeId] });
      }

      const [childFolder] = await currentDrizzleDb(this.db)
        .select({ id: folders.id })
        .from(folders)
        .where(
          and(
            eq(folders.contextSourceId, token.sourceId),
            eq(folders.parentId, token.nodeId),
            isNull(folders.deletedAt),
          ),
        )
        .limit(1);
      if (childFolder) return Err({ code: "invalid_operation" });

      const [childDocument] = await currentDrizzleDb(this.db)
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.contextSourceId, token.sourceId),
            eq(documents.folderId, token.nodeId),
            isNull(documents.deletedAt),
          ),
        )
        .limit(1);
      if (childDocument) return Err({ code: "invalid_operation" });

      const deleted = await currentDrizzleDb(this.db)
        .update(folders)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(
            eq(folders.id, token.nodeId),
            eq(folders.contextSourceId, token.sourceId),
            isNull(folders.deletedAt),
          ),
        )
        .returning({ id: folders.id });
      if (deleted.length !== 1) rollback("stale_source");
      return Ok({ deletedNodeId: token.nodeId, invalidatedDocumentIds: [] });
    });
  }
}
