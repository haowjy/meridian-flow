/** Reads the pane's height cap on pictures. The cap itself is CSS (`--meridian-picture-cap`). */

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
