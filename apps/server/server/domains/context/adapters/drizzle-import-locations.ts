/** Identity-resolved import parents, locked and reread in their current project area. */
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { Database } from "@meridian/database";
import { contextSources, documents, folders } from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { lockSeamWorks } from "../../../shared/work-lifecycle-lock.js";
import {
  ContextImportDestinationError,
  type ContextImportLocations,
  ContextImportParentMovedError,
} from "../ports/context-import-locations.js";
import { lockContextNamespaces } from "./context-fs/document-locations.js";
import { loadDocumentAddresses, loadFolderAddresses } from "./document-address.js";

export function createDrizzleContextImportLocations(
  db: Database,
  projectId: string,
  userId: string,
): ContextImportLocations {
  const tx = () => currentDrizzleDb(db);
  async function source(id: string) {
    const [row] = await tx()
      .select()
      .from(contextSources)
      .where(
        and(
          eq(contextSources.id, id),
          eq(contextSources.projectId, projectId as never),
          isNull(contextSources.deletedAt),
        ),
      );
    return row && ["kb", "manuscript", "unfiled"].includes(row.slug) ? row : null;
  }
  async function folder(id: string) {
    const [row] = await tx()
      .select()
      .from(folders)
      .where(and(eq(folders.id, id), isNull(folders.deletedAt)));
    return row ?? null;
  }
  const areas = new Set(["kb", "manuscript", "unfiled"]);
  async function currentUris(ids: { files: readonly string[]; folders: readonly string[] }) {
    const [files, dirs] = await Promise.all([
      loadDocumentAddresses(db, { ids: ids.files }),
      loadFolderAddresses(db, ids.folders),
    ]);
    const uris = new Map<string, string>();
    for (const address of [
      ...files.map((file) => ({ ...file, id: file.documentId as string })),
      ...dirs.map((dir) => ({ ...dir, id: dir.folderId })),
    ])
      if (!address.deleted && address.projectId === projectId && areas.has(address.scheme))
        uris.set(address.id, address.uri);
    return uris;
  }
  const locations: ContextImportLocations = {
    async destination(uri) {
      const result = parseContextUri(uri);
      if (!result.ok) throw new ContextImportDestinationError("destination_invalid");
      const parsed = result.value;
      if (!parsed || !["kb", "manuscript", "unfiled"].includes(parsed.scheme))
        throw new ContextImportDestinationError("destination_invalid");
      let [owner] = await tx()
        .select()
        .from(contextSources)
        .where(
          and(
            eq(contextSources.projectId, projectId as never),
            eq(contextSources.slug, parsed.scheme),
            isNull(contextSources.deletedAt),
          ),
        );
      if (!owner && !parsed.path) {
        await runInDrizzleTransaction(db, async () => {
          await lockSeamWorks(db, []);
          await lockContextNamespaces(db, { projectId, userId }, [
            { scheme: parsed.scheme as "kb", workId: null },
          ]);
          await tx()
            .insert(contextSources)
            .values({
              projectId: projectId as never,
              name:
                parsed.scheme === "kb"
                  ? "Knowledge Base"
                  : parsed.scheme === "manuscript"
                    ? "Manuscript"
                    : "Unfiled",
              slug: parsed.scheme,
              scope: "project",
              isPrimary: parsed.scheme === "manuscript",
            })
            .onConflictDoNothing();
        });
        [owner] = await tx()
          .select()
          .from(contextSources)
          .where(
            and(
              eq(contextSources.projectId, projectId as never),
              eq(contextSources.slug, parsed.scheme),
              isNull(contextSources.deletedAt),
            ),
          );
      }
      if (!owner) throw new ContextImportDestinationError("destination_not_found");
      let folderId: string | null = null;
      for (const segment of parsed.path.split("/").filter(Boolean)) {
        const [child] = await tx()
          .select()
          .from(folders)
          .where(
            and(
              eq(folders.contextSourceId, owner.id),
              folderId ? eq(folders.parentId, folderId) : isNull(folders.parentId),
              eq(folders.name, segment),
              isNull(folders.deletedAt),
            ),
          );
        if (!child) throw new ContextImportDestinationError("destination_not_found");
        folderId = child.id;
      }
      return { sourceId: owner.id, folderId };
    },
    async lockParent(sourceId, folderId) {
      const before = folderId ? await folder(folderId) : null;
      if (folderId && !before) return null;
      const currentSource = before?.contextSourceId ?? sourceId;
      const owner = await source(currentSource);
      if (!owner) return null;
      await lockContextNamespaces(db, { projectId, userId }, [
        { scheme: owner.slug as "kb", workId: null },
      ]);
      const after = folderId ? await folder(folderId) : null;
      if (folderId && !after) return null;
      if (after && after.contextSourceId !== currentSource)
        throw new ContextImportParentMovedError();
      const uri = folderId
        ? (await currentUris({ files: [], folders: [folderId] })).get(folderId)
        : `${owner.slug}://`;
      if (!uri) return null;
      const predicate = (column: typeof folders.parentId | typeof documents.folderId) =>
        folderId ? eq(column, folderId) : isNull(column);
      const [dirs, files] = await Promise.all([
        tx()
          .select({ name: folders.name })
          .from(folders)
          .where(
            and(
              eq(folders.contextSourceId, currentSource),
              predicate(folders.parentId),
              isNull(folders.deletedAt),
            ),
          ),
        tx()
          .select({ name: documents.name, extension: documents.extension })
          .from(documents)
          .where(
            and(
              eq(documents.contextSourceId, currentSource),
              predicate(documents.folderId),
              isNull(documents.deletedAt),
            ),
          ),
      ]);
      return {
        sourceId: currentSource,
        folderId,
        uri,
        children: [
          ...dirs.map((row) => ({ ...row, kind: "folder" as const, extension: "" })),
          ...files.map((row) => ({ ...row, kind: "file" as const })),
        ],
      };
    },
    async lockDocument(id) {
      const [before] = await tx()
        .select()
        .from(documents)
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)));
      if (!before) return false;
      const parent = await locations.lockParent(before.contextSourceId, before.folderId);
      if (!parent) return false;
      const [after] = await tx()
        .select()
        .from(documents)
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)));
      if (!after) return false;
      if (after.contextSourceId !== before.contextSourceId || after.folderId !== before.folderId)
        throw new ContextImportParentMovedError();
      return true;
    },
    async currentUri(id, kind) {
      const uris = await currentUris(
        kind === "folder" ? { files: [], folders: [id] } : { files: [id], folders: [] },
      );
      return uris.get(id) ?? null;
    },
    currentUris,
  };
  return locations;
}
