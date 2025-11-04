/**
 * Counts words in a string of text or HTML content.
 * Strips HTML tags and counts whitespace-separated words.
 *
 * @param content - Text or HTML string to count words from
 * @returns Number of words (0 if empty)
 */
export function countWords(content: string | undefined): number {
  if (!content) return 0

  // Strip HTML tags
  const text = content.replace(/<[^>]*>/g, ' ')

  // Count whitespace-separated words
  const words = text.trim().split(/\s+/)

  // Empty string after trimming returns [''], so check first element
  return words.length === 1 && words[0] === '' ? 0 : words.length
}
