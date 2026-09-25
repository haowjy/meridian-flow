/**
 * RecencyGroupedList — Today / Yesterday / Earlier sections for project
 * resume lists. The Editor's Recently opened and the Chat index share it so
 * both read as one family: same buckets, labels, and row rhythm.
 */
import { t } from "@lingui/core/macro";
import { type ReactNode, useEffect, useState } from "react";
import { SectionLabel } from "@/components/ui/section-label";
import { cn } from "@/lib/utils";

/** Age buckets the list groups under, oldest last. */
const GROUPS = ["today", "yesterday", "earlier"] as const;
type RecencyGroup = (typeof GROUPS)[number];

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

export function RecencyGroupedList<T>({
  items,
  now,
  timestamp,
  itemKey,
  renderItem,
  busy,
  listClassName,
}: {
  /** Newest first; each bucket keeps this order. */
  items: readonly T[];
  now: number;
  timestamp: (item: T) => string;
  itemKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  busy?: boolean;
  listClassName?: string;
}) {
  return (
    <div className="flex flex-col">
      {GROUPS.map((group) => {
        const rows = items.filter((item) => recencyGroup(timestamp(item), now) === group);
        if (rows.length === 0) return null;
        return (
          <section key={group} className="mt-7 first:mt-0">
            <SectionLabel variant="group">{groupLabel(group)}</SectionLabel>
            <ul className={cn("mt-2 divide-row-rule", listClassName)} aria-busy={busy || undefined}>
              {rows.map((item) => (
                <li key={itemKey(item)}>{renderItem(item)}</li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
