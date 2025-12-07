import { Decoration } from '@codemirror/view'
import type { Range } from '@codemirror/state'

/**
 * CSS classes used for live preview decorations.
 * These should be defined in globals.css or a dedicated stylesheet.
 */
export const CLASSES = {
  // Hide syntax markers
  hiddenMark: 'cm-md-hidden',

  // Headings
  heading1: 'cm-md-heading1',
  heading2: 'cm-md-heading2',
  heading3: 'cm-md-heading3',
  heading4: 'cm-md-heading4',
  heading5: 'cm-md-heading5',
  heading6: 'cm-md-heading6',

  // Emphasis
  bold: 'cm-md-bold',
  italic: 'cm-md-italic',
  boldItalic: 'cm-md-bold-italic',
  strikethrough: 'cm-md-strikethrough',

  // Code
  inlineCode: 'cm-md-inline-code',
  codeBlock: 'cm-md-code-block',

  // Links
  link: 'cm-md-link',
  linkUrl: 'cm-md-link-url',

  // Lists
  listMarker: 'cm-md-list-marker',
  checkbox: 'cm-md-checkbox',
  checkboxChecked: 'cm-md-checkbox-checked',

  // Other
  blockquote: 'cm-md-blockquote',
  hr: 'cm-md-hr',
} as const

/**
 * Create a mark decoration that hides text.
 * Used for hiding syntax markers like **, *, etc.
 */
export function hideDecoration(from: number, to: number): Range<Decoration> {
  return Decoration.mark({
    class: CLASSES.hiddenMark,
  }).range(from, to)
}

/**
 * Create a mark decoration with the given class.
 */
export function markDecoration(
  from: number,
  to: number,
  className: string
): Range<Decoration> {
  return Decoration.mark({
    class: className,
  }).range(from, to)
}

/**
 * Create a line decoration with the given class.
 */
export function lineDecoration(
  pos: number,
  className: string
): Range<Decoration> {
  return Decoration.line({
    class: className,
  }).range(pos)
}
