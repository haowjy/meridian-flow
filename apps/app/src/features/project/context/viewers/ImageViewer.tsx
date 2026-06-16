/**
 * ImageViewer — read-only body for `image/*` context/result files.
 *
 * Renders the signed URL inside a contained, centered viewport. No
 * collaboration: the source of truth lives in object storage and the URL is
 * short-lived (re-requested per mount by the host). Phone result figures use a
 * small transform-based touch zoom so pinch gestures stay scoped to the image
 * instead of zooming the whole project shell. Frame/header chrome belongs to
 * hosts; this module exports the body plus its viewer-specific footer slot.
 */
import { Trans } from "@lingui/react/macro";
import { type ReactNode, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export type ImageViewerProps = {
  url: string;
  name: string;
  /** Full-screen phone result viewer fits figures to viewport width first. */
  fitToWidth?: boolean;
};

export type ImageViewerFooterProps = {
  url: string;
  name: string;
};

type TouchGesture =
  | { mode: "pinch"; distance: number; scale: number }
  | { mode: "pan"; x: number; y: number; offsetX: number; offsetY: number };

const MIN_SCALE = 1;
const MAX_SCALE = 4;

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

function touchDistance(touches: React.TouchList): number {
  const first = touches.item(0);
  const second = touches.item(1);
  if (!first || !second) return 0;
  return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
}

export function ImageViewer({ url, name, fitToWidth = false }: ImageViewerProps) {
  return fitToWidth ? (
    <ZoomableFitImage url={url} name={name} />
  ) : (
    <ContainedImage url={url} name={name} />
  );
}

export function imageViewerFooter({ url, name }: ImageViewerFooterProps): ReactNode {
  return (
    <>
      <span>
        <Trans>Read-only preview</Trans>
      </span>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="focus-ring rounded text-fine text-primary underline-offset-2 hover:underline"
        download={name}
      >
        <Trans>Open original</Trans>
      </a>
    </>
  );
}

function ContainedImage({ url, name }: { url: string; name: string }) {
  return (
    <div className="grid h-full min-h-0 place-items-center overflow-auto bg-background p-4 md:p-6">
      <img
        src={url}
        alt={name}
        className="max-h-full max-w-full rounded-md border border-border bg-background object-contain shadow-sm"
      />
    </div>
  );
}

function ZoomableFitImage({ url, name }: { url: string; name: string }) {
  const gesture = useRef<TouchGesture | null>(null);
  const [scale, setScale] = useState(MIN_SCALE);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  function resetIfBase(nextScale: number) {
    if (nextScale <= MIN_SCALE) setOffset({ x: 0, y: 0 });
  }

  function handleTouchStart(event: React.TouchEvent<HTMLDivElement>) {
    if (event.touches.length >= 2) {
      event.preventDefault();
      gesture.current = { mode: "pinch", distance: touchDistance(event.touches), scale };
      return;
    }
    const touch = event.touches.item(0);
    if (touch && scale > MIN_SCALE) {
      event.preventDefault();
      gesture.current = {
        mode: "pan",
        x: touch.clientX,
        y: touch.clientY,
        offsetX: offset.x,
        offsetY: offset.y,
      };
    }
  }

  function handleTouchMove(event: React.TouchEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current) return;
    if (current.mode === "pinch" && event.touches.length >= 2) {
      event.preventDefault();
      const nextScale = clampScale(
        current.scale * (touchDistance(event.touches) / current.distance),
      );
      setScale(nextScale);
      resetIfBase(nextScale);
      return;
    }
    const touch = event.touches.item(0);
    if (current.mode === "pan" && touch && scale > MIN_SCALE) {
      event.preventDefault();
      setOffset({
        x: current.offsetX + touch.clientX - current.x,
        y: current.offsetY + touch.clientY - current.y,
      });
    }
  }

  function handleTouchEnd(event: React.TouchEvent<HTMLDivElement>) {
    if (event.touches.length === 0) {
      gesture.current = null;
      return;
    }
    const touch = event.touches.item(0);
    if (touch && scale > MIN_SCALE) {
      gesture.current = {
        mode: "pan",
        x: touch.clientX,
        y: touch.clientY,
        offsetX: offset.x,
        offsetY: offset.y,
      };
    }
  }

  return (
    <div
      className="grid h-full min-h-0 place-items-start overflow-auto bg-background p-4 md:p-6"
      // `pinch-zoom` is intentionally omitted: the viewer handles two-finger
      // scale itself so closing the overlay cannot leave the whole page zoomed.
      style={{ touchAction: scale > MIN_SCALE ? "none" : "pan-x pan-y" }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      <img
        src={url}
        alt={name}
        className={cn(
          "h-auto w-full max-w-none rounded-md border border-border bg-background object-contain shadow-sm",
          scale > MIN_SCALE && "cursor-grab",
        )}
        style={{
          transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})`,
          transformOrigin: "top left",
        }}
      />
    </div>
  );
}
