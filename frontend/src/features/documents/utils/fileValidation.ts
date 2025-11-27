/**
 * File validation utilities for document import.
 *
 * IMPORTANT: These limits must stay in sync with backend:
 * - Backend handler: backend/internal/handler/import.go (100MB multipart limit)
 * - Backend converters: backend/internal/service/docsystem/converter/
 *
 * If you add a new file type here, you must also:
 * 1. Add a converter in backend/internal/service/docsystem/converter/
 * 2. Register it in converter/registry.go
 */

// Supported file extensions for import (must match backend converters)
const SUPPORTED_EXTENSIONS = ['.zip', '.md', '.txt', '.html'] as const

// Maximum file size: 100MB (must match backend ParseMultipartForm limit)
const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100MB in bytes

// Maximum total size for all files: 100MB
const MAX_TOTAL_SIZE = 100 * 1024 * 1024 // 100MB in bytes

export type ValidationError = {
  file: string
  error: string
}

/**
 * Checks if a file extension is supported
 */
export function isSupportedExtension(filename: string): boolean {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'))
  return SUPPORTED_EXTENSIONS.includes(ext as typeof SUPPORTED_EXTENSIONS[number])
}

/**
 * Validates a single file for import
 * @returns ValidationError if invalid, null if valid
 */
export function validateFile(file: File): ValidationError | null {
  // Check file extension
  if (!isSupportedExtension(file.name)) {
    const supportedList = SUPPORTED_EXTENSIONS.join(', ')
    return {
      file: file.name,
      error: `Unsupported file type. Supported types: ${supportedList}`,
    }
  }

  // Check file size
  if (file.size > MAX_FILE_SIZE) {
    const sizeMB = (MAX_FILE_SIZE / 1024 / 1024).toFixed(0)
    return {
      file: file.name,
      error: `File size exceeds ${sizeMB}MB limit`,
    }
  }

  return null
}

/**
 * Validates multiple files for import
 * @returns Array of validation errors (empty if all files are valid)
 */
export function validateFiles(files: File[]): ValidationError[] {
  const errors: ValidationError[] = []

  // Validate each file
  for (const file of files) {
    const error = validateFile(file)
    if (error) {
      errors.push(error)
    }
  }

  // Check total size
  const totalSize = files.reduce((sum, file) => sum + file.size, 0)
  if (totalSize > MAX_TOTAL_SIZE) {
    const sizeMB = (MAX_TOTAL_SIZE / 1024 / 1024).toFixed(0)
    errors.push({
      file: 'Total',
      error: `Total file size exceeds ${sizeMB}MB limit`,
    })
  }

  return errors
}

/**
 * Formats file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB']
  const k = 1024
  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${units[i]}`
}

/**
 * Gets a human-readable list of supported file types
 */
export function getSupportedExtensions(): string[] {
  return [...SUPPORTED_EXTENSIONS]
}
