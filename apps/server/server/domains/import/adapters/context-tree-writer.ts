/** Context/collab import adapter using bulk creation, identity fill and the isolated binder. */
import { parseLinkRef, resolveDocumentHref } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { documents } from "@meridian/database/schema";
import { walkLinkOccurrences } from "@meridian/markup/links";
import { inArray, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { CollabDomain, ImportLinkBinder } from "../../collab/index.js";
import {
  type ContextBulkCreation,
  ContextImportDestinationError,
  type ContextImportLocations,
  ContextImportParentMovedError,
  type ContextPort,
  type LinkAheadRegistry,
} from "../../context/index.js";
import { ImportError } from "../domain/manifest.js";
import { type ImportTreeWriter, ParentMovedError } from "../ports/import-tree-writer.js";
export function createContextImportTreeWriter(deps: {
  db: Database;
  locations: ContextImportLocations;
  bulk: ContextBulkCreation;
  context: ContextPort;
  collab: CollabDomain;
  binder: ImportLinkBinder;
  ahead: LinkAheadRegistry;
  projectId: string;
  userId: string;
  refreshFiles(ids: readonly string[]): Promise<unknown>;
}): ImportTreeWriter {
  return {
    async destination(uri) {
      try {
        return await deps.locations.destination(uri);
      } catch (error) {
        if (error instanceof ContextImportDestinationError)
          throw new ImportError(error.code === "destination_invalid" ? 400 : 404, error.code);
        throw error;
      }
    },
    async parent(record, folderId) {
      try {
        return await deps.locations.lockParent(record.sourceId, folderId);
      } catch (error) {
        if (error instanceof ContextImportParentMovedError) throw new ParentMovedError();
        throw error;
      }
    },
    async lockDocument(id) {
      try {
        return await deps.locations.lockDocument(id);
      } catch (error) {
        if (error instanceof ContextImportParentMovedError) throw new ParentMovedError();
        throw error;
      }
    },
    async create(parent, nodes) {
      await deps.bulk.create({
        contextSourceId: parent.sourceId,
        folders: nodes
          .filter((node) => node.kind === "folder")
          .map((node) => ({ id: node.id, parentId: parent.folderId, name: node.name })),
        placeholders: nodes
          .filter((node) => node.kind !== "folder")
          .map((node) => ({
            id: node.id,
            folderId: parent.folderId,
            name: node.name,
            extension: node.extension,
            filetype: node.filetype,
            metadata: { importPending: true },
          })),
      });
    },
    async bind(entry, text) {
      if (entry.kind === "code")
        return deps.binder.bindPlannedCode(entry.id as never, entry.filetype, text);
      return deps.binder.bindMarkdown({
        holder: { documentId: entry.id as never },
        markdown: text,
        targets: new Map(),
      });
    },
    aheadTargets(bound, holderUri, entries) {
      const occurrences = walkLinkOccurrences(bound.blocks);
      return bound.aheadRefs.flatMap(({ occurrence, ref }) => {
        const attrs = occurrences[occurrence]?.attrs;
        const written = attrs?.href;
        if (typeof written !== "string") return [];
        const resolved = resolveDocumentHref(written, holderUri);
        const target = entries.find(
          (entry) =>
            (entry.kind === "binary" || entry.kind === "code") && entry.uri === resolved?.uri,
        );
        return target ? [{ targetId: target.id, ref }] : [];
      });
    },
    async settleAhead(ref, documentId) {
      const parsed = parseLinkRef(ref);
      return parsed?.kind === "ahead"
        ? deps.ahead.settleRef(parsed.aheadId, documentId as never)
        : null;
    },
    async fill(entry, bound, prepend) {
      if (!(await deps.locations.currentUri(entry.id, "file"))) return "deleted";
      const result = await (prepend
        ? deps.collab.prependBlocks(entry.id as never, bound)
        : deps.collab.fillEmptyDocument(entry.id as never, bound));
      if (!result.ok) {
        if (result.error.code === "not_found") return "deleted";
        throw new Error(result.error.code);
      }
      return result.value === null ? "edited" : "filled";
    },
    async land(_parent, entry, bound, bytes) {
      if (!entry.uri) throw new Error("Missing allocated URI");
      const origin = {
        type: "import" as const,
        userId: deps.userId,
        source: "selection",
        filename: entry.filename,
      };
      const result =
        entry.kind === "code"
          ? await deps.context.createBoundDocument(entry.uri, bound, {
              documentId: entry.id,
              origin,
            })
          : await deps.context.writeBinary(entry.uri, {
              documentId: entry.id,
              origin,
              fileType: entry.filetype as never,
              storageUrl: entry.storageUrl ?? "",
              mimeType: entry.mimeType,
              sizeBytes: bytes.length,
            });
      if (!result.ok) throw new Error(result.error.code);
      if (result.value.documentId !== entry.id) throw new Error("Landing identity mismatch");
    },
    async clearPending(ids) {
      if (!ids.length) return;
      await currentDrizzleDb(deps.db)
        .update(documents)
        .set({ metadata: sql`coalesce(${documents.metadata},'{}'::jsonb) - 'importPending'` })
        .where(inArray(documents.id, [...ids]));
      await deps.refreshFiles(ids);
    },
    currentUri: (id, kind) => deps.locations.currentUri(id, kind),
    currentUris: (ids) => deps.locations.currentUris(ids),
  };
}
