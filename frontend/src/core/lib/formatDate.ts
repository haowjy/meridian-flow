/**
 * Formats a date as a relative time string (e.g., "just now", "5 mins ago", "2 hours ago")
 *
 * @param date - Date to format, or null
 * @returns Formatted relative time string, or empty string if date is null
 */
export function formatRelative(date: Date | null): string {
  if (!date) return ''

  const diff = Math.max(0, Date.now() - date.getTime())
  const mins = Math.floor(diff / 60000)

  if (mins < 1) return 'just now'
  if (mins === 1) return '1 min ago'
  if (mins < 60) return `${mins} mins ago`

  const hours = Math.floor(mins / 60)
  if (hours === 1) return '1 hour ago'
  if (hours < 24) return `${hours} hours ago`

  const days = Math.floor(hours / 24)
  if (days === 1) return '1 day ago'
  if (days < 7) return `${days} days ago`

  const weeks = Math.floor(days / 7)
  if (weeks === 1) return '1 week ago'
  return `${weeks} weeks ago`
}
