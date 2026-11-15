/**
 * A field that handles Escape itself (an inline edit cancels on it) marks itself
 * `data-handles-escape`. A dialog or takeover ignores Escape from inside such an element, because
 * Radix hears Escape on the document before the field's own handler could stop it.
 */
export function ignoreFieldEscape(event: {
  target: EventTarget | null;
  preventDefault: () => void;
}) {
  if (event.target instanceof Element && event.target.closest("[data-handles-escape]"))
    event.preventDefault();
}
