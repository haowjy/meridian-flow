import type { ProjectId } from "@meridian/contracts";
import { parseDocumentFilename } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { contextSources, documents, threads, works } from "@meridian/database/schema";
import { compareCatalogSiblings } from "@meridian/project-tree";
import { eq } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { sourceOwnerProjectId } from "./source-owner.js";
import { loadDocumentAddresses, loadFolderAddresses } from "./tree-addresses.js";
import { LIVE_TREE, visibleDocuments, visibleFolders } from "./tree-relations.js";

type Sibling<Document> = {
  kind: "folder" | "file";
  name: string;
  rank: string | null;
  entryId: string;
  document?: Document;
};

type ExportFolderRow = {
  uri: string;
  path: string;
  scheme: string;
  workId: string | null;
  workName: string | null;
  rootThreadId: string | null;
  chatTitle: string | null;
};

export async function loadLiveProjectExportEntries(db: Database, projectId: string) {
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
      .filter(
        (row) => !row.deleted && row.owner.kind === "project" && row.owner.projectId === projectId,
      )
      .map((row) => [row.documentId, row]),
  );
  const live = rows.flatMap((row) => {
    const address = addresses.get(row.id);
    return address ? [{ ...row, address }] : [];
  });

  const vf = visibleFolders(LIVE_TREE);
  const folderRows = await tx
    .select({
      id: vf.id,
      sourceId: vf.contextSourceId,
      parentId: vf.parentId,
      name: vf.name,
      rank: vf.rank,
      workName: works.name,
      chatTitle: threads.title,
    })
    .from(vf)
    .innerJoin(contextSources, eq(vf.contextSourceId, contextSources.id))
    .leftJoin(works, eq(contextSources.workId, works.id))
    .leftJoin(threads, eq(contextSources.rootThreadId, threads.id))
    .where(eq(sourceOwnerProjectId, projectId));
  const folderAddresses = new Map(
    (
      await loadFolderAddresses(
        db,
        folderRows.map((row) => row.id),
      )
    )
      .filter(
        (row) => !row.deleted && row.owner.kind === "project" && row.owner.projectId === projectId,
      )
      .map((row) => [row.folderId as string, row]),
  );

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
  const folders: ExportFolderRow[] = [];
  const folderById = new Map(folderRows.map((row) => [row.id, row]));
  const walk = (sourceId: string, folderId: string | null) => {
    const key = parentKey(sourceId, folderId);
    for (const child of (children.get(key) ?? []).sort(compareCatalogSiblings)) {
      if (child.document) ordered.push(child.document);
      else {
        const address = folderAddresses.get(child.entryId);
        const row = folderById.get(child.entryId);
        if (!address || !row) continue;
        folders.push({
          uri: address.uri.slice(0, -1),
          path: address.path.slice(0, -1),
          scheme: address.scheme,
          workId: address.workId,
          workName: row.workName,
          rootThreadId: address.rootThreadId,
          chatTitle: row.chatTitle,
        });
        walk(sourceId, child.entryId);
      }
    }
  };
  const uriBySource = new Map([
    ...[...folderAddresses.values()].map(
      (row) => [row.contextSourceId as string, row.uri.slice(0, -row.path.length)] as const,
    ),
    ...live.map(
      (row) =>
        [row.sourceId as string, row.address.uri.slice(0, -row.address.path.length)] as const,
    ),
  ]);
  const bySourceUri = [...uriBySource].sort(([, left], [, right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [sourceId] of bySourceUri) walk(sourceId, null);
  return {
    folders,
    documents: ordered.map((row) => {
      const parsed = parseDocumentFilename(row.name);
      return {
        ...row,
        name: parsed.ok ? parsed.value.name : row.name,
        extension: parsed.ok ? parsed.value.extension : "",
      };
    }),
  };
}
