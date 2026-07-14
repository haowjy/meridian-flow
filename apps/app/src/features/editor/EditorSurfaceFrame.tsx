/** Shared docked-toolbar and scrolling layout for document editor surfaces. */
import type { ReactNode, Ref, UIEventHandler } from "react";

import { cn } from "@/lib/utils";

export type EditorSurfaceFrameProps = {
  toolbar?: ReactNode;
  /**
   * Horizontal alignment of the toolbar row's content within the host's text
   * coordinate system — the toolbar should start where the prose starts.
   */
  toolbarPositionClassName: string;
  children: ReactNode;
  scrollClassName?: string;
  scrollRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
};

export function EditorSurfaceFrame({
  toolbar,
  toolbarPositionClassName,
  children,
  scrollClassName,
  scrollRef,
  onScroll,
}: EditorSurfaceFrameProps) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {toolbar ? (
        // Docked in flow above the scroll area — no rule below it, separation
        // from the prose is whitespace only. Being a sibling of the scroll
        // container keeps it in place while text scrolls beneath.
        <div className="flex h-9 shrink-0 items-center">
          <div className={toolbarPositionClassName}>{toolbar}</div>
        </div>
      ) : null}
      <div
        ref={scrollRef}
        className={cn(
          "flex min-h-0 flex-1 overflow-y-auto",
          // Hosts pad ProseMirror for the toolbar-less case; when the docked
          // row is present it already provides the top breathing room, so trim
          // the prose's own reserve.
          toolbar && "[&_.ProseMirror]:pt-4",
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
