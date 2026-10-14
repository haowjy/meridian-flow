/** Atomic chunk creation of context folders and seeded tracked placeholders, publishing one catalog refresh. */
import { classifyFiletype, folderDocumentName } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { contextSources, documents, folders } from "@meridian/database/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { lockSeamWorks } from "../../../shared/work-lifecycle-lock.js";
import type { MarkdownDocumentStore } from "../../collab/index.js";
import type {
  ContextBulkCreation,
  ContextBulkCreationInput,
} from "../ports/context-bulk-creation.js";
import type { ContextCatalogMutationPort } from "../ports/context-catalog.js";
import { ContextEntryConflictError } from "../ports/context-document-store.js";
import type { DocumentArrivals } from "../ports/document-arrivals.js";
import {
  claimDocumentLocation,
  hasOppositeContextEntry,
  lockContextSources,
} from "./context-fs/document-locations.js";

export function createDrizzleContextBulkCreation(deps: {
  db: Database;
  documents: Pick<MarkdownDocumentStore, "bindStatic" | "seedFromMarkdown">;
  recordMembership(documentIds: readonly DocumentId[]): Promise<void>;
  arrivals: DocumentArrivals;
  catalog: ContextCatalogMutationPort;
}): ContextBulkCreation {
  return {
    async create(input: ContextBulkCreationInput) {
      const { contextSourceId, folders: directoryRows, placeholders } = input;
      if (!directoryRows.length && !placeholders.length) return;
      const ids = [...directoryRows, ...placeholders].map(({ id }) => id);
      if (new Set(ids).size !== ids.length) throw new RangeError("Duplicate chunk identity");
      const seeds = placeholders.map(({ filetype }) => {
        if (classifyFiletype(filetype).kind !== "tracked")
          throw new RangeError("Placeholder must be tracked");
        return deps.documents.bindStatic("", filetype);
      });
      await runInDrizzleTransaction(deps.db, async () => {
        await lockSeamWorks(deps.db, []);
        await lockContextSources(deps.db, [contextSourceId]);
        const tx = currentDrizzleDb(deps.db);
        const [source] = await tx
          .select({ id: contextSources.id })
          .from(contextSources)
          .where(and(eq(contextSources.id, contextSourceId), isNull(contextSources.deletedAt)));
        if (!source) throw new RangeError("Context source is not live");
        const newFolders = new Set(directoryRows.map(({ id }) => id));
        const parents = [
          ...new Set(
            [
              ...directoryRows.map(({ parentId }) => parentId),
              ...placeholders.map(({ folderId }) => folderId),
            ].filter((id): id is string => id !== null && !newFolders.has(id)),
          ),
        ];
        if (parents.length) {
          const live = await tx
            .select({ id: folders.id })
            .from(folders)
            .where(
              and(
                inArray(folders.id, parents),
                eq(folders.contextSourceId, contextSourceId),
                isNull(folders.deletedAt),
              ),
            );
          if (live.length !== parents.length)
            throw new RangeError("Chunk parent is not live in this source");
        }
        // Validate the folder graph before insertion: SQL FKs alone permit cycles.
        const pending = new Map(directoryRows.map((folder) => [folder.id, folder.parentId]));
        for (const { id } of directoryRows) {
          const seen = new Set<string>();
          let current: string | null = id;
          while (current !== null && pending.has(current)) {
            if (seen.has(current)) throw new RangeError("Cyclic chunk folders");
            seen.add(current);
            current = pending.get(current) ?? null;
          }
        }
        for (const folder of directoryRows) {
          if (
            await hasOppositeContextEntry(
              tx as Database,
              contextSourceId,
              folder.parentId,
              folder.name,
              "folder",
            )
          )
            throw new ContextEntryConflictError("file");
        }
        for (const document of placeholders) {
          const filename = document.extension
            ? `${document.name}.${document.extension}`
            : document.name;
          if (
            await hasOppositeContextEntry(
              tx as Database,
              contextSourceId,
              document.folderId,
              filename,
              "file",
            )
          )
            throw new ContextEntryConflictError("folder");
          if (
            directoryRows.some(
              (folder) =>
                folder.parentId === document.folderId &&
                folderDocumentName(folder.name) === filename,
            )
          )
            throw new ContextEntryConflictError("folder");
        }
        if (directoryRows.length)
          await tx
            .insert(folders)
            .values(directoryRows.map((folder) => ({ ...folder, contextSourceId })));
        if (placeholders.length)
          await tx.insert(documents).values(
            placeholders.map(({ filetype, ...document }) => ({
              ...document,
              contextSourceId,
              fileType: filetype,
              markdownProjection: "",
              sizeBytes: 0,
            })),
          );
        for (const folder of directoryRows)
          await claimDocumentLocation(deps.db, contextSourceId, folder.parentId, folder.name);
        await deps.recordMembership(placeholders.map((row) => row.id as DocumentId));
        for (const [index, document] of placeholders.entries()) {
          const filename = document.extension
            ? `${document.name}.${document.extension}`
            : document.name;
          await claimDocumentLocation(deps.db, contextSourceId, document.folderId, filename);

          const seeded = await deps.documents.seedFromMarkdown(document.id, seeds[index], {
            type: "system",
          });
          if (!seeded.ok)
            throw new Error(`Placeholder seed failed: ${JSON.stringify(seeded.error)}`);
        }
        await deps.arrivals.settle(placeholders.map(({ id }) => id as DocumentId));
        await deps.catalog.refreshSources([contextSourceId]);
      });
    },
  };
}
