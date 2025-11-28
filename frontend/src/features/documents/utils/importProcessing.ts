/**
 * Import processing utilities for folder upload support.
 *
 * Handles categorization, zip creation, and tree building for import preview.
 */

import JSZip from 'jszip'
import type { ImportSelection, FolderTreeNode } from '../types/import'
import { shouldIgnoreFile, getIgnoredRoot, getIgnoreReason } from './importFilters'

// Content extensions (excluding .zip which is handled separately)
const CONTENT_EXTENSIONS = ['.md', '.txt', '.html'] as const

/**
 * Check if file is a content file (not a zip)
 */
function isContentFile(filename: string): boolean {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'))
  return CONTENT_EXTENSIONS.includes(ext as typeof CONTENT_EXTENSIONS[number])
}

/**
 * Check if file is a zip archive
 */
function isZipFile(filename: string): boolean {
  return filename.toLowerCase().endsWith('.zip')
}

/**
 * Get the root folder name from a webkitRelativePath.
 * e.g., "my-folder/chapter-1/intro.md" -> "my-folder"
 */
function getRootFolderName(relativePath: string): string | null {
  const parts = relativePath.split('/')
  return parts.length > 1 ? parts[0] ?? null : null
}

/**
 * Check if a File came from folder selection (has webkitRelativePath with folder structure)
 */
function isFromFolderSelection(file: File): boolean {
  // webkitRelativePath is set when using webkitdirectory
  // It will be "folder/file.md" for folder selections
  // It will be empty or just the filename for individual file selections
  const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath
  return !!relativePath && relativePath.includes('/')
}

/**
 * Get the webkitRelativePath from a file (type-safe)
 */
function getRelativePath(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
}

/**
 * Process a FileList from selection into categorized ImportSelection.
 *
 * Categorization rules:
 * - Files with webkitRelativePath containing "/" -> folder files (will be zipped)
 * - .zip files -> sent as-is
 * - .md/.txt/.html without folder path -> individual files
 * - Everything else -> skipped (unsupported)
 */
export function processSelection(files: FileList): ImportSelection {
  const result: ImportSelection = {
    individualFiles: [],
    folderFiles: [],
    folderName: null,
    zipFiles: [],
    skippedFiles: [],
    filteredSystemFiles: [],
  }

  // Track ignored roots for deduplication (show ".git" once, not every nested file)
  const seenIgnoredRoots = new Set<string>()

  for (const file of Array.from(files)) {
    const relativePath = getRelativePath(file)
    const isFromFolder = isFromFolderSelection(file)

    // Check for system/hidden files to filter
    if (shouldIgnoreFile(relativePath)) {
      const root = getIgnoredRoot(relativePath)
      if (root && !seenIgnoredRoots.has(root)) {
        seenIgnoredRoots.add(root)
        const reason = getIgnoreReason(relativePath)
        if (reason) {
          result.filteredSystemFiles.push({ name: root, reason })
        }
      }
      continue // Skip this file
    }

    if (isFromFolder) {
      // File came from folder selection
      if (isContentFile(file.name)) {
        result.folderFiles.push(file)
        // Extract folder name from first file
        if (!result.folderName) {
          result.folderName = getRootFolderName(relativePath)
        }
      } else if (!isZipFile(file.name)) {
        // Skip unsupported files in folder (don't include .zip in folder contents)
        result.skippedFiles.push(relativePath)
      }
      // Note: .zip files inside folders are skipped (unusual case)
    } else {
      // Individual file selection
      if (isZipFile(file.name)) {
        result.zipFiles.push(file)
      } else if (isContentFile(file.name)) {
        result.individualFiles.push(file)
      } else {
        result.skippedFiles.push(file.name)
      }
    }
  }

  return result
}

/**
 * Create a zip file from folder files, preserving relative paths.
 *
 * @param files - Files from folder selection (with webkitRelativePath)
 * @param folderName - Root folder name for the zip
 * @returns A File object containing the zip
 */
export async function createFolderZip(files: File[], folderName: string): Promise<File> {
  const zip = new JSZip()

  for (const file of files) {
    const relativePath = getRelativePath(file)
    // Add file to zip with its relative path
    zip.file(relativePath, file)
  }

  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }, // Good balance of speed/compression for text
  })

  return new File([blob], `${folderName}.zip`, { type: 'application/zip' })
}

/**
 * Build final upload files from ImportSelection.
 *
 * - Individual files: passed through
 * - Folder files: zipped together
 * - Zip files: passed through
 */
export async function buildUploadFiles(selection: ImportSelection): Promise<File[]> {
  const result: File[] = []

  // Add individual files as-is
  result.push(...selection.individualFiles)

  // Add zip files as-is
  result.push(...selection.zipFiles)

  // Create zip from folder files if any
  if (selection.folderFiles.length > 0 && selection.folderName) {
    const folderZip = await createFolderZip(selection.folderFiles, selection.folderName)
    result.push(folderZip)
  }

  return result
}

/**
 * Build a tree structure from folder files for preview display.
 */
export function buildFolderTree(files: File[]): FolderTreeNode | null {
  if (files.length === 0) return null

  // Get the root folder name
  const firstFile = files[0]
  if (!firstFile) return null

  const firstPath = getRelativePath(firstFile)
  const rootName = getRootFolderName(firstPath)
  if (!rootName) return null

  const root: FolderTreeNode = {
    name: rootName,
    type: 'folder',
    children: [],
  }

  // Track folders we've created
  const folderMap = new Map<string, FolderTreeNode>()
  folderMap.set(rootName, root)

  for (const file of files) {
    const relativePath = getRelativePath(file)
    const parts = relativePath.split('/')
    if (parts.length < 2) continue // Skip files without folder structure

    // Navigate/create folder structure
    let currentPath = parts[0]!
    let currentNode = root

    for (let i = 1; i < parts.length - 1; i++) {
      const partName = parts[i]!
      currentPath = `${currentPath}/${partName}`

      let folder = folderMap.get(currentPath)
      if (!folder) {
        folder = {
          name: partName,
          type: 'folder',
          children: [],
        }
        folderMap.set(currentPath, folder)
        currentNode.children = currentNode.children || []
        currentNode.children.push(folder)
      }
      currentNode = folder
    }

    // Add file to current folder
    const fileName = parts[parts.length - 1]!
    currentNode.children = currentNode.children || []
    currentNode.children.push({
      name: fileName,
      type: 'file',
      size: file.size,
    })
  }

  // Sort children: folders first, then files, alphabetically
  const sortChildren = (node: FolderTreeNode) => {
    if (node.children) {
      node.children.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'folder' ? -1 : 1
        }
        return a.name.localeCompare(b.name)
      })
      node.children.forEach(sortChildren)
    }
  }
  sortChildren(root)

  return root
}

/**
 * Check if webkitdirectory is supported in the current browser.
 */
export function isFolderUploadSupported(): boolean {
  if (typeof window === 'undefined') return false
  return 'webkitdirectory' in HTMLInputElement.prototype
}

/**
 * Get total size of files in selection (for display).
 */
export function getSelectionSize(selection: ImportSelection): number {
  let total = 0
  total += selection.individualFiles.reduce((sum, f) => sum + f.size, 0)
  total += selection.folderFiles.reduce((sum, f) => sum + f.size, 0)
  total += selection.zipFiles.reduce((sum, f) => sum + f.size, 0)
  return total
}

/**
 * Get count of valid files to import.
 */
export function getValidFileCount(selection: ImportSelection): number {
  return (
    selection.individualFiles.length +
    selection.folderFiles.length +
    selection.zipFiles.length
  )
}
