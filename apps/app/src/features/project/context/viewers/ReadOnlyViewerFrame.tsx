/**
 * ReadOnlyViewerFrame — shared chrome for non-tracked file viewers.
 *
 * Hosts compose this frame around viewer bodies and optional viewer-owned
 * footers. Header ownership is explicit: pass a file header when the surrounding
 * chrome does not name the file, as the trash record does. `ContextViewerHost`
 * omits it: the Editor's path, the dock's title chip and the phone's top bar
 * already name the file.
 */
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type ReadOnlyViewerHeader = { name: string; path: string };

export type ReadOnlyViewerFrameProps = {
  /** File identity, for a host whose chrome does not already name the file. */
  header?: ReadOnlyViewerHeader;
  /** Inline viewer surface (image, PDF object, etc). */
  children: ReactNode;
  /** Optional footer slot — viewer-specific actions/status. */
  footer?: ReactNode;
  /** The frame's material; a host that paints its own passes `bg-transparent`. */
  className?: string;
};

export function ReadOnlyViewerFrame({
  header,
  children,
  footer,
  className,
}: ReadOnlyViewerFrameProps) {
  return (
    <section className={cn("flex h-full min-h-0 flex-col bg-background", className)}>
      {header ? (
        <header
          className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4 pb-2.5 pt-2.5"
          style={{
            paddingTop: "calc(0.625rem + env(safe-area-inset-top))",
            paddingLeft: "calc(1rem + env(safe-area-inset-left))",
            paddingRight: "calc(1rem + env(safe-area-inset-right))",
          }}
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground">{header.name}</div>
            <div className="truncate font-mono text-xs text-muted-foreground">{header.path}</div>
          </div>
        </header>
      ) : null}
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
