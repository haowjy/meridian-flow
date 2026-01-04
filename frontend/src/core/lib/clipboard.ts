/**
 * HTML <-> Markdown conversion utilities.
 *
 * SRP: This module ONLY converts between formats.
 * Used by clipboard operations, chat rendering, etc.
 */

/**
 * Convert HTML to markdown.
 * Handles common rich text patterns.
 */
export function htmlToMarkdown(html: string): string {
  // Create a temporary element to parse HTML
  const div = document.createElement('div')
  div.innerHTML = html

  return nodeToMarkdown(div).trim()
}

function nodeToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent || ''
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return ''
  }

  const el = node as HTMLElement
  const tag = el.tagName.toLowerCase()
  const children = Array.from(el.childNodes).map(nodeToMarkdown).join('')

  switch (tag) {
    case 'p':
      return children + '\n\n'
    case 'br':
      return '\n'
    case 'strong':
    case 'b':
      return `**${children}**`
    case 'em':
    case 'i':
      return `*${children}*`
    case 'u':
      return children // No markdown equivalent
    case 's':
    case 'strike':
    case 'del':
      return `~~${children}~~`
    case 'code':
      return `\`${children}\``
    case 'pre':
      return `\`\`\`\n${children}\n\`\`\``
    case 'a': {
      const href = el.getAttribute('href') || ''
      return `[${children}](${href})`
    }
    case 'h1':
      return `# ${children}\n\n`
    case 'h2':
      return `## ${children}\n\n`
    case 'h3':
      return `### ${children}\n\n`
    case 'h4':
      return `#### ${children}\n\n`
    case 'h5':
      return `##### ${children}\n\n`
    case 'h6':
      return `###### ${children}\n\n`
    case 'ul':
      return convertList(el, false)
    case 'ol':
      return convertList(el, true)
    case 'li':
      return children
    case 'blockquote':
      return (
        children
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n') + '\n\n'
      )
    case 'img': {
      const src = el.getAttribute('src') || ''
      const alt = el.getAttribute('alt') || ''
      return `![${alt}](${src})`
    }
    case 'hr':
      return '---\n\n'
    case 'div':
    case 'span':
      return children
    default:
      return children
  }
}

function convertList(el: HTMLElement, ordered: boolean): string {
  const items = Array.from(el.querySelectorAll(':scope > li'))
  return (
    items
      .map((li, i) => {
        const prefix = ordered ? `${i + 1}. ` : '- '
        const content = nodeToMarkdown(li).trim()
        return prefix + content
      })
      .join('\n') + '\n\n'
  )
}

/**
 * Convert markdown to HTML (for copy to rich targets).
 */
export function markdownToHtml(markdown: string): string {
  // Simple conversion for common patterns
  const html = markdown
    // Escape HTML
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Bold
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    // Strikethrough
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    // Code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // Headers
    .replace(/^###### (.+)$/gm, '<h6>$1</h6>')
    .replace(/^##### (.+)$/gm, '<h5>$1</h5>')
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Paragraphs
    .replace(/\n\n/g, '</p><p>')

  return `<p>${html}</p>`.replace(/<p><\/p>/g, '')
}
