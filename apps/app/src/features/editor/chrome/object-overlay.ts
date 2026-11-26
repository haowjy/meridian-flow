import type { Editor } from "@tiptap/core";
import type { CSSProperties } from "react";

import { manuscriptOverlay } from "./manuscript-overlay";
import { useAnchorRect } from "./useAnchorRect";
import "./object-overlay.css";

export type ObjectOverlayCorner = { inside: HTMLElement } | { over: HTMLElement };

export type ObjectOverlayPlacement = {
  container: Element;
  placement: "inside" | "over";
  style: CSSProperties | undefined;
};

const OVERLAY_INSET_PX = 10;

export function useObjectOverlayCorner(
  editor: Editor | null,
  corner: ObjectOverlayCorner | null,
): ObjectOverlayPlacement | null {
  const measured = corner && "over" in corner ? corner.over : null;
  const rect = useAnchorRect(editor, measured);
  const overlay = manuscriptOverlay(editor);

  if (!corner || typeof document === "undefined") return null;

  if ("inside" in corner) {
    if (!corner.inside.isConnected) return null;
    return { container: corner.inside, placement: "inside", style: undefined };
  }

  if (!rect || !overlay) return null;
  return {
    container: overlay,
    placement: "over",
    style: { top: rect.top + OVERLAY_INSET_PX, left: rect.right - OVERLAY_INSET_PX },
  };
}
