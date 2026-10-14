/**
 * Context/collab import adapter: which project areas are importable, destination resolution
 * with its ImportError mapping, sibling-batch creation, identity fill and the isolated binder.
 */
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { Database } from "@meridian/database";
import { documents } from "@meridian/database/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { CollabDomain, ImportLinkBinder } from "../../collab/index.js";
import {
  type ContextChildCreation,
  type ContextParentLocations,
  ContextParentMovedError,
  type ContextPort,
  type LinkAheadRegistry,
  type ProjectContextFsScheme,
} from "../../context/index.js";
import { ImportError } from "../domain/manifest.js";
import { type ImportTreeWriter, ParentMovedError } from "../ports/import-tree-writer.js";
/** The project areas imports may read from and write into. */
export const IMPORT_AREAS = [
  "manuscript",
  "kb",
  "unfiled",
] as const satisfies readonly ProjectContextFsScheme[];
const isImportArea = (scheme: string): scheme is (typeof IMPORT_AREAS)[number] =>
  (IMPORT_AREAS as readonly string[]).includes(scheme);

export function createContextImportTreeWriter(deps: {
  db: Database;
  locations: ContextParentLocations;
  children: ContextChildCreation;
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
      for (const area of IMPORT_AREAS) await visit(`${area}://`);
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
    async destination(uri) {
      const parsed = parseContextUri(uri);
      if (!parsed.ok || !parsed.value || !isImportArea(parsed.value.scheme))
        throw new ImportError(400, "destination_invalid");
      const { scheme, path } = parsed.value;
      const segments = path.split("/").filter(Boolean);
      let found = await deps.locations.findFolder(scheme, segments);
      // A fresh project has no area source yet: importing to its root creates it.
      if (!found && !segments.length) {
        await deps.locations.ensureSource(scheme);
        found = await deps.locations.findFolder(scheme, segments);
      }
      if (!found) throw new ImportError(404, "destination_not_found");
      return found;
    },
    async parent(sourceId, folderId) {
      try {
        return await deps.locations.lockParent(sourceId, folderId);
      } catch (error) {
        if (error instanceof ContextParentMovedError) throw new ParentMovedError();
        throw error;
      }
    },
    async lockDocument(id) {
      try {
        return await deps.locations.lockDocument(id);
      } catch (error) {
        if (error instanceof ContextParentMovedError) throw new ParentMovedError();
        throw error;
      }
    },
    async create(parent, nodes) {
      await deps.children.createChildren({
        parent: { sourceId: parent.sourceId, folderId: parent.folderId },
        folders: nodes
          .filter((node) => node.kind === "folder")
          .map((node) => ({ id: node.id, name: node.name })),
        documents: nodes
          .filter((node) => node.kind !== "folder")
          .map((node) => ({
            id: node.id,
            name: node.name,
            extension: node.extension,
            filetype: node.filetype,
            metadata: { importPending: true },
          })),
      });
    },
    async bind(entry, { text, targets, hrefs, pending }) {
      if (entry.kind === "code")
        return deps.binder.bindPlannedCode(entry.id as never, entry.filetype, text);
      return deps.binder.bindMarkdown({
        holder: { documentId: entry.id as never },
        markdown: text,
        targets: targets as never,
        hrefs,
        pending: pending as never,
      });
    },
    async releaseAhead(documentIds) {
      await deps.ahead.releaseAwaiting(documentIds as never);
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
