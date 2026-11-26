import type { EditorView } from "@tiptap/pm/view";

export function pictureCapHeight(element: Element): number {
  return Number.parseFloat(
    window.getComputedStyle(element).getPropertyValue("--meridian-picture-cap"),
  );
}

export function pictureCapped(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLImageElement)) return false;
  return target.getBoundingClientRect().height >= pictureCapHeight(target) - 1;
}

export function holdPictureCapThroughKeyboard(view: EditorView, pane: HTMLElement): () => void {
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
