import { type ReactNode, useEffect, useRef } from "react";
import { useOptionalPanePlace } from "@/features/project/pane-place";
import { useReviewMode } from "./review-mode";

/** Where the focus is in something that takes Esc for itself: a menu, a dialog, a listbox. */
const OWNS_ESCAPE = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';
/** Something open over the page (a popover, a menu, a dialog) that Esc closes first. */
const OPEN_LAYER =
  '[data-radix-popper-content-wrapper], [role="dialog"][data-state="open"], [role="alertdialog"]';

/** A field the writer types in, other than a document's editor, keeps Esc for itself. */
function isOtherField(target: Element): boolean {
  if (target.closest(".ProseMirror")) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target as HTMLElement).isContentEditable
  );
}

/**
 * The one Esc of Review changes: wherever the focus is on the page, Esc closes the
 * review of the host it is in, or main's when it is in no host (the sidebar, the top bar). What
 * handles Esc first (an editor's popup, which prevents it) or owns it (a menu, a dialog, another
 * field) keeps it.
 */
export function ReviewEscapeScope({ children }: { children: ReactNode }) {
  const mode = useReviewMode();
  const place = useOptionalPanePlace();
  const root = useRef<HTMLDivElement>(null);
  const close = mode?.close;
  useEffect(() => {
    if (!close) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target && (target.closest(OWNS_ESCAPE) || isOtherField(target))) return;
      if (document.querySelector(OPEN_LAYER)) return;
      const host = target?.closest("[data-review-host]");
      if (host ? host !== root.current : place !== "main") return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, place]);
  return (
    <div ref={root} data-review-host className="contents">
      {children}
    </div>
  );
}
