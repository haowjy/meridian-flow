import type { Extension } from '@codemirror/state'
import { copyHandler } from './copy'
import { pasteHandler } from './paste'

export { detectContentType, looksLikeMarkdown, looksLikeCode, looksLikeRichEditor } from './detection'
export type { ContentType } from './detection'
export { htmlToMarkdown, markdownToHtml } from './conversion'

/**
 * Clipboard extension bundle.
 *
 * Provides smart copy/paste handling:
 * - Copy: Exports both markdown (plain) and HTML (rich)
 * - Paste: Converts rich text to markdown, preserves plain/markdown
 */
export function clipboard(): Extension {
  return [copyHandler, pasteHandler]
}
