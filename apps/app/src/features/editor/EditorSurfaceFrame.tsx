/** Shared pinned-toolbar and scrolling layout for document editor surfaces. */
import type { ReactNode, Ref, UIEventHandler } from "react";

import { cn } from "@/lib/utils";

export type EditorSurfaceFrameProps = {
  toolbar?: ReactNode;
  /** Horizontal placement within the host's text coordinate system. */
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
        <div className={cn("pointer-events-none absolute top-3 z-10", toolbarPositionClassName)}>
          <div className="pointer-events-auto w-fit">{toolbar}</div>
        </div>
      ) : null}
      <div
        ref={scrollRef}
        className={cn(
          "flex min-h-0 flex-1 overflow-y-auto",
          toolbar && "[&_.ProseMirror]:pt-16",
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
