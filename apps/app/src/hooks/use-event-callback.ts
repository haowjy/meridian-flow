/**
 * useEventCallback — a handler whose identity never changes but whose body
 * always sees the latest render's props and state.
 *
 * For long-lived imperative consumers (a ProseMirror DOM handler, a subscribed
 * listener) that would otherwise be torn down and rebuilt whenever a plain
 * `useCallback` closes over something new. Do not call the returned handler
 * during render: its body is only guaranteed current from the commit onward.
 */
import { useCallback, useInsertionEffect, useRef } from "react";

export function useEventCallback<Args extends unknown[], Result>(
  handler: (...args: Args) => Result,
): (...args: Args) => Result {
  const handlerRef = useRef(handler);
  // Insertion phase so the handler is current before any layout effect or
  // event dispatched from one can reach it.
  useInsertionEffect(() => {
    handlerRef.current = handler;
  });
  return useCallback((...args: Args) => handlerRef.current(...args), []);
}
