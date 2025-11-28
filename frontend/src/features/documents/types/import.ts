/**
 * Types for document import with folder support.
 *
 * Import flow:
 * 1. User selects files/folder/zip
 * 2. processSelection() categorizes into ImportSelection
 * 3. Preview shows categorized items
 * 4. buildUploadFiles() prepares final File[] for API
 */

/** Filtered system file entry for display */
export interface FilteredSystemFile {
  /** Display name (e.g., ".git" not ".git/objects/abc") */
  name: string
  /** Human-readable reason for filtering */
  reason: string
}

/** Categorized import items after selection */
export interface ImportSelection {
  /** Individual .md/.txt/.html files - sent as multipart to target root */
  individualFiles: File[]

  /** Files from folder selection - will be zipped to preserve structure */
  folderFiles: File[]

  /** Root folder name if folder selected (extracted from webkitRelativePath) */
  folderName: string | null

  /** .zip files - sent as-is */
  zipFiles: File[]

  /** Unsupported file names for warning display */
  skippedFiles: string[]

  /** System files that were filtered out (deduplicated by root) */
  filteredSystemFiles: FilteredSystemFile[]
}

/** Item for preview display */
export interface PreviewItem {
  /** Display name */
  name: string

  /** File size in bytes */
  size: number

  /** Type for display grouping */
  type: 'file' | 'folder' | 'zip'

  /** Relative path within folder (for folder items) */
  relativePath?: string
}

/** Folder tree node for preview display */
export interface FolderTreeNode {
  name: string
  type: 'file' | 'folder'
  children?: FolderTreeNode[]
  size?: number
}
