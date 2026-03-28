import DOMPurify from "dompurify"
import { marked } from "marked"

// --- Client-side export helpers ---

/**
 * Download a Blob as a file via a temporary anchor element.
 * Uses URL.createObjectURL + <a download> pattern.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Export document content as a Markdown (.md) file */
export function exportMarkdown(content: string, documentName: string): void {
  const blob = new Blob([content], { type: "text/markdown" })
  downloadBlob(blob, `${documentName}.md`)
}

/**
 * Export document content as a Plain Text (.txt) file.
 * Strips basic markdown syntax while preserving readable text.
 */
export function exportPlainText(content: string, documentName: string): void {
  // Strip common markdown syntax for a readable plain text output
  const plain = content
    // Remove headings markers
    .replace(/^#{1,6}\s+/gm, "")
    // Remove bold/italic markers
    .replace(/(\*{1,3}|_{1,3})(.*?)\1/g, "$2")
    // Remove inline code
    .replace(/`([^`]+)`/g, "$1")
    // Remove link syntax, keep text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Remove image syntax
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    // Remove horizontal rules
    .replace(/^---+$/gm, "")
    // Remove blockquote markers
    .replace(/^>\s?/gm, "")

  const blob = new Blob([plain], { type: "text/plain" })
  downloadBlob(blob, `${documentName}.txt`)
}

/**
 * Export document content as an HTML (.html) file.
 * Parses markdown via `marked`, then sanitizes with DOMPurify
 * to prevent XSS from malicious markdown content.
 */
export function exportHTML(content: string, documentName: string): void {
  const rawHtml = marked.parse(content, { async: false }) as string

  // Mandatory: sanitize to prevent XSS from malicious markdown content
  // (e.g., collaborator injecting `[click me](javascript:alert(1))`)
  const safeHtml = DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: [
      "h1", "h2", "h3", "h4", "h5", "h6",
      "p", "br", "hr",
      "ul", "ol", "li",
      "blockquote", "pre", "code",
      "em", "strong", "a", "img",
      "table", "thead", "tbody", "tr", "th", "td",
      "del", "figure", "figcaption",
    ],
    ALLOWED_ATTR: ["href", "src", "alt", "class", "id"],
  })

  const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${DOMPurify.sanitize(documentName)}</title>
<style>
  body { font-family: Georgia, serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.75; color: #1a1a1a; }
  h1, h2, h3 { margin-top: 1.5em; }
  code { background: #f5f5f5; padding: 0.15em 0.3em; border-radius: 3px; font-size: 0.9em; }
  pre { background: #f5f5f5; padding: 1em; border-radius: 6px; overflow-x: auto; }
  blockquote { border-left: 3px solid #ccc; padding-left: 1em; color: #555; font-style: italic; }
  img { max-width: 100%; height: auto; }
</style>
</head>
<body>
${safeHtml}
</body>
</html>`

  const blob = new Blob([fullHtml], { type: "text/html" })
  downloadBlob(blob, `${documentName}.html`)
}

// --- Server-side export stubs ---
// These will call backend API endpoints when available (Phase 6+).
// For now, they log a message. The UI shows a "Server" badge.

export function exportPDF(documentId: string, documentName: string): void {
  // Will use documentId and documentName when backend is available
  void documentId
  void documentName
  console.warn("[Export] PDF export requires backend support (not yet implemented)")
}

export function exportDOCX(documentId: string, documentName: string): void {
  void documentId
  void documentName
  console.warn("[Export] DOCX export requires backend support (not yet implemented)")
}

export function exportEPUB(documentId: string, documentName: string): void {
  void documentId
  void documentName
  console.warn("[Export] EPUB export requires backend support (not yet implemented)")
}
