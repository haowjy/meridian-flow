/**
 * RecencyGroupedList — Today / Yesterday / Earlier sections for project
 * resume lists. The Editor's Recently opened renders through it; the chat
 * index virtualizes the same `recencyGroups` under the same `RecencyGroupLabel`,
 * so both read as one family: same buckets, labels, and row rhythm.
 */
import { t } from "@lingui/core/macro";
import { type ReactNode, useEffect, useState } from "react";
import { SectionLabel } from "@/components/ui/section-label";
import { cn } from "@/lib/utils";

/** Age buckets the list groups under, oldest last. */
const GROUPS = ["today", "yesterday", "earlier"] as const;
export type RecencyGroup = (typeof GROUPS)[number];

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** A clock that ticks each minute so relative ages and buckets stay current. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function recencyGroup(iso: string, nowMs: number): RecencyGroup {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "earlier";
  const today = startOfDay(nowMs);
  if (at >= today) return "today";
  // Day arithmetic, not a fixed 86400000: a DST day is not 24 hours long.
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  return at >= yesterday.getTime() ? "yesterday" : "earlier";
}

function groupLabel(group: RecencyGroup): string {
  switch (group) {
    case "today":
      return t`Today`;
    case "yesterday":
      return t`Yesterday`;
    default:
      return t`Earlier`;
  }
}

/** Newest-first items split into their non-empty buckets, each keeping that order. */
export function recencyGroups<T>(
  items: readonly T[],
  now: number,
  timestamp: (item: T) => string,
): { group: RecencyGroup; items: T[] }[] {
  return GROUPS.map((group) => ({
    group,
    items: items.filter((item) => recencyGroup(timestamp(item), now) === group),
  })).filter((bucket) => bucket.items.length > 0);
}

/** A bucket's label with the space above (except the first) and below it. */
export function RecencyGroupLabel({ group, first }: { group: RecencyGroup; first: boolean }) {
  return (
    <div className={cn("pb-2", !first && "pt-7")}>
      <SectionLabel variant="group">{groupLabel(group)}</SectionLabel>
    </div>
  );
}

export function RecencyGroupedList<T>({
  items,
  now,
  timestamp,
  itemKey,
  renderItem,
}: {
  /** Newest first; each bucket keeps this order. */
  items: readonly T[];
  now: number;
  timestamp: (item: T) => string;
  itemKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
}) {
  return (
    <div className="flex flex-col">
      {recencyGroups(items, now, timestamp).map((bucket, index) => (
        <section key={bucket.group}>
          <RecencyGroupLabel group={bucket.group} first={index === 0} />
          <ul>
            {bucket.items.map((item, row) => (
              <li
                key={itemKey(item)}
                className={cn("relative", row < bucket.items.length - 1 && "row-rule")}
              >
                {renderItem(item)}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
