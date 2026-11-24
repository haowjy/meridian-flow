import { type RefObject, useEffect, useRef } from "react";

let keyboardInput = false;
const tracked = new WeakSet<Document>();

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

export function trackInputModality(doc: Document) {
  if (tracked.has(doc)) return;
  tracked.add(doc);
  const root = doc.documentElement;
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

export const lastInputWasKeyboard = () => keyboardInput;

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

export function focusIsFree() {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected || heldByPaint(active);
}

const heldByPaint = (element: Element) =>
  element.matches("[data-paint-status], [data-paint-frame]");

export function focusWhenFree(element: HTMLElement) {
  requestAnimationFrame(() => {
    if (focusIsFree()) element.focus();
  });
}

export function holdFocus(
  target: () => HTMLElement | null,
  onTaken?: () => void,
  focus: (element: HTMLElement) => void = (element) => element.focus(),
): () => void {
  const settle = () => {
    if (!focusIsFree()) return;
    const element = target();
    if (element) focus(element);
  };
  const outside = (event: FocusEvent) => {
    const to = event.target;
    if (to instanceof Element && (heldByPaint(to) || target()?.contains(to))) return;
    taken();
  };
  const blurred = () => queueMicrotask(settle);
  const observer = new MutationObserver(settle);
  const stop = () => {
    observer.disconnect();
    window.removeEventListener("keydown", taken, true);
    window.removeEventListener("pointerdown", taken, true);
    document.removeEventListener("focusin", outside, true);
    document.removeEventListener("focusout", blurred, true);
  };
  function taken() {
    stop();
    onTaken?.();
  }
  window.addEventListener("keydown", taken, true);
  window.addEventListener("pointerdown", taken, true);
  document.addEventListener("focusin", outside, true);
  document.addEventListener("focusout", blurred, true);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  settle();
  return stop;
}

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
