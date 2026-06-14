// @ts-nocheck
import { msg } from "@lingui/core/macro";

import { i18n } from "./i18n";

/**
 * Coarse buckets for sidebar/recent lists. The values are *identifier keys* —
 * the human-readable label is looked up at render time so it can be translated.
 */
export type DateGroup = "today" | "yesterday" | "thisWeek" | "older";

export const DATE_GROUP_ORDER: DateGroup[] = ["today", "yesterday", "thisWeek", "older"];

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Bucket a timestamp into a coarse date group.
 * `now` is a stable epoch-ms reference (loader-provided) so SSR and client agree.
 */
export function dateGroupFor(value: string | Date, now: number): DateGroup {
  const updated = new Date(value);
  const today = startOfDay(new Date(now));
  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.floor((today.getTime() - startOfDay(updated).getTime()) / dayMs);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays <= 7) return "thisWeek";
  return "older";
}

const DATE_GROUP_LABELS: Record<DateGroup, ReturnType<typeof msg>> = {
  today: msg`Today`,
  yesterday: msg`Yesterday`,
  thisWeek: msg`This week`,
  older: msg`Older`,
};

/** Localized display label for a date group. */
export function dateGroupLabel(group: DateGroup): string {
  return i18n._(DATE_GROUP_LABELS[group]);
}

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

export type GroupedByDate<T> = { group: DateGroup; items: T[] }[];

/**
 * Group items by date bucket, newest-first within each group, in display order.
 * `getDate(item)` returns the timestamp used for bucketing and sort.
 */
export function groupByDate<T>(
  items: T[],
  getDate: (item: T) => string | Date,
  now: number,
): GroupedByDate<T> {
  const byGroup = new Map<DateGroup, T[]>();
  for (const group of DATE_GROUP_ORDER) {
    byGroup.set(group, []);
  }

  const sorted = [...items].sort(
    (a, b) => new Date(getDate(b)).getTime() - new Date(getDate(a)).getTime(),
  );

  for (const item of sorted) {
    byGroup.get(dateGroupFor(getDate(item), now))?.push(item);
  }

  return DATE_GROUP_ORDER.map((group) => ({ group, items: byGroup.get(group) ?? [] })).filter(
    (entry) => entry.items.length > 0,
  );
}
