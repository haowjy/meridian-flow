/**
 * ChatSurface — the viewport-locked frame shared by every chat view.
 *
 * Provides the `main-pane` shell, the visually-hidden page heading, an optional
 * fixed header, a flex body slot, and a pinned composer footer. The conversation
 * body owns its OWN scroll (see `TurnList` → message-scroller); this frame only
 * positions the body and the pinned composer over it.
 *
 * The pinned footer is variable-height (composer growth + the unanchored-drafts
 * review strip), so we publish its measured height as `--chat-footer-clearance`
 * for the body to pad its final turns clear of the composer. We only MEASURE —
 * the message-scroller owns follow, so there is no scroll repin here. Used by
 * `ChatView`.
 */
import type { ReactNode, RefObject } from "react";
import { useCallback, useLayoutEffect, useRef } from "react";

import { ChatColumn } from "./ChatColumn";

export type ChatSurfaceProps = {
  /** Screen-reader page title. */
  title: string;
  surfaceRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
  footer?: ReactNode;
  /** Fixed thread chrome (title + switcher) rendered above the body. */
  header?: ReactNode;
};

export function ChatSurface({ title, surfaceRef, children, footer, header }: ChatSurfaceProps) {
  const hasFooter = Boolean(footer);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);

  const setRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;
      if (surfaceRef) surfaceRef.current = node;
    },
    [surfaceRef],
  );

  // Publish the pinned footer's height so the self-scrolling body can clear its
  // last turns from behind the composer. The body owns scroll/follow, so we
  // only measure — no manual scroll repin.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    if (!hasFooter) {
      root.style.removeProperty("--chat-footer-clearance");
      return;
    }

    const footerElement = footerRef.current;
    if (!footerElement) return;

    const syncFooterClearance = () => {
      root.style.setProperty(
        "--chat-footer-clearance",
        `${Math.ceil(footerElement.getBoundingClientRect().height)}px`,
      );
    };

    syncFooterClearance();

    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(syncFooterClearance);
    observer.observe(footerElement);
    return () => observer.disconnect();
  }, [hasFooter]);

  return (
    <div
      ref={setRootRef}
      className="main-pane relative flex h-full w-full flex-col overflow-hidden"
    >
      <h1 className="visually-hidden">{title}</h1>

      {header}

      <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>

      {footer ? (
        <div ref={footerRef} className="pointer-events-none absolute inset-x-0 bottom-0">
          <ChatColumn>
            <div
              className="pointer-events-auto pt-3"
              style={{
                paddingBottom:
                  "calc(var(--mobile-keyboard-height, 0px) + max(env(safe-area-inset-bottom), 1.25rem))",
              }}
            >
              {footer}
            </div>
          </ChatColumn>
        </div>
      ) : null}
    </div>
  );
}
