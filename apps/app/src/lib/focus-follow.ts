import { type RefObject, useEffect, useRef } from "react";

/**
 * Focus the app moves on the writer's behalf, such as following a Work to the
 * tab it moved to. The keyboard ring paints only when the writer's action came
 * from the keyboard. Browsers guess this for script focus and guess wrong after
 * pointer actions that pass through a menu, so the caller says which it was.
 */

let keyboardInput = false;
const tracked = new WeakSet<Document>();

/**
 * Keys that move focus. Only these turn the keyboard ring on: Shift held for a
 * shift-click, Escape closing a menu, or typing must not ring what was clicked.
 */
const NAVIGATION_KEYS = new Set([
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/**
 * Starts tracking the writer's input modality in `doc`; safe to call again.
 * `data-focus-keys` on the root gates every focus ring (globals.css).
 */
export function trackInputModality(doc: Document) {
  if (tracked.has(doc)) return;
  tracked.add(doc);
  const root = doc.documentElement;
  // Capture phase, so handlers that stop propagation still count. Shortcuts
  // with a modifier (switching apps, copying) are not keyboard navigation.
  doc.addEventListener(
    "keydown",
    (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey || !NAVIGATION_KEYS.has(event.key)) return;
      keyboardInput = true;
      root.dataset.focusKeys = "";
    },
    true,
  );
  doc.addEventListener(
    "pointerdown",
    () => {
      keyboardInput = false;
      delete root.dataset.focusKeys;
    },
    true,
  );
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

/**
 * Nothing the writer chose holds the focus: the element that had it went away, or a
 * paint cover (`PaintHold`) is holding it while the pane's content changes.
 */
export function focusIsFree() {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected || heldByPaint(active);
}

const heldByPaint = (element: Element) =>
  element.matches("[data-paint-status], [data-paint-frame]");

/**
 * Focuses `element` a frame from now if focus is still free then. A name field closed by a
 * click elsewhere ends during its blur, before the click moves focus: the click wins.
 */
export function focusWhenFree(element: HTMLElement) {
  requestAnimationFrame(() => {
    if (focusIsFree()) element.focus();
  });
}

/**
 * Puts the focus on `target()` whenever it falls free, for a destination that may not be
 * shown yet or may be swapped for another copy after it took the focus. Ends at the
 * writer's first key or press, or when focus lands anywhere outside the target, and then
 * calls `onTaken`. The returned stop ends it without calling `onTaken`.
 */
export function holdFocus(target: () => HTMLElement | null, onTaken?: () => void): () => void {
  const settle = () => {
    if (focusIsFree()) target()?.focus();
  };
  const outside = (event: FocusEvent) => {
    const to = event.target;
    if (to instanceof Element && (heldByPaint(to) || target()?.contains(to))) return;
    taken();
  };
  const observer = new MutationObserver(settle);
  const stop = () => {
    observer.disconnect();
    window.removeEventListener("keydown", taken, true);
    window.removeEventListener("pointerdown", taken, true);
    document.removeEventListener("focusin", outside, true);
  };
  function taken() {
    stop();
    onTaken?.();
  }
  window.addEventListener("keydown", taken, true);
  window.addEventListener("pointerdown", taken, true);
  document.addEventListener("focusin", outside, true);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  settle();
  return stop;
}

/**
 * Keeps the focus in `container` when a command there removes the control that held it (a
 * Discard gives way to its notice, an Undo to the changes again): `next(container)` takes it,
 * or the first enabled button. A press outside, or focus moved elsewhere, lets go.
 */
export function useFocusSuccession(
  container: RefObject<HTMLElement | null>,
  mounted = true,
  next?: (container: HTMLElement) => HTMLElement | null,
) {
  const pick = useRef(next);
  pick.current = next;
  useEffect(() => {
    const element = container.current;
    if (!mounted || !element) return;
    let within = element.contains(document.activeElement);
    const succeed = () => {
      if (!within || !focusIsFree()) return;
      const to =
        pick.current?.(element) ?? element.querySelector<HTMLElement>("button:not(:disabled)");
      if (to) moveFocus(to, { ring: lastInputWasKeyboard() });
    };
    const focused = (event: FocusEvent) => {
      // A paint cover takes the focus while the pane swaps and hands it to the frame when it
      // lifts: not the writer moving it, and the moment the successor can take it.
      if (event.target instanceof Element && heldByPaint(event.target)) {
        queueMicrotask(succeed);
        return;
      }
      within = event.target instanceof Node && element.contains(event.target);
    };
    const pressed = (event: PointerEvent) => {
      if (!(event.target instanceof Node && element.contains(event.target))) within = false;
    };
    const observer = new MutationObserver(succeed);
    document.addEventListener("focusin", focused, true);
    document.addEventListener("pointerdown", pressed, true);
    observer.observe(element, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      document.removeEventListener("focusin", focused, true);
      document.removeEventListener("pointerdown", pressed, true);
    };
  }, [container, mounted]);
}
