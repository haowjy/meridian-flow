import { msg } from "@lingui/core/macro";

import { i18n } from "./i18n";

/**
 * Compact trailing timestamp ("now", "2h", "3d", "May 12") for a sidebar row.
 * `now` is a stable epoch-ms reference (loader-provided) so SSR and client agree.
 */
export function formatRelativeTime(value: string | Date, now: number): string {
  const then = new Date(value);
  const diffMs = now - then.getTime();
  const minutes = Math.floor(diffMs / (60 * 1000));
  if (minutes < 1) return i18n._(msg`now`);
  if (minutes < 60) return i18n._(msg`${minutes}m`);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return i18n._(msg`${hours}h`);
  const days = Math.floor(hours / 24);
  if (days < 7) return i18n._(msg`${days}d`);

  const sameYear = then.getFullYear() === new Date(now).getFullYear();
  const formatter = new Intl.DateTimeFormat(i18n.locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return formatter.format(then);
}
