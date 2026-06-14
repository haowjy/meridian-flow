// @ts-nocheck
/**
 * ResizeHandle provides imperative pointer resizing for stable slot grids.
 *
 * Purpose: resize a CSS-grid track without routing every pointermove through
 * React. Key decision: the handle is absolutely positioned so its transparent
 * hit target can straddle a zero-width grid seam while the narrow visible pill
 * remains centered; pointer capture plus a drag-time full-viewport shield keeps
 * drags reliable over editors and other rich surfaces, and the assignment map
 * receives the committed width only on pointerup or keyboard commit.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export type ResizeHandleProps = {
  gridRef: React.RefObject<HTMLElement | null>;
  cssVariableName: `--${string}`;
  widthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
  onCommit: (widthPx: number) => void;
  ariaLabel: string;
  className?: string;
  keyboardStepPx?: number;
  /** Use -1 for handles on a right-side panel's left edge. */
  dragDirection?: 1 | -1;
};

export function ResizeHandle({
  gridRef,
  cssVariableName,
  widthPx,
  minWidthPx,
  maxWidthPx,
  onCommit,
  ariaLabel,
  className,
  keyboardStepPx = 8,
  dragDirection = 1,
}: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const liveWidthRef = useRef(widthPx);
  const dragOriginRef = useRef<{ pointerX: number; startWidth: number } | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const activePointerIdRef = useRef<number | null>(null);

  // INVARIANT: CSS var writes (setProperty) must never be read back into
  // React state in the render/layout path. Doing so would close a loop:
  //   render → setProperty → style recalc → React read → setState → render
  // and trigger a "Maximum update depth exceeded" crash.
  useEffect(() => {
    if (dragOriginRef.current) return;
    liveWidthRef.current = widthPx;
    gridRef.current?.style.setProperty(cssVariableName, `${widthPx}px`);
  }, [cssVariableName, gridRef, widthPx]);

  const writeWidth = useCallback(
    (nextWidthPx: number) => {
      const clamped = clamp(nextWidthPx, minWidthPx, maxWidthPx);
      liveWidthRef.current = clamped;
      gridRef.current?.style.setProperty(cssVariableName, `${clamped}px`);
      return clamped;
    },
    [cssVariableName, gridRef, maxWidthPx, minWidthPx],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent | PointerEvent) => {
      const origin = dragOriginRef.current;
      if (!origin) return;
      writeWidth(origin.startWidth + (event.clientX - origin.pointerX) * dragDirection);
    },
    [dragDirection, writeWidth],
  );

  const endDrag = useCallback(() => {
    if (!dragOriginRef.current && activePointerIdRef.current === null) return;
    const pointerId = activePointerIdRef.current;
    const handle = handleRef.current;
    if (handle && pointerId !== null && handle.hasPointerCapture(pointerId)) {
      handle.releasePointerCapture(pointerId);
    }
    activePointerIdRef.current = null;
    dragOriginRef.current = null;
    setDragging(false);
    onCommit(liveWidthRef.current);
  }, [onCommit]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = handleRef.current;
    if (!handle) return;
    handle.setPointerCapture(event.pointerId);
    activePointerIdRef.current = event.pointerId;
    dragOriginRef.current = {
      pointerX: event.clientX,
      startWidth: liveWidthRef.current,
    };
    setDragging(true);
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      let nextWidth: number | null = null;
      if (event.key === "ArrowLeft") nextWidth = liveWidthRef.current - keyboardStepPx;
      if (event.key === "ArrowRight") nextWidth = liveWidthRef.current + keyboardStepPx;
      if (event.key === "Home") nextWidth = minWidthPx;
      if (event.key === "End") nextWidth = maxWidthPx;
      if (nextWidth === null) return;
      event.preventDefault();
      onCommit(writeWidth(nextWidth));
    },
    [keyboardStepPx, maxWidthPx, minWidthPx, onCommit, writeWidth],
  );

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: this is an interactive adjustable separator; a static <hr> cannot own the drag and keyboard handlers. */}
      <div
        ref={handleRef}
        role="separator"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-orientation="vertical"
        aria-valuemin={minWidthPx}
        aria-valuemax={maxWidthPx}
        aria-valuenow={Math.round(liveWidthRef.current)}
        data-stable-layout-resize-handle
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        className={cn(
          "group absolute top-0 left-1/2 z-20 flex h-full w-3 -translate-x-1/2 cursor-col-resize touch-none select-none items-center justify-center focus-ring",
          className,
        )}
        style={{ touchAction: "none" }}
      >
        <div
          className={cn(
            "h-12 w-1 rounded-full bg-border transition-colors group-hover:bg-primary",
            dragging && "bg-primary",
          )}
        />
      </div>
      {dragging ? (
        <div
          data-stable-layout-resize-shield
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className="z-50"
          style={{
            position: "fixed",
            inset: 0,
            cursor: "col-resize",
            pointerEvents: "auto",
            userSelect: "none",
          }}
        />
      ) : null}
    </>
  );
}
