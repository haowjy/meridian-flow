/** Shared docked-toolbar and scrolling layout for document editor surfaces. */
import { type ReactNode, type Ref, type UIEventHandler, useRef } from "react";

import { useScrollEdges } from "@/hooks/use-scroll-edges";
import { cn } from "@/lib/utils";
import { editorColumnChrome } from "./editor-column";

export type EditorSurfaceFrameProps = {
  /** Notes about this document (schema repair, a fenced session), prose-aligned above the toolbar. */
  notices?: ReactNode;
  /** The persistent document toolbar, docked prose-aligned above the scroll area. */
  toolbar?: ReactNode;
  /** What follows the formatting controls on the toolbar row: the document's state. */
  toolbarTrailing?: ReactNode;
  children: ReactNode;
  /**
   * The whole scroll area is caret territory (the ProseMirror node spans it,
   * so a margin press is the editor's own to answer): the cursor promises it.
   * The pane must not have click-dead margins.
   */
  textCursor?: boolean;
  scrollClassName?: string;
  scrollRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
};

export function EditorSurfaceFrame({
  notices,
  toolbar,
  toolbarTrailing,
  children,
  textCursor,
  scrollClassName,
  scrollRef,
  onScroll,
}: EditorSurfaceFrameProps) {
  return (
    // The container the column insets answer to: the pane, not the viewport.
    <div className="@container flex min-h-0 flex-1 flex-col">
      {notices ? (
        // empty:hidden: a notice that has nothing to say (none yet, or dismissed)
        // renders nothing, and the row must not keep its padding.
        <div className={cn(editorColumnChrome, "flex shrink-0 flex-col gap-1.5 pt-2 empty:hidden")}>
          {notices}
        </div>
      ) : null}
      {toolbar ? (
        // Equal gutters keep the toolbar on the prose column; the state sits at the pane's right
        // edge, in the right gutter, and takes room from the column only when the pane is narrow.
        <div className="flex h-8 shrink-0 items-center coarse:h-11">
          <div className="min-w-0 flex-1 basis-0" />
          {/* The toolbar's geometry is fixed (ten controls, one order), so a
              pane too narrow for it scrolls the row rather than dropping controls. */}
          <ToolbarScroller>{toolbar}</ToolbarScroller>
          <div className="flex flex-1 basis-0 justify-end pr-3">{toolbarTrailing}</div>
        </div>
      ) : null}
      <div
        ref={scrollRef}
        // flex-col so the editor can take the editorColumnFill chain and fill
        // the scroll area.
        // cursor-text: the whole scroll area is caret territory when an editor
        // is attached — the cursor must promise what the press delivers.
        // relative: this pane is the coordinate space every piece of measured
        // chrome is placed in, and the box that clips it
        // (`chrome/manuscript-overlay.ts`), which needs the pane to be the
        // containing block of everything portalled into it.
        className={cn(
          "relative flex min-h-0 flex-1 flex-col overflow-y-auto",
          textCursor && "cursor-text",
          scrollClassName,
        )}
        data-stable-layout-scroll
        onScroll={onScroll}
      >
        {children}
      </div>
    </div>
  );
}

/** Scrolls a toolbar wider than its pane, fading the edge that has buttons behind it. */
function ToolbarScroller({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const more = useScrollEdges(ref);
  return (
    <div
      ref={ref}
      data-more-start={more.start || undefined}
      data-more-end={more.end || undefined}
      className={cn(
        editorColumnChrome,
        "scroll-fade-x min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
      )}
    >
      {children}
    </div>
  );
}
