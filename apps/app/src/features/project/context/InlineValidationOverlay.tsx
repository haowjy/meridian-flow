/**
 * Floating validation message for the context tree's inline create/rename
 * input. Rendered as a fixed-position portal anchored to the input's bottom
 * edge — NOT inline — so a message never shifts the tree rows beneath it and
 * never gets clipped by the tree's scroll container. Repositions on scroll
 * (capture phase, to catch the inner scroller) and resize.
 */
import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ContextEntryNameSeverity } from "./context-entry-name";
import { ValidationNote } from "./validation-note";

type Anchor = { top: number; left: number; width: number };

export function InlineValidationOverlay({
  anchorRef,
  severity,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  severity: ContextEntryNameSeverity | null;
}) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  useLayoutEffect(() => {
    const el = anchorRef.current;
    if (!severity || !el) {
      setAnchor(null);
      return;
    }
    const place = () => {
      const rect = el.getBoundingClientRect();
      setAnchor({ top: rect.bottom + 2, left: rect.left, width: Math.max(rect.width, 140) });
    };
    place();
    // Capture phase catches the tree's own scroll container, not just window.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [severity, anchorRef]);

  if (!severity || !anchor) return null;

  return createPortal(
    <div
      style={{
        position: "fixed",
        top: anchor.top,
        left: anchor.left,
        width: anchor.width,
        maxWidth: 260,
        zIndex: 50,
      }}
    >
      <ValidationNote severity={severity} className="shadow-md" />
    </div>,
    document.body,
  );
}
