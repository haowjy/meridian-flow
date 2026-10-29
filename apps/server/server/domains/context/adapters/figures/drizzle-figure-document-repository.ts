import { renderFilename } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { contextSources, works } from "@meridian/database/schema";
import { and, eq, isNull, or } from "drizzle-orm";
import { currentDrizzleDb } from "../../../../shared/drizzle-transaction.js";
import { mapFigureFileType } from "../../figures/figure-file-types.js";
import type {
  DocumentFileRecord,
  FigureDocumentRepository,
} from "../../ports/figure-document-repository.js";
import { createTreeReader, LIVE_TREE, type TreeView } from "../../tree/tree-view.js";

type DocumentRow = {
  id: string;
  storageUrl: string | null;
  mimeType: string | null;
  fileType: string;
  sizeBytes: number | null;
  name: string;
  extension: string;
  hasPreview: boolean;
};

function mapDocumentFile(
  row: Pick<
    DocumentRow,
    | "id"
    | "storageUrl"
    | "mimeType"
    | "fileType"
    | "sizeBytes"
    | "name"
    | "extension"
    | "hasPreview"
  >,
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
    name: renderFilename(row.name, row.extension),
    hasPreview: row.hasPreview,
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
    view: TreeView = LIVE_TREE,
  ): Promise<DocumentFileRecord | null> {
    const row = await this.findDocumentForProject(projectId, assetDocumentId, view);
    return row ? mapDocumentFile(row) : null;
  }

  private async findDocumentForProject(
    projectId: string,
    documentId: string,
    view: TreeView = LIVE_TREE,
  ) {
    const tree = createTreeReader(this.db);
    const found = await tree.findById(view, documentId);
    if (found.kind !== "found") return null;
    const [source] = await currentDrizzleDb(this.db)
      .select({ id: contextSources.id })
      .from(contextSources)
      .leftJoin(works, eq(contextSources.workId, works.id))
      .where(
        and(
          eq(contextSources.id, found.document.contextSourceId),
          isNull(contextSources.deletedAt),
          or(eq(contextSources.projectId, projectId), eq(works.projectId, projectId)),
        ),
      )
      .limit(1);
    return source ? found.document : null;
  }
}

export function createDrizzleFigureDocumentRepository(options: {
  db: Database;
}): FigureDocumentRepository {
  return new DrizzleFigureDocumentRepository(options.db);
}
