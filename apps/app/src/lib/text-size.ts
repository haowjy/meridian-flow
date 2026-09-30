/**
 * Text-size preference — local, pre-paint reading scale for rendered prose.
 *
 * The preference is intentionally device-local (like locale today): writers may
 * want different reading sizes on a laptop and a phone. Medium is represented by
 * the absence of a DOM attribute so the default browser-sized body stays the
 * default path.
 */
import { createPreferenceSubscribers } from "./preference-subscribers";

export const TEXT_SIZE_STORAGE_KEY = "meridian:text-size";
export const TEXT_SIZE_ATTRIBUTE = "data-text-size";

export const TEXT_SIZES = ["sm", "md", "lg"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

export const DEFAULT_TEXT_SIZE: TextSize = "md";

export function isTextSize(value: string): value is TextSize {
  return (TEXT_SIZES as readonly string[]).includes(value);
}

export function normalizeTextSize(value: string | null | undefined): TextSize {
  return value && isTextSize(value) ? value : DEFAULT_TEXT_SIZE;
}

export function resolveTextSize(): TextSize {
  if (typeof window === "undefined") return DEFAULT_TEXT_SIZE;
  try {
    return normalizeTextSize(localStorage.getItem(TEXT_SIZE_STORAGE_KEY));
  } catch {
    return DEFAULT_TEXT_SIZE;
  }
}

export function applyTextSize(textSize: TextSize): void {
  if (typeof document === "undefined") return;
  if (textSize === DEFAULT_TEXT_SIZE) {
    document.documentElement.removeAttribute(TEXT_SIZE_ATTRIBUTE);
    return;
  }
  document.documentElement.setAttribute(TEXT_SIZE_ATTRIBUTE, textSize);
}

export function applyStoredTextSize(): TextSize {
  const textSize = resolveTextSize();
  applyTextSize(textSize);
  return textSize;
}

// Another tab changed it: apply theirs here too.
const subscribers = createPreferenceSubscribers(TEXT_SIZE_STORAGE_KEY, () => {
  applyStoredTextSize();
});

export function changeTextSize(textSize: TextSize): void {
  applyTextSize(textSize);
  try {
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, textSize);
  } catch {
    // localStorage unavailable
  }
  subscribers.notify();
}

export const subscribeTextSize = subscribers.subscribe;

export const TEXT_SIZE_BOOT_SCRIPT = `(() => { try { const key = ${JSON.stringify(
  TEXT_SIZE_STORAGE_KEY,
)}; const attr = ${JSON.stringify(
  TEXT_SIZE_ATTRIBUTE,
)}; const value = localStorage.getItem(key); const root = document.documentElement; if (value === "sm" || value === "lg") root.setAttribute(attr, value); else root.removeAttribute(attr); } catch {} })();`;
