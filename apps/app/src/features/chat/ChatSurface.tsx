/**
 * ChatSurface — the viewport-locked frame shared by every chat view.
 *
 * Provides the `main-pane` shell, the visually-hidden page heading, an optional
 * designated scroll region, a `ChatColumn` body, and a pinned composer footer.
 * Owns the chat scroll/overflow chrome; conversation content is passed in as
 * children. Used by `ChatView` and the compose (draft) surfaces.
 */
import type { ReactNode, Ref, RefObject } from "react";

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
  const showScrollFadeBottom = scrollFadeBottom ?? Boolean(footer);

  return (
    <div
      ref={surfaceRef}
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
          ref={scrollRef}
          onScroll={onScroll}
          role="log"
          aria-label={scrollAriaLabel}
          className={cn(
            "main-pane flex-1 overflow-y-auto",
            showScrollFadeBottom && "chat-scroll-fade-bottom",
          )}
          data-stable-layout-scroll
        >
          <ChatColumn className={scrollClassName}>{children}</ChatColumn>
        </div>
      )}

      {footer ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0">
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
