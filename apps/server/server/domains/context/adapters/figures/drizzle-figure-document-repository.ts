import type { Database } from "@meridian/database";
import { contextSources, works } from "@meridian/database/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../../shared/drizzle-transaction.js";
import { mapFigureFileType } from "../../figures/figure-file-types.js";
import type {
  DocumentFileRecord,
  FigureDocumentRepository,
} from "../../ports/figure-document-repository.js";
import { ownedByRequestSql, sourceOwnerProjectId } from "../../tree/source-owner.js";
import { createTreeReader, LIVE_TREE, type TreeView } from "../../tree/tree-view.js";

type DocumentRow = {
  id: string;
  storageUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  name: string;
  hasPreview: boolean;
};

function mapDocumentFile(
  row: Pick<DocumentRow, "id" | "storageUrl" | "mimeType" | "sizeBytes" | "name" | "hasPreview">,
): DocumentFileRecord | null {
  if (!row.storageUrl || !row.mimeType) return null;
  const fileType = mapFigureFileType(row.mimeType);
  if (!fileType) return null;
  return {
    assetDocumentId: row.id,
    storageUrl: row.storageUrl,
    mimeType: row.mimeType,
    fileType,
    sizeBytes: row.sizeBytes === null ? 0 : Number(row.sizeBytes),
    name: row.name,
    hasPreview: row.hasPreview,
  };
}

class DrizzleFigureDocumentRepository implements FigureDocumentRepository {
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
          // The project's own files, and its account's home folder's.
          ownedByRequestSql(
            { projectId: sourceOwnerProjectId, userId: sql`${contextSources.userId}` },
            {
              projectId: sql`${projectId}::uuid`,
              accountId: sql`(SELECT user_id FROM projects WHERE id = ${projectId}::uuid)`,
            },
          ),
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
