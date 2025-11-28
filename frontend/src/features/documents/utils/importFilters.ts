/**
 * Import filtering utilities for excluding system/hidden files.
 *
 * Single Responsibility: This module only handles filtering logic.
 * Open/Closed: Add new patterns to DEFAULT_IGNORE_PATTERNS without modifying functions.
 */

/** Pattern definition for ignored files/directories */
export interface IgnorePattern {
  /** Pattern to match (exact name or prefix) */
  pattern: string
  /** Type of match: 'directory' matches path segments, 'file' matches filename, 'prefix' matches filename start */
  type: 'directory' | 'file' | 'prefix'
  /** Human-readable reason for UI display */
  reason: string
}

/**
 * Default patterns to filter during import.
 * Extend this array to add new patterns without modifying filter logic.
 */
export const DEFAULT_IGNORE_PATTERNS: IgnorePattern[] = [
  // Version control
  { pattern: '.git', type: 'directory', reason: 'Git version control' },
  { pattern: '.svn', type: 'directory', reason: 'SVN version control' },
  { pattern: '.hg', type: 'directory', reason: 'Mercurial version control' },

  // macOS
  { pattern: '__MACOSX', type: 'directory', reason: 'macOS archive artifact' },
  { pattern: '.DS_Store', type: 'file', reason: 'macOS folder metadata' },
  { pattern: '.AppleDouble', type: 'directory', reason: 'macOS resource forks' },

  // Windows
  { pattern: 'Thumbs.db', type: 'file', reason: 'Windows thumbnail cache' },
  { pattern: 'desktop.ini', type: 'file', reason: 'Windows folder config' },

  // Dependencies/build
  { pattern: 'node_modules', type: 'directory', reason: 'Node.js dependencies' },
  { pattern: '.venv', type: 'directory', reason: 'Python virtual environment' },
  { pattern: 'venv', type: 'directory', reason: 'Python virtual environment' },
  { pattern: '__pycache__', type: 'directory', reason: 'Python bytecode cache' },

  // IDE/editor
  { pattern: '.vscode', type: 'directory', reason: 'VS Code settings' },
  { pattern: '.idea', type: 'directory', reason: 'JetBrains IDE settings' },

  // Environment (security risk)
  { pattern: '.env', type: 'prefix', reason: 'Environment variables (security)' },
]

/**
 * Check if a file path matches any ignore pattern.
 *
 * @param path - File path (e.g., "folder/.git/config" or ".DS_Store")
 * @param patterns - Patterns to check against (defaults to DEFAULT_IGNORE_PATTERNS)
 * @returns true if the file should be ignored
 */
export function shouldIgnoreFile(
  path: string,
  patterns: IgnorePattern[] = DEFAULT_IGNORE_PATTERNS
): boolean {
  const segments = path.split('/')
  const filename = segments[segments.length - 1] ?? ''

  for (const { pattern, type } of patterns) {
    switch (type) {
      case 'directory':
        // Check if any path segment matches the directory pattern
        if (segments.some((seg) => seg === pattern)) {
          return true
        }
        break

      case 'file':
        // Check if the filename exactly matches
        if (filename === pattern) {
          return true
        }
        break

      case 'prefix':
        // Check if the filename starts with the pattern
        if (filename.startsWith(pattern)) {
          return true
        }
        break
    }
  }

  return false
}

/**
 * Get the human-readable reason why a file is ignored.
 *
 * @param path - File path to check
 * @param patterns - Patterns to check against
 * @returns Reason string if ignored, null otherwise
 */
export function getIgnoreReason(
  path: string,
  patterns: IgnorePattern[] = DEFAULT_IGNORE_PATTERNS
): string | null {
  const segments = path.split('/')
  const filename = segments[segments.length - 1] ?? ''

  for (const { pattern, type, reason } of patterns) {
    switch (type) {
      case 'directory':
        if (segments.some((seg) => seg === pattern)) {
          return reason
        }
        break

      case 'file':
        if (filename === pattern) {
          return reason
        }
        break

      case 'prefix':
        if (filename.startsWith(pattern)) {
          return reason
        }
        break
    }
  }

  return null
}

/**
 * Get the root ignored path segment for deduplication.
 *
 * For a path like "project/.git/objects/abc123", returns "project/.git"
 * so we only show the ignored folder once, not every nested file.
 *
 * @param path - File path to check
 * @param patterns - Patterns to check against
 * @returns The path up to and including the first ignored segment, or null if not ignored
 */
export function getIgnoredRoot(
  path: string,
  patterns: IgnorePattern[] = DEFAULT_IGNORE_PATTERNS
): string | null {
  const segments = path.split('/')
  const filename = segments[segments.length - 1] ?? ''

  // Check directory patterns - return path up to the ignored directory
  for (const { pattern, type } of patterns) {
    if (type === 'directory') {
      const matchIndex = segments.findIndex((seg) => seg === pattern)
      if (matchIndex !== -1) {
        // Return path including the matched directory
        return segments.slice(0, matchIndex + 1).join('/')
      }
    }
  }

  // For file matches, return just the filename (or full path if nested)
  for (const { pattern, type } of patterns) {
    if (type === 'file' && filename === pattern) {
      return path
    }
    if (type === 'prefix' && filename.startsWith(pattern)) {
      return path
    }
  }

  return null
}
