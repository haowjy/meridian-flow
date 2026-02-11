/**
 * Path Utilities for References
 *
 * Helper functions for building and manipulating reference paths.
 * Extracted from resolveDocument.ts for reuse across reference systems.
 */

// =============================================================================
// FOLDER PATH
// =============================================================================

/**
 * Build full path for a folder by walking its parentId chain.
 *
 * @param folderId - The folder ID to build path for
 * @param folderMap - Map of folder ID → { name, parentId }
 * @returns Full path like "parent/child/folder"
 */
export function buildFolderPath(
  folderId: string,
  folderMap: Map<string, { name: string; parentId: string | null }>,
): string {
  const parts: string[] = [];
  let currentId: string | null = folderId;
  // Guard against cycles — max depth 20
  let depth = 0;
  while (currentId && depth < 20) {
    const folder = folderMap.get(currentId);
    if (!folder) break;
    parts.unshift(folder.name);
    currentId = folder.parentId;
    depth++;
  }
  return parts.join("/");
}
