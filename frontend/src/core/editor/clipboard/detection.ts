/**
 * Content type detection for clipboard handling.
 *
 * SRP: This module ONLY detects content types. No conversion or insertion.
 */

export type ContentType = 'markdown' | 'code' | 'rich' | 'plain'

/**
 * Detect if text looks like markdown.
 */
export function looksLikeMarkdown(text: string): boolean {
  const markdownPatterns = [
    /^#{1,6}\s/m,           // Headers
    /\*\*[^*]+\*\*/,        // Bold
    /\*[^*]+\*/,            // Italic
    /\[[^\]]+\]\([^)]+\)/,  // Links
    /^[-*+]\s/m,            // Unordered lists
    /^\d+\.\s/m,            // Ordered lists
    /^>\s/m,                // Blockquotes
    /^```/m,                // Code blocks
    /`[^`]+`/,              // Inline code
  ]

  return markdownPatterns.some((pattern) => pattern.test(text))
}

/**
 * Detect if text looks like code.
 */
export function looksLikeCode(text: string): boolean {
  const codePatterns = [
    /^(import|export|const|let|var|function|class|interface|type)\s/m,
    /^(def|class|import|from|if|elif|else|for|while|return)\s/m,
    /^(package|import|func|type|struct|interface)\s/m,
    /[{};]\s*$/m,
    /^\s{2,}(return|if|for|while)/m,
  ]

  const codeIndicators = codePatterns.filter((p) => p.test(text)).length
  return codeIndicators >= 2
}

/**
 * Detect if HTML looks like it came from a rich text editor.
 */
export function looksLikeRichEditor(html: string): boolean {
  if (!html) return false

  const richEditorPatterns = [
    /class="[^"]*(?:ql-|ProseMirror|tiptap|slate)/i,
    /<(?:b|strong|i|em|u|s|strike)>/i,
    /style="[^"]*(?:font-|color:|background)/i,
    /data-(?:slate|block|inline)/i,
    /<span[^>]*style=/i,
  ]

  return richEditorPatterns.some((p) => p.test(html))
}

/**
 * Detect content type from clipboard data.
 */
export function detectContentType(
  html: string | null,
  text: string | null
): ContentType {
  if (html && looksLikeRichEditor(html)) {
    return 'rich'
  }

  if (text) {
    if (looksLikeCode(text)) return 'code'
    if (looksLikeMarkdown(text)) return 'markdown'
  }

  return 'plain'
}
