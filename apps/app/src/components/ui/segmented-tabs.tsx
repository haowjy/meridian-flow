/**
 * SegmentedTabs — a contained segmented switch between sibling views of one
 * surface (the dock's Chat | Changes, the chat index's All | Favorites).
 *
 * Deliberately not underline tabs: the recessed track gives the control a
 * complete boundary, so it reads as a switch inside chrome or a heading row
 * rather than a tab strip with its base cut off. The active segment surfaces
 * the paper tone inside the track; selection is tonal, never an outline.
 */
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type SegmentedTabOption<T extends string> = { value: T; label: ReactNode };

export function SegmentedTabs<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  /** Accessible name of the tablist. */
  label: string;
  value: T;
  options: readonly SegmentedTabOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        "flex shrink-0 items-center self-center rounded-lg bg-foreground/6 p-0.5",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "focus-ring h-6 shrink-0 rounded-[calc(var(--radius-lg)-2px)] px-2.5 text-xs transition-colors [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:px-3.5 [@media(pointer:coarse)]:text-sm",
              active
                ? "bg-background font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
