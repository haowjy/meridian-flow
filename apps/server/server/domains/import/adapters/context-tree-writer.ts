/** Context/collab import adapter using bulk creation, identity fill and the isolated binder. */
import { parseLinkRef } from "@meridian/contracts";
import { parseDocumentFilename } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documents } from "@meridian/database/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { CollabDomain, ImportLinkBinder } from "../../collab/index.js";
import {
  type ContextBulkCreation,
  type ContextImportLocations,
  ContextImportParentMovedError,
  type ContextPort,
  type LinkAheadRegistry,
} from "../../context/index.js";
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
    async existingLinks() {
      const files: {
        id: string;
        uri: string;
        kind: "note" | "code" | "binary";
        filetype: string;
      }[] = [];
      async function visit(uri: string) {
        const result = await deps.context.list(uri);
        if (!result.ok) throw new Error(result.error.code);
        for (const item of result.value.entries) {
          if (item.kind === "directory") await visit(item.uri);
          else if (item.documentId)
            files.push({
              id: item.documentId,
              uri: item.uri,
              kind: item.editable ? (item.schemaType === "code" ? "code" : "note") : "binary",
              filetype: item.editable ? item.filetype : item.fileType,
            });
        }
      }
      for (const area of ["manuscript", "kb", "unfiled"]) await visit(`${area}://`);
      const rows = files.length
        ? await currentDrizzleDb(deps.db)
            .select({ id: documents.id, metadata: documents.metadata })
            .from(documents)
            .where(
              inArray(
                documents.id,
                files.map((file) => file.id),
              ),
            )
        : [];
      const metadataById = new Map(rows.map((row) => [row.id, row.metadata]));
      return files.map((file) => {
        const metadata = metadataById.get(file.id) as {
          aliases?: unknown;
        } | null;
        return {
          ...file,
          rootId: null,
          path: file.uri,
          aliases: Array.isArray(metadata?.aliases)
            ? metadata.aliases.filter((value): value is string => typeof value === "string")
            : [],
        };
      });
    },
    async setProperties(id, properties, aliases) {
      const metadata = { ...(properties ? { properties } : {}), aliases };
      await currentDrizzleDb(deps.db)
        .update(documents)
        .set({
          metadata: sql`coalesce(${documents.metadata},'{}'::jsonb) || ${JSON.stringify(metadata)}::jsonb`,
        })
        .where(eq(documents.id, id));
    },
    async preview(uri) {
      const listing = await deps.context.list(uri);
      if (!listing.ok) throw new Error(listing.error.code);
      return listing.value.entries.map((entry) => {
        const filename = entry.uri.split("/").filter(Boolean).at(-1) ?? "";
        if (entry.kind === "directory")
          return { kind: "folder" as const, name: filename, extension: "" };
        const parsed = parseDocumentFilename(filename);
        if (!parsed.ok) throw new Error("Invalid live filename");
        return {
          kind: "file" as const,
          name: parsed.value.name,
          extension: parsed.value.extension,
        };
      });
    },
    destination: (uri) => deps.locations.destination(uri),
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
    async bind(entry, text, targets) {
      if (entry.kind === "code")
        return deps.binder.bindPlannedCode(entry.id as never, entry.filetype, text);
      return deps.binder.bindMarkdown({
        holder: { documentId: entry.id as never },
        markdown: text,
        targets: targets as never,
      });
    },
    aheadTargets(bound, _holderUri, entries, targets) {
      return bound.aheadRefs.flatMap(({ occurrence, ref }) => {
        const targetId = targets?.get(occurrence);
        const target = entries.find((entry) => entry.id === targetId);
        return target && (target.kind === "binary" || target.kind === "code")
          ? [{ targetId: target.id, ref }]
          : [];
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
  };
}
