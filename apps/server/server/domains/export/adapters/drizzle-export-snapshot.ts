/** Atomic export inventory from persisted metadata and the canonical live document tree. */
import { canonicalContextUri, type ProjectId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import {
  contextSources,
  documents,
  linkAheadRefs,
  threads,
  works,
} from "@meridian/database/schema";
import { eq, or } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInRootDrizzleReadSnapshot,
} from "../../../shared/drizzle-transaction.js";
import { catalogSourceAuthority } from "../../context/adapters/catalog-file-mapper.js";
import {
  listsThroughLiveManifest,
  loadDocumentAddresses,
} from "../../context/adapters/document-address.js";
import type { ExportSnapshotStore, ExportSourceRoot } from "../ports/export-snapshot.js";

export function createDrizzleExportSnapshotStore(db: Database): ExportSnapshotStore {
  return {
    read: (projectId) =>
      runInRootDrizzleReadSnapshot(db, async () => {
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
            .filter((row) => !row.deleted && row.projectId === projectId)
            .map((row) => [row.documentId, row]),
        );
        const settlements = await currentDrizzleDb(db)
          .select({
            id: linkAheadRefs.aheadId,
            documentId: linkAheadRefs.settledDocumentId,
            scheme: linkAheadRefs.scheme,
            workId: linkAheadRefs.workId,
            rootThreadId: linkAheadRefs.rootThreadId,
            workName: works.name,
            workSlug: works.slug,
            noWork: works.isNoWork,
            workDeleted: works.deletedAt,
            chatTitle: threads.title,
            rootThreadRef: threads.ref,
          })
          .from(linkAheadRefs)
          .leftJoin(works, eq(linkAheadRefs.workId, works.id))
          .leftJoin(threads, eq(linkAheadRefs.rootThreadId, threads.id))
          .where(eq(linkAheadRefs.projectId, projectId as ProjectId));
        const sources: ExportSourceRoot[] = settlements.flatMap((row) => {
          if (
            row.documentId ||
            (row.scheme !== "scratch" && row.scheme !== "uploads") ||
            row.workDeleted
          )
            return [];
          try {
            const uri = canonicalContextUri(
              row.scheme,
              "",
              catalogSourceAuthority(
                row.scheme,
                row.workId,
                row.noWork ? null : row.workSlug,
                row.rootThreadRef,
              ),
            );
            return [
              {
                uri,
                scheme: row.scheme,
                workId: row.noWork ? null : row.workId,
                workName: row.workName,
                rootThreadId: row.rootThreadId,
                chatTitle: row.chatTitle,
              },
            ];
          } catch {
            return [];
          }
        });
        return {
          sources,
          settlements: new Map(
            settlements.flatMap((row) => (row.documentId ? [[row.id, row.documentId]] : [])),
          ),
          documents: rows.flatMap((row) => {
            const address = addresses.get(row.id);
            return address
              ? [
                  {
                    ...row,
                    manifestScoped: listsThroughLiveManifest(address.scheme),
                    uri: address.uri,
                    path: address.path,
                    scheme: address.scheme,
                    workId: address.workId,
                    rootThreadId: address.rootThreadId ?? null,
                  },
                ]
              : [];
          }),
        };
      }),
  };
}
