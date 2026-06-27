/**
 * usePhoneShell — device-capability predicate for selecting the phone project shell.
 *
 * The shell boundary is not a generic responsive breakpoint. It requires a
 * coarse primary pointer plus either:
 * - narrow width, which catches portrait phones; or
 * - short height, which catches landscape phones whose width exceeds 767px.
 *
 * The height clause is capped at 500px so iPhone landscape gets the phone shell
 * while iPad mini landscape (744px tall) stays on the desktop project. Hover
 * is deliberately excluded: touch-primary tablets with trackpads may report
 * hover, but hover capability does not make a phone-sized viewport usable with
 * the desktop 3-column shell.
 */
import { useSyncExternalStore } from "react";

export type PhoneShellViewport = {
  width: number;
  height: number;
  pointer: "coarse" | "fine" | "none";
};

export const PHONE_SHELL_QUERY =
  "(pointer: coarse) and (max-width: 767px), (pointer: coarse) and (max-height: 500px)";

export function matchesPhoneShellViewport({ width, height, pointer }: PhoneShellViewport): boolean {
  return pointer === "coarse" && (width <= 767 || height <= 500);
}

export function usePhoneShell(): boolean | null {
  return useSyncExternalStore(subscribePhoneShell, getPhoneShellSnapshot, getServerSnapshot);
}

function subscribePhoneShell(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const mql = window.matchMedia(PHONE_SHELL_QUERY);
  mql.addEventListener("change", onStoreChange);
  return () => mql.removeEventListener("change", onStoreChange);
}

function getPhoneShellSnapshot(): boolean | null {
  if (typeof window === "undefined") return null;
  return window.matchMedia(PHONE_SHELL_QUERY).matches;
}

function getServerSnapshot(): null {
  return null;
}
