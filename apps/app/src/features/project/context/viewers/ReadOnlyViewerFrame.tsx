/**
 * ReadOnlyViewerFrame — shared chrome for non-tracked file viewers: the viewer body and an
 * optional viewer-owned footer. The host's own chrome names the file (main's chip, the side
 * header, the phone's top bar).
 */
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type ReadOnlyViewerFrameProps = {
  /** Inline viewer surface (image, PDF object, etc). */
  children: ReactNode;
  /** Optional footer slot — viewer-specific actions/status. */
  footer?: ReactNode;
  /** The frame's material; a host that paints its own passes `bg-transparent`. */
  className?: string;
};

export function ReadOnlyViewerFrame({ children, footer, className }: ReadOnlyViewerFrameProps) {
  return (
    <section className={cn("flex h-full min-h-0 flex-col bg-background", className)}>
      <div
        className="min-h-0 flex-1"
        style={{
          paddingLeft: "env(safe-area-inset-left)",
          paddingRight: "env(safe-area-inset-right)",
        }}
      >
        {children}
      </div>
      {footer ? (
        <footer
          className="flex shrink-0 items-center justify-between gap-2 border-t border-border-subtle px-4 pb-2 pt-2 text-xs text-muted-foreground"
          style={{
            paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom))",
            paddingLeft: "calc(1rem + env(safe-area-inset-left))",
            paddingRight: "calc(1rem + env(safe-area-inset-right))",
          }}
        >
          {footer}
        </footer>
      ) : null}
    </section>
  );
}
