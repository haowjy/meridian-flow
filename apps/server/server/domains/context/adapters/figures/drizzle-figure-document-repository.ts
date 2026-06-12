import type { Database } from "@meridian/database";
import { contextSources, documents, works } from "@meridian/database/schema";
import { and, eq, isNull, or } from "drizzle-orm";
import { mapFigureFileType } from "../../figures/figure-file-types.js";
import type {
  AttachDocumentFileInput,
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
    documentId: row.id,
    storageUrl: row.storageUrl,
    mimeType: row.mimeType,
    fileType,
    sizeBytes: row.sizeBytes === null ? 0 : Number(row.sizeBytes),
  };
}

export class DrizzleFigureDocumentRepository implements FigureDocumentRepository {
  constructor(private readonly db: Database) {}

  async findDocumentFileForWorkbench(
    workbenchId: string,
    documentId: string,
  ): Promise<DocumentFileRecord | null> {
    const row = await this.findDocumentForWorkbench(workbenchId, documentId);
    return row ? mapDocumentFile(row) : null;
  }

  async attachDocumentFile(input: AttachDocumentFileInput): Promise<DocumentFileRecord | null> {
    const existing = await this.findDocumentForWorkbench(input.workbenchId, input.documentId);
    if (!existing) return null;
    const [row] = await this.db
      .update(documents)
      .set({
        storageUrl: input.storageUrl,
        mimeType: input.mimeType,
        fileType: input.fileType,
        sizeBytes: input.sizeBytes,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, input.documentId))
      .returning({
        id: documents.id,
        storageUrl: documents.storageUrl,
        mimeType: documents.mimeType,
        fileType: documents.fileType,
        sizeBytes: documents.sizeBytes,
      });
    return row ? mapDocumentFile(row) : null;
  }

  private async findDocumentForWorkbench(workbenchId: string, documentId: string) {
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
          or(eq(contextSources.projectId, workbenchId), eq(works.projectId, workbenchId)),
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
