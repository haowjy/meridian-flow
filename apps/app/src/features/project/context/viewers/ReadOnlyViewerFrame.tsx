/**
 * ReadOnlyViewerFrame — shared chrome for non-tracked file viewers.
 *
 * Hosts compose this frame around viewer bodies and optional viewer-owned
 * footers. Header ownership is explicit: pass a file header when the surrounding
 * chrome does not name the file. The dock's title chip and phone document
 * screens' top bar already name it, so they omit the header.
 */
import type { ReactNode } from "react";

export type ReadOnlyViewerHeader = { name: string; path: string };

export type ReadOnlyViewerFrameProps = {
  /** File identity, for a host whose chrome does not already name the file. */
  header?: ReadOnlyViewerHeader;
  /** Inline viewer surface (image, PDF object, etc). */
  children: ReactNode;
  /** Optional footer slot — viewer-specific actions/status. */
  footer?: ReactNode;
};

export function ReadOnlyViewerFrame({ header, children, footer }: ReadOnlyViewerFrameProps) {
  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
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
            <div className="truncate font-mono text-meta text-ink-subtle">{header.path}</div>
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
          className="flex shrink-0 items-center justify-between gap-2 border-t border-border-subtle px-4 pb-2 pt-2 text-meta text-muted-foreground"
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
