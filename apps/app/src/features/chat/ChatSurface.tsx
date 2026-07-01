/**
 * ChatSurface — the viewport-locked frame shared by every chat view.
 *
 * Provides the `main-pane` shell, the visually-hidden page heading, an optional
 * designated scroll region, a `ChatColumn` body, and a pinned composer footer.
 * Owns the chat scroll/overflow chrome; conversation content is passed in as
 * children. Used by `ChatView` and the compose (draft) surfaces.
 */
import type { ReactNode, Ref, RefObject } from "react";
import { useCallback, useLayoutEffect, useRef } from "react";

import { cn } from "@/lib/utils";

import { ChatColumn } from "./ChatColumn";

export type ChatSurfaceProps = {
  /** Screen-reader page title. */
  title: string;
  surfaceRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
  footer?: ReactNode;
  /** Fixed thread chrome (title + switcher) rendered above the scroll region. */
  header?: ReactNode;
  /** When set, main content scrolls (conversation layout). */
  scrollRef?: Ref<HTMLDivElement>;
  onScroll?: () => void;
  scrollAriaLabel?: string;
  scrollClassName?: string;
  /**
   * Bottom-edge mask on the scrollport so messages fade behind the pinned composer.
   * Defaults to `true` when `footer` is set; pass `false` to keep scroll content sharp.
   */
  scrollFadeBottom?: boolean;
  /** Compose-only: pin content to the bottom (draft new chat). */
  composePinned?: boolean;
};

export function ChatSurface({
  title,
  surfaceRef,
  children,
  footer,
  header,
  scrollRef,
  onScroll,
  scrollAriaLabel,
  scrollClassName,
  scrollFadeBottom,
  composePinned = false,
}: ChatSurfaceProps) {
  const hasFooter = Boolean(footer);
  const showScrollFadeBottom = scrollFadeBottom ?? hasFooter;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);
  const setRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;
      if (surfaceRef) surfaceRef.current = node;
    },
    [surfaceRef],
  );

  const setScrollElementRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollElementRef.current = node;
      assignRef(scrollRef, node);
    },
    [scrollRef],
  );

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
      const scrollElement = scrollElementRef.current;
      const wasPinnedToBottom = scrollElement
        ? scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight <= 8
        : false;
      const nextClearance = Math.ceil(footerElement.getBoundingClientRect().height);

      root.style.setProperty("--chat-footer-clearance", `${nextClearance}px`);

      if (scrollElement && wasPinnedToBottom) {
        scrollElement.scrollTop = scrollElement.scrollHeight;
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => {
            scrollElement.scrollTop = scrollElement.scrollHeight;
          });
        }
      }
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

      {composePinned ? (
        <div className="main-pane flex flex-1 flex-col justify-end pb-5">
          <ChatColumn className={scrollClassName}>{children}</ChatColumn>
        </div>
      ) : (
        <div
          ref={setScrollElementRef}
          onScroll={onScroll}
          role="log"
          aria-label={scrollAriaLabel}
          className={cn(
            "main-pane flex-1 overflow-y-auto",
            showScrollFadeBottom && "chat-scroll-fade-bottom",
          )}
          style={hasFooter ? { paddingBottom: "var(--chat-footer-clearance, 0px)" } : undefined}
          data-stable-layout-scroll
        >
          <ChatColumn className={scrollClassName}>{children}</ChatColumn>
        </div>
      )}

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

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  ref.current = value;
}
