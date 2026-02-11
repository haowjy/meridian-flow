import { hasMatch, score } from "fzy.js";
import type { Document } from "@/features/documents/types/document";
import type { Folder } from "@/features/folders/types/folder";
import { buildFolderPath } from "@/core/references";

export type ReferenceSearchRefType = "document" | "folder";

export interface ReferenceSearchItem {
  id: string;
  name: string;
  path: string;
  refType: ReferenceSearchRefType;
}

interface RankedItem extends ReferenceSearchItem {
  score: number;
}

/**
 * Fuzzy-rank project documents/folders for adding as thread references.
 *
 * - No query: returns 8 most recently updated documents
 * - Query: returns up to 10 matches across documents (name/path) + folders (name)
 */
export function rankReferenceItems(
  query: string,
  documents: Document[],
  folders: Folder[],
): ReferenceSearchItem[] {
  // No query: show 8 most recent documents sorted by updatedAt
  if (!query) {
    return documents
      .toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, 8)
      .map((doc) => ({
        id: doc.id,
        name: doc.name,
        path: doc.path,
        refType: "document" as const,
      }));
  }

  const results: RankedItem[] = [];

  // Score documents by name AND path, take the best score
  for (const doc of documents) {
    const nameMatch = hasMatch(query, doc.name);
    const pathMatch = hasMatch(query, doc.path);
    if (!nameMatch && !pathMatch) continue;
    const nameScore = nameMatch ? score(query, doc.name) : -Infinity;
    const pathScore = pathMatch ? score(query, doc.path) : -Infinity;
    results.push({
      id: doc.id,
      name: doc.name,
      path: doc.path,
      refType: "document",
      score: Math.max(nameScore, pathScore),
    });
  }

  // Build folder map for path computation (only when querying)
  const folderMap = new Map(
    folders.map((f) => [f.id, { name: f.name, parentId: f.parentId }]),
  );

  // Score folders by name
  for (const folder of folders) {
    if (!hasMatch(query, folder.name)) continue;
    results.push({
      id: folder.id,
      name: folder.name,
      path: buildFolderPath(folder.id, folderMap),
      refType: "folder",
      score: score(query, folder.name),
    });
  }

  // Sort by score descending, cap at 10
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(({ id, name, path, refType }) => ({
      id,
      name,
      path,
      refType,
    }));
}
