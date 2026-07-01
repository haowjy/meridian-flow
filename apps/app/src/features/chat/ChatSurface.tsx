/**
 * ChatSurface — the viewport-locked frame shared by every chat view.
 *
 * Provides the `main-pane` shell, the visually-hidden page heading, an optional
 * fixed header, a flex body slot, and a pinned composer footer. The conversation
 * body owns its OWN (single) scroll — see `TurnList`; this frame only positions the
 * body and the pinned composer over it.
 *
 * The pinned footer is variable-height (composer growth + the unanchored-drafts
 * review strip), so this frame MEASURES it and exposes the height via
 * `ChatSurfaceBottomInsetContext`. The transcript reads that inset as its virtual
 * `paddingEnd`, so the last turn rests above the composer AND "scrolled to the end"
 * lines up exactly with it (no dead gap, no phantom scroll). Used by `ChatView`.
 */
import type { ReactNode, RefObject } from "react";
import { createContext, useContext, useLayoutEffect, useRef, useState } from "react";

import { ChatColumn } from "./ChatColumn";

/** Measured height (px) of the pinned composer footer; the transcript's bottom inset. */
const ChatSurfaceBottomInsetContext = createContext(0);

export function useChatSurfaceBottomInset(): number {
  return useContext(ChatSurfaceBottomInsetContext);
}

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
  const footerRef = useRef<HTMLDivElement | null>(null);
  const [bottomInset, setBottomInset] = useState(0);

  // Measure the pinned footer so the transcript can pad its end to match. Layout
  // effect so the first paint already has the inset (no flash of content behind the
  // composer). We only measure — the transcript owns scroll/follow.
  useLayoutEffect(() => {
    const footerElement = footerRef.current;
    if (!hasFooter || !footerElement) {
      setBottomInset(0);
      return;
    }
    const sync = () => setBottomInset(Math.ceil(footerElement.getBoundingClientRect().height));
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(footerElement);
    return () => observer.disconnect();
  }, [hasFooter]);

  return (
    <div
      ref={surfaceRef}
      className="main-pane relative flex h-full w-full flex-col overflow-hidden"
    >
      <h1 className="visually-hidden">{title}</h1>

      {header}

      <div className="relative flex min-h-0 flex-1 flex-col">
        <ChatSurfaceBottomInsetContext.Provider value={bottomInset}>
          {children}
        </ChatSurfaceBottomInsetContext.Provider>
      </div>

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
