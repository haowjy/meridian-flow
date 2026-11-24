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
