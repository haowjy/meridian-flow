/**
 * Cursor Utility Functions
 *
 * Shared helpers for checking cursor/selection proximity to syntax nodes.
 * Extracted from plugin.ts so renderers depend on this utility module
 * instead of the high-level coordinator (DIP).
 */

import type { EditorState } from "@codemirror/state";

/**
 * Markdown-aware word boundary check.
 * Treats whitespace AND inline syntax delimiters as word breaks so that
 * e.g. `[link](url)` is split into separate "words" rather than one blob.
 * This prevents cursor-near-link from expanding to include the whole link,
 * which would cause decoration toggles and scroll jumps.
 *
 * Deliberately excludes apostrophe to preserve contractions (don't, it's).
 */
const isWordBreak = (char: string) =>
  /[\s[\](){}*_~`]/.test(char);

/**
 * Get word boundaries around a position using markdown-aware delimiters
 */
export function getWordBounds(
  state: EditorState,
  pos: number,
): { from: number; to: number } {
  const line = state.doc.lineAt(pos);
  const lineText = line.text;
  const lineStart = line.from;
  const offsetInLine = pos - lineStart;

  // Handle edge case: position at start of line with a word-break char
  if (offsetInLine === 0 && lineText.length > 0) {
    const firstChar = lineText.charAt(0);
    if (isWordBreak(firstChar)) {
      return { from: pos, to: pos };
    }
  }

  // Find start of word (scan backwards for word-break chars)
  let wordStart = offsetInLine;
  while (wordStart > 0) {
    const char = lineText.charAt(wordStart - 1);
    if (isWordBreak(char)) break;
    wordStart--;
  }

  // Find end of word (scan forwards for word-break chars)
  let wordEnd = offsetInLine;
  while (wordEnd < lineText.length) {
    const char = lineText.charAt(wordEnd);
    if (isWordBreak(char)) break;
    wordEnd++;
  }

  return { from: lineStart + wordStart, to: lineStart + wordEnd };
}

/**
 * Check if cursor is in the same "word" as a formatting node
 */
export function cursorInSameWord(
  cursorWords: Array<{ from: number; to: number }>,
  nodeFrom: number,
  nodeTo: number,
): boolean {
  for (const cursorWord of cursorWords) {
    if (cursorWord.from < nodeTo && cursorWord.to > nodeFrom) {
      return true;
    }
  }
  return false;
}

/**
 * Check if selection overlaps a range
 */
export function selectionOverlapsRange(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  const { selection } = state;
  for (const range of selection.ranges) {
    if (range.from < to && range.to >= from) {
      return true;
    }
  }
  return false;
}

/**
 * Get line range for a position
 */
export function getLineRange(
  state: EditorState,
  pos: number,
): { from: number; to: number } {
  const line = state.doc.lineAt(pos);
  return { from: line.from, to: line.to };
}
