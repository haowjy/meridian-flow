import { t } from "@lingui/core/macro";
import { cn } from "@/lib/utils";
import type { ModeKey } from "../../layout/types";
import { MODES, modeLabel } from "./modes";

/** Write | Chat: which surface takes the centre. One segment per entry in `MODES`. */
export function ModeSwitch({
  mode,
  onSelect,
}: {
  mode: ModeKey;
  onSelect: (mode: ModeKey) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={t`Mode`}
      className="mx-2 flex shrink-0 rounded-lg bg-foreground/6 p-0.5"
    >
      {MODES.map((entry) => {
        const active = entry.key === mode;
        const Icon = entry.icon;
        return (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(entry.key)}
            className={cn(
              "focus-ring flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-[13px] transition-colors",
              active
                ? "bg-background font-medium text-foreground shadow-xs"
                : "text-ink-muted hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {modeLabel(entry.key)}
          </button>
        );
      })}
    </div>
  );
}
