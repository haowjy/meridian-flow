/**
 * ResizeHandle provides imperative pointer resizing for stable slot grids.
 *
 * Purpose: resize a CSS-grid track without routing every pointermove through
 * React. Key decision: the handle is absolutely positioned so its transparent
 * hit target can straddle a zero-width grid seam while the narrow visible pill
 * remains centered; pointer capture plus a drag-time full-viewport shield keeps
 * drags reliable over editors and other rich surfaces, and the assignment map
 * receives the committed width only on pointerup or keyboard commit.
 *
 * `measure` re-reads the pane's live size and bounds when an interaction
 * starts, for panes whose default size is content-driven.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export type ResizeHandleProps = {
  gridRef: React.RefObject<HTMLElement | null>;
  cssVariableName: `--${string}`;
  /** `null` leaves the variable unset: the pane keeps its default size. */
  widthPx: number | null;
  minWidthPx: number;
  maxWidthPx: number;
  onCommit: (widthPx: number) => void;
  /** The pane's live size and bounds, read when a drag or key press begins. */
  measure?: () => { value: number; min: number; max: number };
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
  measure,
}: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const liveWidthRef = useRef(widthPx ?? minWidthPx);
  const boundsRef = useRef({ min: minWidthPx, max: maxWidthPx });
  const dragOriginRef = useRef<{ pointer: number; startWidth: number } | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const activePointerIdRef = useRef<number | null>(null);

  // INVARIANT: CSS var writes (setProperty) must never be read back into
  // React state in the render/layout path. Doing so would close a loop:
  //   render → setProperty → style recalc → React read → setState → render
  // and trigger a "Maximum update depth exceeded" crash.
  useEffect(() => {
    if (dragOriginRef.current) return;
    if (widthPx === null) {
      gridRef.current?.style.removeProperty(cssVariableName);
      return;
    }
    liveWidthRef.current = widthPx;
    gridRef.current?.style.setProperty(cssVariableName, `${widthPx}px`);
  }, [cssVariableName, gridRef, widthPx]);

  /** Re-read a content-sized pane's live size and bounds as an interaction starts. */
  const beginMeasured = useCallback(() => {
    boundsRef.current = { min: minWidthPx, max: maxWidthPx };
    if (!measure) return;
    const live = measure();
    liveWidthRef.current = live.value;
    boundsRef.current = { min: live.min, max: Math.max(live.min, live.max) };
  }, [maxWidthPx, measure, minWidthPx]);

  const writeWidth = useCallback(
    (nextWidthPx: number) => {
      const clamped = clamp(nextWidthPx, boundsRef.current.min, boundsRef.current.max);
      liveWidthRef.current = clamped;
      gridRef.current?.style.setProperty(cssVariableName, `${clamped}px`);
      return clamped;
    },
    [cssVariableName, gridRef],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent | PointerEvent) => {
      const origin = dragOriginRef.current;
      if (!origin) return;
      writeWidth(origin.startWidth + (event.clientX - origin.pointer) * dragDirection);
    },
    [dragDirection, writeWidth],
  );

  const endDrag = useCallback(() => {
    if (!dragOriginRef.current && activePointerIdRef.current === null) return;
    const pointerId = activePointerIdRef.current;
    const startWidth = dragOriginRef.current?.startWidth;
    const handle = handleRef.current;
    if (handle && pointerId !== null && handle.hasPointerCapture(pointerId)) {
      handle.releasePointerCapture(pointerId);
    }
    activePointerIdRef.current = null;
    dragOriginRef.current = null;
    setDragging(false);
    // A click that moved nothing (the first half of a double-click) commits nothing.
    if (liveWidthRef.current !== startWidth) onCommit(liveWidthRef.current);
  }, [onCommit]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const handle = handleRef.current;
      if (!handle) return;
      handle.setPointerCapture(event.pointerId);
      activePointerIdRef.current = event.pointerId;
      beginMeasured();
      dragOriginRef.current = {
        pointer: event.clientX,
        startWidth: liveWidthRef.current,
      };
      setDragging(true);
    },
    [beginMeasured],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      let nextWidth: number | null = null;
      if (
        event.key !== "ArrowLeft" &&
        event.key !== "ArrowRight" &&
        event.key !== "Home" &&
        event.key !== "End"
      )
        return;
      beginMeasured();
      if (event.key === "ArrowLeft") nextWidth = liveWidthRef.current - keyboardStepPx;
      if (event.key === "ArrowRight") nextWidth = liveWidthRef.current + keyboardStepPx;
      if (event.key === "Home") nextWidth = boundsRef.current.min;
      if (event.key === "End") nextWidth = boundsRef.current.max;
      if (nextWidth === null) return;
      event.preventDefault();
      onCommit(writeWidth(nextWidth));
    },
    [beginMeasured, keyboardStepPx, onCommit, writeWidth],
  );

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: this is an interactive adjustable separator; a static <hr> cannot own the drag and keyboard handlers. slop-lint: allow suppression the reason is stated in this comment */}
      <div
        ref={handleRef}
        role="separator"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-orientation="vertical"
        aria-valuemin={boundsRef.current.min}
        aria-valuemax={boundsRef.current.max}
        aria-valuenow={Math.round(liveWidthRef.current)}
        data-stable-layout-resize-handle
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        className={cn(
          "group absolute z-20 flex touch-none select-none items-center justify-center focus-ring",
          "top-0 left-1/2 h-full w-3 -translate-x-1/2 cursor-col-resize",
          className,
        )}
        style={{ touchAction: "none" }}
      >
        {/* No visible grip — region separation is tonal, and any colored pill
            reads as debris on the shelf edge. The col-resize cursor is the
            hover affordance; keyboard focus shows via the container's
            focus-ring; drag feedback is the moving seam itself. */}
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
