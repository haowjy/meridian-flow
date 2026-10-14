/** Atomic sibling creation under one live parent, publishing one catalog refresh. */
import { classifyFiletype } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { contextSources, folders } from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { lockSeamWorks } from "../../../shared/work-lifecycle-lock.js";
import type { MarkdownDocumentStore } from "../../collab/index.js";
import type { ContextCatalogMutationPort } from "../ports/context-catalog.js";
import type {
  ContextChildCreation,
  ContextChildrenInput,
} from "../ports/context-child-creation.js";
import type { DocumentArrivals } from "../ports/document-arrivals.js";
import { lockContextSources } from "./context-fs/document-locations.js";
import { createDocumentRow, createFolderRow } from "./context-fs/entry-rows.js";

export function createDrizzleContextChildCreation(deps: {
  db: Database;
  documents: Pick<MarkdownDocumentStore, "bindStatic" | "seedFromMarkdown">;
  recordMembership(documentIds: readonly DocumentId[]): Promise<void>;
  arrivals: DocumentArrivals;
  catalog: ContextCatalogMutationPort;
}): ContextChildCreation {
  return {
    async createChildren(input: ContextChildrenInput) {
      const { parent, folders: newFolders, documents: newDocuments } = input;
      if (!newFolders.length && !newDocuments.length) return;
      const ids = [...newFolders, ...newDocuments].map(({ id }) => id);
      if (new Set(ids).size !== ids.length) throw new RangeError("Duplicate chunk identity");
      const seeds = newDocuments.map(({ filetype }) => {
        if (classifyFiletype(filetype).kind !== "tracked")
          throw new RangeError("Placeholder must be tracked");
        return deps.documents.bindStatic("", filetype);
      });
      const { sourceId, folderId } = parent;
      await runInDrizzleTransaction(deps.db, async () => {
        await lockSeamWorks(deps.db, []);
        await lockContextSources(deps.db, [sourceId]);
        const tx = currentDrizzleDb(deps.db);
        const [source] = await tx
          .select({ id: contextSources.id })
          .from(contextSources)
          .where(and(eq(contextSources.id, sourceId), isNull(contextSources.deletedAt)));
        if (!source) throw new RangeError("Context source is not live");
        if (folderId) {
          const [live] = await tx
            .select({ id: folders.id })
            .from(folders)
            .where(
              and(
                eq(folders.id, folderId),
                eq(folders.contextSourceId, sourceId),
                isNull(folders.deletedAt),
              ),
            );
          if (!live) throw new RangeError("Chunk parent is not live in this source");
        }
        // Folders first: a document's opposite-kind check then sees this chunk's own folders.
        for (const folder of newFolders)
          await createFolderRow(
            deps.db,
            { id: folder.id, sourceId, parentId: folderId, name: folder.name },
            { ifAbsent: false },
          );
        for (const { filetype, ...document } of newDocuments)
          await createDocumentRow(
            deps.db,
            { ...document, sourceId, folderId, filetype, markdown: "" },
            { ifAbsent: false },
          );
        await deps.recordMembership(newDocuments.map((row) => row.id as DocumentId));
        for (const [index, document] of newDocuments.entries()) {
          const seeded = await deps.documents.seedFromMarkdown(document.id, seeds[index], {
            type: "system",
          });
          if (!seeded.ok)
            throw new Error(`Placeholder seed failed: ${JSON.stringify(seeded.error)}`);
        }
        await deps.arrivals.settle(newDocuments.map(({ id }) => id as DocumentId));
        await deps.catalog.refreshSources([sourceId]);
      });
    },
  };
}
