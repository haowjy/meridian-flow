/**
 * Wiki-Link Regex & Parser
 *
 * Matches `[[path/to/file.md | Display Name]]` or `[[path/to/file.md]]`
 * in document editor content. Also matches legacy `@[[...]]` for backward
 * compatibility. Used by the ViewPlugin to find and decorate wiki-links,
 * and by insertion helpers to validate syntax.
 */

import { ALL_MARKER_REGEX } from "@/core/lib/mergedDocument";

// =============================================================================
// PATTERN
// =============================================================================

/**
 * Wiki-link syntax pattern (without flags).
 * Groups: [1] path, [2] display name (optional, after pipe)
 *
 * The `@?` makes the at-sign optional for backward compatibility.
 * Negative lookbehind `(?<!\[)` prevents matching `[[[` (triple bracket).
 *
 * Use `findWikiLinks()` for iteration — it creates its own `g`-flagged copy.
 */
export const WIKI_LINK_PATTERN =
  /(?<!\[)@?\[\[([^|\]]+?)(?:\s*\|\s*([^\]]+?))?\]\]/;

// =============================================================================
// TYPES
// =============================================================================

export interface WikiLinkMatch {
  /** Document path, e.g. "book-one/chapter-5.md" */
  path: string;
  /** Display name, e.g. "Chapter 5" (or derived from path if no pipe) */
  displayName: string;
  /** Start position of the wiki-link (`[[` or `@[[`) in the document */
  from: number;
  /** End position (after `]]`) in the document */
  to: number;
  /** Start of the visible text (display name or path) — for mark decoration */
  displayFrom: number;
  /** End of the visible text (display name or path) — for mark decoration */
  displayTo: number;
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
    // Strip PUA diff markers that may split a wiki-link when AI edits part of it
    const path = match[1]!.trim().replace(ALL_MARKER_REGEX, "");
    const displayName =
      match[2]?.trim().replace(ALL_MARKER_REGEX, "") || pathToDisplayName(path);

    const matchFrom = offset + match.index;
    const matchTo = matchFrom + match[0].length;
    const fullMatch = match[0];

    // Compute displayFrom/displayTo: the visible text range within the match.
    // For `[[path | display]]` — the display name after the pipe.
    // For `[[path]]` — the path itself.
    let displayFrom: number;
    let displayTo: number;

    if (match[2]) {
      // Pipe variant: find display name within the full match string
      const pipeIdx = fullMatch.indexOf("|");
      // Find first non-space after pipe
      const afterPipe = fullMatch.slice(pipeIdx + 1);
      const trimStart = afterPipe.length - afterPipe.trimStart().length;
      // Find last non-space before ]]
      const trimEnd =
        afterPipe.slice(0, -2).length - afterPipe.slice(0, -2).trimEnd().length;
      displayFrom = matchFrom + pipeIdx + 1 + trimStart;
      displayTo = matchTo - 2 - trimEnd;
    } else {
      // No-pipe variant: visible text is the path (between [[ and ]])
      // Account for optional @ prefix
      const bracketStart = fullMatch.indexOf("[[");
      const pathStr = fullMatch.slice(bracketStart + 2, -2);
      const trimStart = pathStr.length - pathStr.trimStart().length;
      const trimEnd = pathStr.length - pathStr.trimEnd().length;
      displayFrom = matchFrom + bracketStart + 2 + trimStart;
      displayTo = matchTo - 2 - trimEnd;
    }

    results.push({
      path,
      displayName,
      from: matchFrom,
      to: matchTo,
      displayFrom,
      displayTo,
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
