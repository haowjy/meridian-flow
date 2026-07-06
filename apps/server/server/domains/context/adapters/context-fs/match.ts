/** First-line excerpt matching: finds the first line containing a query (case-insensitive). Shared by the in-memory and drizzle context stores so both report search excerpts identically. */
export interface LineMatch {
  /** The exact serialized text of the first matching line. */
  excerpt: string;
  /** 1-based line number of the match. */
  line: number;
}

/**
 * Find the first line of `markdown` that contains `query` (case-insensitive).
 * Returns null when no line matches. Shared by the in-memory and Drizzle
 * document stores so both report excerpts identically.
 */
export function firstLineMatch(markdown: string, query: string): LineMatch | null {
  const needle = query.toLowerCase();
  const lines = markdown.split("\n");
  const index = lines.findIndex((line) => line.toLowerCase().includes(needle));
  if (index === -1) return null;
  return { excerpt: lines[index], line: index + 1 };
}
