import type { Database } from "@meridian/database";
import { contextSources, documents, works } from "@meridian/database/schema";
import { and, eq, isNull, or } from "drizzle-orm";
import { mapFigureFileType } from "../../figures/figure-file-types.js";
import type {
  DocumentFileRecord,
  FigureDocumentRepository,
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
