/** Identity-resolved parents in the given project areas, locked and reread in their current area. */
import type { Database } from "@meridian/database";
import { contextSources } from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { lockContextNamespaces } from "../adapters/context-fs/document-locations.js";
import { provisionProjectContextSource } from "../context-source-provisioning.js";
import {
  type ContextParentLocations,
  ContextParentMovedError,
} from "../ports/context-parent-locations.js";
import type { ProjectContextFsScheme } from "../ports/context-port.js";
import { createTreeReader, LIVE_TREE, visibleDocuments, visibleFolders } from "./tree-view.js";

export function createDrizzleContextParentLocations(
  db: Database,
  owner: { projectId: string; userId: string },
  areas: readonly ProjectContextFsScheme[],
): ContextParentLocations {
  const { projectId, userId } = owner;
  const tx = () => currentDrizzleDb(db);
  const tree = createTreeReader(db);
  async function source(id: string) {
    const [row] = await tx()
      .select()
      .from(contextSources)
      .where(
        and(
          eq(contextSources.id, id),
          eq(contextSources.projectId, projectId as never),
          isNull(contextSources.workId),
          isNull(contextSources.rootThreadId),
          isNull(contextSources.chatThreadId),
          isNull(contextSources.deletedAt),
        ),
      );
    return row && (areas as readonly string[]).includes(row.slug) ? row : null;
  }
  async function currentUris(ids: { files: readonly string[]; folders: readonly string[] }) {
    const uris = new Map<string, string>();
    for (const id of ids.files) {
      const found = await tree.findById(LIVE_TREE, id as never);
      if (found.kind !== "found") continue;
      const owner = await source(found.document.contextSourceId);
      if (owner) uris.set(id, `${owner.slug}://${found.document.path}`);
    }
    for (const id of ids.folders) {
      const found = await tree.findFolderById(LIVE_TREE, id as never);
      if (!found) continue;
      const owner = await source(found.contextSourceId);
      if (owner) uris.set(id, `${owner.slug}://${found.path}/`);
    }
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
            isNull(contextSources.workId),
            isNull(contextSources.rootThreadId),
            isNull(contextSources.chatThreadId),
            isNull(contextSources.deletedAt),
          ),
        );
      if (!owner) return null;
      const found = await tree.resolvePath(LIVE_TREE, {
        contextSourceId: owner.id,
        path: segments.join("/"),
      });
      return found.kind === "found" && found.node.kind === "folder"
        ? { sourceId: owner.id, folderId: found.node.folder.id }
        : null;
    },
    ensureSource: (scheme) => provisionProjectContextSource(db, { projectId, userId }, scheme),
    async lockParent(sourceId, folderId) {
      const before = folderId ? await tree.findFolderById(LIVE_TREE, folderId as never) : null;
      if (folderId && !before) return null;
      const currentSource = before?.contextSourceId ?? sourceId;
      const owner = await source(currentSource);
      if (!owner) return null;
      await lockContextNamespaces(db, { projectId, userId }, [
        { scheme: owner.slug as "kb", workId: null },
      ]);
      const after = folderId ? await tree.findFolderById(LIVE_TREE, folderId as never) : null;
      if (folderId && !after) return null;
      if (after && after.contextSourceId !== currentSource) throw new ContextParentMovedError();
      const uri = folderId
        ? (await currentUris({ files: [], folders: [folderId] })).get(folderId)
        : `${owner.slug}://`;
      if (!uri) return null;
      const vf = visibleFolders(LIVE_TREE);
      const vd = visibleDocuments(LIVE_TREE);
      const predicate = (column: typeof vf.parentId | typeof vd.folderId) =>
        folderId ? eq(column, folderId) : isNull(column);
      const [dirs, files] = await Promise.all([
        tx()
          .select({ name: vf.name })
          .from(vf)
          .where(and(eq(vf.contextSourceId, currentSource), predicate(vf.parentId))),
        tx()
          .select({ name: vd.name, extension: vd.extension })
          .from(vd)
          .where(and(eq(vd.contextSourceId, currentSource), predicate(vd.folderId))),
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
      const before = await tree.findById(LIVE_TREE, id as never);
      if (before.kind !== "found") return false;
      const parent = await locations.lockParent(
        before.document.contextSourceId,
        before.document.folderId,
      );
      if (!parent) return false;
      const after = await tree.findById(LIVE_TREE, id as never);
      if (after.kind !== "found") return false;
      if (
        after.document.contextSourceId !== before.document.contextSourceId ||
        after.document.folderId !== before.document.folderId
      )
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
