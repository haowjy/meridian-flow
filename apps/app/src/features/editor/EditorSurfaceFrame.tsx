import { type ReactNode, type Ref, type UIEventHandler, useRef } from "react";

import { useScrollEdges } from "@/hooks/use-scroll-edges";
import { cn } from "@/lib/utils";
import { editorColumnChrome } from "./editor-column";

export type EditorSurfaceFrameProps = {
  notices?: ReactNode;
  toolbar?: ReactNode;
  toolbarHeld?: ReactNode;
  toolbarTrailing?: ReactNode;
  children: ReactNode;
  textCursor?: boolean;
  scrollClassName?: string;
  scrollRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
};

export function EditorSurfaceFrame({
  notices,
  toolbar,
  toolbarHeld,
  toolbarTrailing,
  children,
  textCursor,
  scrollClassName,
  scrollRef,
  onScroll,
}: EditorSurfaceFrameProps) {
  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      {notices ? (
        <div className={cn(editorColumnChrome, "flex shrink-0 flex-col gap-1.5 pt-2 empty:hidden")}>
          {notices}
        </div>
      ) : null}
      {toolbar || toolbarHeld ? (
        <div
          className={cn("flex h-8 shrink-0 items-center coarse:h-11", toolbarHeld && "bg-review")}
        >
          <div className="min-w-0 flex-1 basis-0" />
          {toolbarHeld ? (
            <div className={cn(editorColumnChrome, "flex h-full min-w-0")}>{toolbarHeld}</div>
          ) : (
            <ToolbarScroller>{toolbar}</ToolbarScroller>
          )}
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
