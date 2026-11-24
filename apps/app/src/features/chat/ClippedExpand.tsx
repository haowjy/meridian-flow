import { Trans } from "@lingui/react/macro";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
    setClipped(node.scrollHeight - node.clientHeight > 1);
  }, []);

  useEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    measure();
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
      {clipped && footer ? <div className="mt-[var(--chat-space-inline)]">{footer}</div> : null}
    </div>
  );
}

export function ExpandableProse({ children, more }: { children: ReactNode; more: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const toggle = (
    <Button
      type="button"
      variant="quiet"
      size="meta"
      aria-expanded={expanded}
      aria-controls={bodyId}
      onClick={() => setExpanded((value) => !value)}
    >
      {expanded ? <Trans>Show less</Trans> : more}
    </Button>
  );
  return (
    <div id={bodyId}>
      {expanded ? (
        <>
          {children}
          <div className="mt-[var(--chat-space-inline)]">{toggle}</div>
        </>
      ) : (
        <ClippedProse footer={toggle}>{children}</ClippedProse>
      )}
    </div>
  );
}

export function BoundLine({ children }: { children: ReactNode }) {
  return <p className="mt-[var(--chat-space-inline)] text-xs text-muted-foreground">{children}</p>;
}
