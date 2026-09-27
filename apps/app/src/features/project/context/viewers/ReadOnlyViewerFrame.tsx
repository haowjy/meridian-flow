/**
 * ReadOnlyViewerFrame — shared chrome for non-tracked file viewers.
 *
 * Hosts compose this frame around viewer bodies and optional viewer-owned
 * footers. Header ownership is explicit: pass a file header when the surrounding
 * chrome does not name the file, or a location header when it already does.
 * Phone document screens omit the header because their top bar owns the file.
 */
import type { ReactNode } from "react";

export type ReadOnlyViewerHeader = {
  action?: ReactNode;
} & (
  | {
      /** Writer-facing location label for hosts whose chrome already names the file. */
      location: { name: string; folder?: string };
      name?: never;
      path?: never;
    }
  | { location?: never; name: string; path: string }
);

export type ReadOnlyViewerFrameProps = {
  /** File identity or writer-facing location, depending on the host's chrome. */
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
            {"location" in header && header.location ? (
              <>
                <div className="truncate text-sm font-semibold text-foreground">
                  {header.location.name}
                </div>
                {header.location.folder ? (
                  <div className="truncate text-meta text-muted-foreground">
                    {header.location.folder}
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <div className="truncate text-sm font-semibold text-foreground">{header.name}</div>
                <div className="truncate font-mono text-meta text-ink-subtle">{header.path}</div>
              </>
            )}
          </div>
          {header.action}
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
