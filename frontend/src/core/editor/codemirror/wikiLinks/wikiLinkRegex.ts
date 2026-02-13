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
  /(?<!\[)@?\[\[([^|\]\r\n]+?)(?:[^\S\r\n]*\|[^\S\r\n]*([^\]\r\n]+?))?\]\]/;

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
  /** Whether the raw path ended with `/` (folder intent, e.g. `[[folder/]]`) */
  endsWithSlash: boolean;
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
    const rawPath = match[1]!.trim().replace(ALL_MARKER_REGEX, "");
    // Detect folder intent (trailing slash, e.g. `[[folder/]]`) before stripping
    const endsWithSlash = rawPath.endsWith("/");
    // Normalize: strip trailing slashes so "folder/" resolves the same as "folder"
    const path = rawPath.replace(/\/+$/, "");
    // Skip empty paths (e.g. `[[ | ]]` or `[[/]]`) — no valid target to link to.
    // Without this, empty paths produce inverted display ranges and blank pills.
    if (path.length === 0) continue;
    const rawDisplay = match[2]?.replace(ALL_MARKER_REGEX, "");
    const normalizedDisplay = rawDisplay?.trim() ?? "";
    const hasDisplayAlias = normalizedDisplay.length > 0;
    const displayName = hasDisplayAlias
      ? normalizedDisplay
      : pathToDisplayName(path);

    const matchFrom = offset + match.index;
    const matchTo = matchFrom + match[0].length;
    const fullMatch = match[0];
    const bracketStart = fullMatch.indexOf("[[");
    const contentStart = bracketStart + 2;
    const contentEnd = fullMatch.length - 2;
    const pipeIdx = fullMatch.indexOf("|");
    const hasPipe = pipeIdx >= 0;

    // Compute displayFrom/displayTo: the visible text range within the match.
    // For `[[path | display]]` — the display name after the pipe.
    // For `[[path]]` — the path itself.
    // For `[[path | ]]` (whitespace-only alias) — fall back to path text.
    let displayFrom: number;
    let displayTo: number;

    if (hasPipe && hasDisplayAlias) {
      // Pipe variant: find display name within the full match string
      // Find first non-space after pipe
      const afterPipe = fullMatch.slice(pipeIdx + 1);
      const trimStart = afterPipe.length - afterPipe.trimStart().length;
      // Find last non-space before ]]
      const trimEnd =
        afterPipe.slice(0, -2).length - afterPipe.slice(0, -2).trimEnd().length;
      displayFrom = matchFrom + pipeIdx + 1 + trimStart;
      displayTo = matchTo - 2 - trimEnd;
    } else {
      // No-pipe variant (or whitespace-only alias): visible text is the path.
      const pathStr = hasPipe
        ? fullMatch.slice(contentStart, pipeIdx)
        : fullMatch.slice(contentStart, contentEnd);
      const trimStart = pathStr.length - pathStr.trimStart().length;
      const trimEnd = pathStr.length - pathStr.trimEnd().length;
      displayFrom = matchFrom + contentStart + trimStart;
      displayTo = hasPipe
        ? matchFrom + pipeIdx - trimEnd
        : matchFrom + contentEnd - trimEnd;
    }

    results.push({
      path,
      displayName,
      from: matchFrom,
      to: matchTo,
      displayFrom,
      displayTo,
      endsWithSlash,
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
