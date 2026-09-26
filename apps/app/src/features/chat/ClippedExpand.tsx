/** ClippedExpand — the two honest ways an expand can be cut, and how it says so. */
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Roughly a third of a docked-chat viewport, shared with the stream tail so no
 * expand type towers over another.
 */
const PROSE_CLAMP = "max-h-48";

const BOTTOM_FADE = "[mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)]";

export type ClippedProseProps = {
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
};

export function ClippedProse({ children, footer, className }: ClippedProseProps) {
  const [clipped, setClipped] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const measure = useCallback(() => {
    const node = contentRef.current;
    if (!node) return;
    // A fade over content that fits is a lie about there being more.
    setClipped(node.scrollHeight - node.clientHeight > 1);
  }, []);

  useEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    measure();
    // Markup renders asynchronously (fonts, images, highlighted code), and the
    // docked chat resizes; either can turn a complete passage into a clipped one.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    for (const child of Array.from(node.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div className="min-w-0">
      <div
        ref={contentRef}
        className={cn(PROSE_CLAMP, "overflow-hidden", clipped && BOTTOM_FADE, className)}
      >
        {children}
      </div>
      {clipped && footer ? <div className="mt-1">{footer}</div> : null}
    </div>
  );
}

/** A fact about what a capped list left out. Never an invitation. */
export function BoundLine({ children }: { children: ReactNode }) {
  return <p className="mt-1.5 text-meta text-ink-subtle">{children}</p>;
}
