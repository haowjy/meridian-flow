/**
 * Where a writer's drag-restore lands, read from the tree as it is now. The service reads it
 * before taking locks (to name the destination's source) and again under them, so a folder
 * deleted, moved into Trash or into another source while the request was in flight is caught.
 */
import type { ContextSourceId, FolderId, ProjectId, UserId } from "@meridian/contracts";
import type { RestoreContextDocumentsRequest } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { contextSources, projects } from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { loadFolderChains, presentSourceId } from "../tree/tree-addresses.js";
import { createTreeReader, LIVE_TREE } from "../tree/tree-view.js";

/** Rows move freely within one system, and a restore never leaves it (it has no Copy). */
export type RestoreSystem = "project" | "user";

export type RestoreDestination = {
  contextSourceId: ContextSourceId;
  parentFolderId: FolderId | null;
  system: RestoreSystem;
};

/** The system a source belongs to; null for a Work's, chat's or lineage's source, which a drag-restore doesn't serve. */
export async function readRestoreSystem(
  db: Database,
  input: { sourceId: ContextSourceId; projectId: ProjectId; userId: UserId },
): Promise<RestoreSystem | null> {
  const [source] = await currentDrizzleDb(db)
    .select({
      slug: contextSources.slug,
      projectId: contextSources.projectId,
      workId: contextSources.workId,
      rootThreadId: contextSources.rootThreadId,
      chatThreadId: contextSources.chatThreadId,
      ownerAccountId: projects.userId,
      personal: projects.isPersonal,
    })
    .from(contextSources)
    .innerJoin(projects, eq(projects.id, contextSources.projectId))
    .where(
      and(
        eq(contextSources.id, input.sourceId),
        isNull(contextSources.deletedAt),
        isNull(projects.deletedAt),
        isNull(contextSources.workId),
        isNull(contextSources.rootThreadId),
        isNull(contextSources.chatThreadId),
      ),
    );
  if (!source) return null;
  if (source.slug === "user")
    return source.personal && source.ownerAccountId === input.userId ? "user" : null;
  return source.projectId === input.projectId &&
    (source.slug === "manuscript" || source.slug === "kb")
    ? "project"
    : null;
}

/** The destination as it stands now, or null when the writer can't restore into it any more. */
export async function readRestoreDestination(
  db: Database,
  input: {
    projectId: ProjectId;
    userId: UserId;
    parent: NonNullable<RestoreContextDocumentsRequest["destination"]>["parent"];
  },
): Promise<RestoreDestination | null> {
  let sourceId: ContextSourceId | null;
  let parentFolderId: FolderId | null = null;
  if (input.parent.kind === "root") {
    sourceId = await presentSourceId(db, {
      scheme: input.parent.scheme,
      workId: null,
      project:
        input.parent.scheme === "user" ? { personalOf: input.userId } : { id: input.projectId },
    });
  } else {
    const folderId = input.parent.folderId as FolderId;
    const folder = await createTreeReader(db).findFolderById(LIVE_TREE, folderId);
    // A folder is live only while every folder above it is.
    const chain = (await loadFolderChains(db, [folderId])).get(folderId) ?? [];
    if (!folder || chain.some((link) => link.deleted)) return null;
    sourceId = folder.contextSourceId;
    parentFolderId = folder.id;
  }
  if (!sourceId) return null;
  const system = await readRestoreSystem(db, {
    sourceId,
    projectId: input.projectId,
    userId: input.userId,
  });
  return system ? { contextSourceId: sourceId, parentFolderId, system } : null;
}
