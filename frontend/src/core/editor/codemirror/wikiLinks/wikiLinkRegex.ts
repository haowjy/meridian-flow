/**
 * Wiki-Link Regex & Parser
 *
 * Matches `@[[path/to/file.md | Display Name]]` or `@[[path/to/file.md]]`
 * in document editor content. Used by the ViewPlugin to find and decorate
 * wiki-links, and by insertion helpers to validate syntax.
 */

// =============================================================================
// PATTERN
// =============================================================================

/**
 * Wiki-link syntax pattern (without flags).
 * Groups: [1] path, [2] display name (optional, after pipe)
 *
 * Use `findWikiLinks()` for iteration — it creates its own `g`-flagged copy.
 */
export const WIKI_LINK_PATTERN = /@\[\[([^|\]]+?)(?:\s*\|\s*([^\]]+?))?\]\]/;

// =============================================================================
// TYPES
// =============================================================================

export interface WikiLinkMatch {
  /** Document path, e.g. "book-one/chapter-5.md" */
  path: string;
  /** Display name, e.g. "Chapter 5" (or derived from path if no pipe) */
  displayName: string;
  /** Start position of `@[[` in the document */
  from: number;
  /** End position (after `]]`) in the document */
  to: number;
}

// =============================================================================
// PARSER
// =============================================================================

/**
 * Find all wiki-links in a text string.
 *
 * @param text - The text to search
 * @param offset - Position offset to add to match indices (e.g., line start)
 */
export function findWikiLinks(text: string, offset: number): WikiLinkMatch[] {
  const results: WikiLinkMatch[] = [];
  const regex = new RegExp(WIKI_LINK_PATTERN.source, "g");

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const path = match[1]!.trim();
    const displayName = match[2]?.trim() || pathToDisplayName(path);
    results.push({
      path,
      displayName,
      from: offset + match.index,
      to: offset + match.index + match[0].length,
    });
  }

  return results;
}

/**
 * Derive a display name from a file path.
 * Strips directory prefix and extension.
 *
 * "book-one/chapter-5.md" → "chapter-5"
 * "notes.md" → "notes"
 */
export function pathToDisplayName(path: string): string {
  const filename = path.split("/").pop() ?? path;
  // Strip common extensions
  return filename.replace(/\.(md|txt|doc|docx)$/i, "");
}
