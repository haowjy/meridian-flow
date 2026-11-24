import { type FocusEvent, type RefObject, useLayoutEffect, useRef } from "react";

export function useFocusWithinRow<T extends HTMLElement>(
  ref: RefObject<T | null>,
): { onFocus: () => void; onBlur: (event: FocusEvent<T>) => void } {
  const focusWithin = useRef(false);
  useLayoutEffect(() => {
    const row = ref.current;
    if (!row || !focusWithin.current) return;
    const active = row.ownerDocument.activeElement;
    if (active && active !== row.ownerDocument.body && row.contains(active)) return;
    if (active && active !== row.ownerDocument.body) {
      focusWithin.current = false;
      return;
    }
    const enabled = 'button:not([disabled]):not([aria-disabled="true"])';
    const next =
      row.querySelector<HTMLElement>("button[data-focus-landing]:not([disabled])") ??
      [...row.querySelectorAll<HTMLElement>(enabled)].at(-1);
    (next ?? row).focus({ preventScroll: true });
  });
  return {
    onFocus: () => {
      focusWithin.current = true;
    },
    onBlur: (event) => {
      if (event.relatedTarget && ref.current?.contains(event.relatedTarget as Node)) return;
      // keep: In the blur microtask check target.isConnected; an unmounted control is disconnected and keeps the focus claim, a real blur stays connected.
      const target = event.target;
      queueMicrotask(() => {
        if (target.isConnected) focusWithin.current = false;
      });
    },
  };
}
