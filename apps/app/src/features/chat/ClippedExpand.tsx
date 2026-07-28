/**
 * ClippedExpand — the two honest ways an expand can be cut, and how it says so.
 *
 * An expand shows the writer a payload the model received or submitted. It is
 * bounded so one chatty tool call can't run the transcript, and the bound is
 * always visible: a cut the writer can't detect is the one kind that misleads.
 *
 * Two cuts, because the payloads differ:
 *
 * - **Continuous prose** ({@link ClippedProse}) clamps by height and fades its
 *   bottom edge. No count: a clipped passage never *looks* complete, and
 *   "first 240 words" is not a unit writers think in.
 * - **Discrete lists** ({@link BoundLine}) cap by item count and state it as a
 *   fact. `4 of 42`, never "Showing…", which is systems voice.
 *
 * **The anchor is the trap.** `StreamTail` is bottom-pinned with a *top* fade,
 * because for a running command the newest output wins. A preview is the
 * opposite: it is **top-anchored with a bottom fade**, because the opening of
 * the passage is what the writer wants. Reusing `StreamTail` here would show
 * the end of the chapter.
 *
 * **No nested scrollports.** The transcript is the single scroll owner, so the
 * clamp is `overflow: hidden` and never `auto`. What a writer cannot see here
 * they reach by opening the document.
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Roughly a third of a docked-chat viewport, shared with the stream tail so no
 * expand type towers over another.
 */
const PROSE_CLAMP = "max-h-48";

/**
 * Fades the last line into the surface instead of cutting a word in half. A
 * mask rather than a gradient overlay: the chat surface is a card on the page
 * sheet and the page tone in the dock, and a hardcoded gradient colour would be
 * wrong in one of them.
 */
const BOTTOM_FADE = "[mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)]";

export type ClippedProseProps = {
  children: ReactNode;
  /**
   * Rendered under the fade, where the need arrives: the writer has read to the
   * bound and wants the rest. Only shown when the content is actually cut,
   * because a way out of a complete passage is noise.
   */
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
