export const BAR_SLOT_CLASS = "meridian-review-bar-slot";
export const BAR_SLOT_ATTR = "data-review-bar-slot";

/**
 * The empty block the focused change's bar is drawn into when the margin is too
 * narrow for it. It lives in the editor's flow, so it pushes the text after the
 * change down and can never cover any. The bar itself is React's, portalled in.
 */
export function createBarSlotElement(doc: Document): HTMLElement {
  const slot = doc.createElement("div");
  slot.className = BAR_SLOT_CLASS;
  slot.setAttribute("contenteditable", "false");
  slot.setAttribute(BAR_SLOT_ATTR, "");
  return slot;
}
