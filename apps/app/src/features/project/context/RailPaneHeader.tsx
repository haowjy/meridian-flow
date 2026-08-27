/**
 * RailPaneHeader — the rail's one pane-header grammar, shared by every
 * section band: Manuscript / Knowledge Base / User / Scratch / Uploads, all
 * flush full-width top-level siblings (never indented). There is no work
 * header row (ruling 2026-08-06, superseding the work-title-as-marking
 * model); the work-scoped panes name their work through a hover tooltip
 * their caller wraps around this header. Pane headers retain their own compact
 * 28px rhythm; context entry rows are 32px on fine pointers and 44px on
 * coarse/no-hover input.
 * Grammar: `font-medium text-sm uppercase tracking-wide` on the
 * section row. The caps + row rhythm carry the header read (bold was
 * rejected by ruling; caps apply to ALL headers, as VS Code uppercases
 * folder names in explorer headers). Headers use a `size-3.5` icon in a `w-4`
 * slot and a `size-3` twistie in a `w-4` slot.
 *
 * Separation follows the flatter workbench direction: headers remain
 * transparent at rest. A subtle hover is the only temporary fill, so section
 * identity comes from rhythm, the caps label, and the twistie rather than
 * stacked color bands or repeated rules. The whole
 * row is the collapse target (Enter/Space via the native button, ArrowLeft
 * collapses, ArrowRight expands, aria-expanded, focus-ring).
 *
 * Headers carry identity icons: every pane passes its category's `icon`
 * (the scheme icons from `context-schemes`) at the tree rows' icon scale.
 * Actions follow the Explorer header grammar: a right-edge shelf, invisible
 * at rest, revealed on header hover / focus-within, and only while expanded
 * (VS Code hides actions on collapsed panes). Callers pass
 * `PaneHeaderActionButton`s as `actions`.
 */
import { ChevronRight, type LucideIcon } from "lucide-react";
import type React from "react";

import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

export function RailPaneHeader({
  label,
  icon: Icon,
  ariaLabel,
  expanded,
  onExpandedChange,
  actions,
}: {
  /** Header text, rendered in UPPERCASE at the tree rows' `text-sm` scale. */
  label: string;
  /** Mini category mark between the twistie and the label. */
  icon: LucideIcon;
  /** Optional richer accessible name (e.g. "Work: {name}"). */
  ariaLabel?: string;
  expanded: boolean;
  /** Click toggles; ArrowLeft/ArrowRight force collapse/expand. */
  onExpandedChange: (expanded: boolean) => void;
  /** Hover-revealed `PaneHeaderActionButton`s; hidden while collapsed. */
  actions?: React.ReactNode;
}) {
  return (
    /* This row stays on the rail material at rest and only lifts on hover. */
    <div className="group relative flex h-7 w-full items-center transition-colors hover:bg-sidebar-accent/50">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={ariaLabel}
        onClick={() => onExpandedChange(!expanded)}
        onKeyDown={(event) => {
          // VS Code pane header keys: Left collapses, Right expands.
          if (event.key === "ArrowLeft") onExpandedChange(false);
          if (event.key === "ArrowRight") onExpandedChange(true);
        }}
        className="focus-ring flex h-full min-w-0 flex-1 items-center rounded-none pr-1 pl-1 text-left"
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
      {/* VS Code's expanded-only rule: no actions on a collapsed pane. The
          shelf sits in normal flow at the row's end (VS Code: titles
          ellipsize, actions hold the right edge) so it needs no background
          mask over the translucent tint; invisible at rest, revealed on
          header hover / focus-within. */}
      {expanded && actions ? (
        <span className="mr-2 flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {actions}
        </span>
      ) : null}
    </div>
  );
}

/**
 * One header action (VS Code Explorer-header anatomy): ~20px hit target
 * around a 16px icon, transparent at rest, rail hover tint + icon darken on
 * hover, focus-ring for keyboard. stopPropagation so an action click can
 * never toggle the header's collapse.
 */
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
