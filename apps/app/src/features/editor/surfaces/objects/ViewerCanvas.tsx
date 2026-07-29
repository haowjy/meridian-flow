/**
 * The lightbox's viewer face: a dot-grid canvas with the object floating on it
 * and one zoom pill along the bottom (mockup 04).
 *
 * The React half is deliberately thin — mount, measure, and read back a
 * percentage. Every gesture lives in viewer-core, which is why the same
 * component serves a rendered diagram and an image without a branch.
 */

import { t } from "@lingui/core/macro";
import { Maximize, Minus, Plus } from "lucide-react";
import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  createPanZoomViewer,
  intrinsicContentSize,
  type PanZoomViewer,
} from "@/core/editor/viewer";

export type ViewerCanvasProps = {
  children: ReactNode;
  /**
   * Changes when the content is replaced, so the stage is re-measured. A live
   * preview re-renders under a viewer that keeps the writer's pan and zoom.
   */
  contentKey: string;
  /** Ceiling on Fit. A raster passes 1 rather than opening enlarged and soft. */
  maxFitScale?: number;
};

export function ViewerCanvas({ children, contentKey, maxFitScale }: ViewerCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PanZoomViewer | null>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const host = hostRef.current;
    const stage = stageRef.current;
    if (!host || !stage) return;

    const viewer = createPanZoomViewer({ host, content: stage, maxFitScale });
    viewerRef.current = viewer;
    setScale(viewer.scale);
    const unsubscribe = viewer.subscribe(() => setScale(viewer.scale));

    return () => {
      unsubscribe();
      viewer.destroy();
      viewerRef.current = null;
    };
  }, [maxFitScale]);

  /**
   * The stage carries the content's intrinsic size because the content itself
   * usually will not: mermaid emits `width="100%"`, and an unsized wrapper
   * around it measures zero and fits to nothing.
   */
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const measure = () => {
      const media = stage.querySelector("svg, img");
      const size = media ? intrinsicContentSize(media) : null;
      if (!size) return;
      stage.style.width = `${size.width}px`;
      stage.style.height = `${size.height}px`;
      viewerRef.current?.resize();
    };

    measure();

    // An image has no natural size until it has loaded, and the diagram it
    // stands beside would otherwise fit to a one-pixel box.
    const image = stage.querySelector("img");
    if (!image || image.complete) return;
    image.addEventListener("load", measure);
    return () => image.removeEventListener("load", measure);
  }, [contentKey]);

  const step = useCallback((factor: number) => {
    viewerRef.current?.zoomBy(factor);
  }, []);

  return (
    // The pill is a SIBLING of the gesture host, not a child of it. The viewer
    // takes pointer capture on `pointerdown` anywhere in its host, which would
    // redirect the `pointerup` away from a button inside and swallow the click
    // — measured in the browser, not guessed at. The host is the viewport;
    // chrome sits beside it.
    <div className="meridian-viewer-frame">
      <div className="meridian-viewer-canvas" ref={hostRef}>
        <div className="meridian-viewer-stage" ref={stageRef}>
          {children}
        </div>
      </div>

      <div className="meridian-viewer-pill">
        <IconButton
          type="button"
          size="sm"
          variant="ghost"
          aria-label={t`Zoom out`}
          onClick={() => step(1 / 1.6)}
        >
          <Minus aria-hidden />
        </IconButton>
        <span className="meridian-viewer-percent" aria-live="polite">
          {`${Math.round(scale * 100)}%`}
        </span>
        <IconButton
          type="button"
          size="sm"
          variant="ghost"
          aria-label={t`Zoom in`}
          onClick={() => step(1.6)}
        >
          <Plus aria-hidden />
        </IconButton>
        <span className="meridian-viewer-pill-divider" aria-hidden />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 px-2 text-xs"
          onClick={() => viewerRef.current?.fit()}
        >
          <Maximize className="size-3.5" aria-hidden />
          {t`Fit`}
        </Button>
      </div>
    </div>
  );
}
