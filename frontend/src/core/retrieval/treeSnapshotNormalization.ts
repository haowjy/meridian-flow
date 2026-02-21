import { detectEditorType } from "@/core/editor/types";
import { buildTree, type TreeNode } from "@/core/lib/treeBuilder";
import type { Document } from "@/features/documents/types/document";
import type { Folder } from "@/features/folders/types/folder";

export interface SanitizeTreeSnapshotArgs {
  folders: Folder[];
  documents: Document[];
  fallbackProjectId: string | null;
  selectedIds?: Set<string>;
}

export interface SanitizedTreeSnapshot {
  folders: Folder[];
  documents: Document[];
  selectedIds?: Set<string>;
}

export interface NormalizedTreeState {
  folders: Folder[];
  documents: Document[];
  tree: TreeNode[];
  selectedIds?: Set<string>;
}

export function sanitizeTreeSnapshot({
  folders,
  documents,
  fallbackProjectId,
  selectedIds,
}: SanitizeTreeSnapshotArgs): SanitizedTreeSnapshot {
  const now = new Date();
  const sanitizedFoldersById = new Map<string, Folder>();

  for (const folder of folders) {
    if (!folder?.id || !folder?.name) continue;

    const projectId = folder.projectId ?? fallbackProjectId;
    if (!projectId) continue;

    const createdAt =
      folder.createdAt instanceof Date
        ? folder.createdAt
        : new Date(folder.createdAt);

    sanitizedFoldersById.set(folder.id, {
      id: folder.id,
      projectId,
      parentId: folder.parentId ?? null,
      name: folder.name,
      createdAt: Number.isNaN(createdAt.getTime()) ? now : createdAt,
    });
  }

  // Clear dangling parent references.
  for (const folder of sanitizedFoldersById.values()) {
    if (folder.parentId && !sanitizedFoldersById.has(folder.parentId)) {
      folder.parentId = null;
    }
  }

  const sanitizedFolders = Array.from(sanitizedFoldersById.values());
  const validFolderIds = new Set(sanitizedFolders.map((folder) => folder.id));
  const seenDocumentIds = new Set<string>();
  const sanitizedDocuments: Document[] = [];

  for (const doc of documents) {
    if (!doc?.id || seenDocumentIds.has(doc.id)) continue;

    const path = typeof doc.path === "string" ? doc.path.trim() : "";
    if (!path) continue;

    const folderId = doc.folderId ?? null;
    if (folderId !== null && !validFolderIds.has(folderId)) continue;

    const pathFilename = path.split("/").filter(Boolean).at(-1) ?? "";
    const rawFilename =
      (typeof doc.filename === "string" && doc.filename.trim()) || pathFilename;
    if (!rawFilename) continue;

    const dotIndex = rawFilename.lastIndexOf(".");
    const inferredExtension =
      dotIndex > 0 ? rawFilename.slice(dotIndex) : ".md";
    const rawExtension =
      typeof doc.extension === "string" && doc.extension.trim()
        ? doc.extension
        : inferredExtension;
    const extension = rawExtension.startsWith(".")
      ? rawExtension
      : `.${rawExtension}`;

    const name =
      (typeof doc.name === "string" && doc.name.trim()) ||
      (dotIndex > 0 ? rawFilename.slice(0, dotIndex) : rawFilename);
    const filename = `${name}${extension}`;

    const projectId =
      doc.projectId ??
      (folderId ? sanitizedFoldersById.get(folderId)?.projectId : undefined) ??
      fallbackProjectId;
    if (!projectId) continue;

    const updatedAt =
      doc.updatedAt instanceof Date ? doc.updatedAt : new Date(doc.updatedAt);

    seenDocumentIds.add(doc.id);
    sanitizedDocuments.push({
      ...doc,
      projectId,
      folderId,
      name,
      path,
      extension,
      filename,
      fileType: detectEditorType(filename),
      updatedAt: Number.isNaN(updatedAt.getTime()) ? now : updatedAt,
    });
  }

  if (!selectedIds) {
    return { folders: sanitizedFolders, documents: sanitizedDocuments };
  }

  const validNodeIds = new Set<string>([
    ...sanitizedFolders.map((folder) => folder.id),
    ...sanitizedDocuments.map((doc) => doc.id),
  ]);
  const sanitizedSelectedIds = new Set(
    Array.from(selectedIds).filter((id) => validNodeIds.has(id)),
  );

  return {
    folders: sanitizedFolders,
    documents: sanitizedDocuments,
    selectedIds: sanitizedSelectedIds,
  };
}

export function normalizeTreeState({
  folders,
  documents,
  fallbackProjectId,
  selectedIds,
}: SanitizeTreeSnapshotArgs): NormalizedTreeState {
  const sanitized = sanitizeTreeSnapshot({
    folders,
    documents,
    fallbackProjectId,
    selectedIds,
  });

  return {
    folders: sanitized.folders,
    documents: sanitized.documents,
    tree: buildTree(sanitized.folders, sanitized.documents),
    selectedIds: sanitized.selectedIds,
  };
}
