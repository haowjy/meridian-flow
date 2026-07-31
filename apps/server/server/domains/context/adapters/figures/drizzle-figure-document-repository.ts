import type { Database } from "@meridian/database";
import { contextSources, documents, folders, works } from "@meridian/database/schema";
import { and, eq, isNull, or } from "drizzle-orm";
import { mapFigureFileType } from "../../figures/figure-file-types.js";
import type {
  DocumentFileRecord,
  FigureDocumentRepository,
  ManuscriptAssetFileRecord,
} from "../../ports/figure-document-repository.js";

type DocumentRow = typeof documents.$inferSelect;

function mapDocumentFile(
  row: Pick<DocumentRow, "id" | "storageUrl" | "mimeType" | "fileType" | "sizeBytes">,
): DocumentFileRecord | null {
  if (!row.storageUrl || !row.mimeType) return null;
  const fileType = mapFigureFileType(row.mimeType);
  if (!fileType || row.fileType !== fileType) return null;
  return {
    assetDocumentId: row.id,
    storageUrl: row.storageUrl,
    mimeType: row.mimeType,
    fileType,
    sizeBytes: row.sizeBytes === null ? 0 : Number(row.sizeBytes),
  };
}

export class DrizzleFigureDocumentRepository implements FigureDocumentRepository {
  constructor(private readonly db: Database) {}

  async documentExistsForProject(projectId: string, documentId: string): Promise<boolean> {
    return (await this.findDocumentForProject(projectId, documentId)) !== null;
  }

  async findDocumentFileForProject(
    projectId: string,
    assetDocumentId: string,
  ): Promise<DocumentFileRecord | null> {
    const row = await this.findDocumentForProject(projectId, assetDocumentId);
    return row ? mapDocumentFile(row) : null;
  }

  async findManuscriptAssetForProject(
    projectId: string,
    assetDocumentId: string,
  ): Promise<ManuscriptAssetFileRecord | null> {
    const [row] = await this.db
      .select({
        id: documents.id,
        contextSourceId: documents.contextSourceId,
        folderId: documents.folderId,
        storageUrl: documents.storageUrl,
        mimeType: documents.mimeType,
        fileType: documents.fileType,
        sizeBytes: documents.sizeBytes,
        name: documents.name,
        extension: documents.extension,
      })
      .from(documents)
      .innerJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
      .where(
        and(
          eq(documents.id, assetDocumentId),
          eq(contextSources.projectId, projectId),
          eq(contextSources.slug, "manuscript"),
          isNull(documents.deletedAt),
          isNull(contextSources.deletedAt),
        ),
      )
      .limit(1);
    const file = row ? mapDocumentFile(row) : null;
    if (!row || !file) return null;
    const path = [`${row.name}${row.extension ? `.${row.extension}` : ""}`];
    let folderId = row.folderId;
    while (folderId) {
      const [folder] = await this.db
        .select({ id: folders.id, name: folders.name, parentId: folders.parentId })
        .from(folders)
        .where(
          and(
            eq(folders.id, folderId),
            eq(folders.contextSourceId, row.contextSourceId),
            isNull(folders.deletedAt),
          ),
        )
        .limit(1);
      if (!folder) return null;
      path.unshift(folder.name);
      folderId = folder.parentId;
    }
    return {
      ...file,
      assetPath: path.join("/"),
    };
  }

  private async findDocumentForProject(projectId: string, documentId: string) {
    const [row] = await this.db
      .select({
        id: documents.id,
        storageUrl: documents.storageUrl,
        mimeType: documents.mimeType,
        fileType: documents.fileType,
        sizeBytes: documents.sizeBytes,
      })
      .from(documents)
      .innerJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
      .leftJoin(works, eq(contextSources.workId, works.id))
      .where(
        and(
          eq(documents.id, documentId),
          isNull(documents.deletedAt),
          isNull(contextSources.deletedAt),
          or(eq(contextSources.projectId, projectId), eq(works.projectId, projectId)),
        ),
      )
      .limit(1);
    return row ?? null;
  }
}

export function createDrizzleFigureDocumentRepository(options: {
  db: Database;
}): FigureDocumentRepository {
  return new DrizzleFigureDocumentRepository(options.db);
}
