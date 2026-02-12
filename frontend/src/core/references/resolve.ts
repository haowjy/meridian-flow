/**
 * Reference Resolution
 *
 * Pure resolvers that operate on a tree snapshot.
 * Store-backed adapters are provided for convenience and compatibility.
 *
 * Search order (first match wins):
 * 1. Document — exact path match
 * 2. Document — unique filename match
 * 3. Folder — exact path match
 * 4. Folder — unique name match
 */

import { useTreeStore } from "@/core/stores/useTreeStore";
import { buildFolderPath } from "./pathing";
import type { ResolvedRef } from "./types";

export interface ResolverDocument {
  id: string;
  name: string;
  path: string;
  filename: string;
}

export interface ResolverFolder {
  id: string;
  name: string;
  parentId: string | null;
}

export interface ResolverTreeSnapshot {
  documents: readonly ResolverDocument[];
  folders: readonly ResolverFolder[];
}

// =============================================================================
// PURE RESOLVERS
// =============================================================================

/**
 * Resolve a path to a document or folder from a tree snapshot.
 *
 * @param path - The path to resolve (e.g., "doc.md", "folder/doc", "Chapter 1")
 * @returns Resolved reference or null if not found
 */
export function resolveReferenceFromTree(
  path: string,
  snapshot: ResolverTreeSnapshot,
): ResolvedRef | null {
  const { documents, folders } = snapshot;
  // --- Document: exact path match ---
  const exactDoc = documents.find((d) => d.path === path);
  if (exactDoc) {
    return {
      type: "document",
      id: exactDoc.id,
      name: exactDoc.name,
      path: exactDoc.path,
    };
  }

  // --- Document: unique filename match ---
  const filename = path.split("/").pop();
  if (filename) {
    const filenameMatches = documents.filter((d) => d.filename === filename);
    if (filenameMatches.length === 1) {
      const doc = filenameMatches[0]!;
      return {
        type: "document",
        id: doc.id,
        name: doc.name,
        path: doc.path,
      };
    }
  }

  // --- Folder: build a lookup map and full paths ---
  if (folders.length > 0) {
    const folderMap = new Map(
      folders.map((f) => [f.id, { name: f.name, parentId: f.parentId }]),
    );

    // Exact path match
    for (const folder of folders) {
      const folderPath = buildFolderPath(folder.id, folderMap);
      if (folderPath === path) {
        return {
          type: "folder",
          id: folder.id,
          name: folder.name,
          path: folderPath,
        };
      }
    }

    // Unique name match (only if the input has no slashes — single segment)
    if (!path.includes("/")) {
      const nameMatches = folders.filter((f) => f.name === path);
      if (nameMatches.length === 1) {
        const folder = nameMatches[0]!;
        const folderPath = buildFolderPath(folder.id, folderMap);
        return {
          type: "folder",
          id: folder.id,
          name: folder.name,
          path: folderPath,
        };
      }
    }
  }

  return null;
}

/**
 * Resolve document path from ID using a tree snapshot.
 */
export function resolveDocumentPathByIdFromTree(
  documentId: string,
  snapshot: Pick<ResolverTreeSnapshot, "documents">,
): string | null {
  const doc = snapshot.documents.find((d) => d.id === documentId);
  return doc?.path ?? null;
}

/**
 * Resolve path from ID, searching both documents and folders, using a tree snapshot.
 *
 * Used by clipboard `toPlainText` so folder references don't degrade
 * to display-name-only when `documentPath` is absent.
 */
export function resolvePathByIdFromTree(
  id: string,
  snapshot: ResolverTreeSnapshot,
): string | null {
  const { documents, folders } = snapshot;
  const doc = documents.find((d) => d.id === id);
  if (doc) return doc.path;

  if (folders.length === 0) return null;
  const folder = folders.find((f) => f.id === id);
  if (!folder) return null;

  const folderMap = new Map(
    folders.map((f) => [f.id, { name: f.name, parentId: f.parentId }]),
  );
  return buildFolderPath(folder.id, folderMap);
}

// =============================================================================
// STORE-BACKED ADAPTERS
// =============================================================================

/**
 * Resolve a path to a document or folder from the current tree store snapshot.
 */
export function resolveReference(path: string): ResolvedRef | null {
  return resolveReferenceFromTree(path, useTreeStore.getState());
}

/**
 * Resolve document path from ID using the current tree store snapshot.
 */
export function resolveDocumentPathById(documentId: string): string | null {
  return resolveDocumentPathByIdFromTree(documentId, useTreeStore.getState());
}

/**
 * Resolve path from ID using the current tree store snapshot.
 */
export function resolvePathById(id: string): string | null {
  return resolvePathByIdFromTree(id, useTreeStore.getState());
}
