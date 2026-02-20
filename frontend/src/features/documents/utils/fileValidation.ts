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

/**
 * Formats file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${units[i]}`;
}
