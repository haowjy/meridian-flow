/**
 * Link Target Classification
 *
 * Determines whether a link target is internal (resolved path), external (URL or unresolved),
 * anchor-only (#fragment), or unsupported (absolute paths, query strings).
 *
 * Key behavior: If a relative path doesn't resolve to a document/folder in the tree,
 * it's treated as an external URL (e.g., "google.com" -> external, not broken internal).
 */

import type { LinkClassification } from "./types";
import { resolveReference } from "./resolve";

// =============================================================================
// PATTERNS
// =============================================================================

/**
 * Protocols that indicate external URLs.
 * Order matters for performance — most common first.
 */
const EXTERNAL_PROTOCOLS = [
  "https://",
  "http://",
  "mailto:",
  "tel:",
  "ftp://",
  "file://",
];

// =============================================================================
// CLASSIFY
// =============================================================================

/**
 * Classify a link target to determine how it should be handled.
 *
 * Classification rules:
 * | Pattern            | Type        | Examples                                |
 * |--------------------|-------------|-----------------------------------------|
 * | Protocol URL       | external    | https://, http://, mailto:, ftp://      |
 * | Fragment only      | anchor      | #heading, #section                      |
 * | Query string       | unsupported | path.md?query=value                     |
 * | Absolute path      | unsupported | /path/to/file.md                        |
 * | Resolved path      | internal    | existing-doc.md, ./doc.md (if in tree)  |
 * | Unresolved path    | external    | google.com, nonexistent.md (not in tree)|
 *
 * Key insight: If a path doesn't resolve to an existing document/folder,
 * treat it as an external URL rather than a "broken" internal link.
 *
 * @param target - The raw link target (URL or path)
 * @returns Classification with type, normalized path, and optional anchor/resolved
 */
export function classifyLinkTarget(target: string): LinkClassification {
  // Normalize whitespace
  const trimmed = target.trim();

  if (!trimmed) {
    return { type: "unsupported", normalizedPath: "" };
  }

  // 1. External: protocol URLs
  const lowerTarget = trimmed.toLowerCase();
  for (const protocol of EXTERNAL_PROTOCOLS) {
    if (lowerTarget.startsWith(protocol)) {
      return { type: "external", normalizedPath: trimmed };
    }
  }

  // 2. Anchor-only: starts with #
  if (trimmed.startsWith("#")) {
    return { type: "anchor", normalizedPath: "", anchor: trimmed };
  }

  // 3. Unsupported: absolute paths (Unix or Windows)
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return { type: "unsupported", normalizedPath: trimmed };
  }

  // 4. Unsupported: query strings
  if (trimmed.includes("?")) {
    return { type: "unsupported", normalizedPath: trimmed };
  }

  // 5. Handle anchor in path
  const anchorIndex = trimmed.indexOf("#");
  const pathPart = anchorIndex !== -1 ? trimmed.slice(0, anchorIndex) : trimmed;
  const anchor = anchorIndex !== -1 ? trimmed.slice(anchorIndex) : undefined;
  const normalizedPath = normalizePath(pathPart);

  // 6. Resolution-based: exists in tree = internal, otherwise external
  const resolved = resolveReference(normalizedPath);
  if (resolved) {
    return { type: "internal", normalizedPath, anchor, resolved };
  }

  // Doesn't exist — treat as external URL (e.g., "google.com")
  return { type: "external", normalizedPath: trimmed };
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Normalize a relative path by removing leading "./" prefix.
 * Preserves "../" for parent directory references.
 */
function normalizePath(path: string): string {
  if (path.startsWith("./")) {
    return path.slice(2);
  }
  return path;
}

/**
 * Quick check if a target is external (for performance-critical paths).
 */
export function isExternalLink(target: string): boolean {
  const lower = target.toLowerCase().trim();
  return EXTERNAL_PROTOCOLS.some((p) => lower.startsWith(p));
}
