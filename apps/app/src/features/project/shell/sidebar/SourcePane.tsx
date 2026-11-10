import { type HTMLAttributes, type ReactNode, useRef } from "react";
import { role } from "@/components/ui/roles";
import { dragPayloadKind } from "@/core/editor/landing/drag-payload";
import { dragEdgeScroll } from "@/core/editor/landing/edge-scroll";
import { cn } from "@/lib/utils";
import { PaneHeaderActions } from "../../context/RailPaneHeader";
import { DropRegion } from "../../context/tree-drop/DropRegion";
import type { TreeDropState } from "../../context/tree-drop/tree-drop";

/** A list's drop at its root: where a row lands when it is let go anywhere but on a row. */
export type SourceDrop = {
  dropProps: HTMLAttributes<HTMLElement>;
  dropState: TreeDropState;
};

/**
 * The frame every sidebar list shares: its name and actions held still above
 * one scroller of rows, and, with a `drop`, the whole pane as one target at
 * the list's root. Rows that are targets of their own claim their drags first
 * (`tree-drop.tsx`), so the pane takes only what lands on the heading, a
 * row that isn't a target, or the space below the rows.
 */
export function SourcePane({
  label,
  title,
  actions,
  bar,
  drop,
  children,
}: {
  label: string;
  /** Tooltip and accessible name, for a list whose full name is longer than its label. */
  title?: string;
  actions?: ReactNode;
  /** Controls too wide for the heading's line, held still on their own line under it. */
  bar?: ReactNode;
  drop?: SourceDrop;
  children: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  return (
    <DropRegion state={drop?.dropState ?? "idle"} className="flex min-h-0 flex-1 flex-col">
      <div {...drop?.dropProps} className="flex min-h-0 flex-1 flex-col">
        <div data-rail-pane-header className="mx-2 flex h-7 shrink-0 items-center">
          <h2
            title={title}
            aria-label={title}
            className={cn("min-w-0 flex-1 truncate pr-1 pl-1.5", role.groupLabel)}
          >
            {label}
          </h2>
          <PaneHeaderActions actions={actions} />
        </div>
        {bar ? <div className="mx-2 flex shrink-0 items-center justify-end pb-1">{bar}</div> : null}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: scrolling at the edges while dragging. slop-lint: allow suppression the reason is stated in this comment */}
        <div
          ref={scroller}
          onDragOver={(event) => {
            if (dragPayloadKind(Array.from(event.dataTransfer.types)) !== "none")
              dragEdgeScroll(scroller.current, event.clientY);
          }}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden pb-2"
        >
          {children}
        </div>
      </div>
    </DropRegion>
  );
}

/** A line standing in for a list's rows: loading, empty, or what the list needs first. */
export function SourceHint({
  children,
  status = false,
}: {
  children: ReactNode;
  status?: boolean;
}) {
  return (
    <p
      role={status ? "status" : undefined}
      aria-live={status ? "polite" : undefined}
      className={cn("pr-2 pl-3.5 leading-snug", role.emptyLine)}
    >
      {children}
    </p>
  );
}
