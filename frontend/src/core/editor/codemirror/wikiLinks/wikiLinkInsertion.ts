/**
 * Wiki-Link Insertion Helper
 *
 * Inserts a wiki-link `@[[path | displayName]]` into the editor,
 * replacing the `@query` text that triggered the mention popover.
 */

import type { EditorView } from "@codemirror/view";

/**
 * Insert a wiki-link at the position of an @-mention trigger.
 *
 * Replaces the text from `atPos` (the @ character) through `cursorPos`
 * (end of the typed query) with the formatted wiki-link syntax,
 * followed by a trailing space.
 *
 * @param view - The CM6 EditorView
 * @param atPos - Position of the @ character in the document
 * @param cursorPos - Current cursor position (end of @query)
 * @param path - Document path, e.g. "book-one/chapter-5.md"
 * @param displayName - Display name, e.g. "Chapter 5"
 */
export function insertWikiLink(
  view: EditorView,
  atPos: number,
  cursorPos: number,
  path: string,
  displayName: string,
): void {
  const wikiLink = `@[[${path} | ${displayName}]]`;
  view.dispatch({
    changes: { from: atPos, to: cursorPos, insert: wikiLink + " " },
    selection: { anchor: atPos + wikiLink.length + 1 },
  });
}
