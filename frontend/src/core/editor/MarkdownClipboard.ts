import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { DOMSerializer } from '@tiptap/pm/model'
import type {} from '@tiptap/markdown' // Import to trigger Editor type augmentation
import { makeLogger } from '@/core/lib/logger'

const logger = makeLogger('markdown-clipboard')

/**
 * MarkdownClipboard Extension
 *
 * Provides smart markdown copy/paste behavior:
 * - Copy: Adds markdown format alongside HTML to clipboard
 * - Paste: Smart detection of markdown vs rich HTML with fallback
 */
export const MarkdownClipboard = Extension.create({
  name: 'markdownClipboard',

  addProseMirrorPlugins() {
    const editor = this.editor

    return [
      new Plugin({
        key: new PluginKey('markdownClipboard'),
        props: {
          // Handle copy events - add markdown to clipboard
          handleDOMEvents: {
            copy: (view, event) => {
              logger.debug('Copy event triggered')
              const { state } = view
              const { selection } = state

              // Only handle if there's a selection
              if (selection.empty) {
                logger.debug('Selection is empty, skipping')
                return false
              }

              logger.debug('Has clipboardData:', !!event.clipboardData)
              logger.debug('Has editor.markdown:', !!editor.markdown)

              // Manually handle both text/plain (markdown) and text/html (formatted)
              if (event.clipboardData && editor.markdown) {
                // Get the selected content
                const slice = selection.content()
                const tempDoc = state.schema.topNodeType.createAndFill(undefined, slice.content)
                logger.debug('Created tempDoc:', !!tempDoc)

                if (tempDoc) {
                  // 1. Serialize to markdown for text/plain
                  const selectedMarkdown = editor.markdown.serialize(tempDoc.toJSON())
                  logger.debug('Serialized markdown:', selectedMarkdown.substring(0, 200))

                  // 2. Serialize to HTML for text/html
                  const div = document.createElement('div')
                  DOMSerializer.fromSchema(state.schema).serializeFragment(
                    slice.content,
                    {},
                    div
                  )
                  const html = div.innerHTML
                  logger.debug('Serialized HTML:', html.substring(0, 200))

                  // 3. Set both clipboard data types
                  event.clipboardData.setData('text/plain', selectedMarkdown)
                  event.clipboardData.setData('text/html', html)
                  logger.debug('Set both text/plain (markdown) and text/html')

                  // 4. Prevent default to stop browser from overwriting our clipboard data
                  event.preventDefault()
                  return true // We handled the copy
                }
              }

              logger.debug('Fallback - using default copy')
              return false
            },
          },

          // Handle paste events - smart markdown detection
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          handlePaste: (view, event, _slice) => {
            const text = event.clipboardData?.getData('text/plain')
            const html = event.clipboardData?.getData('text/html')

            logger.debug('Paste event:', {
              hasText: !!text,
              hasHtml: !!html,
              textPreview: text?.substring(0, 100),
            })

            // Priority 1: Rich editors (Word, Docs, GitHub rendered) → preserve HTML
            if (html && looksLikeRichEditor(html)) {
              logger.debug('Rich editor detected, using HTML')
              return false
            }

            // Priority 2: VSCode-specific detection via metadata
            const vscodeData = event.clipboardData?.getData('vscode-editor-data')
            if (vscodeData) {
              logger.debug('VSCode data detected:', vscodeData)
              try {
                const data = JSON.parse(vscodeData)
                logger.debug('VSCode mode:', data.mode)
                // VSCode markdown file → parse as markdown
                if (data.mode === 'markdown' && text && editor.markdown) {
                  logger.debug('VSCode markdown detected, parsing')
                  const json = editor.markdown.parse(text)
                  logger.debug('Parsed markdown:', json)
                  editor.commands.insertContent(json)
                  return true
                }
                // VSCode code file → use default (preserves code block from HTML)
                if (text && looksLikeCode(text)) {
                  logger.debug('VSCode code detected, using default')
                  return false
                }
              } catch {
                logger.debug('Failed to parse VSCode data')
                // Invalid JSON, continue to pattern detection
              }
            }

            // Priority 3: Pattern detection for non-VSCode sources
            if (text) {
              // Looks like markdown → parse it
              if (looksLikeMarkdown(text) && editor.markdown) {
                logger.debug('Pattern: markdown detected, parsing')
                const json = editor.markdown.parse(text)
                editor.commands.insertContent(json)
                return true
              }
              // Looks like code → use default (HTML becomes code block if present)
              if (looksLikeCode(text)) {
                logger.debug('Pattern: code detected, using default')
                return false
              }
            }

            // Fallback to default
            logger.debug('Fallback to default')
            return false
          },
        },
      }),
    ]
  },
})

/**
 * Check if text looks like markdown
 */
function looksLikeMarkdown(text: string): boolean {
  if (!text) return false

  // Trim to avoid false positives from leading/trailing whitespace
  const trimmed = text.trim()

  // Check for common markdown patterns
  const patterns = [
    /^#{1,6}\s+/m,           // Headers: # Header
    /\*\*[^*]+\*\*/,         // Bold: **text**
    /\*[^*]+\*/,             // Italic: *text*
    /__[^_]+__/,             // Bold: __text__
    /_[^_]+_/,               // Italic: _text_
    /\[.+\]\(.+\)/,          // Links: [text](url)
    /^[-*+]\s+/m,            // Unordered lists: - item
    /^\d+\.\s+/m,            // Ordered lists: 1. item
    /^>\s+/m,                // Blockquotes: > quote
    /`[^`]+`/,               // Inline code: `code`
    /^```/m,                 // Code blocks: ```
    /^\|.+\|/m,              // Tables: | cell |
  ]

  // If at least one pattern matches, treat as markdown
  return patterns.some(pattern => pattern.test(trimmed))
}

/**
 * Check if HTML looks like it came from a rich text editor (Word, Google Docs, etc.)
 * or rendered markdown (GitHub, GitLab)
 */
function looksLikeRichEditor(html: string): boolean {
  if (!html) return false

  const richEditorMarkers = [
    // Microsoft Word
    /mso-/i,                          // MS Office tags
    /urn:schemas-microsoft-com/i,
    /class="?Mso/i,

    // Google Docs
    /docs-internal-guid/i,
    /id="docs-internal-guid/i,

    // Apple Pages
    /class="?Apple-/i,

    // GitHub rendered markdown
    /class="?markdown-body/i,         // GitHub's markdown container

    // GitLab rendered markdown
    /data-sourcepos/i,                // GitLab markdown attribute

    // Generic rich editor markers
    /<meta\s+name="?Generator"?\s+content="?(Microsoft|Google|Apple)/i,
  ]

  return richEditorMarkers.some(marker => marker.test(html))
}

/**
 * Check if text looks like code (programming syntax)
 */
function looksLikeCode(text: string): boolean {
  if (!text) return false

  const trimmed = text.trim()

  // Common programming language patterns
  const codePatterns = [
    // Keywords
    /\b(function|class|const|let|var|import|export|return|if|else|for|while)\b/,
    // Common syntax
    /[{}\[\]();]/,              // Braces, brackets, semicolons
    /=>/,                       // Arrow functions
    /\/\//,                     // Single-line comments
    /\/\*[\s\S]*?\*\//,         // Multi-line comments
    /<\/[\w]+>/,                // HTML/XML closing tags
    /^\s*(public|private|protected|static)\s+/m, // Access modifiers
  ]

  // Count how many patterns match (require multiple to reduce false positives)
  const matches = codePatterns.filter(pattern => pattern.test(trimmed)).length

  // Need at least 2 patterns to be confident it's code
  return matches >= 2
}
