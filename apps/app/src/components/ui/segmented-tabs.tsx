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
  label: string;
  value: T;
  options: readonly SegmentedTabOption<T>[];
  onChange: (value: T) => void;
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
