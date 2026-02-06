/**
 * Utility to flatten recursive tool result tree structure into flat arrays.
 *
 * Tool results (doc_tree, doc_view folder) return nested folder/document structure.
 * Tree store uses flat arrays with parentId/folderId references.
 * This utility converts between the two formats for hydration.
 *
 * Placed in core layer to be used by useTreeStore without DIP violation.
 */

import type { Document } from "@/features/documents/types/document";
import type { Folder } from "@/features/folders/types/folder";
import type { DocTreeFolder, DocTreeDocument } from "@/types/docTree";

/** Partial document with fields from tool result */
export type PartialDocument = Pick<
  Document,
  | "id"
  | "name"
  | "filename"
  | "extension"
  | "folderId"
  | "wordCount"
  | "updatedAt"
>;

/** Partial folder with fields from tool result */
export type PartialFolder = Pick<Folder, "id" | "name" | "parentId">;

export interface FlattenResult {
  documents: PartialDocument[];
  folders: PartialFolder[];
}

/**
 * Flatten recursive tool result tree into flat arrays for tree store.
 *
 * Handles:
 * - Deriving parentId/folderId from nested structure
 * - Splitting name into name (without extension) + filename (with extension)
 * - Converting snake_case (word_count) to camelCase (wordCount)
 *
 * @param folders - Nested folders from tool result
 * @param documents - Documents at current level from tool result
 * @param parentId - Parent folder ID (null for root level)
 */
export function flattenToolTree(
  folders: DocTreeFolder[],
  documents: DocTreeDocument[],
  parentId: string | null = null,
): FlattenResult {
  const result: FlattenResult = { documents: [], folders: [] };

  // Process documents at this level
  for (const doc of documents) {
    const extension = doc.extension || ".md";
    const filename = doc.name;
    // Strip extension from name if present
    const name = filename.endsWith(extension)
      ? filename.slice(0, -extension.length)
      : filename;

    result.documents.push({
      id: doc.id,
      name,
      filename,
      extension,
      folderId: parentId,
      wordCount: doc.word_count,
      updatedAt: new Date(doc.updated_at),
    });
  }

  // Process folders recursively
  for (const folder of folders) {
    result.folders.push({
      id: folder.id,
      name: folder.name,
      parentId,
    });

    // Recurse into children
    const childResult = flattenToolTree(
      folder.folders || [],
      folder.documents || [],
      folder.id,
    );
    result.documents.push(...childResult.documents);
    result.folders.push(...childResult.folders);
  }

  return result;
}
