/**
 * Live project documents and canonical addresses for an atomic export snapshot, in tree order:
 * one source after another (by canonical address; sources are not siblings), each walked depth
 * first with every folder's children in the project's sibling order (`compareCatalogSiblings`).
 */
import type { ProjectId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { contextSources, documents, folders, threads, works } from "@meridian/database/schema";
import { compareCatalogSiblings } from "@meridian/resource-replica";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { renderFilename } from "../context/paths.js";
import { loadDocumentAddresses } from "./tree-addresses.js";

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
  const rows = await tx
    .select({
      id: documents.id,
      name: documents.name,
      extension: documents.extension,
      fileType: documents.fileType,
      storageUrl: documents.storageUrl,
      metadata: documents.metadata,
      sourceId: documents.contextSourceId,
      folderId: documents.folderId,
      rank: documents.rank,
      sourceOrderPolicy: contextSources.orderPolicy,
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
  const live = rows.flatMap((row) => {
    const address = addresses.get(row.id);
    return address ? [{ ...row, address }] : [];
  });

  const sourceIds = [...new Set(live.map((row) => row.sourceId))];
  const folderRows = sourceIds.length
    ? await tx
        .select({
          id: folders.id,
          sourceId: folders.contextSourceId,
          parentId: folders.parentId,
          name: folders.name,
          rank: folders.rank,
          orderPolicy: folders.orderPolicy,
        })
        .from(folders)
        .where(and(inArray(folders.contextSourceId, sourceIds), isNull(folders.deletedAt)))
    : [];

  // A parent is a source's top level (null folder) or a folder; each owns one order policy.
  const parentKey = (sourceId: string, folderId: string | null) => `${sourceId}/${folderId ?? ""}`;
  const policies = new Map<string, "default" | "manual">();
  const children = new Map<string, Sibling<(typeof live)[number]>[]>();
  const adopt = (key: string, child: Sibling<(typeof live)[number]>) => {
    const list = children.get(key);
    if (list) list.push(child);
    else children.set(key, [child]);
  };
  for (const row of live) {
    policies.set(parentKey(row.sourceId, null), row.sourceOrderPolicy);
    adopt(parentKey(row.sourceId, row.folderId), {
      kind: "file",
      name: renderFilename(row.name, row.extension),
      rank: row.rank,
      entryId: row.id,
      document: row,
    });
  }
  for (const folder of folderRows) {
    policies.set(parentKey(folder.sourceId, folder.id), folder.orderPolicy);
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
    const manual = policies.get(key) === "manual";
    for (const child of (children.get(key) ?? []).sort((left, right) =>
      compareCatalogSiblings(manual, left, right),
    )) {
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
  return ordered;
}
