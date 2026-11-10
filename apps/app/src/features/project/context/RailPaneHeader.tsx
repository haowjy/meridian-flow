/** Shared header for project context rail panes. */

import { ChevronRight, type LucideIcon } from "lucide-react";
import type React from "react";
import { IconButton } from "@/components/ui/icon-button";
import { role } from "@/components/ui/roles";
import { cn } from "@/lib/utils";
import { sidebarIcon } from "./context-row-geometry";

export function RailPaneHeader({
  label,
  icon: Icon,
  ariaLabel,
  title,
  expanded,
  onExpandedChange,
  actions,
  dropProps,
}: {
  label: string;
  /** Mini category mark before the label. */
  icon: LucideIcon;
  /** Optional richer accessible name (e.g. "Work: {name}"). */
  ariaLabel?: string;
  /** Tooltip, for a header whose richer name is not shown as a line. */
  title?: string;
  expanded: boolean;
  /** Click toggles; ArrowLeft/ArrowRight force collapse/expand. */
  onExpandedChange: (expanded: boolean) => void;
  /** `PaneHeaderActionButton`s revealed on header hover / focus, expanded or collapsed. */
  actions?: React.ReactNode;
  /** Drop handlers when the header is a drop target. */
  dropProps?: React.HTMLAttributes<HTMLElement>;
}) {
  return (
    /* This row stays on the rail material at rest and only lifts on hover. */
    <div
      {...dropProps}
      data-rail-pane-header
      className={cn("relative mx-2 flex h-7 items-center rounded-md", role.hover)}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={ariaLabel}
        title={title}
        onClick={() => onExpandedChange(!expanded)}
        onKeyDown={(event) => {
          // VS Code pane header keys: Left collapses, Right expands.
          if (event.key === "ArrowLeft") onExpandedChange(false);
          if (event.key === "ArrowRight") onExpandedChange(true);
        }}
        className="focus-ring flex h-full min-w-0 flex-1 items-center rounded-md pr-1 text-left"
      >
        <span className={cn("flex w-4 shrink-0 items-center justify-center", role.secondary)}>
          <ChevronRight
            aria-hidden
            className={cn("size-3 transition-transform", expanded && "rotate-90")}
          />
        </span>
        <span className={cn("flex h-7 w-4 shrink-0 items-center justify-center", role.secondary)}>
          <Icon aria-hidden className={sidebarIcon.row} />
        </span>
        <span className={cn("ml-1 min-w-0 flex-1 truncate", role.groupLabel)}>{label}</span>
      </button>
      <PaneHeaderActions actions={actions} />
    </div>
  );
}

/**
 * A header's actions: invisible at rest and revealed on header hover or focus;
 * on touch always shown, since an invisible button would still take a tap
 * (`.rail-pane-actions` in globals.css). The header carries `data-rail-pane-header`.
 */
export function PaneHeaderActions({ actions }: { actions?: React.ReactNode }) {
  if (!actions) return null;
  return (
    <span className="rail-pane-actions mr-2 flex shrink-0 items-center gap-1 [&>*]:transition-opacity">
      {actions}
    </span>
  );
}

/** One header action (VS Code Explorer-header anatomy): ~20px hit target around a 16px icon, transparent at rest, rail hover tint + icon darken on hover, focus-ring for keyboard. */
export function PaneHeaderActionButton({
  icon: Icon,
  iconClassName,
  label,
  children,
  ...props
}: {
  icon: LucideIcon;
  iconClassName?: string;
  label: string;
} & React.ComponentPropsWithoutRef<"button">) {
  return (
    <IconButton
      size="xs"
      title={label}
      aria-label={label}
      {...props}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick?.(event);
      }}
      className="relative size-5 rounded-sm"
    >
      <Icon aria-hidden className={cn(sidebarIcon.action, iconClassName)} />
      {children}
    </IconButton>
  );
}
