import { t } from "@lingui/core/macro";
import { cn } from "@/lib/utils";
import { sidebarIcon, sidebarRole } from "../../context/context-row-geometry";
import { MODES, type ModeKey, modeLabel } from "../../layout/modes";

/** Write | Chat: which mode shows, and with it its sidebar. One segment per entry in `MODES`. */
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
              "focus-ring flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md transition-colors",
              sidebarRole.row,
              active
                ? "bg-background font-medium text-foreground shadow-xs"
                : cn(sidebarRole.secondary, "hover:text-foreground"),
            )}
          >
            <Icon className={sidebarIcon.row} aria-hidden />
            {modeLabel(entry.key)}
          </button>
        );
      })}
    </div>
  );
}
