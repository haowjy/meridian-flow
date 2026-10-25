/** Live project documents and canonical addresses for an atomic export snapshot. */
import type { ProjectId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { contextSources, documents, threads, works } from "@meridian/database/schema";
import { eq, or } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { loadDocumentAddresses } from "./tree-addresses.js";

export async function loadLiveProjectExportDocuments(db: Database, projectId: string) {
  const rows = await currentDrizzleDb(db)
    .select({
      id: documents.id,
      name: documents.name,
      extension: documents.extension,
      fileType: documents.fileType,
      storageUrl: documents.storageUrl,
      metadata: documents.metadata,
      workName: works.name,
      chatTitle: threads.title,
    })
    .from(documents)
    .innerJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
    .leftJoin(works, eq(contextSources.workId, works.id))
    .leftJoin(threads, eq(contextSources.rootThreadId, threads.id))
    .where(
      or(
        eq(contextSources.projectId, projectId as ProjectId),
        eq(works.projectId, projectId as ProjectId),
      ),
    );
  const addresses = new Map(
    (await loadDocumentAddresses(db, { ids: rows.map((row) => row.id) }))
      .filter((row) => !row.deleted && !row.hidden && row.projectId === projectId)
      .map((row) => [row.documentId, row]),
  );
  return rows.flatMap((row) => {
    const address = addresses.get(row.id);
    return address ? [{ ...row, address }] : [];
  });
}
