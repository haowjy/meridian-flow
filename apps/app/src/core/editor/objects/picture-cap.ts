/** Reads the pane's height cap on pictures. The cap itself is CSS (`--meridian-picture-cap`). */

import type { EditorView } from "@tiptap/pm/view";

/** The tallest the pane draws this picture, in CSS pixels. */
export function pictureCapHeight(element: Element): number {
  return Number.parseFloat(
    window.getComputedStyle(element).getPropertyValue("--meridian-picture-cap"),
  );
}

/** Is `target` a picture the cap is holding back, so the page shows less than it has? */
export function pictureCapped(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLImageElement)) return false;
  return target.getBoundingClientRect().height >= pictureCapHeight(target) - 1;
}

/**
 * Keeps the cap still while a phone keyboard is up, for touch screens only.
 *
 * `interactive-widget=resizes-content` makes the keyboard shrink the pane, and
 * viewport units with it, so no CSS unit outlasts it. A height drop at the same
 * width while the writer is typing here is the keyboard, and the height from
 * before it stands until the pane is back to full height or changes width.
 */
export function holdPictureCapThroughKeyboard(view: EditorView): () => void {
  const pane = view.dom.closest<HTMLElement>(".meridian-editor");
  if (!pane) return () => {};
  let held = { width: 0, height: 0 };
  const observer = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect;
    if (width === held.width && height < held.height && view.hasFocus()) return;
    held = { width, height };
    pane.style.setProperty("--meridian-pane-height", `${height}px`);
  });
  observer.observe(pane);
  return () => {
    observer.disconnect();
    pane.style.removeProperty("--meridian-pane-height");
  };
}
