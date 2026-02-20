/**
 * Markdown conversion utilities.
 *
 * SRP: This module ONLY converts between formats.
 * Used by clipboard operations, thread rendering, etc.
 */

/**
 * Convert markdown to HTML (for copy to rich targets).
 */
export function markdownToHtml(markdown: string): string {
  // Simple conversion for common patterns
  const html = markdown
    // Escape HTML
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Bold
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    // Italic
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    // Strikethrough
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    // Code
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // Headers
    .replace(/^###### (.+)$/gm, "<h6>$1</h6>")
    .replace(/^##### (.+)$/gm, "<h5>$1</h5>")
    .replace(/^#### (.+)$/gm, "<h4>$1</h4>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    // Paragraphs
    .replace(/\n\n/g, "</p><p>");

  return `<p>${html}</p>`.replace(/<p><\/p>/g, "");
}
