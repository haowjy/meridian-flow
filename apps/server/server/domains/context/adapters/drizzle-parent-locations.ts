/** Identity-resolved parents in the given project areas, locked and reread in their current area. */
import type { Database } from "@meridian/database";
import { contextSources, documents, folders } from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { provisionProjectContextSource } from "../context-source-provisioning.js";
import {
  type ContextParentLocations,
  ContextParentMovedError,
} from "../ports/context-parent-locations.js";
import type { ProjectContextFsScheme } from "../ports/context-port.js";
import { lockContextNamespaces } from "./context-fs/document-locations.js";
import { loadDocumentAddresses, loadFolderAddresses } from "./document-address.js";

export function createDrizzleContextParentLocations(
  db: Database,
  owner: { projectId: string; userId: string },
  areas: readonly ProjectContextFsScheme[],
): ContextParentLocations {
  const { projectId, userId } = owner;
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
    return row && (areas as readonly string[]).includes(row.slug) ? row : null;
  }
  async function folder(id: string) {
    const [row] = await tx()
      .select()
      .from(folders)
      .where(and(eq(folders.id, id), isNull(folders.deletedAt)));
    return row ?? null;
  }
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
      if (
        !address.deleted &&
        address.projectId === projectId &&
        (areas as readonly string[]).includes(address.scheme)
      )
        uris.set(address.id, address.uri);
    return uris;
  }
  const locations: ContextParentLocations = {
    async findFolder(scheme, segments) {
      const [owner] = await tx()
        .select()
        .from(contextSources)
        .where(
          and(
            eq(contextSources.projectId, projectId as never),
            eq(contextSources.slug, scheme),
            isNull(contextSources.deletedAt),
          ),
        );
      if (!owner) return null;
      let folderId: string | null = null;
      for (const segment of segments) {
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
        if (!child) return null;
        folderId = child.id;
      }
      return { sourceId: owner.id, folderId };
    },
    ensureSource: (scheme) => provisionProjectContextSource(db, { projectId, userId }, scheme),
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
      if (after && after.contextSourceId !== currentSource) throw new ContextParentMovedError();
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
        throw new ContextParentMovedError();
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
