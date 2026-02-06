/**
 * Scroll margins extension for external obstructions.
 *
 * Tells CM6 about fixed elements (sticky header, floating navigator)
 * so it accounts for them when scrolling. CM6's scrollIntoView and
 * cursor movement commands use these margins to ensure content is
 * visible within the unobstructed viewport area.
 */

import { EditorView } from "@codemirror/view";

/**
 * Creates a scroll margins extension with the given top margin.
 * The top margin should match the sticky header height.
 */
export function createScrollMarginsExtension(topMargin: number) {
  return EditorView.scrollMargins.of(() => ({
    top: topMargin,
  }));
}

// Default: matches --editor-header-height (48px = 3rem)
export const scrollMarginsExtension = createScrollMarginsExtension(48);
