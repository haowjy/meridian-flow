// @ts-nocheck
/**
 * ResizeHandle — pointer-drag resize that mutates `grid-template-columns` on a
 * target container imperatively (no React re-render per pointermove).
 *
 * GATE #2 (the GO/NO-GO for the whole spike). Specifically this proves that
 * even when the drag sweeps DEEP into a live contenteditable, the drag is not
 * stolen — no caret move, no text selection, no focus steal — and `pointerup`
 * over the editor completes the drag cleanly.
 *
 * The mechanism is two-layered:
 *
 *   1. `setPointerCapture(pointerId)` on `pointerdown` — re-routes every
 *      subsequent pointermove/pointerup for that pointerId to THIS element, so
 *      the contenteditable simply never sees a `mousedown` start a selection.
 *   2. A full-viewport SHIELD `<div>` is mounted ONLY while a drag is active:
 *      `position:fixed; inset:0; cursor:col-resize; user-select:none;
 *      pointer-events:auto; z-index:9999`. This belt-and-braces guarantees
 *      that nothing the pointer happens to fly over (iframes, selects, custom
 *      pointer-event listeners on nested elements) can intercept the drag. We
 *      also forward the shield's pointermove to the same update path.
 *
 * Per-pointermove path:
 *   - Read clientX,
 *   - Compute new left-slot width (clamped),
 *   - Write `target.style.gridTemplateColumns = `${w}px <handle> 1fr`` directly.
 *   - NO setState. The Motion `layout` parent will not re-flow because we own
 *     the columns, and React render-counters won't tick.
 *
 * On `pointerup` we commit the final width into a ref the consumer can read.
 *
 * The handle is a sibling of the contenteditable, never a descendant of it.
 * Per the integration report (p1506): the editor installs no
 * pointerdown/move/up handlers, dropcursor + gapcursor are disabled, and the
 * only "drag" handlers are native HTML5 DragEvent for figure uploads — they do
 * not fire on a synthetic pointermove. So the shield is the only intercept we
 * need at the document level.
 */
import { useCallback, useRef, useState } from "react";

export type ResizeHandleProps = {
  /** The element whose `grid-template-columns` we mutate during drag. */
  gridRef: React.RefObject<HTMLElement | null>;
  /**
   * Builds the `grid-template-columns` value for a given left-column width
   * (in pixels). The handle column is always the second track.
   */
  formatGridTemplate: (leftWidthPx: number) => string;
  /** Current committed left-column width in px. */
  initialLeftWidthPx: number;
  /** Inclusive min/max width in px. */
  minLeftWidthPx?: number;
  maxLeftWidthPx?: number;
  /** Called on pointerup with the committed width. */
  onCommit?: (widthPx: number) => void;
  /** A label for the visible handle (a11y). */
  ariaLabel?: string;
  /** Optional render-count probe; called once per *mount*, used by gate #6. */
  onMount?: () => void;
};

export function ResizeHandle({
  gridRef,
  formatGridTemplate,
  initialLeftWidthPx,
  minLeftWidthPx = 240,
  maxLeftWidthPx = 1200,
  onCommit,
  ariaLabel = "Resize column",
}: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  // Live width during drag — kept in a ref so pointermove never causes a render.
  const liveWidthRef = useRef(initialLeftWidthPx);
  // Pointer X at drag start, plus the left-width at drag start.
  const dragOriginRef = useRef<{ pointerX: number; startWidth: number } | null>(null);
  const handleElRef = useRef<HTMLDivElement | null>(null);
  const activePointerIdRef = useRef<number | null>(null);

  const writeWidth = useCallback(
    (widthPx: number) => {
      const target = gridRef.current;
      if (!target) return liveWidthRef.current;
      const clamped = Math.min(Math.max(widthPx, minLeftWidthPx), maxLeftWidthPx);
      liveWidthRef.current = clamped;
      target.style.gridTemplateColumns = formatGridTemplate(clamped);
      handleElRef.current?.setAttribute("aria-valuenow", String(Math.round(clamped)));
      return clamped;
    },
    [gridRef, formatGridTemplate, minLeftWidthPx, maxLeftWidthPx],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent | PointerEvent) => {
      const origin = dragOriginRef.current;
      if (!origin) return;
      const delta = event.clientX - origin.pointerX;
      writeWidth(origin.startWidth + delta);
    },
    [writeWidth],
  );

  const endDrag = useCallback(() => {
    const handle = handleElRef.current;
    const pointerId = activePointerIdRef.current;
    if (handle && pointerId != null && handle.hasPointerCapture(pointerId)) {
      handle.releasePointerCapture(pointerId);
    }
    activePointerIdRef.current = null;
    dragOriginRef.current = null;
    setDragging(false);
    onCommit?.(liveWidthRef.current);
  }, [onCommit]);

  const onHandlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // Only left button.
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = handleElRef.current;
    if (!handle) return;
    handle.setPointerCapture(event.pointerId);
    activePointerIdRef.current = event.pointerId;
    dragOriginRef.current = {
      pointerX: event.clientX,
      startWidth: liveWidthRef.current,
    };
    setDragging(true);
  }, []);

  const onHandlePointerUp = useCallback(
    (_event: React.PointerEvent<HTMLDivElement>) => {
      endDrag();
    },
    [endDrag],
  );

  const onHandlePointerCancel = useCallback(
    (_event: React.PointerEvent<HTMLDivElement>) => {
      endDrag();
    },
    [endDrag],
  );

  const onHandleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      let nextWidth: number | null = null;
      if (event.key === "ArrowLeft") nextWidth = liveWidthRef.current - 8;
      if (event.key === "ArrowRight") nextWidth = liveWidthRef.current + 8;
      if (event.key === "Home") nextWidth = minLeftWidthPx;
      if (event.key === "End") nextWidth = maxLeftWidthPx;
      if (nextWidth === null) return;
      event.preventDefault();
      onCommit?.(writeWidth(nextWidth));
    },
    [maxLeftWidthPx, minLeftWidthPx, onCommit, writeWidth],
  );

  // Shield catches anything that slips past pointer capture (defensive). Both
  // the handle (via pointer capture) and the shield route move/up to the same
  // logic; whichever fires first writes the new width.
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: this is an interactive adjustable separator; a static <hr> cannot own the drag handlers. */}
      <div
        ref={handleElRef}
        role="separator"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-orientation="vertical"
        aria-valuemin={minLeftWidthPx}
        aria-valuemax={maxLeftWidthPx}
        aria-valuenow={Math.round(liveWidthRef.current)}
        data-spike-resize-handle
        onPointerDown={onHandlePointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerCancel}
        onKeyDown={onHandleKeyDown}
        className="group relative z-10 flex h-full w-2 cursor-col-resize touch-none select-none items-center justify-center"
        style={{ touchAction: "none" }}
      >
        <div
          className={
            "h-12 w-[3px] rounded-full bg-border transition-colors group-hover:bg-primary " +
            (dragging ? "!bg-primary" : "")
          }
        />
      </div>
      {dragging ? (
        <div
          data-spike-resize-shield
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          style={{
            position: "fixed",
            inset: 0,
            cursor: "col-resize",
            // Critical: catches stray pointer events over the editor.
            pointerEvents: "auto",
            userSelect: "none",
            // Above editor content (which lives well below this in z-order).
            zIndex: 9999,
            // Transparent — we don't want to occlude the live width preview.
            background: "transparent",
          }}
        />
      ) : null}
    </>
  );
}
