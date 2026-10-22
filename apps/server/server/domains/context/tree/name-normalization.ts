/** Hidden-node yielding after a live tree write installs its rows. */
import type { ContextSourceId, DocumentId, FolderId } from "@meridian/contracts";
import {
  allocateFilename,
  type NamespaceNameClaim,
  renderFilename,
  sameNamespaceName,
} from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documents, folders } from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { bumpLocationVersions } from "./node-locations.js";
import { loadSubtreeNodes } from "./tree-view-sql.js";

export type NameParent = {
  contextSourceId: ContextSourceId;
  parentId: FolderId | null;
};

type Child = NamespaceNameClaim & {
  id: string;
  hidden: boolean;
  createdAt: Date;
};

/** Keep the strongest claimant and move every weaker claimant to its next free name. */
export async function normalizeNames(db: Database, parents: readonly NameParent[]): Promise<void> {
  const tx = currentDrizzleDb(db);
  const unique = new Map(
    parents.map((parent) => [`${parent.contextSourceId}:${parent.parentId ?? "root"}`, parent]),
  );
  for (const parent of unique.values()) {
    const documentParent = and(
      eq(documents.contextSourceId, parent.contextSourceId),
      parent.parentId === null
        ? isNull(documents.folderId)
        : eq(documents.folderId, parent.parentId),
    );
    const folderParent = and(
      eq(folders.contextSourceId, parent.contextSourceId),
      parent.parentId === null ? isNull(folders.parentId) : eq(folders.parentId, parent.parentId),
    );
    const [documentRows, folderRows] = await Promise.all([
      tx
        .select({
          id: documents.id,
          name: documents.name,
          extension: documents.extension,
          hidden: documents.hidden,
          createdAt: documents.createdAt,
        })
        .from(documents)
        .where(and(documentParent, isNull(documents.deletedAt))),
      tx
        .select({
          id: folders.id,
          name: folders.name,
          hidden: folders.hidden,
          createdAt: folders.createdAt,
        })
        .from(folders)
        .where(and(folderParent, isNull(folders.deletedAt))),
    ]);
    const children: Child[] = [
      ...documentRows.map((row) => ({
        ...row,
        kind: "document" as const,
        filename: renderFilename(row.name, row.extension),
      })),
      ...folderRows.map((row) => ({ ...row, kind: "folder" as const, filename: row.name })),
    ].sort(
      (left, right) =>
        Number(left.hidden) - Number(right.hidden) ||
        Number(right.kind === "folder") - Number(left.kind === "folder") ||
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.id.localeCompare(right.id),
    );
    const accepted: Child[] = [];
    for (const child of children) {
      if (!accepted.some((other) => sameNamespaceName(child, other))) {
        accepted.push(child);
        continue;
      }
      const parsed =
        child.kind === "document" ? documentRows.find((row) => row.id === child.id) : undefined;
      const desired =
        child.kind === "document"
          ? {
              kind: "document" as const,
              name: parsed?.name ?? child.filename,
              extension: parsed?.extension ?? "",
            }
          : { kind: "folder" as const, name: child.filename };
      const filename = await allocateFilename(desired, (candidate) =>
        children.some((other) => other.id !== child.id && sameNamespaceName(candidate, other)),
      );
      const now = new Date();
      if (child.kind === "document") {
        const extension = parsed?.extension ?? "";
        await tx
          .update(documents)
          .set({
            name: extension ? filename.slice(0, -(extension.length + 1)) : filename,
            updatedAt: now,
          })
          .where(eq(documents.id, child.id as DocumentId));
        await bumpLocationVersions(db, { documentIds: [child.id as DocumentId] });
      } else {
        await tx
          .update(folders)
          .set({ name: filename, updatedAt: now })
          .where(eq(folders.id, child.id as FolderId));
        const subtree = await loadSubtreeNodes(tx, [child.id as FolderId]);
        await bumpLocationVersions(db, {
          folderIds: [
            child.id as FolderId,
            ...subtree.filter((n) => n.kind === "folder").map((n) => n.id as FolderId),
          ],
          documentIds: subtree.filter((n) => n.kind === "document").map((n) => n.id as DocumentId),
        });
      }
      child.filename = filename;
      accepted.push(child);
    }
  }
}
