/**
 * SegmentedTabs — a contained segmented switch between sibling views of one
 * surface: the sidebar's Write | Chat, the chat index's All | Favorites, the Work
 * page's views.
 *
 * Deliberately not underline tabs: the recessed track gives the control a
 * complete boundary, so it reads as a switch inside chrome or a heading row
 * rather than a tab strip with its base cut off. The active segment surfaces
 * the paper tone inside the track; selection is tonal, never an outline. In dark the
 * paper tone is within a few points of the track, so it takes the selected overlay.
 *
 * A tablist (ARIA tabs pattern): Tab enters on the selected segment, Left/Right
 * and Home/End move and select.
 */
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { role } from "@/components/ui/roles";
import { tabListKeys } from "@/components/ui/tab-keys";
import { cn } from "@/lib/utils";

export type SegmentedTabOption<T extends string> = {
  value: T;
  label: ReactNode;
  icon?: LucideIcon;
  disabled?: boolean;
};

export function SegmentedTabs<T extends string>({
  label,
  value,
  options,
  onChange,
  fill = false,
  className,
}: {
  /** Accessible name of the tablist. */
  label: string;
  value: T;
  options: readonly SegmentedTabOption<T>[];
  onChange: (value: T) => void;
  /** Segments share the full width (the sidebar's mode switch). */
  fill?: boolean;
  className?: string;
}) {
  const keys = tabListKeys(
    options.filter((option) => !option.disabled).map((option) => option.value),
    value,
    onChange,
  );

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={keys.onKeyDown}
      className={cn(
        "flex shrink-0 items-center rounded-lg bg-ink-fill p-0.5",
        !fill && "self-center",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            data-tab-value={option.value}
            aria-selected={active}
            tabIndex={keys.tabIndex(option.value)}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "focus-ring inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 transition-colors coarse:h-11 coarse:px-3.5",
              role.row,
              fill && "flex-1",
              active
                ? "bg-background font-medium text-foreground shadow-raise dark:bg-ink-fill-strong"
                : cn(role.secondary, "hover:text-foreground"),
              option.disabled && "cursor-not-allowed opacity-50 hover:text-muted-foreground",
            )}
          >
            {Icon ? <Icon aria-hidden className="size-3.5" /> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
