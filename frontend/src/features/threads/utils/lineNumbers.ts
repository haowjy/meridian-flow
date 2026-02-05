/**
 * Line Number Parsing Utility
 *
 * Parses content that has line number prefixes (e.g., "1: line content")
 * from the backend's view command output. Enables:
 * - Stripping line numbers so users can copy-paste without them
 * - Displaying in CodeMirror gutter instead of inline
 * - Future "jump to line X" navigation feature
 */

/**
 * Result of parsing line-numbered content
 */
export interface ParsedLineNumberedContent {
  /** Content with line number prefixes stripped */
  rawContent: string
  /** Whether the content had line number prefixes */
  hasLineNumbers: boolean
  /** The starting line number (from first line's prefix) */
  startLine: number
}

/**
 * Pattern to detect line number prefix at start of line
 * Matches: "1: ", "42: ", "999: ", etc.
 */
const LINE_NUMBER_PREFIX = /^(\d+): /

/**
 * Pattern to detect if content has line number format (at least one line)
 */
const HAS_LINE_NUMBERS = /^\d+: /m

/**
 * Parses content with line number prefixes (from backend view output).
 *
 * The backend formats view results as "1: line1\n2: line2\n..." for LLM consumption.
 * This function strips those prefixes so:
 * - Users can copy-paste without line numbers
 * - CodeMirror can display line numbers in its native gutter
 *
 * @param content - Content that may have line number prefixes
 * @returns Parsed result with raw content and line number metadata
 *
 * @example
 * // With line numbers
 * parseLineNumberedContent("1: Hello\n2: World")
 * // => { rawContent: "Hello\nWorld", hasLineNumbers: true, startLine: 1 }
 *
 * @example
 * // With view_range starting at line 50
 * parseLineNumberedContent("50: Chapter 5\n51: The story continues")
 * // => { rawContent: "Chapter 5\nThe story continues", hasLineNumbers: true, startLine: 50 }
 *
 * @example
 * // Without line numbers (pass through)
 * parseLineNumberedContent("Hello\nWorld")
 * // => { rawContent: "Hello\nWorld", hasLineNumbers: false, startLine: 1 }
 */
export function parseLineNumberedContent(content: string): ParsedLineNumberedContent {
  // Quick check - if no line numbers detected, return early
  if (!HAS_LINE_NUMBERS.test(content)) {
    return {
      rawContent: content,
      hasLineNumbers: false,
      startLine: 1,
    }
  }

  const lines = content.split('\n')
  let startLine = 1

  // Extract start line from first line's prefix
  const firstMatch = lines[0]?.match(LINE_NUMBER_PREFIX)
  if (firstMatch) {
    startLine = parseInt(firstMatch[1], 10)
  }

  // Strip prefixes from all lines
  const strippedLines = lines.map(line => {
    const match = line.match(LINE_NUMBER_PREFIX)
    if (match) {
      return line.slice(match[0].length)
    }
    return line
  })

  return {
    rawContent: strippedLines.join('\n'),
    hasLineNumbers: true,
    startLine,
  }
}
