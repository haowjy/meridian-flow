/**
 * useCoarsePointer — true while the primary pointer is a finger, at any width.
 *
 * The phone shell is chosen by `usePhoneShell`; a touch tablet or a touch
 * laptop at desktop width keeps the desktop shell but still needs the phone's
 * 44px targets. Components that take the phone's `touch` prop read this too, so
 * one sizing rule serves both. Pure-CSS sites use `[@media(pointer:coarse)]:`.
 */
import { useSyncExternalStore } from "react";

const COARSE_POINTER_QUERY = "(pointer: coarse)";

function subscribe(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const mql = window.matchMedia(COARSE_POINTER_QUERY);
  mql.addEventListener("change", onStoreChange);
  return () => mql.removeEventListener("change", onStoreChange);
}

const snapshot = () =>
  typeof window !== "undefined" && window.matchMedia(COARSE_POINTER_QUERY).matches;

export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
