/**
 * Focus the app moves on the writer's behalf, such as following a Work to the
 * tab it moved to. The keyboard ring paints only when the writer's action came
 * from the keyboard. Browsers guess this for script focus and guess wrong after
 * pointer actions that pass through a menu, so the caller says which it was.
 */

let keyboardInput = false;
const tracked = new WeakSet<Document>();

/** Starts tracking the writer's input modality in `doc`; safe to call again. */
export function trackInputModality(doc: Document) {
  if (tracked.has(doc)) return;
  tracked.add(doc);
  // Capture phase, so handlers that stop propagation still count. Shortcuts
  // with a modifier (switching apps, copying) are not keyboard navigation.
  doc.addEventListener(
    "keydown",
    (event) => {
      if (!event.metaKey && !event.ctrlKey && !event.altKey) keyboardInput = true;
    },
    true,
  );
  doc.addEventListener("pointerdown", () => (keyboardInput = false), true);
}

/** Whether the writer's latest input was a key press rather than a pointer. */
export const lastInputWasKeyboard = () => keyboardInput;

/**
 * Focuses `element`, painting the keyboard ring only when `ring` is set.
 * `focusVisible` covers browsers that honor it; `data-focus-quiet` covers the
 * rest (see `focus-ring` in globals.css) until focus leaves or a key is pressed.
 */
export function moveFocus(element: HTMLElement, { ring }: { ring: boolean }) {
  if (ring) delete element.dataset.focusQuiet;
  else {
    element.dataset.focusQuiet = "";
    const clear = () => {
      delete element.dataset.focusQuiet;
      element.removeEventListener("blur", clear);
      element.removeEventListener("keydown", clear);
    };
    element.addEventListener("blur", clear);
    element.addEventListener("keydown", clear);
  }
  element.focus({ focusVisible: ring });
}
