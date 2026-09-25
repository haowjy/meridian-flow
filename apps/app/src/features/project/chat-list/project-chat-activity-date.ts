/** Compact activity dates for project chat rows. */
export function formatProjectChatActivity(value: string, now: number, locale?: string): string {
  const date = new Date(value);
  const elapsed = Math.max(0, now - date.getTime());
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d`;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
}

// One formatter per locale: a row rebuilds this every render otherwise, and
// every row shares the same handful of locales.
const fullActivityFormatters = new Map<string, Intl.DateTimeFormat>();

function fullActivityFormatter(locale: string): Intl.DateTimeFormat {
  let formatter = fullActivityFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short" });
    fullActivityFormatters.set(locale, formatter);
  }
  return formatter;
}

/** The row's full, accessible activity timestamp (the `<time title>`). */
export function formatFullProjectChatActivity(value: string, locale: string): string {
  return fullActivityFormatter(locale).format(new Date(value));
}
