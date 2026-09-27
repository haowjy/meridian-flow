/** Shared dev-debug state and its single keyboard subscription. */
import { useEffect, useSyncExternalStore } from "react";
import { DEBUG_FEATURE_ALLOWED } from "@/core/debug-gate";

export { DEBUG_FEATURE_ALLOWED } from "@/core/debug-gate";
export type LlmCallsScope =
  | { threadId: string; turnId: string }
  | { threadId: string; turnIds: string[] }
  | null;
type DebugState = { enabled: boolean; viewerOpen: boolean; filter: LlmCallsScope };
const STORAGE_KEY = "meridian:debug-overlay";
const INITIAL_STATE: DebugState = { enabled: false, viewerOpen: false, filter: null };
let state: DebugState = INITIAL_STATE;
const subscribers = new Set<() => void>();
let initialized = false;
let openViewer: (() => void) | null = null;

function publish(next: DebugState) {
  state = next;
  for (const listener of subscribers) listener();
}
function readEnabled() {
  if (typeof window === "undefined") return false;
  try {
    return (
      new URLSearchParams(window.location.search).get("debug") === "1" ||
      window.localStorage.getItem(STORAGE_KEY) === "1"
    );
  } catch {
    return false;
  }
}
function persist(enabled: boolean) {
  try {
    if (enabled) window.localStorage.setItem(STORAGE_KEY, "1");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* Debug remains usable in memory when storage is unavailable. */
  }
}
function toggleDebug() {
  const enabled = !state.enabled;
  persist(enabled);
  publish({
    ...state,
    enabled,
    viewerOpen: enabled && state.viewerOpen,
    filter: enabled ? state.filter : null,
  });
}
function onKeyDown(event: KeyboardEvent) {
  const key = event.key.toLowerCase();
  if (key !== "d") return;
  if ((event.metaKey && event.ctrlKey) || (event.ctrlKey && event.shiftKey && !event.metaKey)) {
    event.preventDefault();
    toggleDebug();
  }
}
function initialize() {
  if (initialized || !DEBUG_FEATURE_ALLOWED || typeof window === "undefined") return;
  initialized = true;
  if (readEnabled()) {
    persist(true);
    publish({ ...state, enabled: true });
  }
  window.addEventListener("keydown", onKeyDown);
}
function subscribe(listener: () => void) {
  subscribers.add(listener);
  initialize();
  return () => subscribers.delete(listener);
}
const getState = () => state;
export function useDebugEnabled() {
  const enabled = useSyncExternalStore(
    subscribe,
    () => state.enabled,
    () => false,
  );
  useEffect(() => {
    initialize();
  }, []);
  return { enabled: DEBUG_FEATURE_ALLOWED && enabled, toggle: toggleDebug };
}
export function useDebugState(): DebugState {
  return useSyncExternalStore(subscribe, getState, () => INITIAL_STATE);
}
export function setLlmCallsViewerOpener(opener: (() => void) | null) {
  openViewer = opener;
}
export function openLlmCalls(scope: LlmCallsScope) {
  if (!DEBUG_FEATURE_ALLOWED || !state.enabled) return;
  publish({ ...state, viewerOpen: true, filter: scope });
  openViewer?.();
}
export function clearLlmCallsScope() {
  publish({ ...state, filter: null });
}
export function closeLlmCalls() {
  publish({ ...state, viewerOpen: false });
}

/** Reset module state between tests without exposing a production reset path. */
export function resetDebugStoreForTests() {
  if (import.meta.env.MODE !== "test") {
    throw new Error("resetDebugStoreForTests is only available in tests");
  }
  if (typeof window !== "undefined") {
    window.removeEventListener("keydown", onKeyDown);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* Storage is optional; resetting in-memory state is still sufficient. */
    }
  }
  state = INITIAL_STATE;
  initialized = false;
  openViewer = null;
  subscribers.clear();
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (typeof window !== "undefined") window.removeEventListener("keydown", onKeyDown);
    initialized = false;
  });
}
