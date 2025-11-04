import type { Folder } from '@/features/folders/types/folder'

export interface BreadcrumbSegment {
  id: string
  name: string
  isTruncated?: boolean
}

/**
 * Builds breadcrumb path from a folder ID up to the root.
 * Handles truncation with "..." when path exceeds maxSegments.
 *
 * @param folderId - Starting folder ID (or null for root-level documents)
 * @param folders - Flat array of all folders
 * @param maxSegments - Maximum segments before truncating (default: 3)
 * @returns Array of breadcrumb segments from root to current folder
 *
 * @example
 * // Path: Root > Chapters > Arc 1 > Chapter 1
 * buildBreadcrumbs('chapter1-id', folders, 3)
 * // Returns: [{ name: 'Chapters' }, { name: '...', isTruncated: true }, { name: 'Chapter 1' }]
 */
export function buildBreadcrumbs(
  folderId: string | null,
  folders: Folder[],
  maxSegments: number = 3
): BreadcrumbSegment[] {
  if (!folderId) {
    return []
  }

  // Build path from current folder to root
  const path: BreadcrumbSegment[] = []
  let currentId: string | null = folderId

  while (currentId) {
    const folder = folders.find((f) => f.id === currentId)
    if (!folder) break

    path.unshift({
      id: folder.id,
      name: folder.name,
    })

    currentId = folder.parentId
  }

  // Truncate if path is too long
  if (path.length > maxSegments && path.length > 0) {
    const firstSegment = path[0]!
    const lastSegments = path.slice(-(maxSegments - 1))

    return [
      firstSegment,
      { id: 'truncated', name: '...', isTruncated: true },
      ...lastSegments,
    ]
  }

  return path
}

/**
 * Formats breadcrumb segments as a display string.
 *
 * @param segments - Breadcrumb segments
 * @param separator - Separator string (default: ' / ')
 * @returns Formatted breadcrumb string
 *
 * @example
 * formatBreadcrumbs([{ name: 'Chapters' }, { name: 'Chapter 1' }])
 * // Returns: "Chapters / Chapter 1"
 */
export function formatBreadcrumbs(
  segments: BreadcrumbSegment[],
  separator: string = ' / '
): string {
  return segments.map((s) => s.name).join(separator)
}
