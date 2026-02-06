/**
 * Path Resolution for doc_edit Tool
 *
 * Converts Unix-style paths from doc_edit tool input to Document objects
 * for navigation and display.
 *
 * Path format: "/FolderName/SubFolder/Document.md" or "/Document.md"
 */

import type { Document } from "@/features/documents/types/document";
import type { Folder } from "@/features/folders/types/folder";

// =============================================================================
// TYPES
// =============================================================================

export interface ParsedDocPath {
  /** Folder path segments (empty for root documents) */
  folderPath: string[];
  /** Filename with extension (e.g., "Hero.md") */
  filename: string;
  /** Full display path without leading slash (e.g., "Characters/Hero.md") */
  displayName: string;
}

// =============================================================================
// PATH PARSING
// =============================================================================

/**
 * Parse doc_edit path into components.
 *
 * @example
 * parseDocEditPath("/Characters/Hero.md")
 * // => { folderPath: ["Characters"], filename: "Hero.md", displayName: "Characters/Hero.md" }
 *
 * parseDocEditPath("/Chapter 5.md")
 * // => { folderPath: [], filename: "Chapter 5.md", displayName: "Chapter 5.md" }
 */
export function parseDocEditPath(path: string): ParsedDocPath {
  // Remove leading slash if present
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const segments = normalizedPath.split("/");
  const filename = segments.pop() || "";

  return {
    folderPath: segments,
    filename,
    displayName: normalizedPath,
  };
}

// =============================================================================
// DOCUMENT RESOLUTION
// =============================================================================

/**
 * Find document by doc_edit path in tree store data.
 *
 * Walks the folder hierarchy to find the target folder, then finds
 * the document by filename within that folder.
 *
 * @returns Document if found, null otherwise
 */
export function findDocumentByPath(
  path: string,
  documents: Document[],
  folders: Folder[],
): Document | null {
  const parsed = parseDocEditPath(path);

  // Build folder ID chain from path
  let currentFolderId: string | null = null;

  for (const folderName of parsed.folderPath) {
    const folder = folders.find(
      (f) => f.name === folderName && f.parentId === currentFolderId,
    );
    if (!folder) {
      // Folder not found in path - document doesn't exist
      return null;
    }
    currentFolderId = folder.id;
  }

  // Find document in target folder by filename
  // If no extension provided, try with .md (matching backend behavior)
  let searchFilename = parsed.filename;
  if (!searchFilename.includes(".")) {
    searchFilename = `${searchFilename}.md`;
  }

  return (
    documents.find(
      (d) => d.filename === searchFilename && d.folderId === currentFolderId,
    ) || null
  );
}

// =============================================================================
// FOLDER RESOLUTION
// =============================================================================

/**
 * Find folder by path in tree store data.
 *
 * Walks the folder hierarchy to find the target folder.
 *
 * @param path - Unix-style folder path (e.g., "/Chapters" or "/Chapters/Part1")
 * @returns Folder if found, null if path is root ("/"), undefined if not found
 *
 * @example
 * findFolderByPath("/Chapters", folders)
 * // => { id: "abc", name: "Chapters", ... }
 *
 * findFolderByPath("/", folders)
 * // => null (root folder)
 */
export function findFolderByPath(
  path: string,
  folders: Folder[],
): Folder | null | undefined {
  // Normalize path
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;

  // Root folder case
  if (!normalizedPath || normalizedPath === "") {
    return null; // null means "root" (no folder ID)
  }

  const segments = normalizedPath.split("/").filter(Boolean);

  // Walk folder hierarchy
  let currentFolderId: string | null = null;
  let currentFolder: Folder | undefined;

  for (const folderName of segments) {
    currentFolder = folders.find(
      (f) => f.name === folderName && f.parentId === currentFolderId,
    );
    if (!currentFolder) {
      // Folder not found
      return undefined;
    }
    currentFolderId = currentFolder.id;
  }

  return currentFolder ?? null;
}

// =============================================================================
// PATH BUILDING
// =============================================================================

/**
 * Build document path for navigation.
 *
 * Document paths already contain the full path with extension,
 * so we just return the path directly.
 *
 * @example
 * // Document with path "Characters/Hero.md" in folder "Characters"
 * buildDocumentPath(document)
 * // => "Characters/Hero.md"
 */
export function buildDocumentPath(document: Document): string {
  // Path already contains full path with extension (e.g., "Chapters/README.md")
  return document.path;
}
