import DOMPurify from "dompurify"
import TurndownService from "turndown"

/**
 * Singleton turndown instance configured for our markdown subset.
 * Configured once to avoid repeated initialization overhead.
 */
const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
  strongDelimiter: "**",
})

/**
 * DOMPurify allowed tags -- block and inline elements that map to markdown.
 * Scripts, styles, forms, and event handlers are stripped entirely.
 */
const ALLOWED_TAGS = [
  // Block elements
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "hr",
  "br",
  "div",
  // Inline elements
  "a",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "del",
  "strike",
  "sub",
  "sup",
  "img",
  "span",
]

/**
 * DOMPurify allowed attributes -- only what turndown needs.
 */
const ALLOWED_ATTR = ["href", "src", "alt", "title", "class"]

/**
 * Convert HTML to markdown via Turndown, with DOMPurify sanitization first.
 * Strips scripts, styles, event handlers, and other XSS vectors.
 */
export function htmlToMarkdown(html: string): string {
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
  })
  return turndown.turndown(clean)
}

/**
 * Block-level elements that indicate meaningful structure beyond plain text.
 */
const BLOCK_ELEMENTS = /(<p[\s>]|<h[1-6][\s>]|<ul[\s>]|<ol[\s>]|<blockquote[\s>]|<pre[\s>]|<table[\s>])/i

/**
 * Inline formatting elements that indicate rich content.
 */
const INLINE_ELEMENTS = /(<strong[\s>]|<b[\s>]|<em[\s>]|<i[\s>]|<a[\s>]|<code[\s>]|<s[\s>]|<del[\s>]|<strike[\s>])/i

/**
 * Check if HTML contains meaningful markup worth converting to markdown.
 * Returns false for trivial wrappers (just <meta> tags + text, <span>-only
 * wrappers) that some apps generate for plain text copy.
 *
 * This heuristic prevents unnecessary turndown conversion of content
 * that would produce identical output to the plain text version.
 */
export function containsMeaningfulMarkup(html: string): boolean {
  return BLOCK_ELEMENTS.test(html) || INLINE_ELEMENTS.test(html)
}
