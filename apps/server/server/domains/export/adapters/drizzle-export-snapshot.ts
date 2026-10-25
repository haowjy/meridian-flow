/** Atomic export inventory from persisted metadata and the canonical live document tree. */
import { canonicalContextUri, type ProjectId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { linkAheadRefs, threads, works } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInRootDrizzleReadSnapshot,
} from "../../../shared/drizzle-transaction.js";
import { catalogSourceAuthority } from "../../context/adapters/catalog-file-mapper.js";
import { loadLiveProjectExportDocuments } from "../../context/tree/export-inventory.js";
import type { ExportSnapshotStore, ExportSourceRoot } from "../ports/export-snapshot.js";

export function createDrizzleExportSnapshotStore(db: Database): ExportSnapshotStore {
  return {
    read: (projectId) =>
      runInRootDrizzleReadSnapshot(db, async () => {
        const rows = await loadLiveProjectExportDocuments(db, projectId);
        const settlements = await currentDrizzleDb(db)
          .select({
            id: linkAheadRefs.aheadId,
            documentId: linkAheadRefs.settledDocumentId,
            scheme: linkAheadRefs.scheme,
            workId: linkAheadRefs.workId,
            rootThreadId: linkAheadRefs.rootThreadId,
            workName: works.name,
            workHandle: works.handle,
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
                row.noWork ? null : row.workHandle,
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
          documents: rows.map(({ address, ...row }) => ({
            ...row,
            uri: address.uri,
            path: address.path,
            scheme: address.scheme,
            workId: address.workId,
            rootThreadId: address.rootThreadId ?? null,
          })),
        };
      }),
  };
}
