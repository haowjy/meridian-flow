/**
 * THROWAWAY runtime CSS-var override state for the /proto/palette prototype.
 *
 * Tailwind v4 utilities (`bg-background`, `bg-sidebar`, `border-border`, …)
 * resolve to `var(--color-…)` at paint time, so writing a new value onto
 * `:root` instantly restyles every consumer. This hook owns:
 *
 *   - the current applied value per token (whatever string was last written —
 *     hex from the color picker OR a raw oklch(…) string the user typed),
 *   - the currently-selected preset (for UI highlighting only),
 *   - the "manuscript elevated" flag (preset C raises the page),
 *   - `apply` / `applyPreset` / `reset` actions that mutate
 *     `document.documentElement.style` so the chrome updates live.
 *
 * Reset removes only the keys we touched — it never wipes the project theme.
 * Disposable; do not generalize.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  PALETTE_PRESETS,
  PALETTE_TOKENS,
  type PalettePreset,
  type PaletteToken,
  type PaletteValues,
} from "./presets";

type State = {
  values: Partial<PaletteValues>;
  presetId: PalettePreset["id"] | null;
  elevated: boolean;
};

const EMPTY_STATE: State = { values: {}, presetId: null, elevated: false };

export function usePaletteOverrides() {
  const [state, setState] = useState<State>(EMPTY_STATE);

  const writtenKeysRef = useRef<Set<PaletteToken>>(new Set());

  // Mutate :root inline style — the moment a token gets a value, every
  // Tailwind utility that resolves to that var repaints. Removing the property
  // hands the token back to the @theme default in ink-jade.css.
  useEffect(() => {
    const root = document.documentElement;
    const seen = new Set<PaletteToken>();
    for (const token of PALETTE_TOKENS) {
      const value = state.values[token];
      if (value && value.trim().length > 0) {
        root.style.setProperty(token, value);
        seen.add(token);
      } else {
        root.style.removeProperty(token);
      }
    }
    // Clean up any previously-written keys that disappeared from state.
    for (const previous of writtenKeysRef.current) {
      if (!seen.has(previous)) root.style.removeProperty(previous);
    }
    writtenKeysRef.current = seen;
  }, [state.values]);

  // Effect cleanup on unmount: leave the route, restore the project theme.
  useEffect(() => {
    return () => {
      const root = document.documentElement;
      for (const key of writtenKeysRef.current) {
        root.style.removeProperty(key);
      }
      writtenKeysRef.current = new Set();
    };
  }, []);

  const apply = useCallback((token: PaletteToken, value: string) => {
    setState((s) => ({
      ...s,
      // A direct token edit detaches the readout from any preset label so
      // the user knows their tweak deviated from the named direction.
      presetId: null,
      values: { ...s.values, [token]: value },
    }));
  }, []);

  const applyPreset = useCallback((preset: PalettePreset) => {
    setState({
      values: { ...preset.values },
      presetId: preset.id,
      elevated: preset.manuscriptElevated,
    });
  }, []);

  const setElevated = useCallback((next: boolean) => {
    setState((s) => ({ ...s, elevated: next }));
  }, []);

  const reset = useCallback(() => {
    setState(EMPTY_STATE);
  }, []);

  return useMemo(
    () => ({
      values: state.values,
      presetId: state.presetId,
      elevated: state.elevated,
      apply,
      applyPreset,
      setElevated,
      reset,
      presets: PALETTE_PRESETS,
    }),
    [state.values, state.presetId, state.elevated, apply, applyPreset, setElevated, reset],
  );
}

/**
 * Resolve any CSS color string (oklch, hex, rgb, named) to a `#rrggbb` hex
 * the native `<input type="color">` will accept. We render a hidden element,
 * let the browser parse the color, then read the resolved RGB.
 *
 * Returns `null` if the browser couldn't resolve the value (e.g. malformed
 * oklch). Callers fall back to a neutral hex in that case.
 */
export function resolveCssColorToHex(value: string): string | null {
  if (typeof document === "undefined") return null;
  const probe = document.createElement("div");
  probe.style.color = "rgb(0, 0, 0)";
  probe.style.color = value;
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  document.body.removeChild(probe);
  // getComputedStyle returns rgb(...) / rgba(...) — parse the channels out.
  const match = /rgba?\(([^)]+)\)/.exec(resolved);
  if (!match) return null;
  const parts = match[1]
    .split(/[ ,/]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 3) return null;
  const channel = (i: number) => {
    const raw = parts[i];
    const n = raw.endsWith("%") ? (Number.parseFloat(raw) / 100) * 255 : Number.parseFloat(raw);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(255, Math.round(n)));
  };
  const r = channel(0);
  const g = channel(1);
  const b = channel(2);
  if (r === null || g === null || b === null) return null;
  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Read the *currently rendered* value of one of our tokens — either an
 * override the prototype wrote, or the @theme default — and return both the
 * raw string and a hex equivalent for the color picker.
 */
export function readCurrentToken(token: PaletteToken): { raw: string; hex: string } {
  if (typeof document === "undefined") return { raw: "", hex: "#000000" };
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return { raw, hex: resolveCssColorToHex(raw) ?? "#000000" };
}
