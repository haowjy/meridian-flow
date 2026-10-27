/** Import snapshots over Context's live tree authority. */
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { Database } from "@meridian/database";
import { contextSources } from "@meridian/database/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { ContextImportArea, ContextImportRead } from "../ports/context-import-read.js";
import { loadDocumentAddresses } from "./tree-addresses.js";
import { createTreeReader, LIVE_TREE, visibleDocuments, visibleFolders } from "./tree-view.js";

export function createDrizzleContextImportRead(db: Database, projectId: string): ContextImportRead {
  const tree = createTreeReader(db);
  const sources = async (areas: readonly ContextImportArea[]) =>
    currentDrizzleDb(db)
      .select({ id: contextSources.id, area: contextSources.slug })
      .from(contextSources)
      .where(
        and(
          eq(contextSources.projectId, projectId as never),
          inArray(contextSources.slug, areas),
          isNull(contextSources.workId),
          isNull(contextSources.rootThreadId),
          isNull(contextSources.chatThreadId),
          isNull(contextSources.deletedAt),
        ),
      );
  return {
    async destinations(input) {
      const parsed = parseContextUri(input.destinationUri);
      if (!parsed.ok) throw new Error("Import destination is invalid");
      const sourceRows = await sources(input.areas);
      const sourceByArea = new Map(sourceRows.map((row) => [row.area, row.id]));
      const originalArea = parsed.value.scheme as ContextImportArea;
      let destinationFolder =
        input.folderId && sourceByArea.has(originalArea)
          ? await tree.findFolderById(LIVE_TREE, input.folderId as never)
          : null;
      if (destinationFolder?.contextSourceId !== sourceByArea.get(originalArea))
        destinationFolder = null;
      return Promise.all(
        [...new Set(input.areas)].map(async (area) => {
          const sourceId = sourceByArea.get(area);
          const folderId = area === originalArea ? (destinationFolder?.id ?? null) : null;
          const uri =
            area === originalArea && destinationFolder
              ? `${area}://${destinationFolder.path}/`
              : `${area}://`;
          if (!sourceId)
            return {
              area,
              folderId: null,
              uri: `${area}://`,
              fellBack: area === originalArea && input.folderId !== null,
              children: [],
            };
          const vf = visibleFolders(LIVE_TREE);
          const vd = visibleDocuments(LIVE_TREE);
          const parent = <T>(column: T) =>
            folderId ? eq(column as never, folderId) : isNull(column as never);
          const [folders, files] = await Promise.all([
            currentDrizzleDb(db)
              .select({ name: vf.name })
              .from(vf)
              .where(and(eq(vf.contextSourceId, sourceId), parent(vf.parentId))),
            currentDrizzleDb(db)
              .select({ name: vd.name, extension: vd.extension })
              .from(vd)
              .where(and(eq(vd.contextSourceId, sourceId), parent(vd.folderId))),
          ]);
          return {
            area,
            folderId,
            uri,
            fellBack: area === originalArea && input.folderId !== null && !destinationFolder,
            children: [
              ...folders.map(({ name }) => ({ kind: "folder" as const, name, extension: "" })),
              ...files.map((file) => ({ kind: "file" as const, ...file })),
            ],
          };
        }),
      );
    },
    async linkCandidates() {
      const sourceRows = await sources(["manuscript", "kb", "unfiled"]);
      const sourceById = new Map(sourceRows.map((row) => [row.id, row.area]));
      if (!sourceRows.length) return [];
      const vd = visibleDocuments(LIVE_TREE);
      const rows = await currentDrizzleDb(db)
        .select({
          id: vd.id,
          sourceId: vd.contextSourceId,
          filetype: vd.fileType,
          metadata: vd.metadata,
        })
        .from(vd)
        .where(
          inArray(
            vd.contextSourceId,
            sourceRows.map((row) => row.id),
          ),
        );
      const addresses = new Map(
        (await loadDocumentAddresses(currentDrizzleDb(db), { ids: rows.map((row) => row.id) })).map(
          (address) => [address.documentId, address],
        ),
      );
      return rows.map((row) => {
        const address = addresses.get(row.id);
        if (!address || address.deleted || address.hidden)
          throw new Error(`Live import candidate disappeared: ${row.id}`);
        const area = sourceById.get(row.sourceId);
        if (!area) throw new Error(`Import candidate has no project area: ${row.id}`);
        return {
          id: row.id,
          uri: address.uri,
          path: address.path,
          aliases: Array.isArray(row.metadata.aliases)
            ? row.metadata.aliases.filter((alias): alias is string => typeof alias === "string")
            : [],
          filetype: row.filetype,
        };
      });
    },
  };
}
