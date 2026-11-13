/**
 * Live project documents and canonical addresses for an atomic export snapshot, in tree order:
 * one source after another (by canonical address; sources are not siblings), each walked depth
 * first with every folder's children in the project's sibling order (`compareCatalogSiblings`).
 */
import type { ProjectId } from "@meridian/contracts";
import { parseDocumentFilename } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { contextSources, documents, threads, works } from "@meridian/database/schema";
import { compareCatalogSiblings } from "@meridian/resource-replica";
import { eq, inArray } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { loadDocumentAddresses } from "./tree-addresses.js";
import { LIVE_TREE, visibleDocuments, visibleFolders } from "./tree-relations.js";

type Sibling<Document> = {
  kind: "folder" | "file";
  name: string;
  rank: string | null;
  entryId: string;
  /** The row a file stands for; absent for a folder. */
  document?: Document;
};

export async function loadLiveProjectExportDocuments(db: Database, projectId: string) {
  const tx = currentDrizzleDb(db);
  const vd = visibleDocuments(LIVE_TREE);
  const rows = await tx
    .select({
      id: vd.id,
      name: vd.name,
      fileType: vd.fileType,
      storageUrl: vd.storageUrl,
      sizeBytes: vd.sizeBytes,
      metadata: vd.metadata,
      sourceId: vd.contextSourceId,
      folderId: vd.folderId,
      rank: vd.rank,
      workName: works.name,
      chatTitle: threads.title,
    })
    .from(vd)
    .innerJoin(documents, eq(documents.id, vd.id))
    .innerJoin(contextSources, eq(vd.contextSourceId, contextSources.id))
    .leftJoin(works, eq(contextSources.workId, works.id))
    .leftJoin(threads, eq(contextSources.rootThreadId, threads.id))
    .where(eq(documents.projectId, projectId as ProjectId));
  const addresses = new Map(
    (await loadDocumentAddresses(db, { ids: rows.map((row) => row.id) }))
      .filter((row) => !row.deleted && row.projectId === projectId)
      .map((row) => [row.documentId, row]),
  );
  const live = rows.flatMap((row) => {
    const address = addresses.get(row.id);
    return address ? [{ ...row, address }] : [];
  });

  const sourceIds = [...new Set(live.map((row) => row.sourceId))];
  const vf = visibleFolders(LIVE_TREE);
  const folderRows = sourceIds.length
    ? await tx
        .select({
          id: vf.id,
          sourceId: vf.contextSourceId,
          parentId: vf.parentId,
          name: vf.name,
          rank: vf.rank,
        })
        .from(vf)
        .where(inArray(vf.contextSourceId, sourceIds))
    : [];

  // A parent is a source's top level (null folder) or a folder.
  const parentKey = (sourceId: string, folderId: string | null) => `${sourceId}/${folderId ?? ""}`;
  const children = new Map<string, Sibling<(typeof live)[number]>[]>();
  const adopt = (key: string, child: Sibling<(typeof live)[number]>) => {
    const list = children.get(key);
    if (list) list.push(child);
    else children.set(key, [child]);
  };
  for (const row of live) {
    adopt(parentKey(row.sourceId, row.folderId), {
      kind: "file",
      name: row.name,
      rank: row.rank,
      entryId: row.id,
      document: row,
    });
  }
  for (const folder of folderRows) {
    adopt(parentKey(folder.sourceId, folder.parentId), {
      kind: "folder",
      name: folder.name,
      rank: folder.rank,
      entryId: folder.id,
    });
  }

  const ordered: typeof live = [];
  const walk = (sourceId: string, folderId: string | null) => {
    const key = parentKey(sourceId, folderId);
    for (const child of (children.get(key) ?? []).sort(compareCatalogSiblings)) {
      if (child.document) ordered.push(child.document);
      else walk(sourceId, child.entryId);
    }
  };
  const uriBySource = new Map(
    live.map((row) => [row.sourceId, row.address.uri.slice(0, -row.address.path.length)]),
  );
  const bySourceUri = [...uriBySource].sort(([, left], [, right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [sourceId] of bySourceUri) walk(sourceId, null);
  // The export spells a file as stem plus extension, which the filename codec splits.
  return ordered.map((row) => {
    const parsed = parseDocumentFilename(row.name);
    return {
      ...row,
      name: parsed.ok ? parsed.value.name : row.name,
      extension: parsed.ok ? parsed.value.extension : "",
    };
  });
}
