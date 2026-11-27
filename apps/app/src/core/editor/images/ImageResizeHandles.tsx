import type { Editor } from "@tiptap/core";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useRef } from "react";

import { holdNode, type NodeHold } from "../anchors";
import { pictureCapHeight } from "../objects";
import {
  IMAGE_RESIZE_CORNERS,
  type ImageResizeCorner,
  type ImageResizeGesture,
  proseLineHeight,
  resizedImageWidth,
  setImageWidth,
} from "./image-resize";

type ActiveResize = {
  gesture: ImageResizeGesture;
  hold: NodeHold;
  pointerId: number;
  origin: { x: number; y: number };
  box: HTMLElement;
  restore: string;
  listeners: AbortController;
  width: number;
};

export function ImageResizeHandles({
  editor,
  getPos,
  box,
}: {
  editor: Editor;
  getPos: () => number | undefined;
  box: () => HTMLElement | null;
}) {
  const active = useRef<ActiveResize | null>(null);

  const onPointerDown = (corner: ImageResizeCorner, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || active.current) return;
    const element = box();
    const pos = getPos();
    if (!element || pos === undefined) return;
    const hold = holdNode(editor.view.state, pos);
    const bounds = element.getBoundingClientRect();
    if (!hold || bounds.width <= 0 || bounds.height <= 0) return;

    // The picture IS the drag handle (`inline-drag`), so a press that reached a
    // grip has to say so before the browser starts carrying the picture away.
    event.preventDefault();
    event.stopPropagation();

    const ratio = bounds.height / bounds.width;
    const capWidth = pictureCapHeight(element) / ratio;
    const resize: ActiveResize = {
      gesture: {
        corner,
        startWidth: bounds.width,
        ratio,
        minimum: proseLineHeight(element),
        maximum: Math.min(visibleBoundWidth(element) ?? bounds.width, capWidth),
      },
      hold,
      pointerId: event.pointerId,
      origin: { x: event.clientX, y: event.clientY },
      box: element,
      restore: element.style.width,
      listeners: new AbortController(),
      width: Math.round(bounds.width),
    };
    active.current = resize;

    const finish = (commit: boolean) => {
      if (active.current !== resize) return;
      active.current = null;
      resize.listeners.abort();
      const changed = resize.width !== Math.round(resize.gesture.startWidth);
      const wrote = commit && changed && setImageWidth(editor, resize.hold, resize.width);
      if (!wrote) resize.box.style.width = resize.restore;
    };

    const mine = (moved: PointerEvent) => moved.pointerId === resize.pointerId;
    const { signal } = resize.listeners;

    window.addEventListener(
      "pointermove",
      (moved) => {
        if (!mine(moved)) return;
        resize.width = resizedImageWidth(resize.gesture, {
          x: moved.clientX - resize.origin.x,
          y: moved.clientY - resize.origin.y,
        });
        if (resize.box.isConnected) resize.box.style.width = `${resize.width}px`;
      },
      { signal },
    );
    window.addEventListener("pointerup", (up) => mine(up) && finish(true), { signal });
    window.addEventListener("pointercancel", (cancelled) => mine(cancelled) && finish(false), {
      signal,
    });
  };

  return (
    <span className="meridian-image-resize" aria-hidden>
      {IMAGE_RESIZE_CORNERS.map((corner) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: a grip is a pointer affordance with no keyboard equivalent yet, and a role it cannot honour reads worse than being hidden; the keyboard path is in this directory's .context/FUTURE. slop-lint: allow suppression the reason is stated in this comment
        <span
          key={corner}
          className={`meridian-image-resize__grip meridian-image-resize__grip--${corner}`}
          draggable={false}
          onDragStart={(event) => event.preventDefault()}
          onPointerDown={(event) => onPointerDown(corner, event)}
        />
      ))}
    </span>
  );
}

function visibleBoundWidth(element: HTMLElement): number | null {
  let narrowest: number | null = null;
  for (let at = element.parentElement; at; at = at.parentElement) {
    if (!window.getComputedStyle(at).display.startsWith("inline") && at.clientWidth > 0) {
      narrowest = narrowest === null ? at.clientWidth : Math.min(narrowest, at.clientWidth);
    }
    if (at.classList.contains("ProseMirror")) break;
  }
  return narrowest;
}
