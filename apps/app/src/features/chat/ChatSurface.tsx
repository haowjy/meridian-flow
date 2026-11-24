import type { ReactNode, RefObject } from "react";
import { createContext, useContext, useLayoutEffect, useRef, useState } from "react";

import { ChatColumn } from "./ChatColumn";

const ChatSurfaceBottomInsetContext = createContext(0);

export function useChatSurfaceBottomInset(): number {
  return useContext(ChatSurfaceBottomInsetContext);
}

export type ChatSurfaceProps = {
  title: string;
  surfaceRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
  footer?: ReactNode;
  header?: ReactNode;
};

export function ChatSurface({ title, surfaceRef, children, footer, header }: ChatSurfaceProps) {
  const hasFooter = Boolean(footer);
  const footerRef = useRef<HTMLDivElement | null>(null);
  const [bottomInset, setBottomInset] = useState(0);

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
      className="main-pane text-tier-chat relative flex h-full w-full flex-col overflow-hidden"
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
