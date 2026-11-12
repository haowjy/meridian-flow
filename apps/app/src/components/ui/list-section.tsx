import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { DisclosureMark } from "./marks";
import { role } from "./roles";

export type SectionFold = { open: boolean; onToggle: (open: boolean) => void };

/**
 * The name above a list or a group of its rows, the one heading every sidebar list uses. Its
 * text sits on the rows' text edge; a fold's chevron follows the label, so folding and plain
 * headings share that edge. Actions show on hover or focus (`.rail-pane-actions`, globals.css).
 */
export function ListSectionHeader({
  label,
  level = 3,
  title,
  fold,
  foldedMark,
  actions,
  headerProps,
}: {
  label: string;
  level?: 2 | 3;
  /** Tooltip and accessible name, for a list whose full name is longer than its label. */
  title?: string;
  fold?: SectionFold;
  /** Shown after a folded heading's chevron: what its hidden rows would say. */
  foldedMark?: ReactNode;
  actions?: ReactNode;
  /** Drop handlers when the heading is a drop target. */
  headerProps?: HTMLAttributes<HTMLElement>;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  const name = <span className="min-w-0 truncate">{label}</span>;
  return (
    <div {...headerProps} data-rail-pane-header className="mx-2 flex min-h-7 shrink-0 items-center">
      <Heading
        title={title}
        aria-label={fold ? undefined : title}
        className={cn("flex min-w-0 flex-1 items-center pr-1 pl-1.5", role.groupLabel)}
      >
        {fold ? (
          // -mx/px keep the label on the rows' text edge while the hover fill reaches past it.
          <button
            type="button"
            aria-expanded={fold.open}
            aria-label={title}
            onClick={() => fold.onToggle(!fold.open)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") fold.onToggle(false);
              if (event.key === "ArrowRight") fold.onToggle(true);
            }}
            className={cn(
              "interactive -mx-1.5 flex min-w-0 items-center gap-1 self-stretch rounded-sm px-1.5 coarse:min-h-11",
              // Preflight resets a button's text-transform; the label's case needs restating.
              role.groupLabel,
            )}
          >
            {name}
            <DisclosureMark open={fold.open} />
            {fold.open ? null : foldedMark}
          </button>
        ) : (
          name
        )}
      </Heading>
      {actions ? (
        <span className="rail-pane-actions mr-2 flex shrink-0 items-center gap-1 [&>*]:transition-opacity">
          {actions}
        </span>
      ) : null}
    </div>
  );
}

/**
 * A heading and its rows, inset like every list's rows; a folded section shows its heading alone.
 * With no label yet (a Work whose name hasn't loaded) the rows show without one.
 */
export function ListSection({
  children,
  ...header
}: Parameters<typeof ListSectionHeader>[0] & { children: ReactNode }) {
  return (
    <section aria-label={header.label || undefined} className="pt-2">
      {header.label ? <ListSectionHeader {...header} /> : null}
      {header.fold && !header.fold.open ? null : <div className="px-2">{children}</div>}
    </section>
  );
}
