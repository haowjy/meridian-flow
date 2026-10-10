/**
 * Whether the rail's Scratch section is expanded, and the height the writer gave it, remembered per viewer on this
 * device (never synced), like the current Work and chat. Collapsed by default.
 */
const KEY = "meridian:scratch-section-expanded";

export function readScratchExpanded(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function writeScratchExpanded(expanded: boolean): void {
  try {
    window.localStorage.setItem(KEY, expanded ? "1" : "0");
  } catch {
    // Remembering the choice is best-effort when storage is unavailable.
  }
}

const HEIGHT_KEY = "meridian:scratch-section-height";

/** The writer's chosen height for the expanded section, or null for the content-sized default. */
export function readScratchHeight(): number | null {
  try {
    const value = Number(window.localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeScratchHeight(heightPx: number | null): void {
  try {
    if (heightPx === null) window.localStorage.removeItem(HEIGHT_KEY);
    else window.localStorage.setItem(HEIGHT_KEY, String(Math.round(heightPx)));
  } catch {
    // Remembering the height is best-effort when storage is unavailable.
  }
}
