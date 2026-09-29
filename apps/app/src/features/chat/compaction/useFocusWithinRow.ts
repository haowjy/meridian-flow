/**
 * Keeps keyboard focus in a transcript row when the control that held it
 * disappears: Undo leaves a divider while it waits at the tail, Withdraw
 * leaves a row of several, Stop becomes a finished divider or Retry. Browsers drop focus to <body> when a focused
 * element unmounts, which strands a keyboard or screen-reader writer at the
 * top of the page. Focus moves to the control the row marks
 * `data-focus-landing` (the one that replaced it), else the row's last
 * remaining control, else the row itself (it carries `tabIndex={-1}`).
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
    // Controls replace each other at the end of the row (Stop, then Retry).
    const enabled = 'button:not([disabled]):not([aria-disabled="true"])';
    const next =
      row.querySelector<HTMLElement>(`${enabled}[data-focus-landing]`) ??
      [...row.querySelectorAll<HTMLElement>(enabled)].at(-1);
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
