// keep: Radix hears Escape on the document before a field's own handler can stop it
export function ignoreFieldEscape(event: {
  target: EventTarget | null;
  preventDefault: () => void;
}) {
  if (event.target instanceof Element && event.target.closest("[data-handles-escape]"))
    event.preventDefault();
}
