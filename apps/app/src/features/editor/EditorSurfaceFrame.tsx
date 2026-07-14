/** Shared docked-toolbar and scrolling layout for document editor surfaces. */
import type { ReactNode, Ref, UIEventHandler } from "react";

import { cn } from "@/lib/utils";
import { editorColumnChrome } from "./editor-column";

export type EditorSurfaceFrameProps = {
  toolbar?: ReactNode;
  children: ReactNode;
  scrollClassName?: string;
  scrollRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
};

export function EditorSurfaceFrame({
  toolbar,
  children,
  scrollClassName,
  scrollRef,
  onScroll,
}: EditorSurfaceFrameProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {toolbar ? (
        // Docked in flow above the scroll area, aligned to the prose column —
        // no rule below it, separation from the prose is whitespace only.
        // Being a sibling of the scroll container keeps it in place while
        // text scrolls beneath.
        <div className="flex h-9 shrink-0 items-center">
          <div className={editorColumnChrome}>{toolbar}</div>
        </div>
      ) : null}
      <div
        ref={scrollRef}
        className={cn("flex min-h-0 flex-1 overflow-y-auto", scrollClassName)}
        data-stable-layout-scroll
        onScroll={onScroll}
      >
        {children}
      </div>
    </div>
  );
}
