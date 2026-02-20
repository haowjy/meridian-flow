/**
 * Formatting utilities for displaying metadata in the UI.
 * Each function is pure and has a single responsibility.
 */

/**
 * Format word count with abbreviation for large numbers.
 *
 * @param count - Number of words
 * @returns Formatted string (e.g., "347 words", "1.2k words", "12k words")
 *
 * @example
 * formatWordCount(347)     // "347 words"
 * formatWordCount(1234)    // "1.2k words"
 * formatWordCount(12000)   // "12k words"
 */
export function formatWordCount(count: number): string {
  if (count < 1000) return `${count} words`;
  return `${(count / 1000).toFixed(1)}k words`;
}

/**
 * Format date as relative time.
 *
 * @param date - Date to format
 * @returns Formatted relative time (e.g., "2h ago", "Yesterday", "Jan 5")
 *
 * @example
 * formatRelativeTime(new Date(Date.now() - 2 * 60 * 60 * 1000))  // "2h ago"
 * formatRelativeTime(new Date(Date.now() - 24 * 60 * 60 * 1000)) // "Yesterday"
 * formatRelativeTime(new Date('2024-01-05'))                     // "Jan 5"
 */
export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffHours < 1) return "Just now";
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;

  // Format as "Jan 5" for older dates
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

