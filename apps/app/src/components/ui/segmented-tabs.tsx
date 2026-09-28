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

export type SegmentedTabOption<T extends string> = {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  /** A visible close affordance on a removable tab, also available by Delete/Backspace. */
  closeAction?: { icon: ReactNode; onClose: () => void };
};

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
          <div key={option.value} className="flex shrink-0 items-center">
            <button
              type="button"
              role="tab"
              aria-selected={active}
              aria-keyshortcuts={option.closeAction ? "Delete Backspace" : undefined}
              disabled={option.disabled}
              onClick={(event) => {
                if (
                  option.closeAction &&
                  event.target instanceof Element &&
                  event.target.closest("[data-segmented-tab-close]")
                ) {
                  event.preventDefault();
                  option.closeAction.onClose();
                  return;
                }
                onChange(option.value);
              }}
              onKeyDown={(event) => {
                if (option.closeAction && (event.key === "Delete" || event.key === "Backspace")) {
                  event.preventDefault();
                  option.closeAction.onClose();
                }
              }}
              className={cn(
                "focus-ring inline-flex h-6 shrink-0 items-center gap-1 rounded-[calc(var(--radius-lg)-2px)] px-2.5 text-xs transition-colors [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:px-3.5 [@media(pointer:coarse)]:text-sm",
                option.closeAction && "pr-1 [@media(pointer:coarse)]:pr-1.5",
                active
                  ? "bg-background font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
                option.disabled && "cursor-not-allowed opacity-50 hover:text-muted-foreground",
              )}
            >
              {option.label}
              {option.closeAction ? (
                <span
                  data-segmented-tab-close
                  aria-hidden="true"
                  className="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-foreground/10 hover:text-foreground [@media(pointer:coarse)]:size-8"
                >
                  {option.closeAction.icon}
                </span>
              ) : null}
            </button>
          </div>
        );
      })}
    </div>
  );
}
