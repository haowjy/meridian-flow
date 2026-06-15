/**
 * use-debug-enabled — gating hook for the dev-only debug overlay.
 *
 * Key decisions:
 * - The overlay is hard-gated by `import.meta.env.DEV` (or the explicit
 *   `VITE_DEBUG_OVERLAY === "1"` escape hatch) so the entire feature is
 *   dead-code-eliminated from production builds.
 * - Within dev: off by default, toggled by ⌘⌃D / Ctrl+Shift+D, persisted in
 *   `localStorage` (`meridian:debug-overlay`), and force-on via `?debug=1`.
 * - SSR/hydration: the initial render is ALWAYS `enabled: false` so it matches
 *   the server (which has no `window`, hence renders nothing). Reading
 *   `localStorage`/`?debug=1` in the `useState` initializer would make the first
 *   client render diverge from server HTML → "Hydration failed". Instead we
 *   resolve the real initial value in a post-mount effect, after hydration.
 * - i18n exception: this file is DEV-only and never ships. Inline English
 *   strings (only used elsewhere in the overlay) intentionally bypass the
 *   Lingui catalog to keep production translations clean.
 */
import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "meridian:debug-overlay";

/**
 * Build-time gate. If false, the overlay module exports a no-op `enabled` and
 * the build pipeline strips its imports as dead code.
 */
export const DEBUG_FEATURE_ALLOWED: boolean =
  import.meta.env.DEV || import.meta.env.VITE_DEBUG_OVERLAY === "1";

function readQueryParamForce(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("debug") === "1";
  } catch {
    return false;
  }
}

function readPersisted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writePersisted(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(STORAGE_KEY, "1");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage may be unavailable (private mode, quota); fail silently — the
    // overlay is dev-only and degrades to in-memory state.
  }
}

/**
 * Returns the runtime-toggleable overlay state plus a manual `toggle`. When
 * the build-time gate is off, returns `{ enabled: false, toggle: noop }` and
 * never installs keyboard listeners.
 */
export function useDebugEnabled(): { enabled: boolean; toggle: () => void } {
  // ALWAYS false on the first render so client hydration matches SSR (which
  // renders nothing). The real value is resolved in the mount effect below.
  const [enabled, setEnabled] = useState<boolean>(false);

  const toggle = useCallback(() => {
    setEnabled((current) => {
      const next = !current;
      writePersisted(next);
      return next;
    });
  }, []);

  // Resolve the real initial state AFTER hydration: force-on via `?debug=1`,
  // else the persisted preference. Runs once on mount.
  //
  // `?debug=1` is STICKY: visiting once with the param also persists the
  // preference, so you can drop the param from the URL and the overlay stays on
  // across navigations until you explicitly disable it. Without this, the param
  // was session-only and the overlay vanished the moment you navigated to a URL
  // that didn't carry it — and ⌘⌃D (the only other on-switch) collides with the
  // macOS Dictionary shortcut, leaving no reliable persistent path.
  useEffect(() => {
    if (!DEBUG_FEATURE_ALLOWED) return;
    if (readQueryParamForce()) {
      setEnabled(true);
      writePersisted(true);
      return;
    }
    if (readPersisted()) setEnabled(true);
  }, []);

  useEffect(() => {
    if (!DEBUG_FEATURE_ALLOWED) return;
    if (typeof window === "undefined") return;

    function onKeyDown(event: KeyboardEvent) {
      // macOS: ⌘⌃D (metaKey + ctrlKey + d).
      // Other platforms: Ctrl+Shift+D.
      const key = event.key.toLowerCase();
      if (key !== "d") return;
      const macCombo = event.metaKey && event.ctrlKey;
      const winCombo = event.ctrlKey && event.shiftKey && !event.metaKey;
      if (macCombo || winCombo) {
        event.preventDefault();
        toggle();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle]);

  if (!DEBUG_FEATURE_ALLOWED) {
    return { enabled: false, toggle: () => {} };
  }
  return { enabled, toggle };
}
