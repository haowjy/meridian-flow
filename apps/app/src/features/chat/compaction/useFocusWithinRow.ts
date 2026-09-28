/**
 * Keeps keyboard focus in a transcript row when the control that held it
 * disappears: Undo becomes "Undo queued", Withdraw becomes an outcome, Stop
 * becomes a finished divider. Browsers drop focus to <body> when a focused
 * element unmounts, which strands a keyboard or screen-reader writer at the
 * top of the page. Focus moves to the row's last remaining control (the one
 * that replaced it), else to the row itself (it carries `tabIndex={-1}`).
 */
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
    // Controls replace each other at the end of the row (Undo, then Withdraw).
    const next = [
      ...row.querySelectorAll<HTMLElement>('button:not([disabled]):not([aria-disabled="true"])'),
    ].at(-1);
    (next ?? row).focus({ preventScroll: true });
  });
  return {
    onFocus: () => {
      focusWithin.current = true;
    },
    onBlur: (event) => {
      if (event.relatedTarget && ref.current?.contains(event.relatedTarget as Node)) return;
      // A control that unmounted is disconnected by now and keeps the claim;
      // a real blur (click or Tab elsewhere) leaves it connected.
      const target = event.target;
      queueMicrotask(() => {
        if (target.isConnected) focusWithin.current = false;
      });
    },
  };
}
