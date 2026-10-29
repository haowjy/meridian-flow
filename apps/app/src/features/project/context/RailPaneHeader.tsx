/** Shared header for project context rail panes. */
import { ChevronRight, type LucideIcon } from "lucide-react";
import type React from "react";

import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

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
  /** Header text, rendered in UPPERCASE at the tree rows' `text-sm` scale. */
  label: string;
  /** Mini category mark between the twistie and the label. */
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
  /** Drop handlers when the header is a drop target (the tree's areas). */
  dropProps?: React.HTMLAttributes<HTMLElement>;
}) {
  return (
    /* This row stays on the rail material at rest and only lifts on hover. */
    <div
      {...dropProps}
      data-rail-pane-header
      className="relative mx-2 flex h-7 items-center rounded-md transition-colors hover:bg-sidebar-accent/50"
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
        <span className="flex w-4 shrink-0 items-center justify-center text-muted-foreground">
          <ChevronRight
            aria-hidden
            className={cn("size-3 transition-transform", expanded && "rotate-90")}
          />
        </span>
        {/* Tree-row icon scale: size-3.5 glyph in a w-4 slot, matching
            `RowIcon` in `ContextTreeRows`. The tint + caps keep the header
            reading as a header rather than a tree row. */}
        <span className="flex h-7 w-4 shrink-0 items-center justify-center text-muted-foreground">
          <Icon aria-hidden className="size-3.5" />
        </span>
        <span className="ml-0.5 min-w-0 flex-1 truncate font-medium text-foreground text-sm uppercase tracking-wide">
          {label}
        </span>
      </button>
      {/* Actions show on a collapsed pane too (Jimmy overrode VS Code's
          expanded-only rule), so each action must expand its pane itself.
          The shelf sits in normal flow at the row's end (VS Code: titles
          ellipsize, actions hold the right edge) so it needs no background
          mask over the translucent tint. With hover, invisible at rest and
          revealed on header hover / focus; on touch always shown, since an
          invisible button would still take a tap meant for the header
          (`.rail-pane-actions` in globals.css). */}
      {actions ? (
        <span className="rail-pane-actions mr-2 flex shrink-0 items-center gap-1 transition-opacity">
          {actions}
        </span>
      ) : null}
    </div>
  );
}

/** One header action (VS Code Explorer-header anatomy): ~20px hit target around a 16px icon, transparent at rest, rail hover tint + icon darken on hover, focus-ring for keyboard. */
export function PaneHeaderActionButton({
  icon: Icon,
  label,
  ...props
}: {
  icon: LucideIcon;
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
      className="size-5 rounded"
    >
      <Icon aria-hidden className="size-4" />
    </IconButton>
  );
}
